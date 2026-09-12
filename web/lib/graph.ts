import type { Address, Hex } from "viem";
import type { Strategy } from "./aqua";
import { clientFor, type Network } from "./networks";

async function headBlock(n: Network): Promise<bigint | null> {
  try {
    return await clientFor(n).getBlockNumber();
  } catch {
    return null;
  }
}

/** Per-network index state. Mutable module state was fine with one chain and is
 *  a lie with two, so it is keyed rather than shared. */
export type IndexState = "ready" | "syncing" | "unreachable" | "errored" | "off";
const state = new Map<number, { head: bigint; behind: bigint; status: IndexState }>();

export function indexStateOf(n: Network) {
  return state.get(n.id) ?? { head: 0n, behind: 0n, status: "off" as IndexState };
}


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
      tokens
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

async function gql<T>(n: Network, query: string, variables: Record<string, unknown>): Promise<T | null> {
  if (!n.graphUrl) return null;
  try {
    const r = await fetch(n.graphUrl, {
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
export async function indexFresh(n: Network): Promise<boolean> {
  if (!n.graphUrl) {
    state.set(n.id, { head: 0n, behind: 0n, status: "off" });
    return false;
  }

  const meta = await gql<{ _meta: { block: { number: number }; hasIndexingErrors: boolean } | null }>(
    n,
    META_QUERY,
    {}
  );
  if (!meta?._meta) {
    state.set(n.id, { head: 0n, behind: 0n, status: "unreachable" });
    return false;
  }
  if (meta._meta.hasIndexingErrors) {
    state.set(n.id, { head: 0n, behind: 0n, status: "errored" });
    return false;
  }
  const head = BigInt(meta._meta.block.number);

  const chainHead = await headBlock(n);
  if (chainHead !== null && chainHead - head > MAX_LAG_BLOCKS) {
    state.set(n.id, { head, behind: chainHead - head, status: "syncing" });
    return false;
  }
  state.set(n.id, { head, behind: 0n, status: "ready" });
  return true;
}

export async function strategiesFromGraph(n: Network, app: Address): Promise<Strategy[] | null> {
  if (!(await indexFresh(n))) return null;

  const data = await gql<{
    strategies: {
      strategyHash: Hex;
      strategy: Hex;
      shippedAt: string;
      tokens?: Hex[];
      maker: { id: Address };
    }[];
  }>(n, STRATEGIES_QUERY, { app: app.toLowerCase(), first: 500 });

  if (!data) return null;
  return data.strategies.map((s) => ({
    maker: s.maker.id,
    strategyHash: s.strategyHash,
    strategy: s.strategy,
    blockNumber: 0n,
    tokens: (s.tokens ?? []).map((t) => t.toLowerCase() as Address),
  }));
}

/**
 * How much of a token this maker has promised across their whole book. Aqua
 * cannot answer this — the mapping is not enumerable — so it only exists here.
 * Compare against the wallet balance and you have the coverage ratio.
 */
export async function committedFromGraph(n: Network, maker: Address, token: Address): Promise<bigint | null> {
  const data = await gql<{ makerTokenPosition: { totalCommitted: string } | null }>(n, POSITION_QUERY, {
    id: `${maker.toLowerCase()}-${token.toLowerCase()}`,
  });
  if (!data) return null;
  return data.makerTokenPosition ? BigInt(data.makerTokenPosition.totalCommitted) : 0n;
}

const COVERAGE_QUERY = `
  query Coverage($first: Int!) {
    makerTokenPositions(
      where: { totalCommitted_gt: 0 }
      first: $first
      orderBy: totalCommitted
      orderDirection: desc
    ) {
      id
      token
      totalCommitted
      activeStrategies
      maker {
        id
        strategies(where: { active: true }, first: 100) {
          strategyHash
          app
          tokens
        }
      }
    }
  }
`;

export type Position = {
  maker: Address;
  token: Address;
  totalCommitted: bigint;
  activeStrategies: number;
  /** The hashes behind that total. Lens.coverage() needs them and cannot find
   *  them: the mapping is not enumerable, so the index is the only source. */
  strategyHashes: Hex[];
  app: Address | null;
};

/**
 * Every maker's total commitment per token, across their whole book.
 *
 * This is the query that justifies the subgraph. Aqua keys balances by
 * [maker][app][strategyHash][token] and the mapping is not enumerable — 1inch
 * say so themselves — so no contract, and no amount of eth_call, can add up what
 * one maker has promised across all of their strategies. Only an index over
 * Shipped/Pushed/Pulled/Docked can. Put it next to the wallet balance and you
 * have a coverage ratio: on Base today one maker has eight live strategies
 * committing 12,694 DEGEN against a wallet holding none of it.
 */
export async function positionsFromGraph(n: Network, first = 50): Promise<Position[] | null> {
  // Coverage over a half-synced index reads as a shortfall that is really just
  // a Pushed event the index has not reached yet. Refuse rather than mislead.
  if (!(await indexFresh(n))) return null;

  const data = await gql<{
    makerTokenPositions: {
      token: Hex;
      totalCommitted: string;
      activeStrategies: string;
      maker: { id: Address; strategies: { strategyHash: Hex; app: Address; tokens: Hex[] }[] };
    }[];
  }>(n, COVERAGE_QUERY, { first });
  if (!data) return null;
  return data.makerTokenPositions.map((p) => {
    const forToken = (p.maker.strategies ?? []).filter((s) =>
      s.tokens.map((t) => t.toLowerCase()).includes(p.token.toLowerCase())
    );
    return {
      maker: p.maker.id,
      token: p.token as Address,
      totalCommitted: BigInt(p.totalCommitted),
      activeStrategies: Number(p.activeStrategies),
      strategyHashes: forToken.map((s) => s.strategyHash),
      app: forToken.length > 0 ? forToken[0].app : null,
    };
  });
}

const MAKER_POSITIONS_QUERY = `
  query MakerPositions($id: ID!) {
    maker(id: $id) {
      positions(where: { totalCommitted_gt: 0 }, first: 200) {
        token
        totalCommitted
        activeStrategies
      }
      strategies(where: { active: true }, first: 200) {
        strategyHash
        app
        tokens
      }
    }
  }
`;

/**
 * One maker's positions, looked up directly rather than filtered out of the
 * top N globally.
 *
 * positionsFromGraph orders by size and takes the biggest `first` positions
 * across every maker — right for "how bad is it overall", wrong for "check
 * this one address": a maker with a handful of small strategies can rank
 * outside that page and read as having no positions at all, which is the one
 * wrong answer a solvency checker cannot give. Querying the Maker entity by
 * id sidesteps the ranking entirely.
 */
export type MakerStrategy = { strategyHash: Hex; app: Address; tokens: Address[] };

/**
 * One round trip, two views of the same maker.
 *
 * The subgraph's `maker.strategies` already carries each active strategy's own
 * decoded token list (`tokens` — the exact two addresses it was shipped with,
 * per Aqua's `ship()` argument, same fact `liquidPairsFromGraph` relies on
 * elsewhere) in the very query `positionsForMaker` was throwing away after
 * using it only to fill in `strategyHashes`/`app` on the per-token view. A
 * second GQL round trip to ask for what the first response already contained
 * would be the wrong fix; this keeps the raw list and lets callers who want
 * per-strategy detail — not just per-token totals — use it directly.
 */
export async function makerBook(
  n: Network,
  maker: Address
): Promise<{ positions: Position[]; strategies: MakerStrategy[] } | null> {
  if (!(await indexFresh(n))) return null;

  const data = await gql<{
    maker: {
      positions: { token: Hex; totalCommitted: string; activeStrategies: string }[];
      strategies: { strategyHash: Hex; app: Address; tokens: Hex[] }[];
    } | null;
  }>(n, MAKER_POSITIONS_QUERY, { id: maker.toLowerCase() });
  if (!data) return null;
  if (!data.maker) return { positions: [], strategies: [] };

  const rawStrategies = data.maker.strategies ?? [];
  const strategies: MakerStrategy[] = rawStrategies.map((s) => ({
    strategyHash: s.strategyHash,
    app: s.app,
    tokens: s.tokens.map((t) => t.toLowerCase() as Address),
  }));

  const positions = data.maker.positions.map((p) => {
    const forToken = rawStrategies.filter((s) =>
      s.tokens.map((t) => t.toLowerCase()).includes(p.token.toLowerCase())
    );
    return {
      maker,
      token: p.token as Address,
      totalCommitted: BigInt(p.totalCommitted),
      activeStrategies: Number(p.activeStrategies),
      strategyHashes: forToken.map((s) => s.strategyHash),
      app: forToken.length > 0 ? forToken[0].app : null,
    };
  });

  return { positions, strategies };
}

/** Kept for the callers that only ever wanted the per-token view. */
export async function positionsForMaker(n: Network, maker: Address): Promise<Position[] | null> {
  const book = await makerBook(n, maker);
  return book ? book.positions : null;
}

const APPS_QUERY = `
  query Apps($first: Int!) {
    strategies(where: { active: true }, first: $first) {
      app
      maker { id }
    }
  }
`;

export type AppBreakdown = {
  app: Address;
  /** Whether this is the app Bone Dry's own router points at -- the rest
   *  are other Aqua consumers this subgraph happens to also index, since it
   *  listens to Aqua's own events rather than filtering to one app. */
  isOurs: boolean;
  activeStrategies: number;
  distinctMakers: number;
};

/**
 * Every app currently shipping live strategies on Aqua, per the same index
 * that already answers Bone Dry's own coverage questions. This is not a
 * new capability -- it is the existing schema, queried without the `app`
 * filter every other query in this file applies. Proof that the schema
 * generalizes, not a new feature.
 */
export async function appBreakdown(n: Network, ourApp: Address, first = 1000): Promise<AppBreakdown[] | null> {
  if (!(await indexFresh(n))) return null;
  const data = await gql<{ strategies: { app: Address; maker: { id: Address } }[] }>(
    n, APPS_QUERY, { first }
  );
  if (!data) return null;

  const byApp = new Map<string, { makers: Set<string>; count: number }>();
  for (const s of data.strategies) {
    const key = s.app.toLowerCase();
    const entry = byApp.get(key) ?? { makers: new Set<string>(), count: 0 };
    entry.count += 1;
    entry.makers.add(s.maker.id.toLowerCase());
    byApp.set(key, entry);
  }

  return [...byApp.entries()]
    .map(([app, v]) => ({
      app: app as Address,
      isOurs: app === ourApp.toLowerCase(),
      activeStrategies: v.count,
      distinctMakers: v.makers.size,
    }))
    .sort((a, b) => b.activeStrategies - a.activeStrategies);
}

const LIQUID_PAIRS_QUERY = `
  query LiquidPairs($app: Bytes!, $first: Int!) {
    strategies(where: { active: true, app: $app }, first: $first) {
      tokens
      maker { id }
    }
  }
`;

export type LiquidPair = {
  tokenA: Address;
  tokenB: Address;
  distinctMakers: number;
  activeStrategies: number;
};

export type LiquidToken = {
  token: Address;
  distinctMakers: number;
  activeStrategies: number;
};

/**
 * Which token pairs on this router's own app actually have a maker willing
 * to fill them, right now -- not the hardcoded 3-pair list in lib/pairs.ts,
 * which was hand-picked once and never checked against real depth. A
 * strategy's `tokens` is the exact two-address list it was shipped with
 * (ship()'s own `tokens` argument), so grouping active strategies by that
 * pair gives the real answer instead of a guess. Every strategy currently
 * indexed on Base fits in one page; this does not paginate.
 */
export async function liquidPairsFromGraph(
  n: Network,
  app: Address,
  first = 1000
): Promise<{ pairs: LiquidPair[]; tokens: LiquidToken[] } | null> {
  if (!(await indexFresh(n))) return null;
  const data = await gql<{ strategies: { tokens: Address[]; maker: { id: Address } }[] }>(
    n,
    LIQUID_PAIRS_QUERY,
    { app: app.toLowerCase(), first }
  );
  if (!data) return null;

  const byPair = new Map<string, { tokenA: string; tokenB: string; makers: Set<string>; count: number }>();
  const byToken = new Map<string, { makers: Set<string>; count: number }>();

  for (const s of data.strategies) {
    // A strategy carries exactly the tokens it was shipped with, per Aqua's
    // own ship() signature -- two addresses, not necessarily in a stable
    // order, so the pair key is sorted to merge A/B and B/A into one entry.
    if (s.tokens.length !== 2) continue;
    const [a, b] = [s.tokens[0].toLowerCase(), s.tokens[1].toLowerCase()].sort();
    const maker = s.maker.id.toLowerCase();

    const pairKey = `${a}:${b}`;
    const pairEntry = byPair.get(pairKey) ?? { tokenA: a, tokenB: b, makers: new Set<string>(), count: 0 };
    pairEntry.count += 1;
    pairEntry.makers.add(maker);
    byPair.set(pairKey, pairEntry);

    for (const tok of [a, b]) {
      const tokEntry = byToken.get(tok) ?? { makers: new Set<string>(), count: 0 };
      tokEntry.count += 1;
      tokEntry.makers.add(maker);
      byToken.set(tok, tokEntry);
    }
  }

  const pairs = [...byPair.values()]
    .map((v) => ({
      tokenA: v.tokenA as Address,
      tokenB: v.tokenB as Address,
      distinctMakers: v.makers.size,
      activeStrategies: v.count,
    }))
    .sort((a, b) => b.distinctMakers - a.distinctMakers || b.activeStrategies - a.activeStrategies);

  const tokens = [...byToken.entries()]
    .map(([token, v]) => ({
      token: token as Address,
      distinctMakers: v.makers.size,
      activeStrategies: v.count,
    }))
    .sort((a, b) => b.distinctMakers - a.distinctMakers || b.activeStrategies - a.activeStrategies);

  return { pairs, tokens };
}

const MAKER_HISTORY_QUERY = `
  query MakerHistory($maker: String!, $app: Bytes!, $first: Int!) {
    strategies(
      where: { maker: $maker, app: $app }
      first: $first
      orderBy: shippedAt
      orderDirection: desc
    ) {
      strategyHash
      tokens
      shippedAt
      dockedAt
      active
    }
  }
`;

export type StrategyHistoryEntry = {
  strategyHash: Hex;
  tokens: Address[];
  shippedAt: number;
  dockedAt: number | null;
  active: boolean;
};

/**
 * Every strategy a maker has ever shipped on this app, active or docked, real
 * timestamps and real decoded tokens -- the subgraph already indexed both at
 * ship time, which a plain RPC scan cannot do without re-decoding SwapVM's
 * own opcode-specific program bytes. Prefer this over history.ts's RPC
 * fallback whenever a network has an index; it is strictly more complete
 * (full history, not a bounded recent window) and does not cost the
 * per-maker RPC scan history.ts otherwise needs.
 */
export async function strategyHistoryFromGraph(
  n: Network,
  maker: Address,
  app: Address,
  first = 100
): Promise<StrategyHistoryEntry[] | null> {
  if (!(await indexFresh(n))) return null;
  const data = await gql<{
    strategies: {
      strategyHash: Hex;
      tokens: Hex[];
      shippedAt: string;
      dockedAt: string | null;
      active: boolean;
    }[];
  }>(n, MAKER_HISTORY_QUERY, { maker: maker.toLowerCase(), app: app.toLowerCase(), first });
  if (!data) return null;

  return data.strategies.map((s) => ({
    strategyHash: s.strategyHash,
    tokens: (s.tokens ?? []).map((t) => t as Address),
    shippedAt: Number(s.shippedAt),
    dockedAt: s.dockedAt !== null ? Number(s.dockedAt) : null,
    active: s.active,
  }));
}

