import { type Address } from "viem";

export type MakerStatus = "SOLVENT" | "CLAMPED" | "SKIPPED_GHOST" | "UNFILLABLE";

export interface SolvencyWaterfallSlice {
  maker: Address;
  amountIn: bigint;
  amountOut: bigint;
  depth: bigint;
  percentageOfFill: number;
  status: MakerStatus;
  oracleDeviationBps?: number | null;
  reason?: string;
}

export interface SolvencyEngineResult {
  slices: SolvencyWaterfallSlice[];
  totalFilled: bigint;
  unfilled: bigint;
  improvementBps: number;
  solventCount: number;
  clampedCount: number;
  ghostCount: number;
  unfillableCount: number;
  /** What the route API considered, counted in STRATEGIES. A maker can hold
   *  several, so this is larger than slices.length, which counts wallets. The
   *  receipt quotes this; the inspector quotes wallets; showing both without
   *  saying which is which is how one screen ends up with two totals. */
  strategiesConsidered: number;
  /** Wallets that landed in both makersSkipped and makersUnfillable and were
   *  counted once, as skipped. The remaining gap between the two totals. */
  dedupedOverlap: number;
  shieldedVolume: bigint;
  savingsUsdFormatted?: string;
}

/**
 * Transforms raw route API responses into an enriched solvency waterfall model.
 *
 * Classifies each maker's status:
 * - SOLVENT: Delivered the allocated quote without restriction.
 * - CLAMPED: Virtual curve quoted more than wallet held; slice was safely clamped to real depth.
 * - SKIPPED_GHOST: Insolvent wallet (depth == 0) safely skipped via Tap.sol.
 * - UNFILLABLE: Quote reverted or rejected; skipped without risking user capital.
 */
function extractAddress(item: unknown): string {
  if (!item) return "";
  if (typeof item === "string") return item.toLowerCase();
  if (typeof item === "object") {
    if ("maker" in item && typeof (item as { maker?: unknown }).maker === "string") {
      return (item as { maker: string }).maker.toLowerCase();
    }
    if ("address" in item && typeof (item as { address?: unknown }).address === "string") {
      return (item as { address: string }).address.toLowerCase();
    }
  }
  return "";
}

export function buildSolvencyWaterfall(route: any): SolvencyEngineResult {
  if (!route) {
    return {
      slices: [],
      totalFilled: 0n,
      unfilled: 0n,
      improvementBps: 0,
      solventCount: 0,
      clampedCount: 0,
      ghostCount: 0,
      unfillableCount: 0,
      strategiesConsidered: 0,
      dedupedOverlap: 0,
      shieldedVolume: 0n,
    };
  }

  const rawSlices = Array.isArray(route.slices) ? route.slices : [];
  const rawClamped = Array.isArray(route.clamped) ? route.clamped : [];
  const rawSkipped = Array.isArray(route.makersSkipped) ? route.makersSkipped : [];
  const rawUnfillable = Array.isArray(route.makersUnfillable) ? route.makersUnfillable : [];

  const totalFilled = BigInt(route.amountFilled ?? 0);
  const unfilled = BigInt(route.unfilled ?? 0);
  const improvementBps = Number(route.improvementBps ?? 0);

  const clampedSet = new Set(rawClamped.map(extractAddress).filter(Boolean));
  const unfillableSet = new Set(rawUnfillable.map(extractAddress).filter(Boolean));
  const skippedSet = new Set(rawSkipped.map(extractAddress).filter(Boolean));

  const slices: SolvencyWaterfallSlice[] = [];
  let solventCount = 0;
  let clampedCount = 0;

  for (const s of rawSlices) {
    const makerAddr = (extractAddress(s.maker) || s.maker) as Address;
    const isClamped = clampedSet.has(makerAddr.toLowerCase());
    const status: MakerStatus = isClamped ? "CLAMPED" : "SOLVENT";

    if (isClamped) clampedCount++;
    else solventCount++;

    const amtIn = BigInt(s.amountIn ?? 0);
    const amtOut = BigInt(s.amountOut ?? 0);
    const depth = BigInt(s.depth ?? 0);

    const percentageOfFill =
      totalFilled > 0n ? Number((amtIn * 10_000n) / totalFilled) / 100 : 0;

    slices.push({
      maker: makerAddr,
      amountIn: amtIn,
      amountOut: amtOut,
      depth,
      percentageOfFill,
      status,
      oracleDeviationBps: s.oracleDeviationBps !== null && s.oracleDeviationBps !== undefined
        ? Number(s.oracleDeviationBps)
        : null,
      reason: isClamped ? "Quote clamped to real balance" : "Fully solvent fill",
    });
  }

  // Add skipped ghost makers to the waterfall model so the UI/user sees the protection
  let ghostCount = 0;
  let shieldedVolume = 0n;

  for (const ghost of rawSkipped) {
    const addr = (extractAddress(ghost) || ghost) as Address;
    if (!addr) continue;
    ghostCount++;
    slices.push({
      maker: addr,
      amountIn: 0n,
      amountOut: 0n,
      depth: 0n,
      percentageOfFill: 0,
      status: "SKIPPED_GHOST",
      reason: "EncumbranceZeroBacking: 0 deliverable depth — skipped atomically to avoid tx revert",
    });
  }

  let unfillableCount = 0;
  let dedupedOverlap = 0;
  for (const unfillable of rawUnfillable) {
    const addr = (extractAddress(unfillable) || unfillable) as Address;
    if (!addr) continue;
    // A wallet can be reported both skipped and unfillable. Count it once, as
    // skipped, and remember how many -- that count is the difference between
    // the receipt's strategy total and the wallet total shown here.
    if (skippedSet.has(addr.toLowerCase())) {
      dedupedOverlap++;
      continue;
    }
    unfillableCount++;
    slices.push({
      maker: addr,
      amountIn: 0n,
      amountOut: 0n,
      depth: 0n,
      percentageOfFill: 0,
      status: "UNFILLABLE",
      reason: "QuoteUnusable: quote reverted or rejected — skipped safely",
    });
  }

  return {
    slices,
    totalFilled,
    unfilled,
    improvementBps,
    strategiesConsidered: Number(route.makersConsidered ?? 0),
    dedupedOverlap,
    solventCount,
    clampedCount,
    ghostCount,
    unfillableCount,
    shieldedVolume,
  };
}
