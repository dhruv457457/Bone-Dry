"use client";

import { useMemo, useState } from "react";
import s from "../app.module.css";
import { Bar, Blocked, Shim, Table, Trow } from "./bits";
import { FindingCard } from "./Shell";
import { units, short as shortAddr } from "@/lib/format";
import { CopyButton } from "../CopyButton";
import type { AppsResponse, CoverageResponse } from "../types";
import type { Network } from "@/lib/networks";

const MAKER_COLS = "minmax(150px,1.2fr) 96px 58px 120px 132px 146px";
const APP_COLS = "1fr 96px 60px 68px";

type Sort = "worst" | "largest" | "live";

/** Coverage as a percentage, from the basis points the API already computed. */
const covOf = (bps: string) => Number(bps) / 100;

export function Explore({
  coverage,
  coverageError,
  apps,
  appsError,
  net,
  onLookup,
  onRetry,
}: {
  coverage: CoverageResponse | null;
  coverageError: string | null;
  apps: AppsResponse | null;
  appsError: string | null;
  net: Network;
  onLookup: () => void;
  onRetry: () => void;
}) {
  const [sort, setSort] = useState<Sort>("worst");

  const rows = useMemo(() => {
    const list = [...(coverage?.rows ?? [])];
    if (sort === "worst") list.sort((a, b) => Number(a.coverageBps) - Number(b.coverageBps));
    else if (sort === "largest") list.sort((a, b) => (BigInt(b.committed) > BigInt(a.committed) ? 1 : -1));
    else list.sort((a, b) => b.activeStrategies - a.activeStrategies);
    return list;
  }, [coverage, sort]);

  /**
   * Counts, not sums.
   *
   * These rows carry amounts in their own token's decimals — 6 for USDC, 18 for
   * most things else. Adding those integers together produces a number that is
   * not a quantity of anything, and the first version of this panel printed one:
   * "actually backed" came out larger than "committed", which reads as though
   * the network were over-collateralised. Without a price feed the only totals
   * that mean what they say are counts of positions.
   */
  const totals = useMemo(() => {
    if (!coverage) return null;
    const makers = new Set(coverage.rows.map((r) => r.maker.toLowerCase()));
    const short = coverage.rows.filter((r) => r.shortfall !== "0");
    const worst = coverage.rows.reduce((acc, r) => Math.min(acc, covOf(r.coverageBps)), 100);
    return {
      positions: coverage.positions,
      makers: makers.size,
      backedCount: coverage.rows.length - short.length,
      shortCount: short.length,
      zeroCount: coverage.rows.filter((r) => r.backed === "0").length,
      worst,
    };
  }, [coverage]);

  /** Coverage in ten buckets. The design puts 100% at the right-hand end in ink
   *  and everything short of it in the accent, so the shape of the network's
   *  honesty is one glance rather than a table read. */
  const histogram = useMemo(() => {
    if (!coverage) return [];
    const buckets = Array.from({ length: 11 }, () => 0);
    for (const r of coverage.rows) {
      const pct = Number(r.coverageBps) / 100;
      buckets[Math.min(10, Math.max(0, Math.floor(pct / 10)))] += 1;
    }
    const peak = Math.max(1, ...buckets);
    return buckets.map((n, i) => ({
      label: i === 10 ? "100" : String(i * 10),
      n,
      h: Math.round((n / peak) * 70) + 4,
      full: i === 10,
    }));
  }, [coverage]);

  if (coverageError) {
    return (
      <section className={`${s.card} ${s.in}`}>
        <Blocked
          tag={`index error · ${coverageError}`}
          tagTone="short"
          title="The evidence cannot be listed, so it is not."
          body="Listing every promise needs the index, and the index is failing. What does not need it still works: paste a wallet and we read its claims and balances straight from chain."
          actions={
            <>
              <button className={`${s.btn} ${s.btnSolid}`} onClick={onRetry}>
                Retry the index
              </button>
              <button className={s.btn} onClick={onLookup}>
                Look up a wallet
              </button>
            </>
          }
        />
      </section>
    );
  }

  return (
    <div className={`${s.cols} ${s.in}`}>
      <div className={s.colNarrow}>
        <FindingCard
          finding={coverage}
          chainLabel={net.label}
          onEvidence={() => {}}
          stamp="read just now"
        />

        {totals ? (
          <section className={`${s.card} ${s.cardPad}`}>
            <p className={s.label} style={{ margin: "0 0 12px", letterSpacing: ".14em" }}>
              Network totals · {net.label}
            </p>
            {[
              { label: "Live maker positions", value: String(totals.positions), short: false },
              { label: "Distinct makers", value: String(totals.makers), short: false },
              { label: "Fully backed", value: String(totals.backedCount), short: false },
              { label: "Short of their promise", value: String(totals.shortCount), short: true },
              { label: "Backed by nothing at all", value: String(totals.zeroCount), short: true },
            ].map((n) => (
              <div className={s.kv} key={n.label}>
                <span style={{ color: "var(--ink2)" }}>{n.label}</span>
                <span
                  className={s.numBig}
                  style={{ color: n.short ? "var(--short)" : "var(--ink)" }}
                >
                  {n.value}
                </span>
              </div>
            ))}
            <p style={{ margin: "12px 0 0", fontSize: 12.5, color: "var(--ink3)" }}>
              Counted, not summed: these positions are denominated in different tokens, so
              there is no honest single total to add them into. Worst coverage on this
              network right now is {Math.round(totals?.worst ?? 0)}%.
            </p>
          </section>
        ) : null}
      </div>

      <div className={`${s.colWide} ${s.stack}`}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: 18, flexWrap: "wrap" }}>
          <div>
            <h1 className={`${s.display} ${s.h2}`} style={{ margin: "0 0 4px" }}>The evidence, at network scale</h1>
            <p style={{ margin: 0, fontSize: 13.5, color: "var(--ink3)" }}>
              Every open strategy on {net.label} priced against real balances and allowances.
            </p>
          </div>
          <div className={s.seg}>
            {(["worst", "largest", "live"] as Sort[]).map((k) => (
              <button
                key={k}
                onClick={() => setSort(k)}
                className={`${s.segBtn} ${sort === k ? s.segBtnOn : ""}`}
              >
                {k === "worst" ? "Worst first" : k === "largest" ? "Largest" : "Most live"}
              </button>
            ))}
          </div>
        </div>

        {!coverage ? (
          <section className={`${s.card} ${s.cardPad}`}>
            {["88%", "72%", "94%", "64%", "81%", "70%"].map((w, i) => (
              <Shim key={w} w={w} delay={`${i * 0.08}s`} h={12} />
            ))}
            <p className={s.mono} style={{ margin: "4px 0 0", fontSize: 10, color: "var(--ink3)" }}>
              indexing positions across every maker · 2–4s
            </p>
          </section>
        ) : (
          <>

          <section className={`${s.card} ${s.cardClip}`}>
            <div className={s.cardHead}>
              <h2 className={`${s.display} ${s.h3}`}>Coverage per maker</h2>
              <span className={s.mono} style={{ fontSize: 10.5, color: "var(--ink3)" }}>
                {sort === "worst" ? "coverage, ascending" : sort === "largest" ? "amount committed" : "live strategies"}
              </span>
            </div>
            <Table
              cols={MAKER_COLS}
              min={720}
              head={
                <>
                  <span>Maker</span>
                  <span>Token</span>
                  <span className={s.right}>Live</span>
                  <span className={s.right}>Committed</span>
                  <span className={s.right}>Actually backed</span>
                  <span className={s.right}>Coverage</span>
                </>
              }
            >
              {rows.map((m, i) => {
                const cov = covOf(m.coverageBps);
                return (
                  <Trow cols={MAKER_COLS} tone={cov === 0 ? "short" : undefined} key={`${m.maker}-${m.token}-${i}`}>
                    <span className={s.mono} style={{ fontSize: 12.5, display: "inline-flex", alignItems: "center" }}>
                      <span>{shortAddr(m.maker)}</span>
                      <CopyButton value={m.maker} title="Copy maker address" />
                    </span>
                    <span className={s.mono} style={{ fontSize: 11.5, color: "var(--ink2)", display: "inline-flex", alignItems: "center" }}>
                      <span>{shortAddr(m.token)}</span>
                      <CopyButton value={m.token} title="Copy token address" />
                    </span>
                    <span className={`${s.num} ${s.right}`} style={{ color: "var(--ink3)", paddingRight: 14 }}>
                      {m.activeStrategies}
                    </span>
                    <span className={`${s.num} ${s.right}`} style={{ color: "var(--ink3)", paddingRight: 16 }}>
                      {units(m.committed, m.decimals, 2)}
                    </span>
                    <span className={`${s.numBig} ${s.right}`} style={{ paddingRight: 16 }}>
                      {units(m.backed, m.decimals, 2)}
                    </span>
                    <Bar pct={cov} width={70} labelWidth={42} />
                  </Trow>
                );
              })}
            </Table>
          </section>

          <section className={`${s.card} ${s.cardClip}`}>
            <div className={s.cardHead}>
              <h2 className={`${s.display} ${s.h3}`}>Across Aqua</h2>
              <button className={s.btnQuiet} style={{ color: "var(--ink)" }} onClick={onLookup}>
                Check a wallet →
              </button>
            </div>
            {appsError || !apps ? (
              <p style={{ margin: 0, padding: "18px 20px", fontSize: 14, color: "var(--ink3)" }}>
                {appsError ?? "reading the registry…"}
              </p>
            ) : (
              <Table
                cols={APP_COLS}
                min={400}
                head={
                  <>
                    <span>App</span>
                    <span>Status</span>
                    <span className={s.right}>Live</span>
                    <span className={s.right}>Makers</span>
                  </>
                }
              >
                {apps.apps.map((a) => (
                  <Trow cols={APP_COLS} key={a.app}>
                    <span className={s.mono} style={{ fontSize: 12.5, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", display: "inline-flex", alignItems: "center" }}>
                      {a.isOurs ? "bone-dry" : (
                        <>
                          <span>{shortAddr(a.app)}</span>
                          <CopyButton value={a.app} title="Copy app address" />
                        </>
                      )}
                    </span>
                    <span
                      className={s.mono}
                      style={{ fontSize: 9.5, letterSpacing: ".1em", textTransform: "uppercase", color: a.isOurs ? "var(--ink)" : "var(--ink3)" }}
                    >
                      {a.isOurs ? "ours" : "indexed"}
                    </span>
                    <span className={`${s.num} ${s.right}`}>{a.activeStrategies}</span>
                    <span className={`${s.num} ${s.right}`} style={{ color: "var(--ink3)" }}>
                      {a.distinctMakers}
                    </span>
                  </Trow>
                ))}
              </Table>
            )}
            <div style={{ padding: "12px 20px", borderTop: "1px solid var(--rule)", display: "flex", flexWrap: "wrap", gap: 16, alignItems: "baseline" }}>
              <span className={s.labelSm}>Contracts · {net.label}</span>
              {[
                { name: "BoneDryHook", addr: net.hook },
                { name: "Router", addr: net.wellhead },
              ]
                .filter((c) => c.addr)
                .map((c) => (
                  <span key={c.name} style={{ display: "inline-flex", gap: 6, alignItems: "center", fontSize: 12.5, color: "var(--ink2)" }}>
                    {c.name}{" "}
                    <a
                      className={s.mono}
                      style={{ fontSize: 11 }}
                      href={`${net.explorer}/address/${c.addr}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {shortAddr(c.addr as string)} ↗
                    </a>
                    <CopyButton value={c.addr as string} title={`Copy ${c.name} address`} />
                  </span>
                ))}
            </div>
          </section>
        </>
      )}
      </div>
    </div>
  );
}
