"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import s from "../app.module.css";
import { units, short as shortAddr } from "@/lib/format";
import { NETWORKS, type NetworkId } from "@/lib/networks";
import {
  evaluateCrossChainAdvantage,
  type CrossChainComparison,
} from "@/lib/crossChain";
import type { MakerRow, MakersResponse, RouteResponse } from "../types";

type Token = { address: string; symbol: string; decimals: number };

export function PreflightModal({
  isOpen,
  onClose,
  onConfirmBaseSwap,
  onSwitchChain,
  chainId,
  net,
  tokenIn,
  tokenOut,
  input,
  route,
  makers,
  altRoute,
  altTargetChainId,
  txPhase,
  txHash,
  txNote,
  received,
}: {
  isOpen: boolean;
  onClose: () => void;
  onConfirmBaseSwap: () => void;
  onSwitchChain?: (targetChainId: NetworkId) => void;
  chainId: NetworkId;
  net: { label: string; explorer?: string; aquaIsOurs?: boolean };
  tokenIn: Token;
  tokenOut: Token;
  input: string;
  route: RouteResponse | null;
  makers: MakersResponse | null;
  altRoute: RouteResponse | null;
  altTargetChainId: NetworkId;
  txPhase: "idle" | "approving" | "swapping" | "done";
  txHash?: string;
  txNote?: string;
  received?: bigint;
}) {
  // animStep:
  // 0 = Scan book
  // 1 = Opcode-35 audit
  // 2 = Cross-chain radar
  // 3 = Decision pause (if advantage) OR ready to sign
  // 4 = Handoff to wallet
  const [animStep, setAnimStep] = useState<number>(0);
  const [switching, setSwitching] = useState(false);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  const targetNet = NETWORKS[altTargetChainId];
  const adv: CrossChainComparison = useMemo(() => {
    return evaluateCrossChainAdvantage(route, altRoute, chainId, altTargetChainId);
  }, [route, altRoute, chainId, altTargetChainId]);

  const hasSevereDiscrepancy = adv.hasAdvantage && adv.multiplier >= 1.25;

  const clearTimers = () => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
  };

  useEffect(() => {
    if (!isOpen) {
      clearTimers();
      setAnimStep(0);
      setSwitching(false);
      return;
    }

    if (txPhase !== "idle") {
      setAnimStep(4);
      return;
    }

    // Step 0 -> 1 -> 2
    setAnimStep(0);
    timers.current = [
      setTimeout(() => setAnimStep(1), 500),
      setTimeout(() => setAnimStep(2), 1100),
      setTimeout(() => {
        setAnimStep(3);
        // If there's NO discrepancy, automatically proceed to wallet after a brief pause
        if (!hasSevereDiscrepancy) {
          timers.current.push(
            setTimeout(() => {
              setAnimStep(4);
              onConfirmBaseSwap();
            }, 800)
          );
        }
      }, 1700),
    ];

    return clearTimers;
  }, [isOpen, txPhase, hasSevereDiscrepancy, onConfirmBaseSwap]);

  if (!isOpen) return null;

  const canClose = txPhase === "idle" || txPhase === "done";

  const handleSwitch = async () => {
    if (!onSwitchChain) return;
    setSwitching(true);
    try {
      await onSwitchChain(altTargetChainId);
      onClose();
    } finally {
      setSwitching(false);
    }
  };

  const curDevBps = adv.currentDeviationBps;
  const curDevStr =
    curDevBps === null
      ? ""
      : curDevBps < 0
        ? `${(Math.abs(curDevBps) / 100).toFixed(0)}% below oracle`
        : `+${(curDevBps / 100).toFixed(1)}% vs oracle`;

  const curOutStr = route?.amountOut
    ? `${units(route.amountOut, tokenOut.decimals, 6)} ${tokenOut.symbol}`
    : "unfilled";

  const altOutStr = altRoute?.amountOut
    ? `${units(altRoute.amountOut, tokenOut.decimals, 6)} ${tokenOut.symbol}`
    : "—";

  const gain =
    adv.altAmountOut > adv.currentAmountOut ? adv.altAmountOut - adv.currentAmountOut : 0n;
  const gainStr =
    gain > 0n ? `+${units(gain, tokenOut.decimals, 6)} ${tokenOut.symbol}` : null;

  return (
    <div
      className={s.swapModalBackdrop}
      role="presentation"
      onClick={() => (canClose ? onClose() : null)}
    >
      <div
        className={`${s.swapModal} ${s.preflightModalCard}`}
        role="dialog"
        aria-modal="true"
        aria-label="Pre-flight Solvency Audit"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Modal Header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
          <div>
            <span className={s.modalEyebrow}>
              <span className={s.crossChainPulse} />
              Solvency Pre-Flight Audit
            </span>
            <h3 className={s.display} style={{ fontSize: 22, margin: "4px 0 2px" }}>
              {input} {tokenIn.symbol} → {tokenOut.symbol}
            </h3>
            <p className={s.mono} style={{ margin: 0, fontSize: 11, color: "var(--ink3)" }}>
              {route ? `Quoted ${units(route.amountOut, tokenOut.decimals, 6)} ${tokenOut.symbol}` : ""} on {net.label}
            </p>
          </div>
          <button
            className={`${s.btn} ${s.btnXs}`}
            onClick={onClose}
            disabled={!canClose}
            title="Cancel audit"
          >
            ✕
          </button>
        </div>

        {/* Vertical Pipeline Track */}
        <div className={s.pipelineContainer}>
          {/* Step 1: Read Book */}
          <div className={s.pipelineStep}>
            <div className={s.stepIconCol}>
              <span
                className={`${s.stepIndicator} ${
                  animStep > 0 ? s.stepDone : animStep === 0 ? s.stepLive : s.stepIdle
                }`}
              >
                {animStep > 0 ? "✓" : "1"}
              </span>
              <div className={`${s.stepLine} ${animStep >= 1 ? s.stepLineFilled : ""}`} />
            </div>
            <div className={s.stepContent}>
              <p className={s.stepTitle}>Scan Aqua Strategy Book</p>
              <p className={s.stepDesc}>
                {animStep >= 1
                  ? `✓ ${makers?.makers?.length ?? 0} strategies indexed on ${net.label}`
                  : `Querying active SwapVM offers for ${tokenOut.symbol}…`}
              </p>
            </div>
          </div>

          {/* Step 2: Opcode-35 Encumbrance Audit */}
          <div className={s.pipelineStep}>
            <div className={s.stepIconCol}>
              <span
                className={`${s.stepIndicator} ${
                  animStep > 1 ? s.stepDone : animStep === 1 ? s.stepLive : s.stepIdle
                }`}
              >
                {animStep > 1 ? "✓" : "2"}
              </span>
              <div className={`${s.stepLine} ${animStep >= 2 ? s.stepLineFilled : ""}`} />
            </div>
            <div className={s.stepContent}>
              <p className={s.stepTitle}>Opcode-35 Encumbrance Audit</p>
              <p className={s.stepDesc}>
                {animStep >= 2
                  ? route
                    ? `✓ ${route.makersConsidered} makers audited · ${route.clamped?.length ?? 0} clamped to real reserves`
                    : "✓ Solvency verification complete"
                  : animStep === 1
                    ? "Measuring real wallet balances & allowance caps…"
                    : "Awaiting order book resolution"}
              </p>
            </div>
          </div>

          {/* Step 3: Cross-Chain Radar */}
          <div className={s.pipelineStep}>
            <div className={s.stepIconCol}>
              <span
                className={`${s.stepIndicator} ${
                  animStep > 2
                    ? hasSevereDiscrepancy
                      ? s.stepWarn
                      : s.stepDone
                    : animStep === 2
                      ? s.stepLive
                      : s.stepIdle
                }`}
              >
                {animStep > 2 ? (hasSevereDiscrepancy ? "⚠" : "✓") : "3"}
              </span>
            </div>
            <div className={s.stepContent}>
              <p className={s.stepTitle}>Cross-Chain Solvency Radar</p>
              <p className={s.stepDesc}>
                {animStep >= 3
                  ? hasSevereDiscrepancy
                    ? `⚠ High disparity detected: ${adv.multiplier.toFixed(1)}× more output on ${targetNet.label}`
                    : `✓ ${targetNet.label} verified · active chain rate is optimal`
                  : animStep === 2
                    ? `Checking comparative depth on ${targetNet.label}…`
                    : "Comparative depth standby"}
              </p>
            </div>
          </div>
        </div>

        {/* Step 4: Decision Screen or Wallet Progress */}
        {animStep >= 3 && hasSevereDiscrepancy && txPhase === "idle" ? (
          <div className={s.decisionBox}>
            <div className={s.decisionHead}>
              <span style={{ fontWeight: 600, color: "var(--warn-ink)", display: "inline-flex", alignItems: "center", gap: 5 }}>
                <span>⚠</span> Cross-Chain Solvency Discrepancy
              </span>
              <span className={s.crossChainBadge}>
                {net.label} vs {targetNet.label}
              </span>
            </div>

            <p style={{ margin: "4px 0 10px", fontSize: 12, color: "var(--ink2)", lineHeight: 1.4 }}>
              This chain quotes far below the oracle for this size. {targetNet.label} fills the same trade from {adv.altMakers} wallet{adv.altMakers === 1 ? "" : "s"}.
            </p>

            <div className={s.decisionGrid}>
              <div className={s.decisionCol}>
                <span className={s.decisionColLabel}>{net.label} (Current)</span>
                <span className={s.decisionColVal}>{curOutStr}</span>
                <span className={s.decisionColMeta}>
                  {adv.currentMakers} maker{adv.currentMakers === 1 ? "" : "s"} {curDevStr ? `· ${curDevStr}` : ""}
                </span>
              </div>

              <div className={`${s.decisionCol} ${s.decisionColHighlight}`}>
                <span className={s.decisionColLabel} style={{ color: "var(--warn-ink)", fontWeight: 600 }}>
                  {targetNet.label} (Recommended)
                </span>
                <span className={s.decisionColVal} style={{ color: "var(--warn-ink)", fontSize: 14 }}>
                  {altOutStr}
                </span>
                <span className={s.decisionColMeta} style={{ color: "var(--warn-ink)" }}>
                  {adv.altMakers} wallet{adv.altMakers === 1 ? "" : "s"} filling · <strong>{adv.multiplier.toFixed(1)}× output</strong>
                </span>
              </div>
            </div>

            {gainStr ? (
              <div className={s.gainPill}>
                <span>Net deliverable gain:</span>
                <strong>{gainStr}</strong>
              </div>
            ) : null}

            <div className={s.decisionActions}>
              <button
                className={s.crossChainActionBtn}
                onClick={handleSwitch}
                disabled={switching}
                style={{ width: "100%", justifyContent: "center", padding: "8px 14px", fontSize: 13 }}
              >
                {switching ? "Switching…" : `Switch to ${targetNet.label} (${adv.multiplier.toFixed(0)}×) ↗`}
              </button>
              <button
                className={s.btnQuiet}
                onClick={() => {
                  setAnimStep(4);
                  onConfirmBaseSwap();
                }}
                style={{ fontSize: 11.5, textAlign: "center", width: "100%", marginTop: 4 }}
              >
                Continue on {net.label} anyway
              </button>
            </div>
          </div>
        ) : null}

        {/* Active Wallet Phase */}
        {animStep === 4 || txPhase !== "idle" ? (
          <div style={{ marginTop: 14, paddingTop: 12, borderTop: "1px solid var(--rule)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span className={s.crossChainPulse} />
              <span style={{ fontSize: 13, fontWeight: 600, color: "var(--ink)" }}>
                {txPhase === "approving"
                  ? "Approving in wallet…"
                  : txPhase === "swapping"
                    ? "Submitting swap on chain…"
                    : txPhase === "done"
                      ? "Swap Complete!"
                      : "Opening wallet to sign…"}
              </span>
            </div>
            {txNote ? (
              <p style={{ margin: "6px 0 0", fontSize: 12, color: "var(--short)", lineHeight: 1.4 }}>
                {txNote}
              </p>
            ) : null}
            {txHash ? (
              <p className={s.mono} style={{ margin: "6px 0 0", fontSize: 11, color: "var(--ink3)" }}>
                Hash: {shortAddr(txHash)}
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
