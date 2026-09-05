import { cachedStrategies, measureDepth, mergeStrategies } from "@/lib/aqua";
import { planRoute, quoteRoute, clampToDepth, filterFillable, encodeHookData } from "@/lib/router";
import { USDC, WETH, TOKENS, ROUTER } from "@/lib/chain";
import { strategiesFromGraph, GRAPH_URL, graphState } from "@/lib/graph";
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
    const tokenIn = addressParam(url.searchParams.get("tokenIn"), USDC);
    const tokenOut = addressParam(url.searchParams.get("tokenOut"), WETH);
    const amountIn = amountParam(url.searchParams.get("amountIn"), 100_000_000n);
    distinct(tokenIn, tokenOut);

    // The index for history, a short chain scan for the tail it has not reached.
    const fromGraph = await strategiesFromGraph(ROUTER);
    const tail = (await cachedStrategies()).strategies;
    const strategies = fromGraph ? mergeStrategies(fromGraph, tail) : tail;
    const depths = await measureDepth(strategies, tokenOut);

    // Having the token is not the same as being willing to part with it. Probe
    // each solvent maker once and drop the ones whose quote reverts, so their
    // share of the input is not thrown away on a fill that can never land.
    const { fillable, unfillable } = await filterFillable(depths, tokenIn, tokenOut, amountIn);
    const planned = planRoute(fillable, amountIn);

    // A solvent maker is not the same as a deliverable quote: the curve is bounded
    // by the VIRTUAL balance, so a big enough slice quotes out more than the wallet
    // holds. Cut every slice back to what its maker can actually pay.
    const { slices, clamped } = await clampToDepth(planned, tokenIn, tokenOut);

    if (slices.length === 0) {
      return j({
        source: fromGraph ? "aquifer-subgraph" : GRAPH_URL ? `rpc-log-paging (index ${graphState})` : "rpc-log-paging",
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

    const filled = slices.reduce((a, s) => a + s.amountIn, 0n);
    const [split, single] = await Promise.all([
      quoteRoute(slices, tokenIn, tokenOut),
      // Same comparison the split has to beat: everything through the deepest
      // maker alone, clamped by the same rule so the baseline is honest too.
      clampToDepth([{ ...slices[0], amountIn: filled }], tokenIn, tokenOut).then((c) =>
        quoteRoute(c.slices, tokenIn, tokenOut)
      ),
    ]);

    const improvementBps =
      single.amountOut > 0n ? ((split.amountOut - single.amountOut) * 10_000n) / single.amountOut : 0n;

    return j({
      source: fromGraph ? "aquifer-subgraph" : GRAPH_URL ? `rpc-log-paging (index ${graphState})` : "rpc-log-paging",
      tokenIn: { ...TOKENS[tokenIn.toLowerCase()], address: tokenIn },
      tokenOut: { ...TOKENS[tokenOut.toLowerCase()], address: tokenOut },
      amountIn,
      /** what the route can actually absorb — below amountIn when depth ran out */
      amountFilled: filled,
      unfilled: amountIn - filled,
      makersConsidered: depths.length,
      makersUsed: slices.length,
      makersSkipped: depths.filter((d) => !d.solvent).map((d) => d.maker),
      /** solvent makers whose quote reverts — gated, wrong pair, or a program we cannot drive */
      makersUnfillable: unfillable,
      /** makers whose quote exceeded their real depth and had to be cut back */
      clamped,
      slices: slices.map((s, i) => ({
        maker: s.maker,
        amountIn: s.amountIn,
        depth: s.depth,
        amountOut: split.perMaker[i]?.amountOut ?? 0n,
      })),
      amountOut: split.amountOut,
      singleMakerAmountOut: single.amountOut,
      improvementBps,
      hookData: encodeHookData(slices),
    });
  } catch (e) {
    if (e instanceof BadInput) return fail(e.message, 400);
    const unreachable = chainFailure(e);
    if (unreachable) return unreachable;
    return fail((e as Error).message, 500);
  }
}
