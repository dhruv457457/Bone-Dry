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
 * All writes are batched (chunks of BATCH rows per query) rather than one
 * round trip per row -- found live that a naive per-row version of this,
 * against ~7,000 strategies x several tokens, took long enough that a first
 * backfill did not finish inside a 5-minute request. A network round trip
 * to Postgres costs tens of milliseconds; a few thousand of them serialized
 * is minutes, no matter how cheap each one looks alone.
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

const BATCH = 500;

async function chunks<T>(items: T[], size: number): Promise<T[][]> {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

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

    // Accumulate across every page, write once at the end -- dock events in
    // particular are rare enough (Ethereum's Aqua registry has had zero,
    // ever, as of writing) that batching them is about correctness of the
    // pattern, not about a real cost today.
    const shipRows: { maker: string; strategy_hash: string; strategy_bytes: string; block_number: string }[] = [];
    const dockRows: { maker: string; strategy_hash: string }[] = [];

    while (start <= latest) {
      const end = start + PAGE - 1n > latest ? latest : start + PAGE - 1n;

      const [ship, dock] = await Promise.all([
        client.getLogs({ address: n.aqua, event: aquaAbi[0], fromBlock: start, toBlock: end }),
        client.getLogs({ address: n.aqua, event: aquaAbi[1], fromBlock: start, toBlock: end }),
      ]);

      for (const l of ship) {
        const a = l.args as { maker: Address; app: Address; strategyHash: Hex; strategy: Hex };
        if (a.app.toLowerCase() !== n.router.toLowerCase()) continue;
        shipRows.push({
          maker: a.maker.toLowerCase(),
          strategy_hash: a.strategyHash,
          strategy_bytes: a.strategy,
          block_number: l.blockNumber!.toString(),
        });
      }
      for (const l of dock) {
        const a = l.args as { maker: Address; strategyHash: Hex };
        dockRows.push({ maker: a.maker.toLowerCase(), strategy_hash: a.strategyHash });
      }

      start = end + 1n;
    }

    // A strategy shipped and docked inside the SAME window this run just
    // scanned (routine on a first backfill spanning real history) would
    // otherwise cost two writes: an insert as live, then an update to
    // docked. Know the answer before the insert instead.
    const dockedInThisWindow = new Set(dockRows.map((d) => `${d.maker}:${d.strategy_hash}`));

    for (const chunk of await chunks(shipRows, BATCH)) {
      const rows = chunk.map((r) => ({
        chain_id: n.id,
        docked: dockedInThisWindow.has(`${r.maker}:${r.strategy_hash}`),
        ...r,
      }));
      await db`
        INSERT INTO aqua_strategies ${db(rows, "chain_id", "maker", "strategy_hash", "strategy_bytes", "block_number", "docked")}
        ON CONFLICT (chain_id, maker, strategy_hash) DO NOTHING
      `;
    }
    newStrategies = shipRows.length;

    // Found live: assuming dock events would be rare and writing this as a
    // per-row loop cost a first backfill ~27 extra minutes (6,534 individual
    // round trips to Neon). A batched set-based update instead -- one query
    // per chunk regardless of how many rows it touches. This still runs for
    // every dock this scan saw, including ones already caught by the
    // same-window optimization above; those are simply no-ops (`NOT docked`
    // already false), which is cheaper than tracking which dock events still
    // need it.
    for (const chunk of await chunks(dockRows, BATCH)) {
      const makers = chunk.map((d) => d.maker);
      const hashes = chunk.map((d) => d.strategy_hash);
      const res = await db`
        UPDATE aqua_strategies AS s SET docked = TRUE
        FROM (SELECT unnest(${db.array(makers)}::text[]) AS maker, unnest(${db.array(hashes)}::text[]) AS strategy_hash) AS v
        WHERE s.chain_id = ${n.id} AND s.maker = v.maker AND s.strategy_hash = v.strategy_hash AND NOT s.docked
      `;
      newlyDocked += res.count;
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

      const rows: {
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

        // Skip rows that have never touched this token at all -- otherwise
        // this table grows by (live strategies x every curated token) even
        // for tokens a strategy will never hold, forever.
        if (virtual === 0n && wallet === 0n && allowance === 0n) continue;

        const depth = [virtual, wallet, allowance].reduce((a, b) => (b < a ? b : a));
        const solvent = depth > 0n;
        rows.push({
          chain_id: n.id,
          maker: live[i].maker,
          strategy_hash: live[i].strategy_hash,
          token: token.toLowerCase(),
          virtual_amount: virtual.toString(),
          wallet_balance: wallet.toString(),
          allowance: allowance.toString(),
          depth: depth.toString(),
          solvent,
        });
        if (solvent) solventRows++;
      }

      for (const chunk of await chunks(rows, BATCH)) {
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
      depthRowsWritten += rows.length;
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
