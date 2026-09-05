import { encodeAbiParameters, parseAbiParameters, keccak256, encodePacked, toHex, type Address } from "viem";
import { client, POOL_MANAGER, USDC, WETH, poolManagerAbi } from "@/lib/chain";
import { j, fail } from "@/lib/json";

export const dynamic = "force-dynamic";

const POOLS_SLOT = 6n;
const LIQUIDITY_OFFSET = 3n;

/**
 * GET /api/pool?hook=0x...
 *
 * The proof. Reads the pool's own liquidity straight out of the PoolManager's
 * storage — no indexer, no trust. For a Bone Dry pool this is zero, and stays
 * zero after a swap, because the pool never held anything to begin with.
 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const hook = url.searchParams.get("hook") as Address | null;
    if (!hook) return fail("hook address required");

    const fee = Number(url.searchParams.get("fee") ?? 0);
    const tickSpacing = Number(url.searchParams.get("tickSpacing") ?? 60);

    // WETH (0x42..) sorts below USDC (0x83..)
    const currency0 = WETH;
    const currency1 = USDC;

    const poolId = keccak256(
      encodeAbiParameters(
        parseAbiParameters("address, address, uint24, int24, address"),
        [currency0, currency1, fee, tickSpacing, hook]
      )
    );
    const stateSlot = keccak256(encodePacked(["bytes32", "bytes32"], [poolId, toHex(POOLS_SLOT, { size: 32 })]));
    const liquiditySlot = toHex(BigInt(stateSlot) + LIQUIDITY_OFFSET, { size: 32 });

    const [slot0Raw, liqRaw] = await Promise.all([
      client.readContract({ address: POOL_MANAGER, abi: poolManagerAbi, functionName: "extsload", args: [stateSlot] }),
      client.readContract({ address: POOL_MANAGER, abi: poolManagerAbi, functionName: "extsload", args: [liquiditySlot] }),
    ]);

    const sqrtPriceX96 = BigInt(slot0Raw) & ((1n << 160n) - 1n);
    const liquidity = BigInt(liqRaw) & ((1n << 128n) - 1n);

    return j({
      poolManager: POOL_MANAGER,
      poolId,
      key: { currency0, currency1, fee, tickSpacing, hooks: hook },
      initialized: sqrtPriceX96 > 0n,
      liquidity,
      boneDry: liquidity === 0n,
      note:
        liquidity === 0n
          ? "This pool holds no liquidity. Any fill against it is sourced from maker wallets at swap time."
          : "This pool has conventional liquidity in the PoolManager.",
    });
  } catch (e) {
    return fail((e as Error).message, 500);
  }
}
