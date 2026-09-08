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
  {
    type: "function",
    name: "getRoundData",
    stateMutability: "view",
    inputs: [{ name: "_roundId", type: "uint80" }],
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

export type PricePoint = {
  time: number; // Unix timestamp in seconds
  value: number; // Price in USD
};

/**
 * Fetch real historical Chainlink rounds for a token.
 * Never fabricates or interpolates points: returns solely genuine on-chain rounds.
 */
export async function oraclePriceHistory(
  n: Network,
  token: Address,
  count: number = 25
): Promise<PricePoint[] | null> {
  const feed = n.oracleFeeds[token.toLowerCase()];
  if (!feed) return null;

  const client = publicClientFor(n);
  try {
    const [decimals, latestRound] = await Promise.all([
      client.readContract({ address: feed, abi: AGGREGATOR_V3_ABI, functionName: "decimals" }),
      client.readContract({ address: feed, abi: AGGREGATOR_V3_ABI, functionName: "latestRoundData" }),
    ]);

    const [latestRoundId, answer, , updatedAt] = latestRound;
    if (answer <= 0n) return null;

    const scale = 10 ** Number(decimals);
    const points: PricePoint[] = [
      {
        time: Number(updatedAt),
        value: Number(answer) / scale,
      },
    ];

    const prevCalls = [];
    for (let i = 1; i < count; i++) {
      const targetId = latestRoundId - BigInt(i);
      prevCalls.push(
        client
          .readContract({
            address: feed,
            abi: AGGREGATOR_V3_ABI,
            functionName: "getRoundData",
            args: [targetId],
          })
          .catch(() => null)
      );
    }

    const results = await Promise.all(prevCalls);
    for (const r of results) {
      if (r && r[1] > 0n && r[3] > 0n) {
        points.push({
          time: Number(r[3]),
          value: Number(r[1]) / scale,
        });
      }
    }

    // Sort strictly ascending by time for charting libraries
    points.sort((a, b) => a.time - b.time);

    // Filter out duplicate timestamps if any
    const deduped: PricePoint[] = [];
    for (let i = 0; i < points.length; i++) {
      if (i === 0 || points[i].time > points[i - 1].time) {
        deduped.push(points[i]);
      }
    }

    return deduped;
  } catch {
    return null;
  }
}

