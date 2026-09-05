import type { Address, Hex } from "viem";
import type { Strategy } from "./aqua";
import { client } from "./chain";

async function headBlock(): Promise<bigint | null> {
  try {
    return await client.getBlockNumber();
  } catch {
    return null;
  }
}

export const GRAPH_URL = process.env.GRAPH_URL ?? "";

/** Last observed index head, and how far behind the chain it was. Surfaced so
 *  the UI can say "still syncing" rather than "no makers". */
export let graphHead = 0n;
export let graphBehind = 0n;

/**
 * Aquifer — the indexed source.
 *
 * Paging eth_getLogs works, but it is capped at 10k blocks on public RPCs and
 * gets slower every day Aqua is alive. The subgraph is the real answer, and it
 * also gives us the one number no contract can compute: a maker's committed
 * total for a token across every strategy they have live.
 */
const STRATEGIES_QUERY = `
  query Live($app: Bytes!, $first: Int!) {
    strategies(where: { active: true, app: $app }, first: $first, orderBy: shippedAt, orderDirection: desc) {
      strategyHash
      strategy
      shippedAt
      maker { id }
    }
  }
`;

const META_QUERY = `
  query Meta {
    _meta { block { number } hasIndexingErrors }
  }
`;

const POSITION_QUERY = `
  query Position($id: ID!) {
    makerTokenPosition(id: $id) {
      totalCommitted
      activeStrategies
    }
  }
`;

async function gql<T>(query: string, variables: Record<string, unknown>): Promise<T | null> {
  if (!GRAPH_URL) return null;
  try {
    const r = await fetch(GRAPH_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, variables }),
      cache: "no-store",
    });
    if (!r.ok) return null;
    const j = (await r.json()) as { data?: T; errors?: unknown };
    return j.data ?? null;
  } catch {
    return null;
  }
}

/** How far behind head the index may be and still be trusted. Base makes a block
 *  every 2s, so this is about ten minutes of lag. */
const MAX_LAG_BLOCKS = 300n;

/**
 * Live strategies from the index, or null to say "ask the chain instead".
 *
 * Null matters more than it looks. A subgraph that is still syncing answers
 * every query truthfully and uselessly: zero strategies, no error. Returning
 * that empty array would short-circuit the RPC fallback — `[] ?? rpc` is `[]` —
 * and the book would read empty for the hours it takes to catch up, with nothing
 * anywhere saying why. So the freshness of the index is checked before its
 * contents are used.
 */
export async function strategiesFromGraph(app: Address): Promise<Strategy[] | null> {
  if (!GRAPH_URL) return null;

  const meta = await gql<{ _meta: { block: { number: number }; hasIndexingErrors: boolean } | null }>(
    META_QUERY,
    {}
  );
  if (!meta?._meta || meta._meta.hasIndexingErrors) return null;
  graphHead = BigInt(meta._meta.block.number);

  const chainHead = await headBlock();
  if (chainHead !== null && chainHead - graphHead > MAX_LAG_BLOCKS) {
    graphBehind = chainHead - graphHead;
    return null;
  }
  graphBehind = 0n;

  const data = await gql<{
    strategies: { strategyHash: Hex; strategy: Hex; shippedAt: string; maker: { id: Address } }[];
  }>(STRATEGIES_QUERY, { app: app.toLowerCase(), first: 500 });

  if (!data) return null;
  return data.strategies.map((s) => ({
    maker: s.maker.id,
    strategyHash: s.strategyHash,
    strategy: s.strategy,
    blockNumber: 0n,
  }));
}

/**
 * How much of a token this maker has promised across their whole book. Aqua
 * cannot answer this — the mapping is not enumerable — so it only exists here.
 * Compare against the wallet balance and you have the coverage ratio.
 */
export async function committedFromGraph(maker: Address, token: Address): Promise<bigint | null> {
  const data = await gql<{ makerTokenPosition: { totalCommitted: string } | null }>(POSITION_QUERY, {
    id: `${maker.toLowerCase()}-${token.toLowerCase()}`,
  });
  if (!data) return null;
  return data.makerTokenPosition ? BigInt(data.makerTokenPosition.totalCommitted) : 0n;
}
