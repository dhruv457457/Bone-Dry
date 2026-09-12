import { encodeAbiParameters, parseAbiParameters, decodeAbiParameters, type Address, type Hex } from "viem";
import { clientFor, type Network } from "./networks";
import type { MakerDepth } from "./aqua";
import { oraclePriceUsd, deviationBps } from "./oracle";

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

export type QuotedSlice = {
  maker: Address;
  amountIn: bigint;
  depth: bigint;
  amountOut: bigint;
  oracleDeviationBps: bigint | null;
};

/**
 * Compute the oracle deviation in basis points for a slice swap.
 *
 * Math and decimal normalization:
 * Given:
 * - amountIn of tokenIn (decimals decimalsIn, oracle price priceIn normalized to 18 decimals)
 * - amountOut of tokenOut (decimals decimalsOut, oracle price priceOut normalized to 18 decimals)
 *
 * Expected USD value of input at oracle price:
 *   valIn = (amountIn * priceIn) / 10^decimalsIn
 * Delivered USD value of output at oracle price:
 *   valOut = (amountOut * priceOut) / 10^decimalsOut
 *
 * To avoid any loss of precision from intermediate integer division before comparison,
 * we place both over a common denominator 10^(decimalsIn + decimalsOut):
 *   termOut = amountOut * priceOut * 10^decimalsIn
 *   termIn  = amountIn * priceIn * 10^decimalsOut
 *
 * deviationBps(termOut, termIn) = ((termOut - termIn) * 10_000) / termIn
 *
 * Worked example:
 * 1 WETH (amountIn = 1e18, decimalsIn = 18, priceIn = 2500e18)
 * for 2490 USDC (amountOut = 2490e6, decimalsOut = 6, priceOut = 1e18):
 *   termOut = 2490e6 * 1e18 * 10^18 = 2490 * 10^42
 *   termIn  = 1e18 * 2500e18 * 10^6 = 2500 * 10^42
 *   deviation = ((2490 * 10^42 - 2500 * 10^42) * 10_000) / (2500 * 10^42)
 *             = (-10 * 10^42 * 10_000) / (2500 * 10^42)
 *             = -40 bps (maker delivers 40 bps below par).
 */
export function computeSliceDeviationBps(
  amountIn: bigint,
  amountOut: bigint,
  decimalsIn: number,
  decimalsOut: number,
  priceIn: bigint,
  priceOut: bigint
): bigint | null {
  if (amountIn <= 0n || amountOut <= 0n) return null;
  const termOut = amountOut * priceOut * 10n ** BigInt(decimalsIn);
  const termIn = amountIn * priceIn * 10n ** BigInt(decimalsOut);
  if (termIn === 0n) return null;
  return deviationBps(termOut, termIn);
}

export async function attachOracleDeviations(
  n: Network,
  slices: { maker: Address; amountIn: bigint; depth: bigint; amountOut: bigint }[],
  tokenIn: Address,
  tokenOut: Address,
  decimalsIn: number,
  decimalsOut: number
): Promise<QuotedSlice[]> {
  const [oracleIn, oracleOut] = await Promise.all([
    oraclePriceUsd(n, tokenIn),
    oraclePriceUsd(n, tokenOut),
  ]);

  const hasOracles = oracleIn && oracleOut && !oracleIn.stale && !oracleOut.stale;

  return slices.map((s) => {
    const deviation = hasOracles
      ? computeSliceDeviationBps(
          s.amountIn,
          s.amountOut,
          decimalsIn,
          decimalsOut,
          oracleIn.priceUsdE18,
          oracleOut.priceUsdE18
        )
      : null;
    return {
      ...s,
      oracleDeviationBps: deviation,
    };
  });
}

/**
 * One maker, one wallet, not one slot per strategy.
 *
 * `measureDepth` returns one entry per STRATEGY, so a maker who shipped three
 * strategies for the same token appears three times, each independently
 * clamped to `min(virtual, wallet, allowance)`. That per-strategy clamp is
 * correct on its own, but summing three of them for one maker is not: all
 * three draw against the exact same wallet balance, which `pull()` settles
 * from once, not three times. Caught live on Base mainnet -- one maker's three
 * strategies each clamped to their real 3.93e12 wei WETH balance, summed to
 * 8.24e12 in the route, and the swap came back short.
 *
 * This is not a heuristic: a maker's total deliverable capacity for one token
 * is bounded by their one wallet and one allowance no matter how many
 * strategies reference it, so the extras add exactly zero real capacity.
 * It also keeps Tap.sol's own on-chain `totalDepth` honest, since that is a
 * sum over whatever candidate set this hookData ships.
 */
export function dedupeByMaker(depths: MakerDepth[]): MakerDepth[] {
  // One candidate per maker, chosen by PRICE, not by size.
  //
  // This used to keep whichever sibling held the most, on the assumption that
  // a maker's strategies price alike. They need not. Our own Base maker carried
  // a stale set at 5,833 USDC/WETH beside a repriced set at 2,526; the stale one
  // held 12.0e12 against the new one's 11.7e12, won the comparison by that
  // rounding margin, and quoted every taker at 2.3x market. The book looked
  // mispriced when only the selection was.
  //
  // filterFillable probes every strategy with the SAME input, so probeOut is a
  // like-for-like price. Depth stays the tie-break: it is a ceiling on how much
  // can be filled, never a statement about the rate.
  const better = (a: MakerDepth, b: MakerDepth) => {
    const ao = a.probeOut ?? 0n, bo = b.probeOut ?? 0n;
    if (ao !== bo) return ao > bo;
    return a.depth > b.depth;
  };
  const best = new Map<string, MakerDepth>();
  for (const d of depths) {
    const key = d.maker.toLowerCase();
    const existing = best.get(key);
    if (!existing || better(d, existing)) best.set(key, d);
  }
  return [...best.values()].filter((d) => d.solvent).sort(byDepthDesc);
}

// Sweep resolution. Tuned down from 96/48/2 after Base mainnet's real maker
// count (unlike Sepolia's handful of seeded ones) made /api/route take 20-30s.
// Measured, not guessed: a bare eth_blockNumber round trip to the same RPC
// returns in well under a second, so the cost is not network latency -- it is
// a public node simulating every candidate in one multicall. Cutting
// resolution is a precision trade, never a safety one: a probe is only ever
// accepted when its quote landed at or under real depth, so a coarser sweep
// converges to a slightly smaller, still entirely fillable amount.
const GEOMETRIC_STEPS = 16;
const LINEAR_STEPS = 12;
const REFINEMENTS = 1;

/**
 * Whether the deployed Tap folds its pro-rata remainder into the first slice.
 *
 * True as of the redeploy at 0xeAdD3C76bB9f3D8Aa26fA9F793A893e2aBa24088
 * (Base mainnet, block 51140916) -- built from the current src/Tap.sol, which
 * carries the fold. Before that redeploy this was false: the live bytecode
 * swept the remainder as a fill of its own, a lone wei of a 6-decimal token
 * quotes to zero on every maker, that sweep never placed anything, and every
 * multi-maker route reverted on CouldNotFillEntireSwap. Measured, not
 * assumed: quote(1 wei) came back 0 from both makers on the live USDC/WETH
 * route, and the smallest input that split without a remainder at all was
 * ~1.4e13 wei (13.7M USDC) -- unreachable in practice, so it was not a rare
 * edge case, it was every split, always.
 *
 * If this ever needs to go back to false -- a rollback, a second network
 * whose Tap predates the fold -- the planner falls back to a single maker on
 * its own; no other code path needs to change.
 */
const DUST_IS_FOLDED_ON_CHAIN = true;

/** What Tap.sol will actually do, replayed off-chain. */
export type TapPlan = {
  /** the `amountIn` to hand Wellhead.swap -- what Tap.sol calls `takeIn` */
  takeIn: bigint;
  /** per candidate, in hookData order, exactly the slices Tap.sol will compute */
  slices: Slice[];
  amountOut: bigint;
  perMaker: { maker: Address; amountOut: bigint }[];
  /** candidates whose own ceiling forced `takeIn` below what was asked for */
  binding: { maker: Address; from: bigint; to: bigint }[];
  /** the surviving set this plan was computed over -- what hookData must carry,
   *  since Tap.sol sums its own totalDepth over exactly the blob it is given */
  candidates: MakerDepth[];
};

/**
 * Replay `Tap.sol::beforeSwap` off-chain, exactly.
 *
 * This used to be `planRoute` + `clampToDepth`, which quoted a number the hook
 * could not honour. The reason is worth writing down, because the two
 * algorithms look interchangeable and are not:
 *
 *   - Off-chain, we pro-rated the input by depth and then SHRANK any slice
 *     whose quote came out above that maker's depth.
 *   - On-chain, Tap.sol pro-rates by depth and then, per maker, either fills
 *     the slice WHOLE or skips that maker entirely (`_fill`: `expected >
 *     depth[i]` is a skip, never a clamp). It never shrinks anything.
 *
 * So our shrink had no counterpart in the hook. Worse, the per-slice amounts
 * we computed were never sent anywhere: hookData carries the candidate
 * STRATEGIES, and Tap.sol recomputes every slice itself from `takeIn` and
 * freshly-read on-chain depths. The only two numbers we actually control are
 * the candidate set and the total. A total derived from post-shrink slices is
 * one Tap.sol will re-split by unshrunk weights, hand some maker more than
 * their quote allows, skip them, and revert the whole swap on
 * `CouldNotFillEntireSwap` -- which is exactly what Base mainnet did.
 *
 * Framed against the real algorithm the answer is closed-form. Tap's weights
 * are fixed by depth, so for candidate `i`, `slice_i = takeIn * depth_i /
 * totalDepth` is monotonic in `takeIn`. Find `s_i`, the largest slice whose
 * quote still fits under `depth_i`, and invert: `T_i = s_i * totalDepth /
 * depth_i` is the largest total at which maker `i` is still fillable. Every
 * maker must survive, so the answer is the smallest of those, capped by what
 * was asked for. At that total, no candidate is skipped and the fill
 * completes -- correct by construction rather than by margin.
 */
export async function planLikeTap(
  n: Network,
  candidates: MakerDepth[],
  requested: bigint,
  tokenIn: Address,
  tokenOut: Address,
  app: Address = n.router
): Promise<TapPlan> {
  const empty: TapPlan = { takeIn: 0n, slices: [], amountOut: 0n, perMaker: [], binding: [], candidates: [] };
  if (candidates.length === 0 || requested === 0n) return empty;

  // A candidate whose own pro-rata slice prices to nothing contributes nothing:
  // Tap skips it (`expected == 0`) and leans on the sweep pass to place the
  // share it left behind. Rather than plan around that, drop it from the set --
  // then it is not in hookData either, so Tap's totalDepth is a sum over real
  // contributors only and every remaining weight gets correspondingly bigger.
  // Dropping changes the weights, which can strand a different candidate, so
  // this runs to a fixed point; each pass strictly shrinks the set.
  let live = candidates;
  let ceiling: bigint[] = [];
  for (let pass = 0; pass < 4; pass++) {
    const totalDepth = live.reduce((a, c) => a + c.depth, 0n);
    if (totalDepth === 0n) return empty;
    ceiling = await maxSliceWithinDepth(
      n,
      live,
      live.map((c) => (requested * c.depth) / totalDepth),
      tokenIn,
      tokenOut,
      app
    );
    const kept = live.filter((_, i) => ceiling[i] > 0n);
    if (kept.length === live.length) break;
    if (kept.length === 0) return empty;
    live = kept;
  }
  if (live.length === 0) return empty;

  const totalDepth = live.reduce((a, c) => a + c.depth, 0n);
  if (totalDepth === 0n) return empty;

  const sliceAt = (takeIn: bigint, i: number) => (takeIn * live[i].depth) / totalDepth;
  const asSlice = (i: number, amountIn: bigint): Slice => ({
    maker: live[i].maker,
    strategyHash: live[i].strategyHash,
    strategy: live[i].strategy,
    amountIn,
    depth: live[i].depth,
  });

  let takeIn = requested;
  const binding: { maker: Address; from: bigint; to: bigint }[] = [];
  for (let i = 0; i < live.length; i++) {
    // Invert the weight: the largest total at which THIS maker's slice still
    // fits under their own ceiling. Rounds down, so the resulting slice is
    // always <= the ceiling, never a wei over.
    const limit = (ceiling[i] * totalDepth) / live[i].depth;
    if (limit < takeIn) {
      binding.push({ maker: live[i].maker, from: takeIn, to: limit });
      takeIn = limit;
    }
  }
  if (takeIn === 0n) return empty;

  // Verify rather than assert. One exact replay of the hook at the chosen
  // total: if any candidate would be skipped, or the integer-division dust the
  // sweep pass has to place cannot be placed, back off and try again. In
  // practice the closed form lands first time; this is here so a quote is
  // never published that the hook has not been shown to honour.
  for (let attempt = 0; attempt < 4 && takeIn > 0n; attempt++) {
    const run = await replayTapFill(n, live, takeIn, tokenIn, tokenOut, sliceAt, asSlice, app);
    if (run) return { ...run, binding, candidates: live };
    takeIn = (takeIn * 995n) / 1000n;
  }

  // Nothing multi-maker survives the replay. On a hook whose pro-rata
  // remainder has to be placed as a fill of its own, that is the normal
  // outcome rather than an edge case: the remainder is a wei or two, a wei of
  // a 6-decimal token quotes to zero, a zero quote reads as "skip", and the
  // fill reverts having placed everything else. The smallest USDC input that
  // splits without a remainder at all is ~1.4e13 wei, so there is no total
  // worth searching for.
  //
  // One maker has no remainder to place: their single slice is the whole
  // input by construction. So rather than quote a split the hook will refuse,
  // fall back to the deepest maker alone -- a smaller, real, fillable route
  // instead of a larger imaginary one. Deployments carrying the dust-fold fix
  // never reach this, because the multi-maker replay succeeds above.
  if (live.length > 1) {
    const solo = live.slice(0, 1);
    const soloTotal = solo[0].depth;
    const soloSlice = (t: bigint, _i: number) => t; // one candidate, whole input
    const soloAs = (i: number, amountIn: bigint): Slice => ({
      maker: solo[i].maker,
      strategyHash: solo[i].strategyHash,
      strategy: solo[i].strategy,
      amountIn,
      depth: solo[i].depth,
    });
    const soloCeiling = await maxSliceWithinDepth(
      n,
      solo,
      [(requested * solo[0].depth) / soloTotal],
      tokenIn,
      tokenOut,
      app
    );
    let soloTake = soloCeiling[0] < requested ? soloCeiling[0] : requested;
    for (let attempt = 0; attempt < 3 && soloTake > 0n; attempt++) {
      const run = await replayTapFill(n, solo, soloTake, tokenIn, tokenOut, soloSlice, soloAs, app);
      if (run) {
        return {
          ...run,
          binding: soloTake < requested
            ? [{ maker: solo[0].maker, from: requested, to: soloTake }]
            : [],
          candidates: solo,
        };
      }
      soloTake = (soloTake * 995n) / 1000n;
    }
  }

  return empty;
}

/**
 * One faithful pass of Tap.sol's two fill loops at a given total. Returns null
 * when the hook would come up short, which is the same thing as
 * `CouldNotFillEntireSwap` and must never be quoted to a user as a fill.
 */
async function replayTapFill(
  n: Network,
  candidates: MakerDepth[],
  takeIn: bigint,
  tokenIn: Address,
  tokenOut: Address,
  sliceAt: (takeIn: bigint, i: number) => bigint,
  asSlice: (i: number, amountIn: bigint) => Slice,
  app: Address = n.router
): Promise<Omit<TapPlan, "binding" | "candidates"> | null> {
  // --- pass 2 in the hook: pro-rata slices, quoted in one multicall ---
  //
  // This models the hook that is DEPLOYED, which is not the same as the hook
  // in src/Tap.sol. The source now folds the integer-division remainder into
  // the first slice; the deployed bytecode still tries to place it as a fill
  // of its own, which cannot work (see DUST_IS_FOLDED_ON_CHAIN). Modelling the
  // deployed behaviour is the conservative choice: a plan that survives the
  // sweep model also survives the fold model, so quotes stay honest across the
  // redeploy rather than briefly promising fills the live hook would refuse.
  const planned = candidates.map((_, i) => sliceAt(takeIn, i));
  if (DUST_IS_FOLDED_ON_CHAIN) {
    const dust = planned.reduce((rem, s) => rem - s, takeIn);
    if (planned.length > 0) planned[0] += dust;
  }
  const probes: Slice[] = [];
  const owner: number[] = [];
  planned.forEach((amt, i) => {
    if (amt > 0n) {
      probes.push(asSlice(i, amt));
      owner.push(i);
    }
  });
  if (probes.length === 0) return null;

  const q = await quoteRoute(n, probes, tokenIn, tokenOut, app);

  let remaining = takeIn;
  let totalOut = 0n;
  const filled = new Array<bigint>(candidates.length).fill(0n);
  const out = new Array<bigint>(candidates.length).fill(0n);

  probes.forEach((p, idx) => {
    const i = owner[idx];
    if (remaining === 0n) return;
    // Tap caps a slice at what is left, and only ever decrements `remaining`
    // on a fill that actually lands -- a skipped maker leaves it untouched.
    const slice = p.amountIn > remaining ? remaining : p.amountIn;
    if (candidates[i].depth === 0n || slice === 0n) return;
    const got = q.perMaker[idx]?.amountOut ?? 0n;
    // `_fill`'s own guard, verbatim: a reverted quote reads as zero out, and
    // anything above this maker's depth is skipped whole, not trimmed.
    if (got === 0n || got > candidates[i].depth) return;
    remaining -= slice;
    totalOut += got;
    filled[i] = slice;
    out[i] = got;
  });

  // --- pass 3 in the hook: sweep the integer-division dust onto whoever takes it ---
  if (remaining > 0n) {
    const sweepProbes: Slice[] = [];
    const sweepOwner: number[] = [];
    candidates.forEach((c, i) => {
      if (c.depth > 0n) {
        sweepProbes.push(asSlice(i, remaining));
        sweepOwner.push(i);
      }
    });
    if (sweepProbes.length > 0) {
      const sq = await quoteRoute(n, sweepProbes, tokenIn, tokenOut, app);
      sweepProbes.forEach((p, idx) => {
        const i = sweepOwner[idx];
        if (remaining === 0n) return;
        const got = sq.perMaker[idx]?.amountOut ?? 0n;
        if (got === 0n || got > candidates[i].depth) return;
        remaining -= p.amountIn;
        totalOut += got;
        filled[i] += p.amountIn;
        out[i] += got;
      });
    }
  }

  // Tap reverts unless every unit asked for was placed, and unless something
  // came back. Anything less is not a quote, it is a failed transaction.
  if (remaining !== 0n || totalOut === 0n) return null;

  const slices: Slice[] = [];
  const perMaker: { maker: Address; amountOut: bigint }[] = [];
  candidates.forEach((c, i) => {
    if (filled[i] === 0n) return;
    slices.push(asSlice(i, filled[i]));
    perMaker.push({ maker: c.maker, amountOut: out[i] });
  });

  return { takeIn, slices, amountOut: totalOut, perMaker };
}

/**
 * Per candidate, the largest slice whose quote still lands at or under that
 * candidate's depth -- the `s_i` the closed form above inverts.
 *
 * Batched the same way the old clamp was: a geometric halving pass to bracket
 * the answer for every candidate at once, then linear passes inside each
 * bracket, one multicall each. A quote is monotonic in its input, so the
 * largest feasible probe is a lower bound on the true ceiling, and rounding
 * down is always safe -- it can only ask a maker for less than they can give.
 */
async function maxSliceWithinDepth(
  n: Network,
  candidates: MakerDepth[],
  upper: bigint[],
  tokenIn: Address,
  tokenOut: Address,
  app: Address = n.router
): Promise<bigint[]> {
  const asSlice = (i: number, amountIn: bigint): Slice => ({
    maker: candidates[i].maker,
    strategyHash: candidates[i].strategyHash,
    strategy: candidates[i].strategy,
    amountIn,
    depth: candidates[i].depth,
  });

  const sweep = async (perCandidate: bigint[][]): Promise<(bigint | null)[]> => {
    const probes: Slice[] = [];
    const owner: number[] = [];
    perCandidate.forEach((list, i) =>
      list.forEach((amt) => {
        if (amt > 0n) {
          probes.push(asSlice(i, amt));
          owner.push(i);
        }
      })
    );
    const best: (bigint | null)[] = candidates.map(() => null);
    if (probes.length === 0) return best;

    const q = await quoteRoute(n, probes, tokenIn, tokenOut, app);
    probes.forEach((p, idx) => {
      const i = owner[idx];
      const got = q.perMaker[idx]?.amountOut ?? 0n;
      if (got === 0n) return; // reverted or priced to nothing: not feasible
      if (got > candidates[i].depth) return;
      if (best[i] === null || p.amountIn > best[i]!) best[i] = p.amountIn;
    });
    return best;
  };

  const geo = candidates.map((_, i) => {
    const list: bigint[] = [];
    let v = upper[i];
    for (let k = 0; k < GEOMETRIC_STEPS && v > 0n; k++) {
      list.push(v);
      v /= 2n;
    }
    return list;
  });

  let lo = (await sweep(geo)).map((v) => v ?? 0n);
  let hi = lo.map((v, i) => (v === 0n ? upper[i] : v * 2n > upper[i] ? upper[i] : v * 2n));

  for (let r = 0; r < REFINEMENTS; r++) {
    const lin = candidates.map((_, i) => {
      const span = hi[i] - lo[i];
      if (span <= 0n) return [];
      const step = span / BigInt(LINEAR_STEPS);
      if (step === 0n) return [];
      return Array.from({ length: LINEAR_STEPS }, (_, t) => lo[i] + step * BigInt(t + 1));
    });
    const found = await sweep(lin);
    found.forEach((v, i) => {
      if (v !== null && v > lo[i]) {
        const step = (hi[i] - lo[i]) / BigInt(LINEAR_STEPS);
        lo[i] = v;
        hi[i] = v + (step > 0n ? step : 0n);
      }
    });
  }

  return lo;
}

/** The blob the Tap hook receives as `hookData`: TapData{ bytes[] strategies, bytes takerTraits }.
 *  Takes anything carrying strategy bytes, because the set that ships has to be
 *  the candidate set the plan was computed over, not only the ones that filled. */
export function encodeHookData(slices: { strategy: Hex }[]): Hex {
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
export async function quoteRoute(
  n: Network,
  slices: Slice[],
  tokenIn: Address,
  tokenOut: Address,
  /** Which SwapVM router to quote through. Must be the app the strategies were
   *  shipped to: an opcode-35 program quoted against 1inch's canonical router
   *  hits an opcode its table does not have, and the encumbrance haircut is
   *  exactly what the quote is meant to reflect. */
  app: Address = n.router
) {
  if (slices.length === 0) return { amountOut: 0n, perMaker: [] as { maker: Address; amountOut: bigint }[] };

  const contracts = slices.map((s) => {
    const [order] = decodeAbiParameters(
      parseAbiParameters("(address maker, uint256 traits, bytes data)"),
      s.strategy
    );
    return {
      address: app,
      abi: swapVmAbi,
      functionName: "quote",
      args: [order, tokenIn, tokenOut, s.amountIn, TAKER_TRAITS],
    } as const;
  });

  const res = await clientFor(n).multicall({ contracts, allowFailure: true });

  let amountOut = 0n;
  const perMaker = res.map((r, i) => {
    const out = r.status === "success" ? ((r.result as unknown as [bigint, bigint, Hex])[1] ?? 0n) : 0n;
    amountOut += out;
    return { maker: slices[i].maker, amountOut: out };
  });

  return { amountOut, perMaker };
}


/**
 * Drop makers whose strategy cannot be filled by us at all.
 *
 * Depth says a maker HAS the token. It does not say they will hand it over.
 * A strategy can carry an access control the taker fails — 1inch's own dApp
 * attaches a KycNFT check to everything it ships — or price a pair we did not
 * ask about, or run a program this router cannot drive. All of those revert the
 * quote, which `allowFailure` reports as a payout of zero.
 *
 * Left in the plan, such a maker is handed a share of the swapper's input and
 * returns nothing for it. One multicall up front removes them, and the input
 * they would have wasted goes to makers who can actually fill.
 */
export async function filterFillable(
  n: Network,
  depths: MakerDepth[],
  tokenIn: Address,
  tokenOut: Address,
  amountIn: bigint,
  app: Address = n.router
): Promise<{ fillable: MakerDepth[]; unfillable: Address[] }> {
  const solvent = depths.filter((d) => d.solvent);
  if (solvent.length === 0) return { fillable: [], unfillable: [] };

  // The probe is a fraction of the REQUESTED input, never of depth. Depth is
  // denominated in tokenOut and the probe is spent in tokenIn: for WETH in and
  // USDC out that mistake probes 8.5e6 wei of WETH, quotes out zero USDC, and
  // marks every honest maker gated — silently disabling the whole direction.
  const probe = amountIn / 1000n > 0n ? amountIn / 1000n : amountIn > 0n ? amountIn : 1n;
  const probes: Slice[] = solvent.map((d) => ({
    maker: d.maker,
    strategyHash: d.strategyHash,
    strategy: d.strategy,
    amountIn: probe,
    depth: d.depth,
  }));

  const q = await quoteRoute(n, probes, tokenIn, tokenOut, app);
  const fillable: MakerDepth[] = [];
  const unfillable: Address[] = [];
  solvent.forEach((d, i) => {
    const out = q.perMaker[i]?.amountOut ?? 0n;
    // Carry the probe result. Every probe used the same input, so these outputs
    // rank the strategies by price -- which is what dedupeByMaker needs and
    // depth cannot tell it.
    if (out > 0n) fillable.push({ ...d, probeOut: out });
    else unfillable.push(d.maker);
  });
  return { fillable, unfillable };
}
