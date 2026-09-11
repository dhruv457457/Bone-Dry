import { NETWORKS } from "@/lib/networks";
import { refreshIndex } from "@/lib/indexer";
import { j, fail, chainFailure } from "@/lib/json";

export const dynamic = "force-dynamic";
export const maxDuration = 300; // this job is expected to take minutes, not seconds

/**
 * POST /api/cron/refresh?chain=1
 *
 * Triggered on a schedule (GitHub Actions, not Vercel Cron -- see indexer.ts
 * and the workflow file for why) rather than by a user request. Protected by
 * CRON_SECRET so this expensive job can't be fired by anyone who finds the
 * URL; the schedule that calls it holds the same secret.
 */
export async function POST(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return fail("CRON_SECRET is not configured on this deployment", 500);
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${secret}`) return fail("unauthorized", 401);

  try {
    const url = new URL(req.url);
    const chainParam = url.searchParams.get("chain");
    const n = chainParam ? NETWORKS[Number(chainParam) as keyof typeof NETWORKS] : NETWORKS[1];
    if (!n) return fail(`unknown chain ${chainParam}`, 400);

    const stats = await refreshIndex(n);
    return j({ ok: true, ...stats });
  } catch (e) {
    const unreachable = chainFailure(e);
    if (unreachable) return unreachable;
    console.error("[cron/refresh]", (e as Error).message);
    return fail((e as Error).message, 500);
  }
}
