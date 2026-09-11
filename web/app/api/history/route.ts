import { networkFrom } from "@/lib/networks";
import { swapHistoryFor, strategyHistoryFor } from "@/lib/history";
import { strategyHistoryFromGraph } from "@/lib/graph";
import { BadInput } from "@/lib/validate";
import { isAddress, getAddress } from "viem";
import { j, fail, chainFailure } from "@/lib/json";

export const dynamic = "force-dynamic";

/**
 * GET /api/history?chain=&address=
 *
 * The portfolio tab used to show only a snapshot: what this wallet has
 * claimed right now, against what it holds right now. Nothing about how it
 * got there. This is the other half -- every swap this wallet has made
 * through this network's Wellhead, and every strategy this wallet has
 * shipped or docked as a maker, in one call.
 *
 * Swap history has no subgraph to prefer: nothing indexes Wellhead, since it
 * is this project's own contract, not part of Aqua's own schema. Strategy
 * history does, and is asked for it first -- real timestamps and decoded
 * tokens, full history rather than a bounded recent window -- falling back
 * to an RPC scan only where no index is configured.
 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const n = networkFrom(url.searchParams.get("chain"));
    const raw = url.searchParams.get("address");
    if (!raw || !isAddress(raw, { strict: false })) throw new BadInput("address required");
    const address = getAddress(raw);

    const [swaps, graphStrategies] = await Promise.all([
      swapHistoryFor(n, address),
      strategyHistoryFromGraph(n, address, n.router),
    ]);

    const strategies =
      graphStrategies ??
      (await strategyHistoryFor(n, address).then((rows) =>
        rows.map((r) => ({
          strategyHash: r.strategyHash,
          tokens: r.tokens,
          shippedAt: null,
          dockedAt: null,
          active: r.active,
        }))
      ));

    return j({
      chain: { id: n.id, label: n.label, testnet: n.testnet },
      swaps: {
        source: n.wellhead ? "rpc-log-paging" : "none",
        available: !!n.wellhead,
        reason: n.wellhead ? undefined : `no Wellhead deployed on ${n.label}`,
        rows: swaps,
      },
      strategies: {
        source: graphStrategies ? "aquifer-subgraph" : "rpc-log-paging",
        rows: strategies,
      },
    });
  } catch (e) {
    if (e instanceof BadInput) return fail(e.message, 400);
    if ((e as Error).message?.startsWith("unknown chain")) return fail((e as Error).message, 400);
    const unreachable = chainFailure(e);
    if (unreachable) return unreachable;
    return fail((e as Error).message, 500);
  }
}
