import { encodeAbiParameters, parseAbiParameters, keccak256, encodePacked, toHex, type Address } from "viem";
import { poolManagerAbi } from "@/lib/chain";
import { networkFrom, clientFor, poolKey } from "@/lib/networks";
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
    const n = networkFrom(url.searchParams.get("chain"));
    const client = clientFor(n);
    const raw = url.searchParams.get("hook") ?? n.hook;
    if (!raw) {
      const defaultKey = poolKey(n);
      return j({
        poolManager: n.poolManager,
        // A real pool ID is keccak256 of the pool key -- 32 bytes, 64 hex
        // digits. Nothing computes one when there's no hook to key it off,
        // so this is a zero placeholder, not a real ID -- but it still has
        // to be the right *length* for anything that parses it as bytes32.
        poolId: `0x${"0".repeat(64)}`,
        key: {
          currency0: defaultKey.currency0,
          currency1: defaultKey.currency1,
          fee: defaultKey.fee,
          tickSpacing: defaultKey.tickSpacing,
          hooks: "",
        },
        initialized: false,
        liquidity: "0",
        boneDry: false,
        state: "uninitialized",
        note: "No hook configured on this network (Base mainnet is read-only Aqua maker evidence)",
      });
    }
    const hook = addressParam(raw, raw as Address);

    const fee = uintParam(url.searchParams.get("fee"), 0, 24, "fee");
    const tickSpacing = uintParam(url.searchParams.get("tickSpacing"), 60, 23, "tickSpacing");

    // POOL_KEY holds the canonical ordering; fee, tickSpacing, and currencies
    // stay overridable so a caller can inspect a differently-configured pool.
    const paramC0 = url.searchParams.get("currency0");
    const paramC1 = url.searchParams.get("currency1");
    const defaultKey = poolKey(n);
    const { currency0, currency1 } =
      paramC0 && paramC1
        ? {
            currency0: addressParam(paramC0, defaultKey.currency0),
            currency1: addressParam(paramC1, defaultKey.currency1),
          }
        : defaultKey;

    const poolId = keccak256(
      encodeAbiParameters(
        parseAbiParameters("address, address, uint24, int24, address"),
        [currency0, currency1, fee, tickSpacing, hook]
      )
    );
    const stateSlot = keccak256(encodePacked(["bytes32", "bytes32"], [poolId, toHex(POOLS_SLOT, { size: 32 })]));
    const liquiditySlot = toHex(BigInt(stateSlot) + LIQUIDITY_OFFSET, { size: 32 });

    const [slot0Raw, liqRaw] = await Promise.all([
      client.readContract({ address: n.poolManager, abi: poolManagerAbi, functionName: "extsload", args: [stateSlot] }),
      client.readContract({ address: n.poolManager, abi: poolManagerAbi, functionName: "extsload", args: [liquiditySlot] }),
    ]);

    const sqrtPriceX96 = BigInt(slot0Raw) & ((1n << 160n) - 1n);
    const liquidity = BigInt(liqRaw) & ((1n << 128n) - 1n);

    // An uninitialized pool has zero liquidity for the boring reason that it does
    // not exist. Claiming that as proof would be dishonest, so `boneDry` requires
    // the pool to be live AND empty, and the note says which case we are in.
    const initialized = sqrtPriceX96 > 0n;
    const boneDry = initialized && liquidity === 0n;

    return j({
      poolManager: n.poolManager,
      chain: { id: n.id, label: n.label, testnet: n.testnet },
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
    if ((e as Error).message?.startsWith("unknown chain")) return fail((e as Error).message, 400);
    const unreachable = chainFailure(e);
    if (unreachable) return unreachable;
    return fail((e as Error).message, 500);
  }
}
