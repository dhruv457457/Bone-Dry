import { encodeAbiParameters, parseAbiParameters, decodeAbiParameters, type Address, type Hex } from "viem";
import { client, ROUTER } from "./chain";
import type { MakerDepth } from "./aqua";

/** Packed TakerTraits for a plain exact-in Aqua fill.
 *  bit 0x01 = isExactIn, bit 0x40 = useTransferFromAndAquaPush.
 *  shouldUnwrap MUST stay off: unwrap is incompatible with Aqua. */
export const TAKER_TRAITS: Hex = "0x00000000000000000000000000000000000000000041";

/** Array.prototype.sort needs a consistent comparator: cmp(a,b) === -cmp(b,a).
 *  `b.depth > a.depth ? 1 : -1` never returns 0, so equal depths order
 *  differently depending on which side of the comparison they land on. */
export const byDepthDesc = (a: { depth: bigint }, b: { depth: bigint }) =>
  a.depth === b.depth ? 0 : b.depth > a.depth ? 1 : -1;

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
  const solvent = depths.filter((d) => d.solvent).sort(byDepthDesc);
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

/**
 * Clamp each slice to what the maker can actually hand over.
 *
 * This is the failure the whole project is about, turned on ourselves. Picking
 * only solvent makers is not enough: an XYC curve is bounded by the maker's
 * VIRTUAL balance, so a large enough slice quotes out more than the wallet
 * holds. Seeded locally, three makers each promise 3 WETH while two of them hold
 * 3 and 2 — ask for enough and the route quotes 6 WETH against 5 WETH of real
 * depth, and the fill reverts inside `pull()`.
 *
 * Serial bisection is the obvious fix and the wrong one: the feasible amount can
 * be thirty digits below the requested one, so it needs ~100 sequential probes.
 * Instead each pass batches every candidate for every slice into ONE multicall —
 * a geometric sweep to bracket the answer, then linear refinements inside the
 * bracket. Three round trips, and it always lands on a feasible amount.
 */
const GEOMETRIC_STEPS = 96;
const LINEAR_STEPS = 48;
const REFINEMENTS = 2;

export async function clampToDepth(
  slices: Slice[],
  tokenIn: Address,
  tokenOut: Address
): Promise<{ slices: Slice[]; clamped: { maker: Address; from: bigint; to: bigint }[] }> {
  if (slices.length === 0) return { slices, clamped: [] };

  const first = await quoteRoute(slices, tokenIn, tokenOut);
  const over = slices
    .map((s, i) => ({ i, s, out: first.perMaker[i]?.amountOut ?? 0n }))
    .filter((x) => x.out > x.s.depth);
  if (over.length === 0) return { slices, clamped: [] };

  /** Probe `candidates[k]` for each offending slice k in one multicall.
   *  Returns, per slice, the largest candidate that stays within depth. */
  const sweep = async (candidates: bigint[][]): Promise<(bigint | null)[]> => {
    const probes: Slice[] = [];
    const owner: number[] = [];
    candidates.forEach((list, k) =>
      list.forEach((amt) => {
        if (amt <= 0n) return;
        probes.push({ ...over[k].s, amountIn: amt });
        owner.push(k);
      })
    );
    if (probes.length === 0) return over.map(() => null);

    const q = await quoteRoute(probes, tokenIn, tokenOut);
    const best: (bigint | null)[] = over.map(() => null);
    probes.forEach((p, idx) => {
      const k = owner[idx];
      const out = q.perMaker[idx]?.amountOut ?? 0n;
      // A reverted quote reads as 0 out, which would look feasible. Only accept a
      // probe that actually produced something, or that asked for nothing.
      if (out === 0n && p.amountIn > 0n) return;
      if (out > over[k].s.depth) return;
      if (best[k] === null || p.amountIn > best[k]!) best[k] = p.amountIn;
    });
    return best;
  };

  // Pass 1: halve repeatedly to bracket the feasible magnitude.
  const geo = over.map((x) => {
    const list: bigint[] = [];
    let v = x.s.amountIn;
    for (let k = 0; k < GEOMETRIC_STEPS && v > 0n; k++) {
      list.push(v);
      v /= 2n;
    }
    return list;
  });
  let lo = await sweep(geo);
  // The bracket's upper bound is twice the best feasible halving (or the first
  // candidate, when nothing at all was feasible).
  let hi = lo.map((v, k) => (v === null ? geo[k][geo[k].length - 1] ?? 0n : v * 2n));
  lo = lo.map((v) => v ?? 0n);

  // Passes 2..N: linear sweeps that keep tightening the same bracket.
  for (let r = 0; r < REFINEMENTS; r++) {
    const lin = over.map((_, k) => {
      const span = hi[k] - lo[k]!;
      if (span <= 0n) return [];
      const step = span / BigInt(LINEAR_STEPS);
      if (step === 0n) return [];
      return Array.from({ length: LINEAR_STEPS }, (_, t) => lo[k]! + step * BigInt(t + 1));
    });
    const found = await sweep(lin);
    found.forEach((v, k) => {
      if (v !== null && v > lo[k]!) {
        const span = hi[k] - lo[k]!;
        const step = span / BigInt(LINEAR_STEPS);
        lo[k] = v;
        hi[k] = v + (step > 0n ? step : 0n);
      }
    });
  }

  const out = slices.slice();
  const clamped: { maker: Address; from: bigint; to: bigint }[] = [];
  over.forEach((x, k) => {
    const to = lo[k]!;
    clamped.push({ maker: x.s.maker, from: x.s.amountIn, to });
    out[x.i] = { ...x.s, amountIn: to };
  });
  return { slices: out.filter((s) => s.amountIn > 0n), clamped };
}
