import { erc20Abi } from "@/lib/chain";
import { networkFrom, clientFor, tokensOf } from "@/lib/networks";
import { positionsFromGraph, committedFromGraph } from "@/lib/graph";
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

    const allPositions = await positionsFromGraph(n, 500);

    if (allPositions === null) {
      return j({
        available: false,
        reason: !n.graphUrl
          ? `no subgraph is indexing ${n.label} yet`
          : `the ${n.label} index is unavailable or still catching up`,
        maker,
        positions: [],
        fullyCoveredCount: 0,
        totalPositions: 0,
      });
    }

    // Filter positions from the index for this maker
    const makerPositions = allPositions.filter(
      (p) => p.maker.toLowerCase() === maker.toLowerCase()
    );

    // Also check standard network tokens if they weren't in the top positions
    const knownTokens = Object.values(tokensOf(n)).map((t) => t.address);
    for (const token of knownTokens) {
      if (!makerPositions.some((p) => p.token.toLowerCase() === token.toLowerCase())) {
        const committed = await committedFromGraph(n, maker, token);
        if (committed !== null && committed > 0n) {
          makerPositions.push({
            maker,
            token,
            totalCommitted: committed,
            activeStrategies: 1,
            strategyHashes: [],
            app: n.router,
          });
        }
      }
    }

    if (makerPositions.length === 0) {
      return j({
        available: true,
        maker,
        positions: [],
        fullyCoveredCount: 0,
        totalPositions: 0,
      });
    }

    const client = clientFor(n);
    const calls = makerPositions.flatMap((p) => [
      { address: p.token, abi: erc20Abi, functionName: "balanceOf", args: [maker] } as const,
      { address: p.token, abi: erc20Abi, functionName: "allowance", args: [maker, n.aqua] } as const,
      { address: p.token, abi: erc20Abi, functionName: "decimals", args: [] } as const,
    ]);

    const res = await client.multicall({ contracts: calls, allowFailure: true });
    const TOKENS = tokensOf(n);

    const positions = makerPositions.map((p, i) => {
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

    const fullyCoveredCount = positions.filter((p) => p.covered).length;

    return j({
      available: true,
      maker,
      positions,
      fullyCoveredCount,
      totalPositions: positions.length,
    });
  } catch (e) {
    if (e instanceof BadInput) return fail(e.message, 400);
    if ((e as Error).message?.startsWith("unknown chain")) return fail((e as Error).message, 400);
    const unreachable = chainFailure(e);
    if (unreachable) return unreachable;
    return fail((e as Error).message, 500);
  }
}
