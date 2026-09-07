import { encodeFunctionData, isAddress, getAddress } from "viem";
import { AquaProgramBuilder, Order, MakerTraits, instructions } from "@1inch/swap-vm-sdk";
import { Address as SdkAddress, HexString } from "@1inch/sdk-core";
import { networkFrom } from "@/lib/networks";
import { addressParam, amountParam, uintParam, distinct, BadInput } from "@/lib/validate";
import { j, fail } from "@/lib/json";

export const dynamic = "force-dynamic";

const AQUA_ABI = [
  {
    type: "function",
    name: "ship",
    stateMutability: "nonpayable",
    inputs: [
      { name: "app", type: "address" },
      { name: "strategy", type: "bytes" },
      { name: "tokens", type: "address[]" },
      { name: "amounts", type: "uint256[]" },
    ],
    outputs: [{ name: "strategyHash", type: "bytes32" }],
  },
] as const;

const { extruction } = instructions;
// Redeployed once already: the first deployment (0xAe91aEea...) had a
// SwapRegisters mismatch against the real router's ABI (an extra
// amountNetPulled field the original interface copy was missing) and could
// never actually be called by the router. See IExtruction.sol's comment for
// the full story. This is the corrected, verified-reachable deployment.
const BEACON_STRATEGY_ADDRESS = "0x1cAD1eCa368940F91b43B25Db0e3E9B32B46fFe7"; // Base Sepolia only


/**
 * POST /api/strategy
 *
 * The maker side of the same coin the taker's /api/route already stands on.
 * The 1inch SDK that builds a valid Aqua program only runs on Node — a browser
 * cannot construct this call itself — so this route does the one thing a
 * server can do that a wallet can't: turn "I want to be a maker on this pair,
 * with this fee, this salt" into calldata. The wallet still does the one thing
 * only it can do: hold the key and sign. Funds never pass through here; they
 * never leave the maker's own wallet either, ship() only records a claim.
 *
 * Body: { maker, chainId, tokenIn, tokenOut, amountIn, amountOut, feeBps?, salt? }
 *   - amountIn/amountOut are the maker's own claim of what they can deliver —
 *     the same "promise" the whole project measures makers against.
 *   - feeBps is the maker's own spread, encoded as a flat fee opcode.
 *   - salt lets one maker run more than one strategy: dock() never re-enables
 *     a strategyHash once used, so a second strategy needs a different salt.
 */
export async function POST(req: Request) {
  try {
    const body = await req.json();
    const n = networkFrom(body.chainId != null ? String(body.chainId) : null);

    if (!body.maker || !isAddress(body.maker, { strict: false })) {
      throw new BadInput(`not an address: ${body.maker}`);
    }
    const maker = getAddress(body.maker);
    // No allowlist here: a maker can ship a strategy on any ERC20 pair, known
    // to this app's UI or not. ship() itself does not care, and gating it on
    // a hardcoded token table is exactly the kind of single-pair assumption
    // that would have to be re-litigated for every pair Bone Dry ever adds.
    const tokenIn = addressParam(body.tokenIn ?? null, n.usdc);
    const tokenOut = addressParam(body.tokenOut ?? null, n.weth);
    distinct(tokenIn, tokenOut);
    const amountIn = amountParam(body.amountIn != null ? String(body.amountIn) : null, 0n);
    const amountOut = amountParam(body.amountOut != null ? String(body.amountOut) : null, 0n);
    if (amountIn === 0n && amountOut === 0n) {
      throw new BadInput("claim at least one non-zero amount");
    }
    // Fee is basis points on the flat-fee opcode's own scale (parts per 1e4,
    // matching the router's fee unit elsewhere in this codebase).
    const feeBps = uintParam(body.feeBps != null ? String(body.feeBps) : null, 0, 32, "feeBps");
    // Pricing model: "xyc" (default constant-product curve) or "oracle" (Chainlink via BeaconStrategy).
    const pricing = body.pricing ?? "xyc";
    if (pricing !== "xyc" && pricing !== "oracle") {
      throw new BadInput(`unknown pricing model: ${pricing}`);
    }

    if (pricing === "oracle") {
      if (n.id !== 84532) {
        throw new BadInput("BeaconStrategy is only deployed on Base Sepolia");
      }
      const isWethUsdc =
        (tokenIn.toLowerCase() === n.weth.toLowerCase() && tokenOut.toLowerCase() === n.usdc.toLowerCase()) ||
        (tokenIn.toLowerCase() === n.usdc.toLowerCase() && tokenOut.toLowerCase() === n.weth.toLowerCase());
      if (!isWethUsdc) {
        throw new BadInput("BeaconStrategy is only deployed for the WETH/USDC pair");
      }
    }

    // Salt is a uint64. Random by default for xyc so two makers shipping in the same
    // block don't collide; for oracle, salt is only applied if explicitly requested.
    const salt =
      body.salt != null
        ? uintParam(String(body.salt), 0, 64, "salt")
        : pricing === "oracle"
          ? 0
          : Number(BigInt(Math.floor(Math.random() * 2 ** 32)) & 0xffffffffn);

    // Build the program: for oracle, use SwapVM opcode 0x20 (Extruction) targeting
    // BeaconStrategy without layering flat fee on top. For xyc, apply salt and fee as gates/modifiers.
    let builder = new AquaProgramBuilder();
    if (salt !== 0) builder = builder.salt({ salt: BigInt(salt) });

    let program;
    if (pricing === "oracle") {
      program = builder
        .add(
          extruction.extruction.createIx(
            new extruction.ExtructionArgs(new SdkAddress(BEACON_STRATEGY_ADDRESS), new HexString("0x00"))
          )
        )
        .build();
    } else {
      if (feeBps !== 0) builder = builder.flatFeeAmountInXD({ fee: BigInt(feeBps) });
      program = builder.xycSwapXD().build();
    }

    const traits = MakerTraits.default().with({ useAquaInsteadOfSignature: true });
    const order = Order.new({ maker: new SdkAddress(maker), traits, program });
    const strategy = String(order.encode()) as `0x${string}`;

    const tokens = [tokenIn, tokenOut];
    const amounts = [amountIn, amountOut];

    const data = encodeFunctionData({
      abi: AQUA_ABI,
      functionName: "ship",
      args: [n.router, strategy, tokens, amounts],
    });

    return j({
      chainId: n.id,
      to: n.aqua,
      data,
      maker,
      router: n.router,
      strategy,
      programHex: String(program),
      salt,
      feeBps: pricing === "oracle" ? 0 : feeBps,
      tokens,
      amounts,
      note: "Sign and send this as a transaction from the maker's own wallet. It only records a claim in Aqua — no funds move.",
    });
  } catch (e) {
    if (e instanceof BadInput) return fail(e.message, 400);
    console.error("[strategy]", e);
    return fail("could not build a strategy for this request", 500);
  }
}
