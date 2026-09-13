import { NETWORKS, type NetworkId } from "./networks";
import { pairsFor, allTokensFor } from "./pairs";
import type { RouteResponse } from "@/app/ui/types";

export type CrossChainToken = {
  address: string;
  symbol: string;
  decimals: number;
};

/**
 * Identify the recommended alternate network for comparison.
 * Default mapping: Base (8453) <-> Ethereum (1), Base Sepolia (84532) -> Base (8453).
 */
export function getAlternateChain(currentChainId: NetworkId): NetworkId {
  if (currentChainId === 8453) return 1;
  if (currentChainId === 1) return 8453;
  return 8453;
}

/**
 * Finds the corresponding token on the target chain by matching symbols.
 */
export function findCounterpartToken(
  token: CrossChainToken,
  targetChainId: NetworkId
): CrossChainToken | null {
  const sym = token.symbol.toUpperCase();
  const net = NETWORKS[targetChainId];
  if (!net) return null;

  if (sym === "USDC") {
    return { address: net.usdc, symbol: "USDC", decimals: 6 };
  }
  if (sym === "WETH" || sym === "ETH") {
    return { address: net.weth, symbol: "WETH", decimals: 18 };
  }

  // Check all known tokens configured for the target chain
  const targetTokens = allTokensFor(targetChainId);
  for (const t of Object.values(targetTokens)) {
    if (t.symbol.toUpperCase() === sym) {
      return { address: t.address, symbol: t.symbol, decimals: t.decimals };
    }
  }

  return null;
}

export type CrossChainComparison = {
  hasAdvantage: boolean;
  reason: "unfilled_current" | "better_rate" | "deeper_solvency" | "active_hook" | "none";
  title: string;
  detail: string;
  targetChainId: NetworkId;
  targetChainLabel: string;
  currentAmountOut: bigint;
  altAmountOut: bigint;
  improvementBps: number;
  multiplier: number;
  currentMakers: number;
  altMakers: number;
  currentDeviationBps: number | null;
  altDeviationBps: number | null;
};

function getWorstDeviation(route: RouteResponse | null): number | null {
  if (!route?.slices?.length) return null;
  let worst: number | null = null;
  for (const sl of route.slices) {
    if (sl.oracleDeviationBps == null) continue;
    const d = Number(sl.oracleDeviationBps);
    if (worst === null || d < worst) worst = d;
  }
  return worst;
}

/**
 * Compare current route against alternate route to determine if a cross-chain
 * recommendation should be surfaced to the swapper.
 */
export function evaluateCrossChainAdvantage(
  currentRoute: RouteResponse | null,
  altRoute: RouteResponse | null,
  currentChainId: NetworkId,
  targetChainId: NetworkId
): CrossChainComparison {
  const targetNet = NETWORKS[targetChainId];
  const targetChainLabel = targetNet ? targetNet.label : `Chain ${targetChainId}`;

  const defaultResult: CrossChainComparison = {
    hasAdvantage: false,
    reason: "none",
    title: "",
    detail: "",
    targetChainId,
    targetChainLabel,
    currentAmountOut: 0n,
    altAmountOut: 0n,
    improvementBps: 0,
    multiplier: 1,
    currentMakers: 0,
    altMakers: 0,
    currentDeviationBps: null,
    altDeviationBps: null,
  };

  if (!altRoute || altRoute.error || altRoute.amountOut === "0") {
    return defaultResult;
  }

  const curOut = currentRoute && !currentRoute.error ? BigInt(currentRoute.amountOut) : 0n;
  const altOut = BigInt(altRoute.amountOut);
  const curDev = getWorstDeviation(currentRoute);
  const altDev = getWorstDeviation(altRoute);
  // Wallets the route actually fills from -- not strategies considered, which counts
  // every strategy checked (477 on Ethereum) and read as "477 solvent makers".
  const curMakers = currentRoute?.makersUsed ?? 0;
  const altMakers = altRoute?.makersUsed ?? 0;
  // Integer-division dust (a few units of a 6-decimal token) is not "unfilled": only
  // count a shortfall above 0.1% of the input. And only call the other chain a full
  // fill if it actually is one and pays at least as much.
  const unfilledShare = (r: RouteResponse | null) =>
    r && BigInt(r.amountIn ?? "0") > 0n ? (BigInt(r.unfilled ?? "0") * 1000n) / BigInt(r.amountIn) : 1000n;
  const curUnfilled = unfilledShare(currentRoute) > 0n;
  const altFull = unfilledShare(altRoute) === 0n;

  // (A former case here recommended Base whenever the active chain was Ethereum, on the
  // grounds that Ethereum had no hook. Bone Dry is deployed on Ethereum now, so the only
  // reasons left to suggest the other chain are measured ones below.)

  // Case 2: Output and Rate advantage (evaluated first so huge multipliers like 8x are highlighted)
  if (curOut > 0n && altOut > curOut) {
    const diff = altOut - curOut;
    const bps = Number((diff * 10000n) / curOut);
    const mult = Number((altOut * 100n) / curOut) / 100;

    const currentHasSevereSlippage = curDev !== null && curDev <= -100;
    if (bps >= 100 || currentHasSevereSlippage || mult >= 1.2) {
      return {
        ...defaultResult,
        hasAdvantage: true,
        reason: "better_rate",
        title: mult >= 1.3 ? `${mult.toFixed(1)}× More Output on ${targetChainLabel}` : `+${(bps / 100).toFixed(1)}% Better Rate on ${targetChainLabel}`,
        detail: currentHasSevereSlippage
          ? `Current chain quotes ${(Math.abs(curDev!) / 100).toFixed(0)}% below the oracle. ${targetChainLabel} fills the same trade from ${altMakers} wallet${altMakers === 1 ? "" : "s"}.`
          : `More deliverable output from ${altMakers} wallet${altMakers === 1 ? "" : "s"} on ${targetChainLabel}.`,
        currentAmountOut: curOut,
        altAmountOut: altOut,
        improvementBps: bps,
        multiplier: mult,
        currentMakers: curMakers,
        altMakers: altMakers,
        currentDeviationBps: curDev,
        altDeviationBps: altDev,
      };
    }
  }

  // Case 3: Current route has zero fill or unfilled amount, but alternate chain has fillable output
  if ((curOut === 0n || curUnfilled) && altFull && altOut >= curOut) {
    return {
      ...defaultResult,
      hasAdvantage: true,
      reason: "unfilled_current",
      title: `Full Fill Available on ${targetChainLabel}`,
      detail: `${targetChainLabel} fills it from ${altMakers} wallet${altMakers === 1 ? "" : "s"}.`,
      currentAmountOut: curOut,
      altAmountOut: altOut,
      currentMakers: curMakers,
      altMakers: altMakers,
      currentDeviationBps: curDev,
      altDeviationBps: altDev,
    };
  }

  // Case 4: Deep maker advantage (e.g. 50+ makers vs <=2 makers)
  if (altMakers >= 5 && curMakers <= 2) {
    return {
      ...defaultResult,
      hasAdvantage: true,
      reason: "deeper_solvency",
      title: `Deeper book on ${targetChainLabel}`,
      detail: `${altMakers} wallet${altMakers === 1 ? "" : "s"} fill on ${targetChainLabel} vs ${curMakers} here.`,
      currentAmountOut: curOut,
      altAmountOut: altOut,
      currentMakers: curMakers,
      altMakers: altMakers,
      currentDeviationBps: curDev,
      altDeviationBps: altDev,
    };
  }

  return defaultResult;
}
