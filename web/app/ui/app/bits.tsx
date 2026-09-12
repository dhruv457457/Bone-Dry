"use client";

import type { ReactNode } from "react";
import s from "../app.module.css";

/**
 * The pieces the design repeats on every surface.
 *
 * Colours are written as `var(--short)` / `var(--ink)` rather than hex even in
 * inline styles: the tokens live on `.root` in app.module.css, everything here
 * renders inside it, and a hex literal in a component is a token that has quietly
 * stopped being one.
 */

/** Solvency has exactly two colours in this design, and this is the only place
 *  that decides which. Anything short of fully covered reads as short — 99% is
 *  not "nearly fine", it is a promise that cannot be kept in full. */
export const covColor = (coveredPct: number) => (coveredPct >= 100 ? "var(--ink)" : "var(--short)");

export function Bar({
  pct,
  width = 46,
  labelWidth = 38,
}: {
  pct: number;
  width?: number;
  labelWidth?: number;
}) {
  const clamped = Math.max(0, Math.min(100, pct));
  const color = covColor(pct);
  return (
    <div className={s.barWrap}>
      <span className={s.bar} style={{ width }}>
        <span className={s.barFill} style={{ width: `${clamped}%`, background: color }} />
      </span>
      <span className={s.barPct} style={{ width: labelWidth, color }}>
        {Math.round(clamped)}%
      </span>
    </div>
  );
}

/** A loading line. `w` and `delay` are staggered by the caller so a block of
 *  them reads as one thing arriving rather than eight identical pulses. */
export function Shim({ w = "100%", delay = "0s", h = 12 }: { w?: string; delay?: string; h?: number }) {
  return <div className={s.shim} style={{ width: w, height: h, marginBottom: 10, animationDelay: delay }} />;
}

export function Spinner({ size = 12, dark = false }: { size?: number; dark?: boolean }) {
  return (
    <span
      className={s.spinner}
      style={{
        width: size,
        height: size,
        ...(dark ? { borderColor: "rgba(255,255,255,.18)", borderTopColor: "var(--short-bright)" } : null),
      }}
    />
  );
}

/**
 * The state the design spends the most care on: a surface that cannot show what
 * it exists to show. It says what is missing, why, and what still works —
 * rather than an empty table or a spinner that never resolves.
 */
export function Blocked({
  tag,
  tagTone = "quiet",
  title,
  body,
  actions,
}: {
  tag: string;
  tagTone?: "quiet" | "short";
  title: string;
  body: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className={s.blocked}>
      <p className={s.blockTag} style={tagTone === "short" ? { color: "var(--short)" } : undefined}>
        {tag}
      </p>
      <h3 className={s.display} style={{ fontSize: 27, margin: "0 0 10px" }}>
        {title}
      </h3>
      <p className={s.blockBody}>{body}</p>
      {actions ? <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>{actions}</div> : null}
    </div>
  );
}

export type TxTone = "idle" | "live" | "done" | "bad";

export function TxSteps({ steps }: { steps: { label: string; detail?: ReactNode; tone: TxTone }[] }) {
  if (steps.length === 0) return null;
  return (
    <div className={`${s.txWrap} ${s.in}`}>
      {steps.map((t, i) => (
        <div className={s.txRow} key={i}>
          <span
            className={`${s.txDot} ${
              t.tone === "live" ? s.txDotLive : t.tone === "done" ? s.txDotDone : t.tone === "bad" ? s.txDotBad : ""
            }`}
          />
          <div style={{ minWidth: 0 }}>
            <p className={s.txLabel} style={{ color: t.tone === "bad" ? "var(--short)" : "var(--ink)" }}>
              {t.label}
            </p>
            {t.detail ? <p className={s.txDetail}>{t.detail}</p> : null}
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * One of the design's grid tables. Head and rows share a single scroller and a
 * single `min-width` — put the scroller around the head alone and the columns
 * slide out of register with their own labels the moment it overflows.
 *
 * The column template is passed in because every table in the design has its own.
 */
export function Table({
  cols,
  min,
  head,
  children,
}: {
  cols: string;
  min: number;
  head: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className={s.scroller}>
      <div style={{ minWidth: min }}>
        <div className={s.thead} style={{ display: "grid", gridTemplateColumns: cols }}>
          {head}
        </div>
        {children}
      </div>
    </div>
  );
}

/** A row in a Table. `tone` carries the left edge: the design marks a row the
 *  route filled from, and a row that is short, and nothing else. */
export function Trow({
  cols,
  tone,
  children,
}: {
  cols: string;
  tone?: "used" | "short";
  children: ReactNode;
}) {
  return (
    <div
      className={`${s.trow} ${tone === "used" ? s.trowUsed : tone === "short" ? s.trowShort : ""}`}
      style={{ display: "grid", gridTemplateColumns: cols }}
    >
      {children}
    </div>
  );
}
