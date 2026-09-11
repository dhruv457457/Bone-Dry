import postgres from "postgres";

/**
 * The strategy/depth index, precomputed by a background job instead of a
 * live RPC scan on every request. See indexer.ts for why: checking all of
 * Ethereum's ~7,000 live strategies costs 30-45s in RPC calls, which is fine
 * for a job that runs every 15-30 minutes and unusable for a live quote.
 *
 * DATABASE_URL unset is a valid state, not a misconfiguration -- this index
 * is additive. Every caller of `sql()` must handle it returning null and
 * fall back to the live RPC path, the same honest-degradation shape every
 * other index gap in this app already uses (see coverage/route.ts).
 */
let client: ReturnType<typeof postgres> | null | undefined;

export function sql(): ReturnType<typeof postgres> | null {
  if (client !== undefined) return client;
  const url = process.env.DATABASE_URL;
  if (!url) {
    client = null;
    return null;
  }
  client = postgres(url, {
    ssl: "require",
    max: 5,
    idle_timeout: 20,
    connect_timeout: 10,
  });
  return client;
}

let schemaReady: Promise<void> | null = null;

/** Idempotent -- safe to call at the top of every job run. */
export function ensureSchema(): Promise<void> {
  const db = sql();
  if (!db) return Promise.resolve();
  if (schemaReady) return schemaReady;
  schemaReady = (async () => {
    await db`
      CREATE TABLE IF NOT EXISTS aqua_strategies (
        chain_id INTEGER NOT NULL,
        maker TEXT NOT NULL,
        strategy_hash TEXT NOT NULL,
        strategy_bytes TEXT NOT NULL,
        block_number BIGINT NOT NULL,
        docked BOOLEAN NOT NULL DEFAULT FALSE,
        PRIMARY KEY (chain_id, maker, strategy_hash)
      )
    `;
    await db`
      CREATE INDEX IF NOT EXISTS aqua_strategies_live
        ON aqua_strategies (chain_id) WHERE NOT docked
    `;
    await db`
      CREATE TABLE IF NOT EXISTS aqua_depth (
        chain_id INTEGER NOT NULL,
        maker TEXT NOT NULL,
        strategy_hash TEXT NOT NULL,
        token TEXT NOT NULL,
        virtual_amount NUMERIC NOT NULL,
        wallet_balance NUMERIC NOT NULL,
        allowance NUMERIC NOT NULL,
        depth NUMERIC NOT NULL,
        solvent BOOLEAN NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (chain_id, maker, strategy_hash, token)
      )
    `;
    await db`
      CREATE INDEX IF NOT EXISTS aqua_depth_lookup
        ON aqua_depth (chain_id, token) WHERE solvent
    `;
    await db`
      CREATE TABLE IF NOT EXISTS aqua_scan_state (
        chain_id INTEGER PRIMARY KEY,
        last_scanned_block BIGINT NOT NULL,
        last_refreshed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        last_run_ms INTEGER
      )
    `;
  })();
  return schemaReady;
}
