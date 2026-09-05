import { erc20Abi, AQUA, client } from "@/lib/chain";
import { positionsFromGraph, GRAPH_URL } from "@/lib/graph";
import { uintParam, BadInput } from "@/lib/validate";
import { j, fail } from "@/lib/json";

export const dynamic = "force-dynamic";

/**
 * GET /api/coverage?first=
 *
 * The number Aqua cannot produce.
 *
 * Balances are keyed [maker][app][strategyHash][token] and the mapping is not
 * enumerable, so nothing on-chain can total what one maker has promised across
 * every strategy they have live. The subgraph can. Set that against the wallet
 * balance and the allowance and you get a coverage ratio — the honest answer to
 * "if everyone tried to fill against this maker at once, could they?"
 *
 * On Base today the answer is sometimes no, and not marginally: a maker with
 * eight live strategies committing 12,694 DEGEN holds none of it.
 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const first = uintParam(url.searchParams.get("first"), 25, 10, "first");

    const positions = await positionsFromGraph(first);
    if (positions === null) {
      return fail(
        GRAPH_URL
          ? "the index is unavailable or still syncing; coverage is a subgraph-only view"
          : "GRAPH_URL is not configured; coverage cannot be computed from RPC alone",
        503
      );
    }
    if (positions.length === 0) return j({ source: "aquifer-subgraph", positions: [] });

    // Decimals come from the token, not from an assumption. Committing 12,694 of
    // an 18-decimal token and 12,694 of a 6-decimal one are the same integer and
    // wildly different amounts.
    const calls = positions.flatMap((p) => [
      { address: p.token, abi: erc20Abi, functionName: "balanceOf", args: [p.maker] } as const,
      { address: p.token, abi: erc20Abi, functionName: "allowance", args: [p.maker, AQUA] } as const,
      { address: p.token, abi: erc20Abi, functionName: "decimals", args: [] } as const,
    ]);
    const res = await client.multicall({ contracts: calls, allowFailure: true });

    const rows = positions.map((p, i) => {
      const b = res[i * 3];
      const a = res[i * 3 + 1];
      const dec = res[i * 3 + 2];
      const wallet = b.status === "success" ? (b.result as bigint) : 0n;
      const allowance = a.status === "success" ? (a.result as bigint) : 0n;
      const decimals = dec.status === "success" ? Number(dec.result) : 18;
      const backed = wallet < allowance ? wallet : allowance;

      return {
        maker: p.maker,
        token: p.token,
        decimals,
        activeStrategies: p.activeStrategies,
        committed: p.totalCommitted,
        wallet,
        allowance,
        /** what all of those strategies could actually deliver between them */
        backed,
        /** basis points of the promise the maker can honour; 10000 = fully covered */
        coverageBps:
          p.totalCommitted > 0n ? (backed * 10_000n) / p.totalCommitted : 0n,
        shortfall: p.totalCommitted > backed ? p.totalCommitted - backed : 0n,
      };
    });

    const uncovered = rows.filter((r) => r.coverageBps < 10_000n);
    return j({
      source: "aquifer-subgraph",
      note:
        "committed is summed across every live strategy for that maker and token, " +
        "which no contract can do: Aqua's balance mapping is not enumerable",
      positions: rows.length,
      underCollateralised: uncovered.length,
      rows: rows.sort((a, b) => (a.coverageBps === b.coverageBps ? 0 : a.coverageBps < b.coverageBps ? -1 : 1)),
    });
  } catch (e) {
    if (e instanceof BadInput) return fail(e.message, 400);
    return fail((e as Error).message, 500);
  }
}
