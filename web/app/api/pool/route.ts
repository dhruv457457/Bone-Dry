import { encodeAbiParameters, parseAbiParameters, keccak256, encodePacked, toHex, type Address } from "viem";
import { client, POOL_MANAGER, POOL_KEY, poolManagerAbi } from "@/lib/chain";
import { addressParam, uintParam, BadInput } from "@/lib/validate";
import { j, fail, chainFailure } from "@/lib/json";

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
    const raw = url.searchParams.get("hook");
    if (!raw) return fail("hook address required");
    const hook = addressParam(raw, raw as Address);

    const fee = uintParam(url.searchParams.get("fee"), 0, 24, "fee");
    const tickSpacing = uintParam(url.searchParams.get("tickSpacing"), 60, 23, "tickSpacing");

    // POOL_KEY holds the canonical ordering; fee and tickSpacing stay
    // overridable so a caller can inspect a differently-configured pool.
    const currency0 = POOL_KEY.currency0;
    const currency1 = POOL_KEY.currency1;

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

    // An uninitialized pool has zero liquidity for the boring reason that it does
    // not exist. Claiming that as proof would be dishonest, so `boneDry` requires
    // the pool to be live AND empty, and the note says which case we are in.
    const initialized = sqrtPriceX96 > 0n;
    const boneDry = initialized && liquidity === 0n;

    return j({
      poolManager: POOL_MANAGER,
      poolId,
      key: { currency0, currency1, fee, tickSpacing, hooks: hook },
      initialized,
      liquidity,
      boneDry,
      state: !initialized ? "uninitialized" : liquidity === 0n ? "bone-dry" : "conventional",
      note: !initialized
        ? "This pool is not initialized on this chain yet, so its zero liquidity proves nothing. Initialize it with the Tap hook and the figure stays zero for a reason."
        : liquidity === 0n
          ? "Live pool, zero liquidity. Any fill against it is sourced from maker wallets at swap time."
          : "This pool has conventional liquidity in the PoolManager.",
    });
  } catch (e) {
    if (e instanceof BadInput) return fail(e.message, 400);
    const unreachable = chainFailure(e);
    if (unreachable) return unreachable;
    return fail((e as Error).message, 500);
  }
}
