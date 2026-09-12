import { aquaAbi, erc20Abi } from "@/lib/chain";
import { networkFrom, clientFor, tokensOf } from "@/lib/networks";
import { allTokensFor } from "@/lib/pairs";
import { makerBook, type MakerStrategy } from "@/lib/graph";
import { tokenBalances } from "@/lib/tokenApi";
import { addressParam, BadInput } from "@/lib/validate";
import { j, fail, chainFailure } from "@/lib/json";
import type { Address } from "viem";

export const dynamic = "force-dynamic";

/**
 * GET /api/exposure?chain=&maker=
 *
 * A single maker's total commitment across their book, set against what they
 * actually hold and have approved Aqua to move. Like /api/coverage, this totals
 * promises across strategies that cannot be enumerated on-chain, and so relies
 * on the index.
 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const n = networkFrom(url.searchParams.get("chain"));
    const makerParam = url.searchParams.get("maker");
    if (!makerParam) {
      throw new BadInput("maker address required");
    }
    const maker = addressParam(makerParam, "0x0000000000000000000000000000000000000000");
    const client = clientFor(n);
    const TOKENS = { ...tokensOf(n), ...allTokensFor(n.id) };

    // Looked up directly by maker id, not filtered out of a top-N global scan
    // (positionsFromGraph orders by size for the aggregate coverage view, and
    // a maker's own smaller positions can rank outside that page — the one
    // wrong answer a per-address solvency check cannot give).
    const book = await makerBook(n, maker);

    if (book === null) {
      return j({
        available: false,
        reason: !n.graphUrl
          ? `no subgraph is indexing ${n.label} yet`
          : `the ${n.label} index is unavailable or still catching up`,
        maker,
        positions: [],
        strategies: [],
        fullyCoveredCount: 0,
        totalPositions: 0,
      });
    }

    const makerPositions = book.positions;

    // Per-strategy detail — "which strategy is responsible for how much of
    // this" rather than just "how covered is this token overall".
    //
    // The per-token totals below answer the second question; they cannot
    // answer the first on their own, because Aqua's balance mapping is keyed
    // [maker][app][strategyHash][token] and is not enumerable — the whole
    // reason this app exists. makerBook's subgraph query already decoded
    // each active strategy's own token pair at index time, so this reads
    // each strategy's own live claim the same way the router itself checks
    // one before routing to it (`rawBalances`), rather than guessing at a
    // split of the token-level total.
    const strategies = book.strategies;
    const strategyRows = await strategyPositions(n, maker, strategies, client, TOKENS);

    if (makerPositions.length === 0) {
      return j({
        available: true,
        maker,
        positions: [],
        strategies: strategyRows,
        fullyCoveredCount: 0,
        totalPositions: 0,
        sources: {
          commitments: "subgraph",
          balances: "rpc",
          allowances: "rpc",
        },
      });
    }

    const tokenApiBalances = await tokenBalances(n, maker);

    let positions;
    let balancesSource: "token-api" | "rpc";

    if (tokenApiBalances !== null) {
      balancesSource = "token-api";
      // Token API answered, but it can omit a token it doesn't track (e.g. no
      // recent activity, or an unsupported token type) -- that's "unknown",
      // not "zero". For any position missing from its map, fall back to a
      // real balanceOf read for that token specifically, alongside the
      // allowance + decimals reads every position needs.
      let idx = 0;
      const offsets: number[] = [];
      const calls = makerPositions.flatMap((p) => {
        offsets.push(idx);
        const missing = !tokenApiBalances.has(p.token.toLowerCase());
        idx += missing ? 3 : 2;
        return missing
          ? ([
              { address: p.token, abi: erc20Abi, functionName: "allowance", args: [maker, n.aqua] },
              { address: p.token, abi: erc20Abi, functionName: "decimals", args: [] },
              { address: p.token, abi: erc20Abi, functionName: "balanceOf", args: [maker] },
            ] as const)
          : ([
              { address: p.token, abi: erc20Abi, functionName: "allowance", args: [maker, n.aqua] },
              { address: p.token, abi: erc20Abi, functionName: "decimals", args: [] },
            ] as const);
      });
      const res = await client.multicall({ contracts: calls, allowFailure: true });

      positions = makerPositions.map((p, i) => {
        const off = offsets[i];
        const a = res[off];
        const dec = res[off + 1];
        const missing = !tokenApiBalances.has(p.token.toLowerCase());

        const wallet = missing
          ? res[off + 2]?.status === "success"
            ? (res[off + 2].result as bigint)
            : 0n
          : tokenApiBalances.get(p.token.toLowerCase())!;
        const allowance = a.status === "success" ? (a.result as bigint) : 0n;
        const decimals =
          dec.status === "success"
            ? Number(dec.result)
            : TOKENS[p.token.toLowerCase()]?.decimals ?? 18;
        const symbol =
          TOKENS[p.token.toLowerCase()]?.symbol ?? `${p.token.slice(0, 6)}…`;

        const backed = wallet < allowance ? wallet : allowance;
        const covered = backed >= p.totalCommitted;

        return {
          token: p.token,
          symbol,
          decimals,
          claimed: p.totalCommitted.toString(),
          held: wallet.toString(),
          backed: backed.toString(),
          covered,
        };
      });
    } else {
      balancesSource = "rpc";
      // Fallback: read balanceOf, allowance, and decimals via RPC multicall (3 calls per token)
      const calls = makerPositions.flatMap((p) => [
        { address: p.token, abi: erc20Abi, functionName: "balanceOf", args: [maker] } as const,
        { address: p.token, abi: erc20Abi, functionName: "allowance", args: [maker, n.aqua] } as const,
        { address: p.token, abi: erc20Abi, functionName: "decimals", args: [] } as const,
      ]);
      const res = await client.multicall({ contracts: calls, allowFailure: true });

      positions = makerPositions.map((p, i) => {
        const b = res[i * 3];
        const a = res[i * 3 + 1];
        const dec = res[i * 3 + 2];

        const wallet = b.status === "success" ? (b.result as bigint) : 0n;
        const allowance = a.status === "success" ? (a.result as bigint) : 0n;
        const decimals =
          dec.status === "success"
            ? Number(dec.result)
            : TOKENS[p.token.toLowerCase()]?.decimals ?? 18;
        const symbol =
          TOKENS[p.token.toLowerCase()]?.symbol ?? `${p.token.slice(0, 6)}…`;

        const backed = wallet < allowance ? wallet : allowance;
        const covered = backed >= p.totalCommitted;

        return {
          token: p.token,
          symbol,
          decimals,
          claimed: p.totalCommitted.toString(),
          held: wallet.toString(),
          backed: backed.toString(),
          covered,
        };
      });
    }

    const fullyCoveredCount = positions.filter((p) => p.covered).length;

    return j({
      available: true,
      maker,
      positions,
      strategies: strategyRows,
      fullyCoveredCount,
      totalPositions: positions.length,
      sources: {
        commitments: "subgraph",
        balances: balancesSource,
        allowances: "rpc",
      },
    });
  } catch (e) {
    if (e instanceof BadInput) return fail(e.message, 400);
    if ((e as Error).message?.startsWith("unknown chain")) return fail((e as Error).message, 400);
    const unreachable = chainFailure(e);
    if (unreachable) return unreachable;
    return fail((e as Error).message, 500);
  }
}

type Client = ReturnType<typeof clientFor>;
type TokenTable = Record<string, { symbol: string; decimals: number }>;

/**
 * Each active strategy's own claim, per side, read live.
 *
 * A strategy's `tokens` list is usually the two addresses it was shipped
 * with, but nothing here assumes exactly two — it reads whatever the
 * subgraph decoded and asks the contract about each one in turn.
 *
 * Wallet balance and Aqua allowance are per maker-and-token, not per
 * strategy — every one of a maker's strategies on the same token is racing
 * for the same pool of tokens and the same approval, which is exactly the
 * failure mode this whole app exists to surface. So those are read once per
 * token here (not reused from the per-token pass above, which only covers
 * tokens with a strictly positive subgraph total and would silently drop a
 * strategy claiming a token that pass has not seen yet) and shared across
 * every strategy that touches that token.
 */
async function strategyPositions(
  n: ReturnType<typeof networkFrom>,
  maker: Address,
  strategies: MakerStrategy[],
  client: Client,
  TOKENS: TokenTable
) {
  if (strategies.length === 0) return [];

  const tokenList = [...new Set(strategies.flatMap((st) => st.tokens))];

  const ctxCalls = tokenList.flatMap((t) => [
    { address: t, abi: erc20Abi, functionName: "balanceOf", args: [maker] } as const,
    { address: t, abi: erc20Abi, functionName: "allowance", args: [maker, n.aqua] } as const,
    { address: t, abi: erc20Abi, functionName: "decimals", args: [] } as const,
  ]);
  const ctxRes = ctxCalls.length ? await client.multicall({ contracts: ctxCalls, allowFailure: true }) : [];

  const tokenCtx = new Map<string, { wallet: bigint; allowance: bigint; decimals: number; symbol: string }>();
  tokenList.forEach((t, i) => {
    const b = ctxRes[i * 3];
    const a = ctxRes[i * 3 + 1];
    const d = ctxRes[i * 3 + 2];
    tokenCtx.set(t, {
      wallet: b?.status === "success" ? (b.result as bigint) : 0n,
      allowance: a?.status === "success" ? (a.result as bigint) : 0n,
      decimals: d?.status === "success" ? Number(d.result) : (TOKENS[t]?.decimals ?? 18),
      symbol: TOKENS[t]?.symbol ?? `${t.slice(0, 6)}…`,
    });
  });

  const claimCalls = strategies.flatMap((st) =>
    st.tokens.map(
      (t) =>
        ({
          address: n.aqua,
          abi: aquaAbi,
          functionName: "rawBalances",
          args: [maker, n.router, st.strategyHash, t],
        }) as const
    )
  );
  const claimRes = claimCalls.length ? await client.multicall({ contracts: claimCalls, allowFailure: true }) : [];

  let idx = 0;
  return strategies.map((st) => {
    const sides = st.tokens.map((t) => {
      const r = claimRes[idx++];
      let claimed = 0n;
      if (r?.status === "success") {
        const [amount, tokensCount] = r.result as unknown as [bigint, number];
        // tokensCount 0 = never shipped this side, 0xff = docked -- same
        // reading measureDepth already gives the router's own solvency check.
        claimed = tokensCount === 0 || tokensCount === 0xff ? 0n : amount;
      }
      const ctx = tokenCtx.get(t) ?? { wallet: 0n, allowance: 0n, decimals: 18, symbol: `${t.slice(0, 6)}…` };
      const backed = ctx.wallet < ctx.allowance ? ctx.wallet : ctx.allowance;
      return {
        token: t,
        symbol: ctx.symbol,
        decimals: ctx.decimals,
        claimed: claimed.toString(),
        backed: backed.toString(),
        covered: backed >= claimed,
      };
    });
    return { strategyHash: st.strategyHash, app: st.app, sides };
  });
}
