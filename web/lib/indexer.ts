import type { Address, Hex } from "viem";
import { aquaAbi, erc20Abi } from "./chain";
import { clientFor, type Network } from "./networks";
import { tokensForChain } from "./tokenList";
import { sql, ensureSchema } from "./db";

/**
 * The background job that makes /api/route etc. fast on Ethereum without
 * capping coverage. Two costs, kept apart:
 *
 * - Log scan (who has strategies at all) is cheap once backfilled: only the
 *   blocks since the last run need scanning, tracked in aqua_scan_state.
 * - Depth refresh (does the maker's wallet actually back it) is NOT
 *   incremental -- a maker's balance can change with no on-chain event this
 *   app watches, so every live strategy is re-checked every run. That is
 *   the 30-45s part; it belongs in a job on a schedule, not in a request.
 *
 * Both write into Postgres. Every live-request code path treats an empty or
 * missing table as "not indexed yet," and falls back to the direct-RPC path
 * that already exists (aqua.ts's indexStrategies/measureDepth) -- this job
 * is additive, never a hard dependency.
 */
export type RefreshStats = {
  chain: number;
  scannedFromBlock: string;
  scannedToBlock: string;
  newStrategies: number;
  newlyDocked: number;
  liveStrategiesTotal: number;
  tokensChecked: number;
  depthRowsWritten: number;
  solventRows: number;
  tookMs: number;
};

export async function refreshIndex(n: Network): Promise<RefreshStats> {
  const t0 = Date.now();
  const db = sql();
  if (!db) throw new Error("DATABASE_URL is not set -- nothing to refresh into");
  await ensureSchema();

  const client = clientFor(n);
  const latest = await client.getBlockNumber();

  const state = await db<{ last_scanned_block: string }[]>`
    SELECT last_scanned_block FROM aqua_scan_state WHERE chain_id = ${n.id}
  `;
  // First run ever for this chain: start from Aqua's own genesis, same floor
  // the live RPC path already uses -- there is no earlier activity to miss.
  const fromBlock = state.length > 0 ? BigInt(state[0].last_scanned_block) + 1n : n.aquaGenesis;

  let newStrategies = 0;
  let newlyDocked = 0;

  if (fromBlock <= latest) {
    // Page the scan the same way the live fallback does -- a first backfill
    // on Ethereum can be ~109k blocks (see aqua.ts), too wide for one
    // eth_getLogs call under any provider's range cap.
    const PAGE = n.id === 8453 ? 1_500n : 9_000n;
    let start = fromBlock;
    while (start <= latest) {
      const end = start + PAGE - 1n > latest ? latest : start + PAGE - 1n;

      const [ship, dock] = await Promise.all([
        client.getLogs({ address: n.aqua, event: aquaAbi[0], fromBlock: start, toBlock: end }),
        client.getLogs({ address: n.aqua, event: aquaAbi[1], fromBlock: start, toBlock: end }),
      ]);

      const rows = ship
        .map((l) => l.args as { maker: Address; app: Address; strategyHash: Hex; strategy: Hex })
        .filter((a) => a.app.toLowerCase() === n.router.toLowerCase())
        .map((a, i) => ({
          maker: a.maker,
          strategyHash: a.strategyHash,
          strategyBytes: a.strategy,
          blockNumber: ship[i].blockNumber!.toString(),
        }));

      if (rows.length > 0) {
        for (const r of rows) {
          await db`
            INSERT INTO aqua_strategies (chain_id, maker, strategy_hash, strategy_bytes, block_number, docked)
            VALUES (${n.id}, ${r.maker.toLowerCase()}, ${r.strategyHash}, ${r.strategyBytes}, ${r.blockNumber}, FALSE)
            ON CONFLICT (chain_id, maker, strategy_hash) DO NOTHING
          `;
        }
        newStrategies += rows.length;
      }

      for (const l of dock) {
        const a = l.args as { maker: Address; strategyHash: Hex };
        const res = await db`
          UPDATE aqua_strategies SET docked = TRUE
          WHERE chain_id = ${n.id} AND maker = ${a.maker.toLowerCase()} AND strategy_hash = ${a.strategyHash} AND NOT docked
        `;
        newlyDocked += res.count;
      }

      start = end + 1n;
    }

    await db`
      INSERT INTO aqua_scan_state (chain_id, last_scanned_block, last_refreshed_at)
      VALUES (${n.id}, ${latest.toString()}, now())
      ON CONFLICT (chain_id) DO UPDATE SET last_scanned_block = ${latest.toString()}, last_refreshed_at = now()
    `;
  }

  // Depth refresh: every strategy still live, times every curated token for
  // this chain. rawBalances is keyed per token and not enumerable, so there
  // is no cheaper way to know which strategies back which tokens than to
  // ask -- this IS the expensive part this job exists to move off the
  // request path.
  const live = await db<{ maker: string; strategy_hash: string }[]>`
    SELECT maker, strategy_hash FROM aqua_strategies WHERE chain_id = ${n.id} AND NOT docked
  `;
  const tokens = tokensForChain(n.id).map((t) => t.address);

  let depthRowsWritten = 0;
  let solventRows = 0;

  if (live.length > 0 && tokens.length > 0) {
    for (const token of tokens) {
      const calls = live.flatMap((s) => [
        { address: n.aqua, abi: aquaAbi, functionName: "rawBalances", args: [s.maker as Address, n.router, s.strategy_hash as Hex, token] } as const,
        { address: token, abi: erc20Abi, functionName: "balanceOf", args: [s.maker as Address] } as const,
        { address: token, abi: erc20Abi, functionName: "allowance", args: [s.maker as Address, n.aqua] } as const,
      ]);
      const res = await client.multicall({ contracts: calls, allowFailure: true });

      for (let i = 0; i < live.length; i++) {
        const raw = res[i * 3];
        const bal = res[i * 3 + 1];
        const allw = res[i * 3 + 2];

        let virtual = 0n;
        if (raw.status === "success") {
          const [amount, tokensCount] = raw.result as unknown as [bigint, number];
          virtual = tokensCount === 0 || tokensCount === 0xff ? 0n : amount;
        }
        const wallet = bal.status === "success" ? (bal.result as bigint) : 0n;
        const allowance = allw.status === "success" ? (allw.result as bigint) : 0n;
        const depth = [virtual, wallet, allowance].reduce((a, b) => (b < a ? b : a));
        const solvent = depth > 0n;

        // Skip writing rows that have never touched this token at all --
        // otherwise this table grows by (live strategies x every curated
        // token) even for tokens a strategy will never hold, forever.
        if (virtual === 0n && wallet === 0n && allowance === 0n) continue;

        await db`
          INSERT INTO aqua_depth (chain_id, maker, strategy_hash, token, virtual_amount, wallet_balance, allowance, depth, solvent, updated_at)
          VALUES (${n.id}, ${live[i].maker}, ${live[i].strategy_hash}, ${token.toLowerCase()}, ${virtual.toString()}, ${wallet.toString()}, ${allowance.toString()}, ${depth.toString()}, ${solvent}, now())
          ON CONFLICT (chain_id, maker, strategy_hash, token) DO UPDATE SET
            virtual_amount = EXCLUDED.virtual_amount,
            wallet_balance = EXCLUDED.wallet_balance,
            allowance = EXCLUDED.allowance,
            depth = EXCLUDED.depth,
            solvent = EXCLUDED.solvent,
            updated_at = now()
        `;
        depthRowsWritten++;
        if (solvent) solventRows++;
      }
    }
  }

  return {
    chain: n.id,
    scannedFromBlock: fromBlock.toString(),
    scannedToBlock: latest.toString(),
    newStrategies,
    newlyDocked,
    liveStrategiesTotal: live.length,
    tokensChecked: tokens.length,
    depthRowsWritten,
    solventRows,
    tookMs: Date.now() - t0,
  };
}
