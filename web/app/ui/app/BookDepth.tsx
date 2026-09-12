"use client";

import { useMemo, useState } from "react";
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
 * two numbers straight from the index. A chart on this page has
 * to be held to the standard the rest of it is: an earlier version of the depth
 * chart plotted a gaussian and captioned it `x · y = k`, and that is exactly the
 * kind of decoration this one must not become.
 */
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

  const routed = useMemo(() => {
    const set = new Set<string>();
    for (const sl of route?.slices ?? []) set.add(sl.maker.toLowerCase());
    return set;
  }, [route]);

  const totals = useMemo(() => {
    let p = 0n, d = 0n;
    for (const r of rows) { p += r.promised; d += r.deliverable; }
    return { promised: p, deliverable: d, gap: p > d ? p - d : 0n };
  }, [rows]);

  if (rows.length === 0) return null;

  const gapPct = totals.promised > 0n
    ? Number((totals.gap * 10000n) / totals.promised) / 100
    : 0;

  const W = 100; // percent-based layout; bars flex to the column
  const gapW = rows.length > 40 ? 1 : 2;
  const barW = (W - gapW * (rows.length - 1)) / rows.length;

  return (
    <div>
      <div className={s.chartHead} style={{ marginBottom: 12 }}>
        <div>
          <span className={s.label}>Promised vs deliverable</span>
          <p style={{ margin: "3px 0 0", fontSize: 13, color: "var(--ink3)" }}>
            {rows.length} live strategies on {tokenOut.symbol} · bar height is coverage, worst first
          </p>
        </div>
        <div style={{ textAlign: "right" }}>
          <p className={s.mono} style={{ margin: 0, fontSize: 17, fontWeight: 600, color: "var(--short)" }}>
            {units(totals.gap, tokenOut.decimals, 4)} {tokenOut.symbol}
          </p>
          <span className={s.labelSm}>promised and not held · {gapPct.toFixed(1)}%</span>
        </div>
      </div>

      <div
        style={{ display: "flex", alignItems: "flex-end", gap: `${gapW}%`, height, width: "100%" }}
        onMouseLeave={() => setHover(null)}
      >
        {rows.map((r, i) => {
          const fill = Math.min(1, r.coverage);
          const isRouted = routed.has(r.maker.toLowerCase());
          return (
            <div
              key={`${r.maker}-${i}`}
              onMouseEnter={() => setHover(i)}
              title={`${shortAddr(r.maker)} — promised ${units(r.promised, tokenOut.decimals, 6)}, deliverable ${units(r.deliverable, tokenOut.decimals, 6)}`}
              style={{
                width: `${barW}%`,
                height: "100%",
                position: "relative",
                cursor: "crosshair",
                /* The shortfall is the bar's own empty top, not a separate
                   colour stacked on: what is missing is literally the space the
                   promise claimed and the wallet does not fill. */
                background: r.solvent ? "var(--rule)" : "rgba(194, 78, 25, 0.18)",
                outline: isRouted ? "1px solid var(--ink)" : undefined,
                outlineOffset: isRouted ? 1 : undefined,
                opacity: hover === null || hover === i ? 1 : 0.55,
                transition: "opacity .12s",
              }}
            >
              <span
                style={{
                  position: "absolute",
                  left: 0,
                  right: 0,
                  bottom: 0,
                  height: `${Math.max(fill > 0 ? 1 : 0, fill * 100)}%`,
                  background: r.solvent ? "var(--ink)" : "var(--short)",
                }}
              />
            </div>
          );
        })}
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginTop: 10, gap: 10, flexWrap: "wrap" }}>
        <span className={s.mono} style={{ fontSize: 10.5, color: "var(--ink3)" }}>
          ■ covered · □ promised and unbacked · outlined = filled your trade
        </span>
        <span className={s.mono} style={{ fontSize: 10.5, color: "var(--ink3)" }}>
          {units(totals.deliverable, tokenOut.decimals, 4)} of{" "}
          {units(totals.promised, tokenOut.decimals, 4)} {tokenOut.symbol} real
        </span>
      </div>

      {hover !== null && rows[hover] ? (
        <p className={s.mono} style={{ margin: "8px 0 0", fontSize: 11, color: "var(--ink2)" }}>
          {shortAddr(rows[hover].maker)} · {(rows[hover].coverage * 100).toFixed(1)}% covered · promised{" "}
          {units(rows[hover].promised, tokenOut.decimals, 6)} · deliverable{" "}
          <strong style={{ color: rows[hover].solvent ? "var(--ink)" : "var(--short)" }}>
            {units(rows[hover].deliverable, tokenOut.decimals, 6)}
          </strong>{" "}
          {tokenOut.symbol}
          {routed.has(rows[hover].maker.toLowerCase()) ? " · filled your trade" : ""}
        </p>
      ) : null}
    </div>
  );
}
