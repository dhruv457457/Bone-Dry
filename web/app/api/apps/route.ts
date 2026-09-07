import { networkFrom } from "@/lib/networks";
import { appBreakdown } from "@/lib/graph";
import { j, fail, chainFailure } from "@/lib/json";

export const dynamic = "force-dynamic";

/**
 * GET /api/apps?chain=
 *
 * Every app currently shipping live Aqua strategies, per the same subgraph
 * that answers Bone Dry's own coverage view -- proof the schema this
 * project proposed as a reusable Aqua standard actually generalizes, not
 * an assertion about it.
 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const n = networkFrom(url.searchParams.get("chain"));
    const apps = await appBreakdown(n, n.router);

    if (apps === null) {
      return j({
        available: false,
        reason: !n.graphUrl
          ? `no subgraph is indexing ${n.label} yet`
          : `the ${n.label} index is unavailable or still catching up`,
        apps: [],
      });
    }

    return j({ available: true, apps });
  } catch (e) {
    if ((e as Error).message?.startsWith("unknown chain")) return fail((e as Error).message, 400);
    const unreachable = chainFailure(e);
    if (unreachable) return unreachable;
    return fail((e as Error).message, 500);
  }
}
