"use client";

import { useMemo, useState } from "react";
import { useSolvencyRoute } from "@/hooks/useSolvencyRoute";
import type { RouteResponse } from "./types";
import s from "./app.module.css";
import { Table, Trow } from "./app/bits";
import { CopyButton } from "./CopyButton";
import { short as shortAddr } from "@/lib/format";

function formatAmount(raw: bigint, decimals: number): string {
  if (raw === 0n) return "0.00";
  const str = raw.toString().padStart(decimals + 1, "0");
  const whole = str.slice(0, -decimals) || "0";
  const frac = str.slice(-decimals).slice(0, 6);
  return `${whole}.${frac}`;
}

type SliceFilter = "all" | "filled" | "skipped" | "unfillable";

const ROUTE_COLS = "minmax(160px, 1.2fr) 120px 85px 120px 140px minmax(220px, 1.8fr)";
const PAGE_SIZE = 12;

export function RouteInspector({
  route,
  tokenIn,
  tokenOut,
  net,
}: {
  route: RouteResponse | null;
  tokenIn: { symbol: string; decimals: number };
  tokenOut: { symbol: string; decimals: number };
  net: { explorer?: string; label: string };
}) {
  const solvency = useSolvencyRoute(route);
  const [filter, setFilter] = useState<SliceFilter>("all");
  const [page, setPage] = useState(0);

  const filteredSlices = useMemo(() => {
    if (!solvency.slices) return [];
    return solvency.slices.filter((s) => {
      if (filter === "filled") return s.status === "SOLVENT" || s.status === "CLAMPED";
      if (filter === "skipped") return s.status === "SKIPPED_GHOST";
      if (filter === "unfillable") return s.status === "UNFILLABLE";
      return true;
    });
  }, [solvency.slices, filter]);

  const totalPages = Math.max(1, Math.ceil(filteredSlices.length / PAGE_SIZE));
  const clampedPage = Math.min(page, totalPages - 1);
  const pageSlices = filteredSlices.slice(clampedPage * PAGE_SIZE, clampedPage * PAGE_SIZE + PAGE_SIZE);

  if (!route || solvency.slices.length === 0) {
    return null;
  }

  const filledCount = solvency.solventCount + solvency.clampedCount;

  return (
    <section className={`${s.card} ${s.cardClip}`} style={{ marginBottom: 24 }}>
      <div
        className={s.cardHead}
        style={{ padding: "18px 22px", alignItems: "flex-end", flexWrap: "wrap", gap: 12 }}
      >
        <div style={{ minWidth: 0 }}>
          <h2 className={`${s.display} ${s.h2}`} style={{ marginBottom: 3 }}>
            Route &amp; Solvency Breakdown
          </h2>
          <p style={{ margin: 0, fontSize: 13.5, color: "var(--ink3)" }}>
            {solvency.summaryText}
          </p>

          {/* Which book this plan fills from, and what the other one offered.
              Aqua keys balances by app and a v4 pool binds one hook, so these
              cannot be combined — one is chosen. Choosing silently is the thing
              this project argues against, so the comparison is shown. */}
          {route.bookLabel && route.alternatives && route.alternatives.length > 0 ? (
            <p className={s.mono} style={{ margin: "6px 0 0", fontSize: 10.5, color: "var(--ink3)" }}>
              filling from the <strong style={{ color: "var(--ink2)" }}>{route.bookLabel}</strong> book
              {route.encumbranceAware ? " · opcode 35 active" : ""}
              {route.alternatives.map((alt) => {
                const rate = (out: string, filled: string) => {
                  const f = BigInt(filled || "0");
                  if (f === 0n) return null;
                  return Number(BigInt(out) * 1_000_000n / f) / 1_000_000;
                };
                const mine = rate(route.amountOut, route.amountFilled);
                const theirs = rate(alt.amountOut, alt.amountFilled);
                const worse =
                  mine !== null && theirs !== null && theirs > 0
                    ? ` · ${(mine / theirs).toFixed(1)}x better rate than the ${alt.bookLabel} book`
                    : ` · ${alt.bookLabel} book: ${alt.fillable ? "nothing better" : alt.reason ?? "not fillable"}`;
                return <span key={alt.app}>{worse}</span>;
              })}
            </p>
          ) : null}

        </div>

        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          {solvency.improvementBps > 0 && (
            <span
              className={s.mono}
              style={{
                fontSize: 11,
                letterSpacing: ".06em",
                color: "var(--ink)",
                background: "var(--sunk)",
                border: "1px solid var(--rule)",
                padding: "5px 10px",
                whiteSpace: "nowrap",
                fontWeight: 600,
              }}
            >
              +{solvency.improvementBps} BPS BEAT
            </span>
          )}
          {solvency.ghostCount > 0 && (
            <span
              className={s.mono}
              style={{
                fontSize: 11,
                letterSpacing: ".06em",
                color: "var(--ink2)",
                background: "var(--sunk)",
                border: "1px solid var(--rule)",
                padding: "5px 10px",
                whiteSpace: "nowrap",
              }}
            >
              {solvency.ghostCount} SKIPPED (SAVE)
            </span>
          )}
          {solvency.clampedCount > 0 && (
            <span
              className={s.mono}
              style={{
                fontSize: 11,
                letterSpacing: ".06em",
                color: "var(--ink2)",
                background: "var(--sunk)",
                border: "1px solid var(--rule)",
                padding: "5px 10px",
                whiteSpace: "nowrap",
              }}
            >
              {solvency.clampedCount} CLAMPED TO DEPTH
            </span>
          )}
        </div>
      </div>

      <div
        style={{
          padding: "10px 22px",
          borderBottom: "1px solid var(--rule)",
          display: "flex",
          alignItems: "center",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <div className={s.seg}>
          <button
            onClick={() => {
              setFilter("all");
              setPage(0);
            }}
            className={`${s.segBtn} ${filter === "all" ? s.segBtnOn : ""}`}
          >
            All ({solvency.slices.length})
          </button>
          <button
            onClick={() => {
              setFilter("filled");
              setPage(0);
            }}
            className={`${s.segBtn} ${filter === "filled" ? s.segBtnOn : ""}`}
          >
            Filled ({filledCount})
          </button>
          <button
            onClick={() => {
              setFilter("skipped");
              setPage(0);
            }}
            className={`${s.segBtn} ${filter === "skipped" ? s.segBtnOn : ""}`}
          >
            Skipped Saves ({solvency.ghostCount})
          </button>
          {solvency.unfillableCount > 0 && (
            <button
              onClick={() => {
                setFilter("unfillable");
                setPage(0);
              }}
              className={`${s.segBtn} ${filter === "unfillable" ? s.segBtnOn : ""}`}
            >
              Unfillable ({solvency.unfillableCount})
            </button>
          )}
        </div>
        {/* Two totals used to sit on this screen without either saying what it
            counted: the receipt's 55 (strategies) and this list's 53 (wallets).
            A maker can hold several strategies, and a wallet reported both
            skipped and unfillable is counted once here. Both numbers were right;
            neither was labelled. */}
        <span className={s.mono} style={{ fontSize: 10.5, color: "var(--ink3)" }}>
          {filteredSlices.length} of {solvency.slices.length} wallets
          {solvency.strategiesConsidered > 0 && (
            <>
              {" · "}
              {solvency.strategiesConsidered} strategies considered
              {solvency.dedupedOverlap > 0 &&
                ` · ${solvency.dedupedOverlap} counted once as skipped`}
            </>
          )}
        </span>
      </div>

      <Table
        cols={ROUTE_COLS}
        min={820}
        head={
          <>
            <span>Maker</span>
            <span>Status</span>
            <span className={s.right} style={{ paddingRight: 14 }}>Share</span>
            <span className={s.right} style={{ paddingRight: 14 }}>Pay ({tokenIn.symbol})</span>
            <span className={s.right} style={{ paddingRight: 18 }}>Receive ({tokenOut.symbol})</span>
            <span style={{ paddingLeft: 6 }}>Audit / Refusal Reason</span>
          </>
        }
      >
        {pageSlices.length === 0 ? (
          <p style={{ margin: 0, padding: "18px 22px", fontSize: 14, color: "var(--ink3)" }}>
            No makers match this filter.
          </p>
        ) : (
          pageSlices.map((slice, idx) => {
            const isGhost = slice.status === "SKIPPED_GHOST";
            const isClamped = slice.status === "CLAMPED";
            const isSolvent = slice.status === "SOLVENT";
            const isUnfillable = slice.status === "UNFILLABLE";
            const isFilled = isSolvent || isClamped;

            const explorerUrl = net.explorer ? `${net.explorer}/address/${slice.maker}` : undefined;

            return (
              <Trow
                key={`${slice.maker}-${idx}`}
                cols={ROUTE_COLS}
                tone={isFilled ? "used" : undefined}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  {explorerUrl ? (
                    <a
                      href={explorerUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className={s.mono}
                      style={{ fontSize: 12.5, textDecoration: "underline", color: "inherit" }}
                    >
                      {shortAddr(slice.maker)}
                    </a>
                  ) : (
                    <span className={s.mono} style={{ fontSize: 12.5 }}>
                      {shortAddr(slice.maker)}
                    </span>
                  )}
                  <CopyButton value={slice.maker} size={11} />
                </div>

                <div>
                  {isSolvent && (
                    <span className={`${s.pill} ${s.pillRouted}`}>
                      Solvent
                    </span>
                  )}
                  {isClamped && (
                    <span className={s.pill} style={{ background: "var(--sunk)", color: "var(--ink)" }}>
                      Clamped
                    </span>
                  )}
                  {isGhost && (
                    <span className={s.pill} style={{ background: "var(--sunk)", color: "var(--ink2)" }}>
                      Skipped (Save)
                    </span>
                  )}
                  {isUnfillable && (
                    <span className={s.pill} style={{ background: "var(--sunk)", color: "var(--ink3)" }}>
                      Unfillable
                    </span>
                  )}
                </div>

                <span className={`${s.mono} ${s.right}`} style={{ fontSize: 11.5, color: isFilled ? "var(--ink)" : "var(--ink3)", paddingRight: 14 }}>
                  {isFilled ? `${slice.percentageOfFill.toFixed(1)}%` : "—"}
                </span>

                <span className={`${s.mono} ${s.right}`} style={{ fontSize: 11.5, color: isFilled ? "var(--ink)" : "var(--ink3)", paddingRight: 14 }}>
                  {isFilled ? formatAmount(slice.amountIn, tokenIn.decimals) : "0.00"}
                </span>

                <span className={`${s.mono} ${s.right}`} style={{ fontSize: 11.5, fontWeight: isFilled ? 600 : 400, color: isFilled ? "var(--ink)" : "var(--ink3)", paddingRight: 18 }}>
                  {isFilled ? formatAmount(slice.amountOut, tokenOut.decimals) : "0.00"}
                </span>

                <span className={s.mono} style={{ fontSize: 11, color: "var(--ink2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", paddingLeft: 6 }}>
                  {slice.reason}
                </span>
              </Trow>
            );
          })
        )}
      </Table>

      {totalPages > 1 && (
        <div
          style={{
            padding: "10px 22px",
            borderTop: "1px solid var(--rule)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
          }}
        >
          <button
            className={`${s.btn} ${s.btnXs}`}
            disabled={clampedPage === 0}
            onClick={() => setPage((p) => Math.max(0, p - 1))}
          >
            ‹ Prev
          </button>
          <span className={s.mono} style={{ fontSize: 10.5, color: "var(--ink3)" }}>
            page {clampedPage + 1} of {totalPages}
          </span>
          <button
            className={`${s.btn} ${s.btnXs}`}
            disabled={clampedPage >= totalPages - 1}
            onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
          >
            Next ›
          </button>
        </div>
      )}
    </section>
  );
}
