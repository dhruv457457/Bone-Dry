import { cachedStrategies, indexStrategies, measureDepth, mergeStrategies } from "@/lib/aqua";
import { strategiesFromGraph, indexStateOf } from "@/lib/graph";
import { networkFrom, tokensOf } from "@/lib/networks";
import { allTokensFor } from "@/lib/pairs";
import { byDepthDesc } from "@/lib/router";
import { addressParam, amountParam, BadInput } from "@/lib/validate";
import { j, fail, chainFailure } from "@/lib/json";

export const dynamic = "force-dynamic";

/**
 * GET /api/makers?chain=&token=&fromBlock=
 *
 * Every live Aqua strategy on this chain's Bone Dry router, with the only depth
 * number a router may trust: min(virtual balance, wallet balance, Aqua allowance).
 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const n = networkFrom(url.searchParams.get("chain"));
    const token = addressParam(url.searchParams.get("token"), n.weth);
    const fromBlock = url.searchParams.get("fromBlock");
    const from = fromBlock ? amountParam(fromBlock, 0n) : undefined;

    // The index for history, a short chain scan for the tail it has not reached.
    const fromGraph = await strategiesFromGraph(n, n.router);
    const scan = fromGraph
      ? null
      : from !== undefined
        ? { strategies: await indexStrategies(n, { fromBlock: from }), window: null }
        : await cachedStrategies(n);
    const rawStrategies = fromGraph ?? scan!.strategies;
    const strategies = rawStrategies.filter((s) => {
      if (!s.tokens || s.tokens.length === 0) return true;
      return s.tokens.map((t) => t.toLowerCase()).includes(token.toLowerCase());
    });

    const depths = await measureDepth(n, strategies, token);
    const TOKENS = { ...tokensOf(n), ...allTokensFor(n.id) };
    const meta = TOKENS[token.toLowerCase()];
    const index = indexStateOf(n);

    return j({
      // Say which index actually answered, not which one is configured.
      source: fromGraph
        ? "aquifer-subgraph"
        : n.graphUrl
          ? `rpc-log-paging (index ${index.status})`
          : "rpc-log-paging",
      chain: { id: n.id, label: n.label, testnet: n.testnet, aquaIsOurs: n.aquaIsOurs },
      index: n.graphUrl
        ? { state: index.status, head: index.head, behind: index.behind, ready: !!fromGraph }
        : null,
      window: scan?.window ?? null,
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
    if ((e as Error).message?.startsWith("unknown chain")) return fail((e as Error).message, 400);
    const unreachable = chainFailure(e);
    if (unreachable) return unreachable;
    return fail((e as Error).message, 500);
  }
}
