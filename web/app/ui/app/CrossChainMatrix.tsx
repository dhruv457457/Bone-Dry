"use client";

import { useSwapGas } from "./useSwapGas";
import s from "../app.module.css";
import { units } from "@/lib/format";
import { NETWORKS, type NetworkId } from "@/lib/networks";
import type { RouteResponse } from "../types";

type Token = { address: string; symbol: string; decimals: number };

export function CrossChainMatrix({
  chainId,
  targetChainId,
  tokenIn,
  tokenOut,
  input,
  currentRoute,
  altRoute,
  onSwitchChain,
}: {
  chainId: NetworkId;
  targetChainId: NetworkId;
  tokenIn: Token;
  tokenOut: Token;
  input: string;
  currentRoute: RouteResponse | null;
  altRoute: RouteResponse | null;
  onSwitchChain?: (targetId: NetworkId) => void;
}) {
  const currentNet = NETWORKS[chainId];
  const targetNet = NETWORKS[targetChainId];

  const curOut = currentRoute?.amountOut ? BigInt(currentRoute.amountOut) : 0n;
  const altOut = altRoute?.amountOut ? BigInt(altRoute.amountOut) : 0n;

  // Wallets filling, not strategies considered.
  const curMakers = currentRoute?.makersUsed ?? 0;
  const altMakers = altRoute?.makersUsed ?? 0;
  const fillShare = (r: RouteResponse | null) =>
    r && BigInt(r.amountIn ?? "0") > 0n ? Number((BigInt(r.amountFilled ?? "0") * 10_000n) / BigInt(r.amountIn)) / 100 : 0;
  const curFillPct = fillShare(currentRoute);
  const altFillPct = fillShare(altRoute);

  const curDevBps = currentRoute?.slices?.[0]?.oracleDeviationBps
    ? Number(currentRoute.slices[0].oracleDeviationBps)
    : null;
  const altDevBps = altRoute?.slices?.[0]?.oracleDeviationBps
    ? Number(altRoute.slices[0].oracleDeviationBps)
    : null;

  const curOutFormatted = curOut > 0n ? `${units(curOut, tokenOut.decimals, 6)} ${tokenOut.symbol}` : "0";
  const altOutFormatted = altOut > 0n ? `${units(altOut, tokenOut.decimals, 6)} ${tokenOut.symbol}` : "0";

  // Kept for anything still reading it, but as a price ratio per unit filled, not an
  // output ratio: the two chains can fill very different amounts of the same trade.
  const multiplier =
    curOut > 0n && altRoute && currentRoute && BigInt(altRoute.amountFilled ?? "0") > 0n
      ? Number((altOut * BigInt(currentRoute.amountFilled) * 100n) / (curOut * BigInt(altRoute.amountFilled))) / 100
      : 0;

  // Read from each chain's current gas price, not written in.
  const curGas = useSwapGas(chainId);
  const altGas = useSwapGas(targetChainId);

  const devLabel = (bps: number | null, emptyText: string) =>
    bps === null
      ? emptyText
      : Math.abs(bps) < 50
        ? `within ${(Math.abs(bps) / 100).toFixed(1)}% of oracle`
        : `${bps > 0 ? "+" : "−"}${(Math.abs(bps) / 100).toFixed(1)}% vs oracle`;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span className={s.label}>Cross-chain solvency matrix</span>
          <span className={s.mono} style={{ fontSize: 10, color: "var(--ink3)" }}>
            Live comparative routing
          </span>
        </div>
        <p style={{ margin: "4px 0 0", fontSize: 13, color: "var(--ink2)", lineHeight: 1.45 }}>
          Same trade quoted on both chains: deliverable output, price against the oracle, and current gas, on {currentNet.label} and {targetNet.label}.
        </p>
      </div>

      <div className={s.matrixGrid}>
        {/* Current Chain */}
        <div className={s.matrixCard}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span className={s.mono} style={{ fontSize: 11, fontWeight: 600, color: "var(--ink2)" }}>
              {currentNet.label.toUpperCase()} (ACTIVE)
            </span>
            <span className={s.pill} style={{ fontSize: 10, padding: "1px 6px" }}>
              {curMakers} wallet{curMakers === 1 ? "" : "s"}
            </span>
          </div>
          <div>
            <span className={s.mono} style={{ fontSize: 16, fontWeight: 600, color: "var(--ink)" }}>
              {curOutFormatted}
            </span>
            <div style={{ fontSize: 11, color: "var(--short)", marginTop: 2 }}>
              {curOut === 0n ? "nothing fillable" : `${devLabel(curDevBps, "no oracle reading")} · fills ${curFillPct >= 1 ? curFillPct.toFixed(0) : curFillPct.toFixed(2)}%`}
            </div>
          </div>
          <div style={{ fontSize: 11, color: "var(--ink3)", borderTop: "1px solid var(--hair)", paddingTop: 6 }}>
            {curGas}
          </div>
        </div>

        {/* Alternate Chain */}
        <div className={`${s.matrixCard} ${s.matrixCardHighlight}`}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span className={s.mono} style={{ fontSize: 11, fontWeight: 600, color: "var(--warn-ink)" }}>
              {targetNet.label.toUpperCase()} (ALTERNATE)
            </span>
            <span className={s.pill} style={{ fontSize: 10, padding: "1px 6px", background: "var(--surface)" }}>
              {altMakers} wallet{altMakers === 1 ? "" : "s"}
            </span>
          </div>
          <div>
            <span className={s.mono} style={{ fontSize: 16, fontWeight: 600, color: "var(--warn-ink)" }}>
              {altOutFormatted}
            </span>
            <div style={{ fontSize: 11, color: "var(--ink2)", marginTop: 2 }}>
              {altOut === 0n ? "nothing fillable" : `${devLabel(altDevBps, "no oracle reading")} · fills ${altFillPct >= 1 ? altFillPct.toFixed(0) : altFillPct.toFixed(2)}%`}
            </div>
          </div>
          <div style={{ fontSize: 11, color: "var(--ink3)", borderTop: "1px solid var(--warn-line)", paddingTop: 6 }}>
            {altGas}
          </div>
        </div>
      </div>

      {onSwitchChain && targetChainId ? (
        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 4 }}>
          <button
            className={s.crossChainActionBtn}
            onClick={() => onSwitchChain(targetChainId)}
          >
            Switch wallet to {targetNet.label} ↗
          </button>
        </div>
      ) : null}
    </div>
  );
}
