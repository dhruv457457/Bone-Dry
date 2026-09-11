import { type Address, parseAbiItem } from "viem";
import { type Network, clientFor } from "./networks";

export interface MakerRefusalRecord {
  id: string;
  maker: Address;
  wanted: bigint;
  blockNumber: bigint;
  timestamp?: number;
  txHash: `0x${string}`;
}

export interface MakerReliabilityMetrics {
  maker: Address;
  fillsCount: number;
  skipsCount: number;
  totalVolumeSkipped: bigint;
  flakeRate: number; // 0.00 to 1.00 (0% to 100%)
  reliabilityScore: number; // 1.00 to 0.00 (100% to 0%)
  status: "RELIABLE" | "DEGRADED" | "UNRELIABLE";
  refusals: MakerRefusalRecord[];
}

const MAKER_SKIPPED_EVENT = parseAbiItem(
  "event MakerSkipped(address indexed maker, uint256 wanted)"
);

/**
 * Fetches historical MakerSkipped logs directly on-chain from Bone Dry's Tap.sol hook.
 *
 * This guarantees real refusal data is accessible even if an external subgraph indexer
 * is lagging or unavailable.
 */
export async function fetchOnChainRefusals(
  net: Network,
  maker?: Address,
  fromBlock?: bigint,
  opts?: { pageSize?: bigint; maxPages?: number }
): Promise<MakerRefusalRecord[]> {
  if (!net.hook) return [];

  const client = clientFor(net);

  // Same shape as indexStrategies in aqua.ts, and for the same reason: a
  // single unpaged eth_getLogs(genesis, latest) is exactly the call that
  // 500'd the maker book and route quote on Base mainnet before every public
  // RPC fallback here was found to cap the range somewhere well under that.
  // This function has no caller yet (it exists for a maker-reliability view
  // nothing wires up to), which is precisely why it needs to be correct
  // rather than merely working today: the first thing that calls it will
  // inherit whatever bug is already here.
  const page = opts?.pageSize ?? (net.id === 8453 ? 1_500n : 9_999n);
  const budget = opts?.maxPages ?? 12;
  const floor = fromBlock ?? net.aquaGenesis;

  try {
    const latest = await client.getBlockNumber();
    const out: MakerRefusalRecord[] = [];
    let end = latest;
    let pages = 0;

    while (end >= floor && pages < budget) {
      const start = end - page > floor ? end - page : floor;

      const logs = await client.getLogs({
        address: net.hook,
        event: MAKER_SKIPPED_EVENT,
        args: maker ? { maker } : undefined,
        fromBlock: start,
        toBlock: end,
      });

      for (const log of logs) {
        out.push({
          id: `${log.transactionHash}-${log.logIndex}`,
          maker: log.args.maker as Address,
          wanted: log.args.wanted ?? 0n,
          blockNumber: log.blockNumber ?? 0n,
          txHash: log.transactionHash as `0x${string}`,
        });
      }

      if (start === floor) break;
      end = start - 1n;
      pages++;
    }

    return out;
  } catch (err) {
    console.warn(`[RefusalLedger] on-chain logs fetch failed for ${net.label}:`, err);
    return [];
  }
}

const FILLED_EVENT = parseAbiItem(
  "event Filled(address indexed maker, uint256 amountIn, uint256 amountOut)"
);

export interface MakerFillRecord {
  maker: Address;
  amountIn: bigint;
  amountOut: bigint;
  blockNumber: bigint;
  txHash: `0x${string}`;
}

/** Same shape as fetchOnChainRefusals, reading Tap's other event: every fill
 *  that actually landed, not just the ones that didn't. Reliability needs
 *  both sides -- a skip count on its own says nothing about how often this
 *  maker is even asked. */
export async function fetchOnChainFills(
  net: Network,
  fromBlock?: bigint,
  opts?: { pageSize?: bigint; maxPages?: number }
): Promise<MakerFillRecord[]> {
  if (!net.hook) return [];
  const client = clientFor(net);
  const page = opts?.pageSize ?? (net.id === 8453 ? 1_500n : 9_999n);
  const budget = opts?.maxPages ?? 12;
  const floor = fromBlock ?? net.aquaGenesis;

  try {
    const latest = await client.getBlockNumber();
    const out: MakerFillRecord[] = [];
    let end = latest;
    let pages = 0;

    while (end >= floor && pages < budget) {
      const start = end - page > floor ? end - page : floor;
      const logs = await client.getLogs({ address: net.hook, event: FILLED_EVENT, fromBlock: start, toBlock: end });
      for (const log of logs) {
        out.push({
          maker: log.args.maker as Address,
          amountIn: log.args.amountIn ?? 0n,
          amountOut: log.args.amountOut ?? 0n,
          blockNumber: log.blockNumber ?? 0n,
          txHash: log.transactionHash as `0x${string}`,
        });
      }
      if (start === floor) break;
      end = start - 1n;
      pages++;
    }
    return out;
  } catch (err) {
    console.warn(`[FillLedger] on-chain logs fetch failed for ${net.label}:`, err);
    return [];
  }
}

/**
 * Reliability for every maker seen in a window, in one pair of scans rather
 * than one scan per maker -- the difference between this being usable on a
 * page load and being an N+1 query against a free RPC.
 */
export async function reliabilityForAllMakers(
  net: Network,
  fromBlock: bigint
): Promise<MakerReliabilityMetrics[]> {
  const [fills, refusals] = await Promise.all([
    fetchOnChainFills(net, fromBlock),
    fetchOnChainRefusals(net, undefined, fromBlock),
  ]);

  const fillsByMaker = new Map<string, number>();
  for (const f of fills) {
    const k = f.maker.toLowerCase();
    fillsByMaker.set(k, (fillsByMaker.get(k) ?? 0) + 1);
  }
  const refusalsByMaker = new Map<string, MakerRefusalRecord[]>();
  for (const r of refusals) {
    const k = r.maker.toLowerCase();
    const list = refusalsByMaker.get(k) ?? [];
    list.push(r);
    refusalsByMaker.set(k, list);
  }

  const allMakers = new Set([...fillsByMaker.keys(), ...refusalsByMaker.keys()]);
  return [...allMakers].map((k) => {
    const maker = (fills.find((f) => f.maker.toLowerCase() === k)?.maker ??
      refusalsByMaker.get(k)![0].maker) as Address;
    return computeMakerReliability(maker, fillsByMaker.get(k) ?? 0, refusalsByMaker.get(k) ?? []);
  });
}

/**
 * Computes reliability and flake metrics for a maker given their fills and skips.
 */
export function computeMakerReliability(
  maker: Address,
  fillsCount: number,
  refusals: MakerRefusalRecord[]
): MakerReliabilityMetrics {
  const skipsCount = refusals.length;
  const totalVolumeSkipped = refusals.reduce((acc, r) => acc + r.wanted, 0n);
  const totalAttempts = fillsCount + skipsCount;

  const flakeRate = totalAttempts > 0 ? skipsCount / totalAttempts : 0;
  const reliabilityScore = totalAttempts > 0 ? fillsCount / totalAttempts : 1;

  let status: "RELIABLE" | "DEGRADED" | "UNRELIABLE" = "RELIABLE";
  if (flakeRate >= 0.25) {
    status = "UNRELIABLE";
  } else if (flakeRate > 0.05) {
    status = "DEGRADED";
  }

  return {
    maker,
    fillsCount,
    skipsCount,
    totalVolumeSkipped,
    flakeRate,
    reliabilityScore,
    status,
    refusals,
  };
}
