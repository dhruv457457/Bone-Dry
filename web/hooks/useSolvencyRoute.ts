import { useMemo } from "react";
import { buildSolvencyWaterfall, type SolvencyEngineResult } from "../lib/solvencyEngine";

/**
 * Reactive React hook that inspects route solvency and provides structured
 * data ready for UI consumption without any styling constraints.
 */
export function useSolvencyRoute(route: any): SolvencyEngineResult & {
  hasGhosts: boolean;
  hasClamped: boolean;
  isMultiMaker: boolean;
  summaryText: string;
} {
  return useMemo(() => {
    const result = buildSolvencyWaterfall(route);
    const hasGhosts = result.ghostCount > 0;
    const hasClamped = result.clampedCount > 0;
    const isMultiMaker = result.solventCount + result.clampedCount > 1;

    let summaryText = "";
    if (result.totalFilled > 0n) {
      if (hasGhosts) {
        summaryText = `Protected trade: ${result.ghostCount} ghost maker(s) skipped atomically; filled across ${result.solventCount + result.clampedCount} solvent maker(s).`;
      } else if (result.improvementBps > 0) {
        summaryText = `Optimal routing: +${result.improvementBps} bps price improvement across ${result.solventCount} makers.`;
      } else {
        summaryText = `100% backed fill across ${result.solventCount} maker(s).`;
      }
    }

    return {
      ...result,
      hasGhosts,
      hasClamped,
      isMultiMaker,
      summaryText,
    };
  }, [route]);
}
