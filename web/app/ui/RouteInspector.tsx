"use client";

import { useSolvencyRoute } from "@/hooks/useSolvencyRoute";
import type { RouteResponse } from "./types";
import type { Network } from "@/lib/networks";
import s from "./desk.module.css";
import { CopyButton } from "./CopyButton";

function short(addr: string) {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function formatAmount(raw: bigint, decimals: number): string {
  if (raw === 0n) return "0.00";
  const str = raw.toString().padStart(decimals + 1, "0");
  const whole = str.slice(0, -decimals) || "0";
  const frac = str.slice(-decimals).slice(0, 4);
  return `${whole}.${frac}`;
}

export function RouteInspector({
  route,
  tokenIn,
  tokenOut,
  net,
}: {
  route: RouteResponse | null;
  tokenIn: { symbol: string; decimals: number };
  tokenOut: { symbol: string; decimals: number };
  net: Network;
}) {
  const solvency = useSolvencyRoute(route);

  if (!route || solvency.slices.length === 0) {
    return null;
  }

  return (
    <section className={s.book} style={{ marginTop: "24px" }}>
      <div className={s.sectionHead}>
        <div>
          <h2 className={s.sectionTitle}>
            Route &amp; Solvency Breakdown &mdash;{" "}
            <span style={{ fontWeight: 400, color: "var(--ink-soft)" }}>
              {solvency.isMultiMaker ? "Multi-Maker Waterfall" : "Single Maker Fill"}
            </span>
          </h2>
          <p className="label" style={{ marginTop: "4px" }}>
            {solvency.summaryText}
          </p>
        </div>

        <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
          {solvency.improvementBps > 0 && (
            <span
              className={s.shapeBadge}
              style={{
                color: "#1b663e",
                background: "rgba(27, 102, 62, 0.08)",
                borderColor: "rgba(27, 102, 62, 0.3)",
              }}
            >
              +{solvency.improvementBps} BPS BEAT
            </span>
          )}
          {solvency.hasGhosts && (
            <span
              className={s.shapeBadge}
              style={{
                color: "#a6300e",
                background: "rgba(166, 48, 14, 0.08)",
                borderColor: "rgba(166, 48, 14, 0.3)",
              }}
            >
              {solvency.ghostCount} GHOSTS SKIPPED
            </span>
          )}
          {solvency.hasClamped && (
            <span
              className={s.shapeBadge}
              style={{
                color: "#5c5550",
                background: "rgba(92, 85, 80, 0.08)",
                borderColor: "rgba(92, 85, 80, 0.3)",
              }}
            >
              {solvency.clampedCount} CLAMPED TO DEPTH
            </span>
          )}
        </div>
      </div>

      <div className={s.tableWrap}>
        <table className={s.table}>
          <thead>
            <tr>
              <th>Maker Wallet</th>
              <th>Status</th>
              <th>Fill Share</th>
              <th>Routed {tokenIn.symbol}</th>
              <th>Deliverable {tokenOut.symbol}</th>
              <th>Audit Note</th>
            </tr>
          </thead>
          <tbody>
            {solvency.slices.map((slice, idx) => {
              const isGhost = slice.status === "SKIPPED_GHOST";
              const isClamped = slice.status === "CLAMPED";
              const isSolvent = slice.status === "SOLVENT";

              const explorerUrl = `${net.explorer}/address/${slice.maker}`;

              return (
                <tr
                  key={`${slice.maker}-${idx}`}
                  style={{
                    opacity: isGhost ? 0.65 : 1,
                    background: isGhost ? "rgba(166, 48, 14, 0.03)" : undefined,
                  }}
                >
                  <td>
                    <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                      <a
                        href={explorerUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="num"
                        style={{ textDecoration: "underline", color: "inherit" }}
                      >
                        {short(slice.maker)}
                      </a>
                      <CopyButton value={slice.maker} title="Copy maker address" />
                    </div>
                  </td>
                  <td>
                    {isSolvent && (
                      <span
                        className={s.badge}
                        style={{
                          color: "#1b663e",
                          background: "rgba(27, 102, 62, 0.1)",
                          borderColor: "#1b663e",
                        }}
                      >
                        Solvent
                      </span>
                    )}
                    {isClamped && (
                      <span
                        className={s.badge}
                        style={{
                          color: "#8a5800",
                          background: "rgba(138, 88, 0, 0.1)",
                          borderColor: "#8a5800",
                        }}
                      >
                        Clamped
                      </span>
                    )}
                    {isGhost && (
                      <span
                        className={s.badge}
                        style={{
                          color: "#a6300e",
                          background: "rgba(166, 48, 14, 0.12)",
                          borderColor: "#a6300e",
                        }}
                      >
                        Ghost Skipped
                      </span>
                    )}
                  </td>
                  <td className="num">
                    {isGhost ? "--" : `${slice.percentageOfFill.toFixed(1)}%`}
                  </td>
                  <td className="num">
                    {isGhost ? "--" : formatAmount(slice.amountIn, tokenIn.decimals)}
                  </td>
                  <td className="num" style={{ fontWeight: 600 }}>
                    {isGhost ? "--" : formatAmount(slice.amountOut, tokenOut.decimals)}
                  </td>
                  <td className={`label ${s.dim}`} style={{ fontSize: "11px" }}>
                    {slice.reason}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
