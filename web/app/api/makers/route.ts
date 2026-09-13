import { cachedStrategies, indexStrategies, measureDepth, mergeStrategies, type MakerDepth } from "@/lib/aqua";
import { strategiesFromGraph, indexStateOf } from "@/lib/graph";
import { depthFromIndex } from "@/lib/indexedDepth";
import { networkFrom, tokensOf } from "@/lib/networks";
import { allTokensFor } from "@/lib/pairs";
import { byDepthDesc } from "@/lib/router";
import { addressParam, amountParam, BadInput } from "@/lib/validate";
import { j, fail, chainFailure } from "@/lib/json";

export const dynamic = "force-dynamic";

type MakersCacheEntry = {
  data: Record<string, unknown>;
  at: number;
};
const makersServerCache = new Map<string, MakersCacheEntry>();
const MAKERS_CACHE_TTL = 30_000; // 30s TTL

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

    const cacheKey = `${n.id}:${token.toLowerCase()}:${from ? from.toString() : "head"}`;
    const hit = makersServerCache.get(cacheKey);
    if (hit && Date.now() - hit.at < MAKERS_CACHE_TTL) {
      return j(hit.data);
    }

    // The background index (lib/indexer.ts) answers this exact question --
    // every live strategy's depth for one token -- precomputed on a
    // schedule. Skipped when the caller asked for a specific historical
    // fromBlock: the index only ever reflects current state, not a window
    // into the past, so that request has to go live regardless.
    const indexed = from === undefined ? await depthFromIndex(n, token) : null;

    let depths: MakerDepth[];
    let source: string;
    let indexState: { state: string; head: bigint; behind: bigint; ready: boolean } | null = null;
    let window: { fromBlock: bigint; toBlock: bigint } | null = null;
    let indexedCount: number;

    if (indexed !== null) {
      depths = indexed;
      source = "indexed-db";
      indexedCount = indexed.length;
    } else {
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

      depths = await measureDepth(n, strategies, token);
      const idx = indexStateOf(n);
      source = fromGraph ? "aquifer-subgraph" : n.graphUrl ? `rpc-log-paging (index ${idx.status})` : "rpc-log-paging";
      indexState = n.graphUrl ? { state: idx.status, head: idx.head, behind: idx.behind, ready: !!fromGraph } : null;
      window = scan?.window ?? null;
      indexedCount = strategies.length;
    }

    const TOKENS = { ...tokensOf(n), ...allTokensFor(n.id) };
    const meta = TOKENS[token.toLowerCase()];

    const payload = {
      // Say which index actually answered, not which one is configured.
      source,
      chain: { id: n.id, label: n.label, testnet: n.testnet, aquaIsOurs: n.aquaIsOurs },
      index: indexState,
      window,
      token: { address: token, symbol: meta?.symbol ?? "?", decimals: meta?.decimals ?? 18 },
      indexed: indexedCount,
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
    };

    if (makersServerCache.size > 100) {
      makersServerCache.clear();
    }
    makersServerCache.set(cacheKey, { data: payload, at: Date.now() });

    return j(payload);
  } catch (e) {
    if (e instanceof BadInput) return fail(e.message, 400);
    if ((e as Error).message?.startsWith("unknown chain")) return fail((e as Error).message, 400);
    const unreachable = chainFailure(e);
    if (unreachable) return unreachable;
    return fail((e as Error).message, 500);
  }
}
