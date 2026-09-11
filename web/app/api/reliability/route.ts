import { networkFrom, clientFor } from "@/lib/networks";
import { reliabilityForAllMakers } from "@/lib/refusals";
import { j, fail, chainFailure } from "@/lib/json";

export const dynamic = "force-dynamic";

/** How far back a fresh hook's own history needs to reach -- same reasoning
 *  as history.ts: Tap is redeployed periodically in this project, so its
 *  real reliability history is short by construction. */
const WINDOW_BLOCKS = 50_000n;

/**
 * GET /api/reliability?chain=
 *
 * Every maker's fill-vs-skip record against this network's own Tap hook,
 * in one call. MakerSkipped already fires every time a maker is caught
 * unable to deliver (see Tap.sol); this was written this session and had
 * nothing calling it until now.
 *
 * Reads honestly empty on a freshly deployed Tap -- there is no history to
 * report yet, and this says so rather than defaulting every maker to a
 * flattering "reliable" score on zero evidence.
 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const n = networkFrom(url.searchParams.get("chain"));

    if (!n.hook) {
      return j({ available: false, reason: `no hook deployed on ${n.label}`, makers: [] });
    }

    const client = clientFor(n);
    const head = await client.getBlockNumber();
    const floor = head > WINDOW_BLOCKS ? head - WINDOW_BLOCKS : n.aquaGenesis;

    const rows = await reliabilityForAllMakers(n, floor);

    return j({
      available: true,
      chain: { id: n.id, label: n.label, testnet: n.testnet },
      windowBlocks: WINDOW_BLOCKS.toString(),
      makers: rows
        .map((r) => ({
          maker: r.maker,
          fillsCount: r.fillsCount,
          skipsCount: r.skipsCount,
          totalVolumeSkipped: r.totalVolumeSkipped.toString(),
          flakeRate: r.flakeRate,
          status: r.status,
        }))
        .sort((a, b) => b.skipsCount - a.skipsCount),
    });
  } catch (e) {
    if ((e as Error).message?.startsWith("unknown chain")) return fail((e as Error).message, 400);
    const unreachable = chainFailure(e);
    if (unreachable) return unreachable;
    return fail((e as Error).message, 500);
  }
}
