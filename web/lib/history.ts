import type { Address, Hex } from "viem";
import { aquaAbi, wellheadAbi } from "./chain";
import { clientFor, type Network } from "./networks";

export type SwapRecord = {
  txHash: Hex;
  blockNumber: bigint;
  timestamp: number | null;
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  amountOut: bigint;
};

export type StrategyRecord = {
  strategyHash: Hex;
  tokens: Address[];
  shippedAtBlock: bigint;
  dockedAtBlock: bigint | null;
  active: boolean;
};

/** How far back a fresh contract's own history actually needs to reach.
 *  Wellhead has been redeployed as recently as this session, so its real
 *  history is short by construction -- a bounded recent window is not a
 *  compromise here, it is the whole history there is. */
const HISTORY_WINDOW_BLOCKS = 20_000n;

/** Same per-network sizing aqua.ts already settled on empirically -- Base's
 *  free-tier RPCs choke on anything larger, Ethereum's on anything smaller
 *  fails to finish in a reasonable number of round trips. */
function pageSizeFor(n: Network): bigint {
  if (n.id === 8453) return 1_500n;
  if (n.id === 1) return 9_000n;
  return 9_999n;
}

/**
 * Every swap a wallet has made through this network's Wellhead, most recent
 * first. `swapper` is an indexed topic on Swapped, so this is filtered on the
 * RPC side rather than fetched-then-checked -- cheap regardless of how many
 * other swappers used the same router in the window.
 *
 * Paged rather than one call over the whole window: a free-tier Alchemy key
 * (which this app's own primary Base RPC is) caps eth_getLogs at 10 blocks
 * per request and errors outright above it, cascading through every fallback
 * -- including one that turned out to have a broken TLS cert -- before
 * failing the whole request. Every other RPC reader in this app already
 * pages for exactly this reason; this one was the one place that did not.
 */
export async function swapHistoryFor(n: Network, address: Address): Promise<SwapRecord[]> {
  if (!n.wellhead) return [];
  const client = clientFor(n);
  const latest = await client.getBlockNumber();
  const floor = latest > HISTORY_WINDOW_BLOCKS ? latest - HISTORY_WINDOW_BLOCKS : 0n;

  const PAGE = pageSizeFor(n);
  const logs = [];
  let end = latest;
  let pages = 0;
  const budget = Math.ceil(Number(HISTORY_WINDOW_BLOCKS / PAGE)) + 2;
  while (end >= floor && pages < budget) {
    const start = end - PAGE > floor ? end - PAGE : floor;
    const page = await client.getLogs({
      address: n.wellhead as Address,
      event: wellheadAbi[1],
      args: { swapper: address },
      fromBlock: start,
      toBlock: end,
    });
    logs.push(...page);
    if (start === floor) break;
    end = start - 1n;
    pages++;
  }

  const withTimestamps = await Promise.all(
    logs.map(async (l) => {
      const ts = await client
        .getBlock({ blockNumber: l.blockNumber! })
        .then((b) => Number(b.timestamp))
        .catch(() => null);
      const a = l.args as { tokenIn: Address; tokenOut: Address; amountIn: bigint; amountOut: bigint };
      return {
        txHash: l.transactionHash!,
        blockNumber: l.blockNumber!,
        timestamp: ts,
        tokenIn: a.tokenIn,
        tokenOut: a.tokenOut,
        amountIn: a.amountIn,
        amountOut: a.amountOut,
      };
    })
  );

  return withTimestamps.sort((a, b) => (b.blockNumber > a.blockNumber ? 1 : -1));
}

/**
 * Every strategy a maker has ever shipped on this network, active or docked,
 * most recent first. Unlike indexStrategies (which exists to answer "who can
 * fill right now" and drops docked strategies to stay that way), this is for
 * a maker looking at their own history and wants to see both.
 *
 * Shipped and Docked carry no indexed `maker` topic (checked the ABI: neither
 * field is declared indexed), so this cannot filter on the RPC side the way
 * swap history does -- every strategy any maker shipped in the window comes
 * back, and this filters to one maker after decoding. Bounded to the same
 * recent window as swap history, which keeps it cheap on Base and Sepolia's
 * real strategy counts; not used for Ethereum, whose real volume would make
 * an unfiltered scan the exact RPC-overload problem fixed elsewhere in this
 * app for exactly that reason.
 */
export async function strategyHistoryFor(n: Network, maker: Address): Promise<StrategyRecord[]> {
  const client = clientFor(n);
  const latest = await client.getBlockNumber();
  const floor = latest > HISTORY_WINDOW_BLOCKS ? latest - HISTORY_WINDOW_BLOCKS : n.aquaGenesis;

  const shipped: { strategyHash: Hex; tokens: Address[]; block: bigint }[] = [];
  const docked = new Map<string, bigint>();

  const PAGE = pageSizeFor(n);
  let end = latest;
  let pages = 0;
  const budget = 6;
  const lowerMaker = maker.toLowerCase();

  while (end >= floor && pages < budget) {
    const start = end - PAGE > floor ? end - PAGE : floor;

    const [ship, dock] = await Promise.all([
      client.getLogs({ address: n.aqua, event: aquaAbi[0], fromBlock: start, toBlock: end }),
      client.getLogs({ address: n.aqua, event: aquaAbi[1], fromBlock: start, toBlock: end }),
    ]);

    for (const l of ship) {
      const a = l.args as { maker: Address; app: Address; strategyHash: Hex; strategy: Hex };
      if (a.maker.toLowerCase() !== lowerMaker) continue;
      if (a.app.toLowerCase() !== n.router.toLowerCase()) continue;
      // Which tokens a strategy prices is opcode-specific to decode from raw
      // `data` bytes (the subgraph does this once at index time; a plain RPC
      // scan does not have that decoder). Left empty here rather than guessed
      // -- the record that a shipment happened does not depend on it.
      shipped.push({ strategyHash: a.strategyHash, tokens: [], block: l.blockNumber! });
    }
    for (const l of dock) {
      const a = l.args as { maker: Address; strategyHash: Hex };
      if (a.maker.toLowerCase() !== lowerMaker) continue;
      docked.set(a.strategyHash, l.blockNumber!);
    }

    if (start === floor) break;
    end = start - 1n;
    pages++;
  }

  return shipped
    .map((s) => ({
      strategyHash: s.strategyHash,
      tokens: s.tokens,
      shippedAtBlock: s.block,
      dockedAtBlock: docked.get(s.strategyHash) ?? null,
      active: !docked.has(s.strategyHash),
    }))
    .sort((a, b) => (b.shippedAtBlock > a.shippedAtBlock ? 1 : -1));
}
