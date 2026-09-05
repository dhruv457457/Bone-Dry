import { indexStrategies, measureDepth } from "@/lib/aqua";
import { strategiesFromGraph, GRAPH_URL } from "@/lib/graph";
import { ROUTER } from "@/lib/chain";
import { TOKENS, WETH } from "@/lib/chain";
import { byDepthDesc } from "@/lib/router";
import { addressParam, amountParam, BadInput } from "@/lib/validate";
import { j, fail } from "@/lib/json";

export const dynamic = "force-dynamic";

/**
 * GET /api/makers?token=0x...&fromBlock=
 *
 * Every live Aqua strategy on the Bone Dry router, with the only depth number a
 * router may trust: min(virtual balance, wallet balance, Aqua allowance).
 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const token = addressParam(url.searchParams.get("token"), WETH);
    const fromBlock = url.searchParams.get("fromBlock");
    const from = fromBlock ? amountParam(fromBlock, 0n) : undefined;

    // Prefer the index; fall back to paging logs when no subgraph is configured.
    const strategies =
      (await strategiesFromGraph(ROUTER)) ??
      (await indexStrategies(from !== undefined ? { fromBlock: from } : undefined));
    const depths = await measureDepth(strategies, token);

    const meta = TOKENS[token.toLowerCase()];
    return j({
      source: GRAPH_URL ? "aquifer-subgraph" : "rpc-log-paging",
      token: { address: token, symbol: meta?.symbol ?? "?", decimals: meta?.decimals ?? 18 },
      indexed: strategies.length,
      solvent: depths.filter((d) => d.solvent).length,
      totalDepth: depths.reduce((a, d) => a + d.depth, 0n),
      makers: depths
        .sort(byDepthDesc)
        .map((d) => ({
          maker: d.maker,
          strategyHash: d.strategyHash,
          virtual: d.virtual,
          wallet: d.wallet,
          allowance: d.allowance,
          depth: d.depth,
          solvent: d.solvent,
          // the interesting column: promised vs deliverable
          shortfall: d.virtual > d.depth ? d.virtual - d.depth : 0n,
        })),
    });
  } catch (e) {
    if (e instanceof BadInput) return fail(e.message, 400);
    return fail((e as Error).message, 500);
  }
}
