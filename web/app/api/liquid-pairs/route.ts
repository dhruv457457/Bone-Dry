import { networkFrom } from "@/lib/networks";
import { liquidPairsFromGraph } from "@/lib/graph";
import { j, fail, chainFailure } from "@/lib/json";

export const dynamic = "force-dynamic";

/**
 * GET /api/liquid-pairs?chain=
 *
 * Which token pairs on this router actually have a maker willing to fill
 * them, right now. The token picker used to let a user combine any two
 * tokens from a static list and find out only after quoting that nobody
 * backs that pair -- USDC and WETH concentrate almost all real depth on
 * Base today (46 and 26 distinct makers respectively as of writing),
 * everything else in single digits. This is the real answer, not a guess:
 * grouped from every currently-active strategy's own token list.
 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const n = networkFrom(url.searchParams.get("chain"));
    const result = await liquidPairsFromGraph(n, n.router);

    if (result === null) {
      return j({
        available: false,
        reason: !n.graphUrl
          ? `no subgraph is indexing ${n.label} yet`
          : `the ${n.label} index is unavailable or still catching up`,
        pairs: [],
        tokens: [],
      });
    }

    return j({ available: true, ...result });
  } catch (e) {
    if ((e as Error).message?.startsWith("unknown chain")) return fail((e as Error).message, 400);
    const unreachable = chainFailure(e);
    if (unreachable) return unreachable;
    return fail((e as Error).message, 500);
  }
}
