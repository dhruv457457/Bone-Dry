"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import s from "../app.module.css";
import { Spinner } from "./bits";
import type { CoverageResponse } from "../types";
import { NETWORKS, type Network, type NetworkId } from "@/lib/networks";

export type Tab = "swap" | "provide" | "portfolio" | "explore" | "lookup";
export const TABS: Tab[] = ["swap", "provide", "portfolio", "explore", "lookup"];

/**
 * Header, tab bar, and the finding rail.
 *
 * The design's top strip — a "state explorer" that flips the surface between
 * ready/loading/error — is deliberately not here. That was a control for
 * inspecting the mock in the design tool; on the real app those states are
 * decided by what the chain and the index actually return.
 */
export function Header({
  tab,
  onTab,
  chainId,
  onChain,
  busy,
  wallet,
}: {
  tab: Tab;
  onTab: (t: Tab) => void;
  chainId: NetworkId;
  onChain: (c: NetworkId) => void;
  busy: boolean;
  wallet: ReactNode;
}) {
  return (
    <header className={s.header}>
      <div className={s.headerInner}>
        <div className={s.headLeft}>
          <Link className={s.mark} href="/">
            BONE<em>&middot;</em>DRY
          </Link>
          <nav className={s.nav}>
            {TABS.map((t) => (
              <button
                key={t}
                onClick={() => onTab(t)}
                aria-current={t === tab ? "page" : undefined}
                className={`${s.navTab} ${t === tab ? s.navTabOn : ""}`}
              >
                {t}
              </button>
            ))}
          </nav>
        </div>
        <div className={s.headRight}>
          {busy ? (
            <span style={{ display: "flex", alignItems: "center", gap: 7 }}>
              <Spinner size={11} />
              <span className={s.labelSm}>reading chain</span>
            </span>
          ) : null}
          <div className={s.chainSeg}>
            {[
              { id: 84532 as NetworkId, purpose: "TRY IT", name: "Base Sepolia" },
              { id: 8453 as NetworkId, purpose: "LIVE EVIDENCE", name: "Base" },
              { id: 1 as NetworkId, purpose: "AT SCALE", name: "Ethereum · read-only" },
            ].map((c) => (
              <button
                key={c.id}
                onClick={() => onChain(c.id)}
                className={`${s.chainBtn} ${c.id === chainId ? s.chainBtnOn : ""}`}
                title={NETWORKS[c.id]?.purpose}
              >
                <span className={s.chainPurpose}>{c.purpose}</span>
                <span className={s.chainLabel}>{c.name}</span>
              </button>
            ))}
          </div>
          {wallet}
        </div>
      </div>
    </header>
  );
}

/**
 * The claim, with a live number in it, above everything else on every tab.
 *
 * The sparkline is not decoration: one tick per indexed position, coloured by
 * whether that position can actually be delivered. It is the same rows the
 * number is counted from, drawn.
 */
export function FindingCard({
  finding,
  chainLabel,
  onEvidence,
  stamp,
}: {
  finding: CoverageResponse | null;
  chainLabel: string;
  onEvidence: () => void;
  stamp: string;
}) {
  if (!finding) {
    return (
      <div className={s.findingCard}>
        <div className={s.findingHead}>
          <span className={s.railTag}>The finding</span>
          <span className={s.railMeta}>{stamp}</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 0" }}>
          <Spinner size={13} dark />
          <span className={s.findingSay} style={{ fontSize: 13 }}>totalling positions · 2–4s</span>
        </div>
      </div>
    );
  }

  const short = finding.underCollateralised;
  const total = finding.positions;

  if (total === 0) {
    return (
      <div className={s.findingCard}>
        <div className={s.findingHead}>
          <span className={s.railTag} style={{ color: "var(--dark-soft)" }}>Index healthy</span>
          <span className={s.railMeta}>{stamp}</span>
        </div>
        <p className={s.findingSay} style={{ margin: 0 }}>
          Nothing is live on {chainLabel} to total.
        </p>
      </div>
    );
  }

  // Compute coverage distribution in 11 buckets (0% to 100%)
  const buckets = Array.from({ length: 11 }, () => 0);
  for (const r of finding.rows) {
    const pct = Number(r.coverageBps) / 100;
    buckets[Math.min(10, Math.max(0, Math.floor(pct / 10)))] += 1;
  }
  const peak = Math.max(1, ...buckets);

  return (
    <div className={s.findingCard}>
      <div className={s.findingHead}>
        <span className={s.railTag}>The finding</span>
        <span className={s.railMeta}>{stamp}</span>
      </div>

      <div className={s.findingStat}>
        <span className={`${s.findingFig} ${s.roll}`}>{short}</span>
        <span className={s.findingSay}>
          of <span className={s.mono} style={{ fontSize: 13.5 }}>{total}</span> live maker positions on{" "}
          {chainLabel} can&apos;t deliver what they promised.
        </span>
      </div>

      <div>
        <div className={s.findingHisto} aria-label="Coverage distribution from 0% to 100%">
          {buckets.map((count, i) => {
            const h = Math.round((count / peak) * 40) + 4;
            const isFull = i === 10;
            return (
              <span
                key={i}
                className={`${s.findingHistoBar} ${isFull ? s.findingHistoFull : ""}`}
                style={{ height: `${h}px` }}
                title={`${i * 10}% coverage: ${count} positions`}
              />
            );
          })}
        </div>
        <div className={s.findingAxis}>
          <span>0%</span>
          <span>100%</span>
        </div>
      </div>

      <div className={s.findingFoot}>
        <button className={s.railBtn} onClick={onEvidence}>
          {short > 0 ? `See the ${short}` : "See all"} →
        </button>
        <span className={s.railMeta}>read just now</span>
      </div>
    </div>
  );
}

export function FindingLine({
  finding,
  chainLabel,
  onEvidence,
  stamp,
}: {
  finding: CoverageResponse | null;
  chainLabel: string;
  onEvidence: () => void;
  stamp: string;
}) {
  if (!finding || finding.positions === 0) return null;
  const short = finding.underCollateralised;
  const total = finding.positions;

  return (
    <div className={s.findingLine}>
      <span className={s.railTag} style={{ color: "var(--ink3)" }}>The finding</span>
      <span style={{ fontSize: 13.5, color: "var(--ink2)" }}>
        <strong style={{ color: short > 0 ? "var(--short)" : "var(--ink)" }}>{short}</strong> of {total} live positions on {chainLabel} can&apos;t deliver what they promised
      </span>
      {short > 0 ? (
        <button className={s.btnQuiet} onClick={onEvidence}>
          See the {short} →
        </button>
      ) : null}
      <span className={s.mono} style={{ fontSize: 10, color: "var(--ink3)", marginLeft: "auto" }}>
        {stamp}
      </span>
    </div>
  );
}

/** @deprecated Use FindingCard for Swap/Explore and FindingLine for Provide/Portfolio */
export const FindingRail = FindingCard;

export function WrongChain({ netName, onFix }: { netName: string; onFix: () => void }) {
  return (
    <div className={s.wrap}>
      <div className={s.warn}>
        <span className={s.warnTag}>Wallet on another network</span>
        <span style={{ fontSize: 14, color: "var(--ink2)" }}>
          Reading works everywhere. Signing needs {netName}.
        </span>
        <button className={`${s.btn} ${s.btnSolid}`} onClick={onFix}>
          Switch network
        </button>
      </div>
    </div>
  );
}

export function Footer({ net, stamp }: { net: Network; stamp: string }) {
  return (
    <footer className={s.footer}>
      <div className={s.footerInner}>
        <span>Bone Dry · solvency for 1inch Aqua</span>
        <span>
          {net.label} · chain {net.id} · {stamp}
        </span>
      </div>
    </footer>
  );
}

export function ReadOnlyExplainer({
  netName,
  tabName,
  onSwitchChain,
  onExplore,
}: {
  netName: string;
  tabName: string;
  onSwitchChain: (chainId: NetworkId) => void;
  onExplore: () => void;
}) {
  return (
    <section className={`${s.card} ${s.cardPad}`} style={{ maxWidth: 640, margin: "48px auto", textAlign: "center" }}>
      <span className={s.label} style={{ letterSpacing: ".16em", color: "var(--ink3)" }}>
        Read-Only Network
      </span>
      <h2 className={`${s.display} ${s.h2}`} style={{ margin: "14px 0 10px" }}>
        {netName} is read-only here.
      </h2>
      <p style={{ margin: "0 auto 24px", fontSize: 14.5, color: "var(--ink2)", lineHeight: 1.6, maxWidth: 520 }}>
        No Bone Dry contracts are deployed on {netName} — this network is the measurement at full scale. {tabName === "swap" ? "Swapping" : "Providing"} lives on Base and Base Sepolia.
      </p>
      <div style={{ display: "flex", gap: 12, justifyContent: "center", flexWrap: "wrap" }}>
        <button className={`${s.btn} ${s.btnSolid}`} onClick={() => onSwitchChain(84532)}>
          Switch to Base Sepolia
        </button>
        <button className={s.btn} onClick={onExplore}>
          Explore {netName} instead →
        </button>
      </div>
    </section>
  );
}
