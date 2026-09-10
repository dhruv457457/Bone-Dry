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
