import { encodeAbiParameters, parseAbiParameters, decodeAbiParameters, type Address, type Hex } from "viem";
import { client, ROUTER } from "./chain";
import type { MakerDepth } from "./aqua";

/** Packed TakerTraits for a plain exact-in Aqua fill.
 *  bit 0x01 = isExactIn, bit 0x40 = useTransferFromAndAquaPush.
 *  shouldUnwrap MUST stay off: unwrap is incompatible with Aqua. */
export const TAKER_TRAITS: Hex = "0x00000000000000000000000000000000000000000041";

export type Slice = { maker: Address; strategyHash: Hex; strategy: Hex; amountIn: bigint; depth: bigint };

/**
 * Split the input across makers pro-rata to REAL depth.
 *
 * On a constant-product curve this is strictly better than routing everything to
 * one maker: each curve is walked less far up its own price impact. Insolvent
 * makers get zero and are dropped, so a maker who shipped and then emptied their
 * wallet costs the swapper nothing instead of reverting the fill.
 */
export function planRoute(depths: MakerDepth[], amountIn: bigint): Slice[] {
  const solvent = depths.filter((d) => d.solvent).sort((a, b) => (b.depth > a.depth ? 1 : -1));
  if (solvent.length === 0) return [];

  const total = solvent.reduce((a, d) => a + d.depth, 0n);
  const slices: Slice[] = [];
  let assigned = 0n;

  solvent.forEach((d, i) => {
    const isLast = i === solvent.length - 1;
    const amount = isLast ? amountIn - assigned : (amountIn * d.depth) / total;
    if (amount <= 0n) return;
    assigned += amount;
    slices.push({
      maker: d.maker,
      strategyHash: d.strategyHash,
      strategy: d.strategy,
      amountIn: amount,
      depth: d.depth,
    });
  });

  return slices;
}

/** The blob the Tap hook receives as `hookData`: TapData{ bytes[] strategies, bytes takerTraits }. */
export function encodeHookData(slices: Slice[]): Hex {
  return encodeAbiParameters(parseAbiParameters("(bytes[] strategies, bytes takerTraits)"), [
    { strategies: slices.map((s) => s.strategy), takerTraits: TAKER_TRAITS },
  ] as never);
}

const swapVmAbi = [
  {
    type: "function",
    name: "quote",
    stateMutability: "view",
    inputs: [
      {
        name: "order",
        type: "tuple",
        components: [
          { name: "maker", type: "address" },
          { name: "traits", type: "uint256" },
          { name: "data", type: "bytes" },
        ],
      },
      { name: "tokenIn", type: "address" },
      { name: "tokenOut", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "takerTraitsAndData", type: "bytes" },
    ],
    outputs: [
      { name: "amountIn", type: "uint256" },
      { name: "amountOut", type: "uint256" },
      { name: "orderHash", type: "bytes32" },
    ],
  },
] as const;

/** Ask the real router what each slice would pay out. No estimates, no models. */
export async function quoteRoute(slices: Slice[], tokenIn: Address, tokenOut: Address) {
  if (slices.length === 0) return { amountOut: 0n, perMaker: [] as { maker: Address; amountOut: bigint }[] };

  const contracts = slices.map((s) => {
    const [order] = decodeAbiParameters(
      parseAbiParameters("(address maker, uint256 traits, bytes data)"),
      s.strategy
    );
    return {
      address: ROUTER,
      abi: swapVmAbi,
      functionName: "quote",
      args: [order, tokenIn, tokenOut, s.amountIn, TAKER_TRAITS],
    } as const;
  });

  const res = await client.multicall({ contracts, allowFailure: true });

  let amountOut = 0n;
  const perMaker = res.map((r, i) => {
    const out = r.status === "success" ? ((r.result as unknown as [bigint, bigint, Hex])[1] ?? 0n) : 0n;
    amountOut += out;
    return { maker: slices[i].maker, amountOut: out };
  });

  return { amountOut, perMaker };
}
