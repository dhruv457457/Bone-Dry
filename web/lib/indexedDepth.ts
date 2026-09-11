import type { Address, Hex } from "viem";
import { sql } from "./db";
import type { Network } from "./networks";
import type { MakerDepth } from "./aqua";

/**
 * The read side of the background index (see indexer.ts). Returns null when
 * this chain has never been indexed -- DATABASE_URL unset, or the job has
 * not run yet -- so callers fall back to the live RPC path (aqua.ts's
 * cachedStrategies + measureDepth) rather than reporting empty depth as
 * though it were a real answer.
 *
 * Deliberately does NOT fall back on a stale index -- an index that is
 * merely old still answers with real data, just data a background job will
 * refresh within its own schedule. Only "never populated" degrades.
 */
export async function depthFromIndex(n: Network, token: Address): Promise<MakerDepth[] | null> {
  const db = sql();
  if (!db) return null;

  const state = await db<{ last_refreshed_at: string }[]>`
    SELECT last_refreshed_at FROM aqua_scan_state WHERE chain_id = ${n.id}
  `;
  if (state.length === 0) return null;

  const rows = await db<
    {
      maker: string;
      strategy_hash: string;
      strategy_bytes: string;
      block_number: string;
      virtual_amount: string;
      wallet_balance: string;
      allowance: string;
      depth: string;
      solvent: boolean;
    }[]
  >`
    SELECT d.maker, d.strategy_hash, d.virtual_amount, d.wallet_balance, d.allowance, d.depth, d.solvent,
           s.strategy_bytes, s.block_number
    FROM aqua_depth d
    JOIN aqua_strategies s
      ON s.chain_id = d.chain_id AND s.maker = d.maker AND s.strategy_hash = d.strategy_hash
    WHERE d.chain_id = ${n.id} AND d.token = ${token.toLowerCase()} AND NOT s.docked
  `;

  return rows.map((r) => ({
    maker: r.maker as Address,
    strategyHash: r.strategy_hash as Hex,
    strategy: r.strategy_bytes as Hex,
    blockNumber: BigInt(r.block_number),
    virtual: BigInt(r.virtual_amount),
    wallet: BigInt(r.wallet_balance),
    allowance: BigInt(r.allowance),
    depth: BigInt(r.depth),
    solvent: r.solvent,
  }));
}

/** For a status line -- when the index last actually ran for this chain. */
export async function indexFreshness(n: Network): Promise<{ lastRefreshedAt: string; liveStrategies: number } | null> {
  const db = sql();
  if (!db) return null;
  const rows = await db<{ last_refreshed_at: string }[]>`
    SELECT last_refreshed_at FROM aqua_scan_state WHERE chain_id = ${n.id}
  `;
  if (rows.length === 0) return null;
  const count = await db<{ count: string }[]>`
    SELECT COUNT(*)::text FROM aqua_strategies WHERE chain_id = ${n.id} AND NOT docked
  `;
  return { lastRefreshedAt: rows[0].last_refreshed_at, liveStrategies: Number(count[0].count) };
}
