"use client";

import { useEffect, useState } from "react";
import { useWriteContract } from "wagmi";
import type { Address, Hex } from "viem";
import s from "../app.module.css";
import { Bar, Shim, covColor } from "./bits";
import { CopyButton } from "../CopyButton";
import { units, short as shortAddr } from "@/lib/format";
import type { ExposureResponse, HistoryResponse } from "../types";
import { publicClientFor, type Network, type NetworkId } from "@/lib/networks";
import { tokensForChain } from "@/lib/tokenList";

const STRAT_COLS = "minmax(180px,1.3fr) minmax(150px,1fr) minmax(150px,1fr) 130px 170px";

const AQUA_DOCK_ABI = [
  {
    type: "function",
    name: "dock",
    stateMutability: "nonpayable",
    inputs: [
      { name: "app", type: "address" },
      { name: "strategyHash", type: "bytes32" },
      { name: "tokens", type: "address[]" },
    ],
    outputs: [],
  },
] as const;

type DockState =
  | { k: "idle" }
  | { k: "confirm" }
  | { k: "checking" }
  | { k: "signing" }
  | { k: "mining"; hash: Hex }
  | { k: "done"; hash: Hex }
  | { k: "error"; why: string };

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
 * - "Cancel": now real, as Dock. Aqua's dock() zeroes every token of a strategy
 *   and marks it docked -- instant, unilateral, and permanent: that exact
 *   strategyHash can never be shipped again (StrategiesMustBeImmutable). So it
 *   asks twice, simulates before the wallet opens, and says it cannot be undone.
 *   Nothing moves: dock releases a promise; it holds no funds.
 */
export function Portfolio({
  chainId,
  net,
  address,
  wrongChain,
  onProvide,
  onExplore,
  onLookup,
  connectButton,
}: {
  chainId: NetworkId;
  net: Network;
  address?: string;
  wrongChain?: boolean;
  onProvide: () => void;
  onExplore: () => void;
  onLookup: () => void;
  connectButton: React.ReactNode;
}) {
  const [exp, setExp] = useState<ExposureResponse | null>(null);
  const [hist, setHist] = useState<HistoryResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [dock, setDock] = useState<Record<string, DockState>>({});
  const { writeContractAsync } = useWriteContract();

  const setDockFor = (h: string, st: DockState) => setDock((d) => ({ ...d, [h]: st }));
  /** Symbol and decimals for a token this chain's list knows; an unlisted token
   *  shows its address and assumes 18, and says so by showing the address. */
  const tokenMeta = (addr: string) => {
    const t = tokensForChain(chainId).find((x) => x.address.toLowerCase() === addr.toLowerCase());
    return t ? { symbol: t.symbol, decimals: t.decimals } : { symbol: shortAddr(addr), decimals: 18 };
  };


  const runDock = async (strategyHash: Hex, app: Address, tokens: Address[]) => {
    if (!address) return;
    const rpc = publicClientFor(net);
    try {
      // dock() must close EVERY token the strategy holds or it reverts
      // DockingShouldCloseAllTokens. Simulating first means a wrong token list,
      // or a strategy that is not this wallet's, fails here by name -- not as an
      // opaque revert after a signature.
      setDockFor(strategyHash, { k: "checking" });
      await rpc.simulateContract({
        account: address as Address,
        address: net.aqua,
        abi: AQUA_DOCK_ABI,
        functionName: "dock",
        args: [app, strategyHash, tokens],
      });
      setDockFor(strategyHash, { k: "signing" });
      const hash = await writeContractAsync({
        chainId,
        address: net.aqua,
        abi: AQUA_DOCK_ABI,
        functionName: "dock",
        args: [app, strategyHash, tokens],
      });
      setDockFor(strategyHash, { k: "mining", hash });
      const receipt = await rpc.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error("dock reverted on chain");
      setDockFor(strategyHash, { k: "done", hash });
      setReload((n) => n + 1);
    } catch (e) {
      const msg = (e as { shortMessage?: string }).shortMessage ?? (e as Error).message ?? String(e);
      setDockFor(strategyHash, {
        k: "error",
        why: /User rejected|denied/i.test(msg) ? "Rejected in wallet" : msg.slice(0, 140),
      });
    }
  };

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
  }, [address, chainId, reload]);

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

          {/* Live positions spans the page. It sat as the FIRST child of .cols,
              whose grid is 380px | 1fr, so a 680px-minimum table landed in the
              380px slot: Backed, Coverage and Dock were all behind a horizontal
              scrollbar while the two narrow cards got the wide column. */}
          <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
            <section className={`${s.card} ${s.cardClip}`}>
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
                      <span className={s.right}>Action</span>
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
                          <DockCell
                            state={dock[st.strategyHash] ?? { k: "idle" }}
                            disabled={Boolean(wrongChain)}
                            explorer={net.explorer}
                            appLink={`${net.explorer}/address/${st.app}`}
                            onAsk={() => setDockFor(st.strategyHash, { k: "confirm" })}
                            onCancel={() => setDockFor(st.strategyHash, { k: "idle" })}
                            onConfirm={() =>
                              runDock(
                                st.strategyHash as Hex,
                                st.app as Address,
                                st.sides.map((sd) => sd.token as Address)
                              )
                            }
                          />
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </section>

            <div className={s.pfPair}>
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

              <section className={`${s.card} ${s.cardClip}`}>
                <div className={s.cardHead} style={{ padding: "16px 18px" }}>
                  {/* These rows are this wallet's swaps as a TAKER (Wellhead.Swapped by
                      swapper), not fills against its strategies -- "Recent fills"
                      described something else. */}
                  <h2 className={`${s.display} ${s.h3}`}>Your recent swaps</h2>
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
                      : "No swaps from this wallet yet."}
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
                          {/* Each side in its own token's decimals. Hardcoding 18 printed
                              0.001 USDC as 0.000000000000001. */}
                          Swapped {units(f.amountIn, tokenMeta(f.tokenIn).decimals, 6)} {tokenMeta(f.tokenIn).symbol} →{" "}
                          {units(f.amountOut, tokenMeta(f.tokenOut).decimals, 8)} {tokenMeta(f.tokenOut).symbol}
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

function DockCell({
  state,
  disabled,
  explorer,
  appLink,
  onAsk,
  onCancel,
  onConfirm,
}: {
  state: DockState;
  disabled: boolean;
  explorer: string;
  appLink: string;
  onAsk: () => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const note = { fontSize: 10.5, color: "var(--ink3)", display: "block", textAlign: "right" as const };
  if (state.k === "confirm") {
    return (
      <div style={{ textAlign: "right" }}>
        <span className={s.mono} style={{ ...note, color: "var(--short)", marginBottom: 4 }}>
          permanent · cannot be re-shipped
        </span>
        <button className={`${s.btn} ${s.btnXs}`} style={{ color: "var(--short)" }} onClick={onConfirm}>
          Dock it
        </button>{" "}
        <button className={`${s.btn} ${s.btnXs}`} onClick={onCancel}>
          Keep
        </button>
      </div>
    );
  }
  if (state.k === "checking") return <span className={s.mono} style={note}>simulating…</span>;
  if (state.k === "signing") return <span className={s.mono} style={note}>confirm in wallet…</span>;
  if (state.k === "mining" || state.k === "done") {
    return (
      <a className={s.mono} style={note} href={`${explorer}/tx/${state.hash}`} target="_blank" rel="noreferrer">
        {state.k === "mining" ? "docking…" : "docked"} ↗
      </a>
    );
  }
  return (
    <div style={{ textAlign: "right" }}>
      {state.k === "error" ? (
        <span className={s.mono} style={{ ...note, color: "var(--short)", marginBottom: 4 }} title={state.why}>
          {state.why}
        </span>
      ) : null}
      <button
        className={`${s.btn} ${s.btnXs}`}
        onClick={onAsk}
        disabled={disabled}
        title={disabled ? "Switch your wallet to this network to dock" : "Release this promise"}
      >
        Dock
      </button>{" "}
      <a className={s.mono} style={{ fontSize: 10.5, color: "var(--ink3)" }} href={appLink} target="_blank" rel="noreferrer">
        app ↗
      </a>
    </div>
  );
}
