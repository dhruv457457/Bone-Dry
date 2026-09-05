import { indexStrategies, measureDepth } from "@/lib/aqua";
import { TOKENS, WETH } from "@/lib/chain";
import { j, fail } from "@/lib/json";
import type { Address } from "viem";

export const dynamic = "force-dynamic";

/**
 * GET /api/makers?token=0x...&fromBlock=
 *
 * Every live Aqua strategy on the Bone Dry router, with the only depth number a
 * router may trust: min(virtual balance, wallet balance, Aqua allowance).
 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const token = (url.searchParams.get("token") ?? WETH) as Address;
    const fromBlock = url.searchParams.get("fromBlock");

    const strategies = await indexStrategies(
      fromBlock ? { fromBlock: BigInt(fromBlock) } : undefined
    );
    const depths = await measureDepth(strategies, token);

    const meta = TOKENS[token.toLowerCase()];
    return j({
      token: { address: token, symbol: meta?.symbol ?? "?", decimals: meta?.decimals ?? 18 },
      indexed: strategies.length,
      solvent: depths.filter((d) => d.solvent).length,
      totalDepth: depths.reduce((a, d) => a + d.depth, 0n),
      makers: depths
        .sort((a, b) => (b.depth > a.depth ? 1 : -1))
        .map((d) => ({
          maker: d.maker,
          strategyHash: d.strategyHash,
          virtual: d.virtual,
          wallet: d.wallet,
          allowance: d.allowance,
          depth: d.depth,
          solvent: d.solvent,
          // the interesting column: promised vs deliverable
          shortfall: d.virtual > d.depth ? d.virtual - d.depth : 0n,
        })),
    });
  } catch (e) {
    return fail((e as Error).message, 500);
  }
}
