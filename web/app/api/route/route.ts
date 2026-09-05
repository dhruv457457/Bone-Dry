import { indexStrategies, measureDepth } from "@/lib/aqua";
import { planRoute, quoteRoute, encodeHookData } from "@/lib/router";
import { USDC, WETH, TOKENS, ROUTER } from "@/lib/chain";
import { strategiesFromGraph, GRAPH_URL } from "@/lib/graph";
import { j, fail } from "@/lib/json";
import type { Address } from "viem";

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
    const tokenIn = (url.searchParams.get("tokenIn") ?? USDC) as Address;
    const tokenOut = (url.searchParams.get("tokenOut") ?? WETH) as Address;
    const amountIn = BigInt(url.searchParams.get("amountIn") ?? "100000000");

    const strategies = (await strategiesFromGraph(ROUTER)) ?? (await indexStrategies());
    const depths = await measureDepth(strategies, tokenOut);
    const slices = planRoute(depths, amountIn);

    if (slices.length === 0) {
      return j({
        tokenIn,
        tokenOut,
        amountIn,
        slices: [],
        amountOut: 0n,
        hookData: null,
        reason: "no solvent maker can deliver this token right now",
      });
    }

    const [split, single] = await Promise.all([
      quoteRoute(slices, tokenIn, tokenOut),
      // what the same swap would fetch from the single deepest maker
      quoteRoute([{ ...slices[0], amountIn }], tokenIn, tokenOut),
    ]);

    const improvementBps =
      single.amountOut > 0n ? ((split.amountOut - single.amountOut) * 10_000n) / single.amountOut : 0n;

    return j({
      source: GRAPH_URL ? "aquifer-subgraph" : "rpc-log-paging",
      tokenIn: { ...TOKENS[tokenIn.toLowerCase()], address: tokenIn },
      tokenOut: { ...TOKENS[tokenOut.toLowerCase()], address: tokenOut },
      amountIn,
      makersConsidered: depths.length,
      makersUsed: slices.length,
      makersSkipped: depths.filter((d) => !d.solvent).map((d) => d.maker),
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
    return fail((e as Error).message, 500);
  }
}
