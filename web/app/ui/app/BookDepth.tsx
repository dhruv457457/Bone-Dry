"use client";

import { useEffect, useMemo, useState } from "react";
import s from "../app.module.css";
import { units, short as shortAddr } from "@/lib/format";
import type { MakerRow, MakersResponse, RouteResponse } from "../types";

/**
 * Every maker on this pair, as promised against deliverable.
 *
 * One bar per maker. Every bar is the same height because every bar is one
 * promise; the filled part is how much of that promise the wallet can actually
 * cover — min(virtual, balance, allowance), the number the router trusts. The
 * hollow tops are the phantom, and they are the subject of this project drawn
 * rather than described.
 *
 * Height is coverage, NOT size. Promises on this pair span nine orders of
 * magnitude — 1.6 WETH down to 1.9e-9, max/min 8.66e8, with only 6 of 54 bars
 * above 1% of the largest. Drawn to scale, 48 of them are sub-pixel and the
 * chart says nothing. Total size is in the headline figure instead, where one
 * number can carry it honestly. Sorted worst-covered first, so the hollow block
 * is the first thing read.
 *
 * Nothing here is modelled, smoothed or interpolated. Each bar is one strategy's
 * two numbers straight from the index. The interaction only chooses what to look
 * at: a filter dims the rest, hover shows one bar's numbers, click pins them.
 */
type View = "all" | "unbacked" | "routed";

export function BookDepth({
  makers,
  route,
  tokenOut,
  height = 168,
}: {
  makers: MakersResponse | null;
  route: RouteResponse | null;
  tokenOut: { symbol: string; decimals: number };
  height?: number;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const [pinned, setPinned] = useState<number | null>(null);
  const [view, setView] = useState<View>("all");
  const [grown, setGrown] = useState(false);

  const rows = useMemo(() => {
    if (!makers?.makers?.length) return [];
    return [...makers.makers]
      .map((m: MakerRow) => ({
        maker: m.maker,
        promised: BigInt(m.virtual),
        deliverable: BigInt(m.depth),
        solvent: m.solvent,
      }))
      .filter((r) => r.promised > 0n)
      .map((r) => ({
        ...r,
        coverage: r.promised > 0n ? Number((r.deliverable * 10000n) / r.promised) / 10000 : 0,
      }))
      .sort((a, b) => a.coverage - b.coverage);
  }, [makers]);

  // Bars rise once when the book arrives, so the hollow block is seen forming.
  useEffect(() => {
    setGrown(false);
    const t = requestAnimationFrame(() => setGrown(true));
    return () => cancelAnimationFrame(t);
  }, [rows.length]);

  const routed = useMemo(() => {
    const set = new Set<string>();
    for (const sl of route?.slices ?? []) set.add(sl.maker.toLowerCase());
    return set;
  }, [route]);

  const totals = useMemo(() => {
    let p = 0n, d = 0n, unbacked = 0;
    for (const r of rows) {
      p += r.promised;
      d += r.deliverable;
      if (r.coverage < 1) unbacked++;
    }
    return { promised: p, deliverable: d, gap: p > d ? p - d : 0n, unbacked };
  }, [rows]);

  if (rows.length === 0) return null;

  // This chart is the 1inch evidence book (/api/makers reads that router). A trade
  // routed through the Bone Dry book fills from strategies that are not drawn here,
  // so say that rather than offer a "filled you" filter that always reads 0.
  const routedHere = rows.filter((r) => routed.has(r.maker.toLowerCase())).length;
  const otherBook = Boolean(route?.encumbranceAware) && routedHere === 0;

  const gapPct = totals.promised > 0n ? Number((totals.gap * 10000n) / totals.promised) / 100 : 0;
  const inView = (i: number) => {
    const r = rows[i];
    if (view === "unbacked") return r.coverage < 1;
    if (view === "routed") return routed.has(r.maker.toLowerCase());
    return true;
  };
  const focus = pinned ?? hover;
  const f = focus !== null ? rows[focus] : null;
  // Gaps are a share of the width, so they must shrink with the bar count: at 291
  // strategies (Ethereum) a fixed 0.35% gap summed past 100% and every bar went
  // negative -- a blank chart. Gaps take at most a quarter of the width.
  const gapW = Math.min(rows.length > 40 ? 0.35 : 0.8, 25 / Math.max(1, rows.length - 1));
  const barW = Math.max(0.01, (100 - gapW * (rows.length - 1)) / rows.length);

  const chip = (v: View, label: string, n: number) => (
    <button
      type="button"
      onClick={() => {
        setView(v);
        setPinned(null);
      }}
      className={`${s.segBtn} ${view === v ? s.segBtnOn : ""}`}
      style={{ fontSize: 11, padding: "3px 9px" }}
    >
      {label} <span style={{ opacity: 0.7 }}>{n}</span>
    </button>
  );

  return (
    <div>
      <div className={s.chartHead} style={{ marginBottom: 10, alignItems: "flex-start" }}>
        <div>
          <p className={s.mono} style={{ margin: 0, fontSize: 22, fontWeight: 600, color: "var(--short)", lineHeight: 1.1 }}>
            {units(totals.gap, tokenOut.decimals, 4)} {tokenOut.symbol}
          </p>
          <span style={{ fontSize: 12.5, color: "var(--ink3)" }}>
            promised and not held · {gapPct.toFixed(1)}% of {units(totals.promised, tokenOut.decimals, 4)} · 1inch book on
            this chain
          </span>
          {otherBook ? (
            <span className={s.mono} style={{ display: "block", fontSize: 10.5, color: "var(--ink3)", marginTop: 2 }}>
              your trade fills from the {route?.bookLabel ?? "Bone Dry"} book, listed under Your route
            </span>
          ) : null}
        </div>
        <div className={s.seg}>
          {chip("all", "All", rows.length)}
          {chip("unbacked", "Can't pay in full", totals.unbacked)}
          {routedHere > 0 ? chip("routed", "Filled you", routedHere) : null}
        </div>
      </div>

      <div style={{ position: "relative" }}>
        {/* 50% guide: half the promise backed. */}
        <div
          aria-hidden
          style={{ position: "absolute", left: 0, right: 0, top: height / 2, borderTop: "1px dashed var(--rule)", pointerEvents: "none" }}
        />
        <div
          role="img"
          aria-label={`${rows.length} strategies, ${totals.unbacked} cannot pay in full`}
          style={{ display: "flex", alignItems: "flex-end", gap: `${gapW}%`, height, width: "100%" }}
          onMouseLeave={() => setHover(null)}
        >
          {rows.map((r, i) => {
            const fill = Math.min(1, r.coverage);
            const isRouted = routed.has(r.maker.toLowerCase());
            const lit = inView(i) && (focus === null || focus === i);
            return (
              <div
                key={`${r.maker}-${i}`}
                onMouseEnter={() => setHover(i)}
                onClick={() => setPinned((p) => (p === i ? null : i))}
                style={{
                  width: `${barW}%`,
                  height: "100%",
                  position: "relative",
                  cursor: "pointer",
                  background: r.solvent ? "var(--rule)" : "rgba(194, 78, 25, 0.18)",
                  borderRadius: "2px 2px 0 0",
                  outline: pinned === i ? "1.5px solid var(--ink)" : undefined,
                  outlineOffset: 1,
                  opacity: lit ? 1 : inView(i) ? 0.55 : 0.18,
                  transition: "opacity .15s",
                }}
              >
                <span
                  style={{
                    position: "absolute",
                    left: 0,
                    right: 0,
                    bottom: 0,
                    height: grown ? `${Math.max(fill > 0 ? 1 : 0, fill * 100)}%` : "0%",
                    background: r.solvent ? "var(--ink)" : "var(--short)",
                    transition: `height .6s cubic-bezier(.2,.7,.2,1) ${Math.min(i * 8, 400)}ms`,
                  }}
                />
                {isRouted ? (
                  <span
                    aria-hidden
                    style={{
                      position: "absolute",
                      top: -8,
                      left: "50%",
                      transform: "translateX(-50%)",
                      width: 5,
                      height: 5,
                      borderRadius: "50%",
                      background: "var(--warn-ink)",
                    }}
                  />
                ) : null}
              </div>
            );
          })}
        </div>

        {f && focus !== null ? (
          <div
            className={s.mono}
            style={{
              position: "absolute",
              top: 8,
              left: `clamp(0px, calc(${((focus + 0.5) / rows.length) * 100}% - 110px), calc(100% - 220px))`,
              width: 220,
              padding: "8px 10px",
              background: "var(--surface)",
              border: "1px solid var(--line)",
              borderRadius: 6,
              boxShadow: "0 6px 20px rgba(0,0,0,.08)",
              fontSize: 11,
              lineHeight: 1.55,
              color: "var(--ink2)",
              pointerEvents: "none",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <strong style={{ color: "var(--ink)" }}>{shortAddr(f.maker)}</strong>
              <span style={{ color: f.coverage < 1 ? "var(--short)" : "var(--ink)" }}>{(Math.min(1, f.coverage) * 100).toFixed(1)}%</span>
            </div>
            <div>promised {units(f.promised, tokenOut.decimals, 6)}</div>
            <div>
              can pay <strong style={{ color: f.solvent ? "var(--ink)" : "var(--short)" }}>{units(f.deliverable, tokenOut.decimals, 6)}</strong> {tokenOut.symbol}
            </div>
            {routed.has(f.maker.toLowerCase()) ? <div style={{ color: "var(--warn-ink)" }}>● filled your trade</div> : null}
            {pinned !== null ? <div style={{ color: "var(--ink3)" }}>click again to unpin</div> : null}
          </div>
        ) : null}
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginTop: 8, gap: 10, flexWrap: "wrap" }}>
        <span className={s.mono} style={{ fontSize: 10.5, color: "var(--ink3)" }}>
          bar = one strategy · filled part = what its wallet can pay
          {routedHere > 0 ? (
            <>
              {" "}· <span style={{ color: "var(--warn-ink)" }}>●</span> filled your trade
            </>
          ) : null}
        </span>
        <span className={s.mono} style={{ fontSize: 10.5, color: "var(--ink3)" }}>
          worst covered first · hover or click a bar
        </span>
      </div>
    </div>
  );
}
