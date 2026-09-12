"use client";

import { useEffect, useState } from "react";
import s from "../app.module.css";
import { Bar, Shim, covColor } from "./bits";
import { CopyButton } from "../CopyButton";
import { units, short as shortAddr } from "@/lib/format";
import type { ExposureResponse, HistoryResponse } from "../types";
import type { Network, NetworkId } from "@/lib/networks";

const STRAT_COLS = "minmax(150px,1fr) 200px 200px 110px 90px";

/**
 * Your own exposure, claimed against held.
 *
 * The design carried a portfolio value in dollars, a 30-day fee total, and a
 * per-strategy "Live positions" table with Cancel/Top-up actions. Three real
 * gaps, closed three different ways:
 *
 * - Dollar value and fees: no price feed or fee accounting exists behind this
 *   app, so rather than print two confident-looking numbers nobody computed,
 *   the stat strip shows what is actually known — tokens covered, tokens
 *   short, worst coverage.
 * - "Live positions": this DID need real data that did not exist yet. Aqua's
 *   balance mapping cannot be summed per strategy on its own (the whole
 *   reason this app exists) — but the subgraph decodes each active
 *   strategy's own token pair at index time, and /api/exposure now reads
 *   each one's live claim the same way the router checks it before routing.
 *   That is `exp.strategies` below, and it is real.
 * - "Cancel": there is no dock/cancel transaction wired anywhere in this app
 *   yet, so this does not offer one. A button that read "Cancel" and did
 *   nothing would be worse than not having it.
 */
export function Portfolio({
  chainId,
  net,
  address,
  onProvide,
  onExplore,
  onLookup,
  connectButton,
}: {
  chainId: NetworkId;
  net: Network;
  address?: string;
  onProvide: () => void;
  onExplore: () => void;
  onLookup: () => void;
  connectButton: React.ReactNode;
}) {
  const [exp, setExp] = useState<ExposureResponse | null>(null);
  const [hist, setHist] = useState<HistoryResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!address) {
      setExp(null);
      setHist(null);
      return;
    }
    let live = true;
    setExp(null);
    setErr(null);
    fetch(`/api/exposure?chain=${chainId}&maker=${address}`)
      .then((r) => r.json())
      .then((d: ExposureResponse) => {
        if (!live) return;
        if (d.error) setErr(d.error);
        else if (d.available === false) setErr(d.reason ?? "unavailable on this network");
        else setExp(d);
      })
      .catch((e) => live && setErr((e as Error).message));
    fetch(`/api/history?chain=${chainId}&address=${address}`)
      .then((r) => r.json())
      .then((d: HistoryResponse) => live && !d.error && setHist(d))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [address, chainId]);

  if (!address) {
    return (
      <section className={`${s.card} ${s.cardPad} ${s.in}`} style={{ padding: "42px 30px", maxWidth: 640 }}>
        <p className={s.blockTag}>No wallet connected</p>
        <h3 className={s.display} style={{ fontSize: 28, margin: "0 0 10px" }}>
          This is the one screen that needs to know who you are.
        </h3>
        <p style={{ margin: "0 0 20px", color: "var(--ink2)", fontSize: 14.5, maxWidth: "52ch" }}>
          Or paste any address into Lookup instead — it reads the same numbers without a connection.
        </p>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
          {connectButton}
          <button className={s.btn} onClick={onLookup}>
            Paste an address
          </button>
        </div>
      </section>
    );
  }

  const positions = exp?.positions ?? [];
  const strategies = exp?.strategies ?? [];
  const covered = exp?.fullyCoveredCount ?? 0;
  const total = exp?.totalPositions ?? 0;
  const worst = positions.reduce((acc, p) => {
    const claimed = BigInt(p.claimed);
    const cov = claimed === 0n ? 100 : Number((BigInt(p.held) * 10000n) / claimed) / 100;
    return Math.min(acc, cov);
  }, 100);
  // The subgraph's own decoded count when it answered (exact); the RPC-scanned
  // ship/dock log count when it did not (a real count too, just from a
  // different source — see strategyHistoryFor's own doc comment on why it
  // cannot show token pairs the way the subgraph can).
  const liveStrategies = exp ? strategies.length : hist?.strategies.rows.filter((r) => r.active).length;

  return (
    <div className={`${s.stack} ${s.in}`}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: 18, flexWrap: "wrap" }}>
        <div>
          <p className={s.mono} style={{ margin: "0 0 3px", fontSize: 10.5, color: "var(--ink3)", display: "flex", alignItems: "center" }}>
            <span>{shortAddr(address)}</span>
            <CopyButton value={address} title="Copy wallet address" />
            <span style={{ margin: "0 4px" }}>·</span>
            <span>{net.label}</span>
          </p>
          <h1 className={`${s.display} ${s.h1}`}>Your book</h1>
        </div>
        <div style={{ display: "flex", gap: 9, flexWrap: "wrap" }}>
          <button className={`${s.btn} ${s.btnSolid}`} onClick={onProvide}>
            New strategy
          </button>
          <button className={s.btn} onClick={onExplore}>
            Compare to network
          </button>
        </div>
      </div>

      {err ? (
        <section className={`${s.card} ${s.cardPad}`}>
          <p className={s.blockTag} style={{ color: "var(--short)" }}>
            {err}
          </p>
          <p style={{ margin: 0, color: "var(--ink2)", fontSize: 14.5 }}>
            Your exposure could not be read on {net.label}.
          </p>
        </section>
      ) : !exp ? (
        <section className={`${s.card} ${s.cardPad}`}>
          {["70%", "88%", "62%", "80%"].map((w, i) => (
            <Shim key={w} w={w} delay={`${i * 0.08}s`} />
          ))}
        </section>
      ) : total === 0 ? (
        <section className={`${s.card} ${s.cardPad}`} style={{ maxWidth: "62ch" }}>
          <p className={s.blockTag}>Valid wallet · 0 strategies</p>
          <h3 className={s.display} style={{ fontSize: 26, margin: "0 0 10px" }}>
            You have never published on Aqua.
          </h3>
          <p style={{ margin: "0 0 18px", color: "var(--ink2)", fontSize: 14.5 }}>
            Coverage is undefined, not 100%. Ship a strategy and this fills in.
          </p>
          <button className={`${s.btn} ${s.btnSolid}`} onClick={onProvide}>
            Ship a strategy
          </button>
        </section>
      ) : (
        <>
          <div className={s.stats}>
            {[
              { label: "Tokens fully covered", value: `${covered}/${total}`, sub: "claimed ≤ held", short: false },
              {
                label: "Tokens short",
                value: String(total - covered),
                sub: total - covered ? "promised more than held" : "nothing is short",
                short: total - covered > 0,
              },
              {
                label: "Worst coverage",
                value: `${Math.round(worst)}%`,
                sub: "lowest of your tokens",
                short: worst < 100,
              },
              {
                label: "Live strategies",
                value: liveStrategies === undefined ? "—" : String(liveStrategies),
                sub: hist ? "from the registry" : "reading…",
                short: false,
              },
            ].map((st) => (
              <div className={s.stat} key={st.label}>
                <p className={s.labelSm} style={{ margin: "0 0 8px", letterSpacing: ".14em" }}>
                  {st.label}
                </p>
                <p className={s.statFig} style={{ color: st.short ? "var(--short)" : "var(--ink)" }}>
                  {st.value}
                </p>
                <p className={s.statSub}>{st.sub}</p>
              </div>
            ))}
          </div>

          <div className={s.cols}>
            <section className={`${s.colWide} ${s.card} ${s.cardClip}`}>
              <div className={s.cardHead}>
                <h2 className={`${s.display} ${s.h3}`}>Live positions</h2>
                <span className={s.mono} style={{ fontSize: 10.5, color: "var(--ink3)" }}>
                  {strategies.length} published
                  {strategies.length > 0
                    ? ` · ${strategies.filter((st) => st.sides.some((sd) => !sd.covered)).length} unbacked`
                    : ""}
                </span>
              </div>
              {strategies.length === 0 ? (
                <p style={{ margin: 0, padding: "18px 20px", fontSize: 14, color: "var(--ink3)" }}>
                  No active strategy has a decoded pair on this network yet.
                </p>
              ) : (
                <div className={s.scroller}>
                  <div style={{ minWidth: 680 }}>
                    <div
                      className={s.thead}
                      style={{ display: "grid", gridTemplateColumns: STRAT_COLS, padding: "10px 20px" }}
                    >
                      <span>Pair</span>
                      <span className={s.right}>Claimed</span>
                      <span className={s.right}>Backed</span>
                      <span className={s.right}>Coverage</span>
                      <span className={s.right}>Strategy</span>
                    </div>
                    {strategies.map((st) => {
                      const pair = st.sides.map((sd) => sd.symbol).join(" / ") || "—";
                      const worstSide = st.sides.reduce((acc, sd) => {
                        const claimed = BigInt(sd.claimed);
                        const cov = claimed === 0n ? 100 : Number((BigInt(sd.backed) * 10000n) / claimed) / 100;
                        return Math.min(acc, cov);
                      }, 100);
                      const short = st.sides.some((sd) => !sd.covered);
                      return (
                        <div
                          className={`${s.trow} ${short ? s.trowShort : ""}`}
                          style={{ display: "grid", gridTemplateColumns: STRAT_COLS, padding: "14px 20px" }}
                          key={st.strategyHash}
                        >
                          <div style={{ minWidth: 0, paddingRight: 14 }}>
                            <span style={{ display: "block", fontSize: 14.5 }}>{pair}</span>
                            <span className={s.mono} style={{ display: "inline-flex", alignItems: "center", fontSize: 9.5, color: "var(--ink3)" }}>
                              {shortAddr(st.strategyHash)}
                              <CopyButton value={st.strategyHash} size={10} />
                            </span>
                          </div>
                          <div style={{ paddingRight: 16 }}>
                            {st.sides.map((sd) => (
                              <span
                                key={sd.token}
                                className={`${s.num} ${s.right}`}
                                style={{ display: "block", color: "var(--ink3)" }}
                              >
                                {units(sd.claimed, sd.decimals, 2)} {sd.symbol}
                              </span>
                            ))}
                          </div>
                          <div style={{ paddingRight: 16 }}>
                            {st.sides.map((sd) => (
                              <span key={sd.token} className={`${s.numBig} ${s.right}`} style={{ display: "block" }}>
                                {units(sd.backed, sd.decimals, 2)} {sd.symbol}
                              </span>
                            ))}
                          </div>
                          <Bar pct={Math.min(100, worstSide)} width={54} labelWidth={40} />
                          <a
                            className={`${s.mono} ${s.right}`}
                            style={{ fontSize: 11, color: "var(--ink3)" }}
                            href={`${net.explorer}/address/${st.app}`}
                            target="_blank"
                            rel="noreferrer"
                          >
                            app ↗
                          </a>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </section>

            <div className={s.colNarrow}>
              <section className={`${s.card} ${s.cardClip}`}>
                <div className={s.cardHead} style={{ padding: "16px 18px" }}>
                  <h2 className={`${s.display} ${s.h3}`}>Holdings against claims</h2>
                  <span className={s.labelSm}>
                    {total - covered} short
                  </span>
                </div>
                {positions.map((p) => {
                  const claimed = BigInt(p.claimed);
                  const cov = claimed === 0n ? 100 : Number((BigInt(p.held) * 10000n) / claimed) / 100;
                  return (
                    <div style={{ padding: "13px 18px", borderBottom: "1px solid var(--hair)" }} key={p.token}>
                      <div
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                          marginBottom: 8,
                          gap: 10,
                        }}
                      >
                        <span style={{ fontSize: 14 }}>{p.symbol}</span>
                        <Bar pct={Math.min(100, cov)} width={70} labelWidth={40} />
                      </div>
                      <div
                        className={s.mono}
                        style={{ display: "flex", justifyContent: "space-between", fontSize: 10.5, color: "var(--ink3)" }}
                      >
                        <span>claimed {units(p.claimed, p.decimals, 2)}</span>
                        <span>held {units(p.held, p.decimals, 2)}</span>
                      </div>
                    </div>
                  );
                })}
              </section>

              <section className={`${s.card} ${s.cardClip}`} style={{ marginTop: 22 }}>
                <div className={s.cardHead} style={{ padding: "16px 18px" }}>
                  <h2 className={`${s.display} ${s.h3}`}>Recent fills</h2>
                  <span className={s.labelSm}>from chain</span>
                </div>
                {!hist ? (
                  <div style={{ padding: 18 }}>
                    <Shim w="80%" />
                    <Shim w="64%" delay=".08s" />
                  </div>
                ) : hist.swaps.rows.length === 0 ? (
                  <p style={{ margin: 0, padding: "18px", fontSize: 13.5, color: "var(--ink3)" }}>
                    {hist.swaps.available === false
                      ? (hist.swaps.reason ?? "fills are not indexed on this network")
                      : "No fills against your strategies yet."}
                  </p>
                ) : (
                  hist.swaps.rows.slice(0, 6).map((f) => (
                    <div
                      style={{ display: "grid", gridTemplateColumns: "10px minmax(0,1fr)", gap: 10, padding: "13px 18px", borderBottom: "1px solid var(--hair)", alignItems: "start" }}
                      key={f.txHash}
                    >
                      <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--ink)", marginTop: 7 }} />
                      <div style={{ minWidth: 0 }}>
                        <p style={{ margin: 0, fontSize: 13.5, color: "var(--ink2)" }}>
                          Filled {units(f.amountIn, 18, 4)} → {units(f.amountOut, 18, 4)}
                        </p>
                        <p className={s.mono} style={{ margin: "3px 0 0", fontSize: 10, color: "var(--ink3)", display: "inline-flex", alignItems: "center" }}>
                          <a href={`${net.explorer}/tx/${f.txHash}`} target="_blank" rel="noreferrer">
                            {shortAddr(f.txHash)} ↗
                          </a>
                          <CopyButton value={f.txHash} title="Copy tx hash" />
                          <span style={{ margin: "0 4px" }}>·</span>
                          <span>block {f.blockNumber}</span>
                        </p>
                      </div>
                    </div>
                  ))
                )}
              </section>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
