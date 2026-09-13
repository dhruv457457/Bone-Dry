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

// Trimmed to fit the Swap tab's 860px measure without a horizontal scrollbar:
// the audit column already truncates with an ellipsis, so it gives up width first.
const ROUTE_COLS = "minmax(140px, 1.1fr) 104px 72px 110px 128px minmax(160px, 1.6fr)";
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

  // A "+N bps beat" next to a price far below the oracle is a true number that
  // misleads: it beats the deepest single maker on a book that is itself bad. So
  // the badge is only shown when no filled slice is more than 1% under the oracle.
  const worstDev = (route.slices ?? []).reduce<number | null>((w, sl) => {
    const d = (sl as { oracleDeviationBps?: number | string | null }).oracleDeviationBps;
    if (d == null) return w;
    const n = Number(d);
    return w === null || n < w ? n : w;
  }, null);
  const priceOk = worstDev === null || worstDev > -100;

  const badge = (text: string, tone: "ink" | "warn" | "mute" = "mute", title?: string) => (
    <span
      className={s.mono}
      title={title}
      style={{
        fontSize: 10.5,
        letterSpacing: ".05em",
        color: tone === "warn" ? "var(--warn-ink)" : tone === "ink" ? "var(--ink)" : "var(--ink2)",
        background: "var(--sunk)",
        border: `1px solid ${tone === "warn" ? "var(--warn-line)" : "var(--rule)"}`,
        borderRadius: 999,
        padding: "3px 9px",
        whiteSpace: "nowrap",
        fontWeight: tone === "ink" ? 600 : 400,
      }}
    >
      {text}
    </span>
  );

  const alt = route.alternatives?.[0];
  const rate = (out: string, filled: string) => {
    const f = BigInt(filled || "0");
    return f === 0n ? null : Number((BigInt(out) * 1_000_000n) / f) / 1_000_000;
  };
  const altNote = alt
    ? (() => {
        const mine = rate(route.amountOut, route.amountFilled);
        const theirs = rate(alt.amountOut, alt.amountFilled);
        return mine !== null && theirs !== null && theirs > 0
          ? `${(mine / theirs).toFixed(1)}× the ${alt.bookLabel} book's rate`
          : `${alt.bookLabel} book: ${alt.fillable ? "nothing better" : alt.reason ?? "not fillable"}`;
      })()
    : null;

  return (
    <section className={`${s.card} ${s.cardClip}`} style={{ marginBottom: 24 }}>
      <div className={s.cardHead} style={{ padding: "14px 20px", flexDirection: "column", alignItems: "stretch", gap: 6 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <h2 className={`${s.display} ${s.h3}`} style={{ margin: 0 }}>
            Your route
          </h2>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {badge(`${filledCount} filling`, "ink")}
            {solvency.clampedCount > 0 ? badge(`${solvency.clampedCount} clamped to what they hold`) : null}
            {solvency.ghostCount > 0 ? badge(`${solvency.ghostCount} skipped`, "warn") : null}
            {solvency.unfillableCount > 0 ? badge(`${solvency.unfillableCount} can't pay`, "warn") : null}
            {priceOk && solvency.improvementBps > 0
              ? badge(`+${solvency.improvementBps} bps vs one maker`, "mute", "Better than routing the whole trade to the deepest single maker.")
              : null}
          </div>
        </div>
        {/* Which book filled, whether opcode 35 ran, and what the other book
            offered -- on one line. The §2.1 disclosure stays, as a tooltip on
            "our N strategies", so it is one hover away rather than a paragraph. */}
        <p className={s.mono} style={{ margin: 0, fontSize: 11, color: "var(--ink3)", lineHeight: 1.5 }}>
          {route.bookLabel ? (
            <>
              <strong style={{ color: "var(--ink2)" }}>{route.bookLabel}</strong> book
            </>
          ) : (
            "book"
          )}
          {route.encumbranceAware ? (
            <>
              {" "}
              ·{" "}
              <span
                title="Every strategy in the Bone Dry book is published by us. It is where opcode 35 runs: a demonstration of the constraint, not a market."
                style={{ textDecoration: "underline dotted", cursor: "help" }}
              >
                our {route.makersConsidered} strategies
              </span>
            </>
          ) : null}
          {route.opcode35Filled
            ? " · opcode 35 in this fill"
            : route.encumbranceAware
              ? " · filled by a plain strategy, not opcode 35"
              : ""}
          {altNote ? ` · ${altNote}` : ""}
        </p>
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
        min={760}
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
