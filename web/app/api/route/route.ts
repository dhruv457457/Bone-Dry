import { cachedStrategies, measureDepth, mergeStrategies } from "@/lib/aqua";
import { dedupeByMaker, planLikeTap, filterFillable, encodeHookData, attachOracleDeviations } from "@/lib/router";
import { networkFrom, tokensOf } from "@/lib/networks";
import { allTokensFor } from "@/lib/pairs";
import { strategiesFromGraph, indexStateOf } from "@/lib/graph";
import { addressParam, amountParam, distinct, BadInput } from "@/lib/validate";
import { j, fail, chainFailure } from "@/lib/json";

export const dynamic = "force-dynamic";

/**
 * GET /api/route?tokenIn=&tokenOut=&amountIn=
 *
 * The piece that cannot exist on-chain. Aqua stores no list of its makers, so the
 * candidate set has to be assembled off-chain and handed to the hook as calldata.
 * Returns the plan, a real quote for it from the router, and the encoded hookData.
 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const n = networkFrom(url.searchParams.get("chain"));
    const TOKENS = { ...tokensOf(n), ...allTokensFor(n.id) };
    const tokenIn = addressParam(url.searchParams.get("tokenIn"), n.usdc);
    const tokenOut = addressParam(url.searchParams.get("tokenOut"), n.weth);
    const amountIn = amountParam(url.searchParams.get("amountIn"), 100_000_000n);
    distinct(tokenIn, tokenOut);

    // The index for history, a short chain scan for the tail it has not reached.
    const fromGraph = await strategiesFromGraph(n, n.router);
    const rawStrategies = fromGraph ?? (await cachedStrategies(n)).strategies;
    const strategies = rawStrategies.filter((s) => {
      if (!s.tokens || s.tokens.length === 0) return true;
      const toks = s.tokens.map((t) => t.toLowerCase());
      return toks.includes(tokenIn.toLowerCase()) && toks.includes(tokenOut.toLowerCase());
    });
    const depths = await measureDepth(n, strategies, tokenOut);

    // Having the token is not the same as being willing to part with it. Probe
    // each solvent maker once and drop the ones whose quote reverts, so their
    // share of the input is not thrown away on a fill that can never land.
    const { fillable, unfillable } = await filterFillable(n, depths, tokenIn, tokenOut, amountIn);

    // One candidate per maker: `depths` is per-strategy, and sibling strategies
    // of one maker all draw on the same wallet. This set is what ships in
    // hookData, so it is also the exact set Tap.sol sums its own totalDepth
    // over -- the two have to agree or every slice the hook computes is off.
    const candidates = dedupeByMaker(fillable);

    // Replay the hook rather than approximate it. Tap.sol re-derives every
    // slice on-chain from freshly-read depths and either fills a maker whole
    // or skips them; nothing it does resembles trimming a slice down. So the
    // quote is produced by running that same algorithm here and only
    // publishing a total the replay actually completed.
    const plan = await planLikeTap(n, candidates, amountIn, tokenIn, tokenOut);
    const { slices, binding: clamped } = plan;

    if (slices.length === 0) {
      return j({
        source: fromGraph ? "aquifer-subgraph" : n.graphUrl ? `rpc-log-paging (index ${indexStateOf(n).status})` : "rpc-log-paging",
        tokenIn: { ...TOKENS[tokenIn.toLowerCase()], address: tokenIn },
        tokenOut: { ...TOKENS[tokenOut.toLowerCase()], address: tokenOut },
        amountIn,
        // Same shape as the success branch: a consumer should not have to branch.
        amountFilled: 0n,
        unfilled: amountIn,
        slices: [],
        amountOut: 0n,
        singleMakerAmountOut: 0n,
        improvementBps: 0n,
        makersConsidered: depths.length,
        makersUsed: 0,
        makersSkipped: depths.filter((d) => !d.solvent).map((d) => d.maker),
        makersUnfillable: unfillable,
        clamped,
        hookData: null,
        reason:
          amountIn === 0n
            ? "nothing to swap"
            : "no solvent maker can deliver this token right now",
      });
    }

    // `plan.takeIn` is the number the wallet must send, and the replay already
    // proved the hook consumes all of it -- no re-derivation from the slices,
    // which would only reintroduce the rounding the replay just accounted for.
    const filled = plan.takeIn;

    // The comparison the split has to beat: the same input through the single
    // deepest maker alone. Run through the identical replay so the baseline is
    // subject to exactly the rules the split was, rather than a looser
    // approximation -- an earlier version cut corners here and reported
    // improvements over 10,000 bps because the baseline came out near zero.
    const single = await planLikeTap(n, candidates.slice(0, 1), filled, tokenIn, tokenOut);

    const improvementBps =
      single.amountOut > 0n ? ((plan.amountOut - single.amountOut) * 10_000n) / single.amountOut : 0n;

    return j({
      source: fromGraph ? "aquifer-subgraph" : n.graphUrl ? `rpc-log-paging (index ${indexStateOf(n).status})` : "rpc-log-paging",
      tokenIn: { ...TOKENS[tokenIn.toLowerCase()], address: tokenIn },
      tokenOut: { ...TOKENS[tokenOut.toLowerCase()], address: tokenOut },
      chain: { id: n.id, label: n.label, testnet: n.testnet },
      amountIn,
      /** what the route can actually absorb — below amountIn when depth ran out */
      amountFilled: filled,
      unfilled: amountIn - filled,
      makersConsidered: depths.length,
      makersUsed: slices.length,
      makersSkipped: depths.filter((d) => !d.solvent).map((d) => d.maker),
      /** solvent makers whose quote reverts — gated, wrong pair, or a program we cannot drive */
      makersUnfillable: unfillable,
      /** makers whose own ceiling held the whole fill below what was asked for */
      clamped,
      slices: await attachOracleDeviations(
        n,
        slices.map((s, i) => ({
          maker: s.maker,
          amountIn: s.amountIn,
          depth: s.depth,
          amountOut: plan.perMaker[i]?.amountOut ?? 0n,
        })),
        tokenIn,
        tokenOut,
        TOKENS[tokenIn.toLowerCase()]?.decimals ?? 18,
        TOKENS[tokenOut.toLowerCase()]?.decimals ?? 18
      ),
      amountOut: plan.amountOut,
      singleMakerAmountOut: single.amountOut,
      improvementBps,
      // Every candidate, not just the ones that drew a slice. Tap.sol sums its
      // own totalDepth across exactly what this blob carries, and that sum is
      // the denominator of every slice it computes -- ship a shorter list than
      // the plan was built on and the hook silently re-splits by different
      // weights than the quote assumed.
      hookData: encodeHookData(plan.candidates),
    });
  } catch (e) {
    if (e instanceof BadInput) return fail(e.message, 400);
    if ((e as Error).message?.startsWith("unknown chain")) return fail((e as Error).message, 400);
    const unreachable = chainFailure(e);
    if (unreachable) return unreachable;
    return fail((e as Error).message, 500);
  }
}
