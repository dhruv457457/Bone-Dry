import { erc20Abi } from "@/lib/chain";
import { networkFrom, clientFor, tokensOf } from "@/lib/networks";
import { positionsForMaker } from "@/lib/graph";
import { addressParam, BadInput } from "@/lib/validate";
import { j, fail, chainFailure } from "@/lib/json";

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

    // Looked up directly by maker id, not filtered out of a top-N global scan
    // (positionsFromGraph orders by size for the aggregate coverage view, and
    // a maker's own smaller positions can rank outside that page — the one
    // wrong answer a per-address solvency check cannot give).
    const makerPositions = await positionsForMaker(n, maker);

    if (makerPositions === null) {
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
