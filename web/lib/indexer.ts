import type { Network } from "./networks";
import { sql, ensureSchema } from "./db";

/**
 * The background job that makes /api/route etc. fast without capping
 * coverage -- now sourced from 1inch's own Aqua API instead of scanning
 * Shipped/Docked events and multicalling rawBalances/balanceOf/allowance
 * ourselves.
 *
 * GET /v1.0/strategies/opened (business.1inch.com/portal/documentation/
 * aqua/api) returns exactly what this job used to compute by hand: every
 * currently-open strategy for an app, cursor-paginated, WITH per-token
 * balance.strategy (what we called `virtual`), balance.wallet, and
 * allowance already attached -- no RPC calls needed for any of it. It also
 * returns the real `tokens[]` a strategy holds, removing the old
 * curated-token-list guess entirely (aqua.ts's CANDIDATE_CAP/tokensForChain
 * limitation does not exist here).
 *
 * Found live, switching to this: Ethereum's real open-strategy count for
 * our router is 3,275 -- the RPC-based Shipped/Docked scan this replaced
 * only ever found 472 "live" ones, even after being fixed to scan full
 * history. The API's own definition of "open" is authoritative; ours,
 * built from raw events, was undercounting by ~7x, not just slower.
 *
 * All writes are still batched (see BATCH below) -- that lesson from the
 * RPC-based version carries over unchanged: thousands of individual
 * round trips to Postgres cost minutes, no matter how cheap each looks
 * alone.
 */
export type RefreshStats = {
  chain: number;
  itemsFetched: number;
  pages: number;
  newlyDocked: number;
  liveStrategiesTotal: number;
  depthRowsWritten: number;
  solventRows: number;
  tookMs: number;
};

const BATCH = 500;
const AQUA_API_BASE = "https://api.1inch.dev/aqua";
const MAX_PAGES = 50; // 50 x 500 = 25,000 items -- a sane ceiling against a misbehaving API, not a real limit seen in practice

type AquaApiToken = {
  address: string;
  balance: { strategy: string; wallet: string };
  allowance: string;
};
type AquaApiItem = {
  chainId: number;
  maker: string;
  app: string;
  strategyHash: string;
  strategyBytes: string;
  openedAt: number;
  tokens: AquaApiToken[];
};
type AquaApiResponse = { items: AquaApiItem[]; total: number; nextCursor: string | null };

async function fetchOpenStrategies(n: Network, apiKey: string): Promise<{ items: AquaApiItem[]; pages: number }> {
  const items: AquaApiItem[] = [];
  let cursor: string | undefined;
  let pages = 0;

  do {
    const url = new URL(`${AQUA_API_BASE}/v1.0/strategies/opened`);
    url.searchParams.set("chainIds", String(n.id));
    url.searchParams.set("app", n.router);
    url.searchParams.set("limit", "500");
    if (cursor) url.searchParams.set("cursor", cursor);

    const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Aqua API ${res.status}: ${body.slice(0, 300)}`);
    }
    const json = (await res.json()) as AquaApiResponse;
    items.push(...json.items);
    cursor = json.nextCursor ?? undefined;
    pages++;
  } while (cursor && pages < MAX_PAGES);

  return { items, pages };
}

async function chunks<T>(items: T[], size: number): Promise<T[][]> {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export async function refreshIndex(n: Network): Promise<RefreshStats> {
  const t0 = Date.now();
  const db = sql();
  if (!db) throw new Error("DATABASE_URL is not set -- nothing to refresh into");
  const apiKey = process.env.AQUA_API_KEY;
  if (!apiKey) throw new Error("AQUA_API_KEY is not set -- required for the Aqua API discovery/depth source");
  await ensureSchema();

  const { items, pages } = await fetchOpenStrategies(n, apiKey);

  // Strategies: every item the API just called "open," upserted as live.
  // openedAt is a unix timestamp, not a block number -- stored in the same
  // column regardless, since every consumer only ever uses it for relative
  // recency, never as a literal chain height.
  const shipRows = items.map((it) => ({
    chain_id: n.id,
    maker: it.maker.toLowerCase(),
    strategy_hash: it.strategyHash,
    strategy_bytes: it.strategyBytes,
    block_number: String(it.openedAt),
    docked: false,
  }));

  for (const chunk of await chunks(shipRows, BATCH)) {
    await db`
      INSERT INTO aqua_strategies ${db(chunk, "chain_id", "maker", "strategy_hash", "strategy_bytes", "block_number", "docked")}
      ON CONFLICT (chain_id, maker, strategy_hash) DO UPDATE SET
        strategy_bytes = EXCLUDED.strategy_bytes,
        block_number = EXCLUDED.block_number,
        docked = FALSE
    `;
  }

  // The API only ever returns what is currently open -- anything this app
  // previously marked live that is NOT in this fetch has been docked (or
  // otherwise closed) since the last run. This replaces the old Docked-event
  // scan entirely: "missing from the open set" IS the dock signal now,
  // and it is authoritative rather than inferred from raw logs this app
  // might have scanned an incomplete window of.
  const liveKeys = new Set(items.map((it) => `${it.maker.toLowerCase()}:${it.strategyHash}`));
  const previouslyLive = await db<{ maker: string; strategy_hash: string }[]>`
    SELECT maker, strategy_hash FROM aqua_strategies WHERE chain_id = ${n.id} AND NOT docked
  `;
  const nowMissing = previouslyLive.filter((s) => !liveKeys.has(`${s.maker}:${s.strategy_hash}`));

  let newlyDocked = 0;
  for (const chunk of await chunks(nowMissing, BATCH)) {
    const makers = chunk.map((d) => d.maker);
    const hashes = chunk.map((d) => d.strategy_hash);
    const res = await db`
      UPDATE aqua_strategies AS s SET docked = TRUE
      FROM (SELECT unnest(${db.array(makers)}::text[]) AS maker, unnest(${db.array(hashes)}::text[]) AS strategy_hash) AS v
      WHERE s.chain_id = ${n.id} AND s.maker = v.maker AND s.strategy_hash = v.strategy_hash AND NOT s.docked
    `;
    newlyDocked += res.count;
  }

  // Depth: no RPC calls at all -- every token a strategy holds, and its
  // balance/wallet/allowance, came back in the same API response above.
  const depthRows: {
    chain_id: number;
    maker: string;
    strategy_hash: string;
    token: string;
    virtual_amount: string;
    wallet_balance: string;
    allowance: string;
    depth: string;
    solvent: boolean;
  }[] = [];
  let solventRows = 0;

  for (const it of items) {
    for (const t of it.tokens) {
      const virtual = BigInt(t.balance.strategy);
      const wallet = BigInt(t.balance.wallet);
      const allowance = BigInt(t.allowance);
      const depth = [virtual, wallet, allowance].reduce((a, b) => (b < a ? b : a));
      const solvent = depth > 0n;
      if (solvent) solventRows++;
      depthRows.push({
        chain_id: n.id,
        maker: it.maker.toLowerCase(),
        strategy_hash: it.strategyHash,
        token: t.address.toLowerCase(),
        virtual_amount: virtual.toString(),
        wallet_balance: wallet.toString(),
        allowance: allowance.toString(),
        depth: depth.toString(),
        solvent,
      });
    }
  }

  for (const chunk of await chunks(depthRows, BATCH)) {
    await db`
      INSERT INTO aqua_depth ${db(chunk, "chain_id", "maker", "strategy_hash", "token", "virtual_amount", "wallet_balance", "allowance", "depth", "solvent")}
      ON CONFLICT (chain_id, maker, strategy_hash, token) DO UPDATE SET
        virtual_amount = EXCLUDED.virtual_amount,
        wallet_balance = EXCLUDED.wallet_balance,
        allowance = EXCLUDED.allowance,
        depth = EXCLUDED.depth,
        solvent = EXCLUDED.solvent,
        updated_at = now()
    `;
  }

  // last_scanned_block no longer describes an RPC block range -- there is
  // no RPC scan in this version. Repurposed to hold this run's item count,
  // informational only; last_refreshed_at (used by depthFromIndex/
  // positionsFromIndex to decide "has this chain ever been indexed") is the
  // column every reader actually depends on.
  await db`
    INSERT INTO aqua_scan_state (chain_id, last_scanned_block, last_refreshed_at)
    VALUES (${n.id}, ${String(items.length)}, now())
    ON CONFLICT (chain_id) DO UPDATE SET last_scanned_block = ${String(items.length)}, last_refreshed_at = now()
  `;

  return {
    chain: n.id,
    itemsFetched: items.length,
    pages,
    newlyDocked,
    liveStrategiesTotal: liveKeys.size,
    depthRowsWritten: depthRows.length,
    solventRows,
    tookMs: Date.now() - t0,
  };
}
