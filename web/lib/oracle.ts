import type { Address } from "viem";
import { publicClientFor, type Network } from "./networks";

const AGGREGATOR_V3_ABI = [
  {
    type: "function",
    name: "latestRoundData",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "roundId", type: "uint80" },
      { name: "answer", type: "int256" },
      { name: "startedAt", type: "uint256" },
      { name: "updatedAt", type: "uint256" },
      { name: "answeredInRound", type: "uint80" },
    ],
  },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
] as const;

// Chainlink can go quiet without erroring -- an old-but-successful read is
// the dangerous case, not a revert. Volatile pairs (ETH/USD) have 1-hour heartbeats,
// but pegged stablecoins (USDC/USD) have standard 24-hour heartbeats on Chainlink.
// 90,000s (25 hours) accommodates 24h heartbeats with a slight buffer for network jitter.
const MAX_STALENESS_SECONDS = 90_000n;

export type OracleQuote = { priceUsdE18: bigint; updatedAt: bigint; stale: boolean };

/** A token's USD price from its configured Chainlink feed, normalized to
 *  18 decimals regardless of the feed's own decimals (Chainlink USD feeds
 *  are usually 8, but this must never assume that). Returns null if this
 *  network/token has no configured feed -- a normal case, not an error. */
export async function oraclePriceUsd(n: Network, token: Address): Promise<OracleQuote | null> {
  const feed = n.oracleFeeds[token.toLowerCase()];
  if (!feed) return null;

  const client = publicClientFor(n);
  const [decimals, round] = await Promise.all([
    client.readContract({ address: feed, abi: AGGREGATOR_V3_ABI, functionName: "decimals" }),
    client.readContract({ address: feed, abi: AGGREGATOR_V3_ABI, functionName: "latestRoundData" }),
  ]);
  const [, answer, , updatedAt] = round;
  if (answer <= 0n) return null; // a non-positive price is not a price

  const priceUsdE18 = (answer * 10n ** 18n) / 10n ** BigInt(decimals);
  const nowSeconds = BigInt(Math.floor(Date.now() / 1000));
  const stale = nowSeconds - updatedAt > MAX_STALENESS_SECONDS;
  return { priceUsdE18, updatedAt, stale };
}

/** How far a quoted implied price sits from the oracle's, in bps. Positive
 *  means the quote is above the oracle price, negative means below -- sign
 *  matters for reading whether a maker is over- or under-charging, so do
 *  not use an absolute value here; let the caller decide what to show. */
export function deviationBps(impliedUsdE18: bigint, oracleUsdE18: bigint): bigint {
  if (oracleUsdE18 === 0n) return 0n;
  return ((impliedUsdE18 - oracleUsdE18) * 10_000n) / oracleUsdE18;
}
