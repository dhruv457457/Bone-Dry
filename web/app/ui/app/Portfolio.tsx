"use client";

import { useEffect, useState } from "react";
import { useWriteContract } from "wagmi";
import type { Address, Hex } from "viem";
import s from "../app.module.css";
import { Bar, Shim, covColor } from "./bits";
import { CopyButton } from "../CopyButton";
import { units, short as shortAddr } from "@/lib/format";
import type { ExposureResponse, HistoryResponse } from "../types";
import { NETWORKS, publicClientFor, type Network, type NetworkId } from "@/lib/networks";
import { tokensForChain } from "@/lib/tokenList";
import { useMakerBook, CoverageCard, ActivityList } from "./MakerBook";
import { TokenIcon } from "../TokenIcon";
import type { BookStrategy } from "@/lib/makerBook";

const STRAT_COLS = "minmax(200px,1.4fr) minmax(130px,1fr) minmax(150px,1fr) 100px 170px";

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
  const makerBook = useMakerBook(address, reload);
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

  const strategies = exp?.strategies ?? [];
  const total = exp?.totalPositions ?? 0;

  // One list of strategies, every chain. The book carries each strategy's chain,
  // opcode-35 verdict and activity; when it has not answered, this chain's
  // exposure rows stand in so Dock still works.
  type Row = {
    chainId: NetworkId;
    strategyHash: string;
    app: string;
    book: string;
    sides: { token: string; symbol: string; decimals: number; claim: string }[];
    st?: BookStrategy;
  };
  const rows: Row[] = makerBook.book
    ? makerBook.book.chains.flatMap((c) =>
        c.strategies.map((st) => ({
          chainId: c.chainId,
          strategyHash: st.strategyHash,
          app: st.app,
          book: st.book,
          sides: st.sides,
          st,
        }))
      )
    : strategies.map((st) => ({
        chainId,
        strategyHash: st.strategyHash,
        app: st.app,
        book: "",
        sides: st.sides.map((sd) => ({ token: sd.token, symbol: sd.symbol, decimals: sd.decimals, claim: sd.claimed })),
      }));
  rows.sort((a, b) => (a.chainId === chainId ? 0 : 1) - (b.chainId === chainId ? 0 : 1));

  const activity = rows
    .flatMap((r) => (r.st?.activity ?? []).map((a) => ({ ...a, strategyHash: r.strategyHash })))
    .sort((a, b) => b.blockNumber - a.blockNumber);
  const withOp35 = rows.filter((r) => r.st?.opcode35).length;
  const refusingNow = rows.filter((r) => r.st?.opcode35?.refusesNow).length;
  const refusals = activity.filter((a) => a.kind === "refusal").length;
  const fills = activity.length - refusals;

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

      {err && rows.length === 0 && !makerBook.loading ? (
        <section className={`${s.card} ${s.cardPad}`}>
          <p className={s.blockTag} style={{ color: "var(--short)" }}>
            {err}
          </p>
          <p style={{ margin: 0, color: "var(--ink2)", fontSize: 14.5 }}>
            Your exposure could not be read on {net.label}.
          </p>
        </section>
      ) : !exp && rows.length === 0 ? (
        <section className={`${s.card} ${s.cardPad}`}>
          {["70%", "88%", "62%", "80%"].map((w, i) => (
            <Shim key={w} w={w} delay={`${i * 0.08}s`} />
          ))}
        </section>
      ) : rows.length === 0 && (exp ? total === 0 : Boolean(makerBook.book)) ? (
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
          {/* One line to read first: how many strategies, how many are guarded, what happened. */}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {[
              { k: "live strategies", v: rows.length, warn: false },
              { k: "use opcode 35", v: withOp35, warn: false },
              { k: "refuse now", v: refusingNow, warn: refusingNow > 0 },
              { k: "opcode-35 fills", v: fills, warn: false },
              { k: "refusals recorded", v: refusals, warn: refusals > 0 },
            ].map((c) => (
              <span
                key={c.k}
                style={{
                  display: "inline-flex",
                  alignItems: "baseline",
                  gap: 6,
                  padding: "5px 12px",
                  borderRadius: 999,
                  border: "1px solid var(--rule)",
                  background: "var(--surface)",
                }}
              >
                <strong className={s.num} style={{ fontSize: 15, color: c.warn ? "var(--warn-ink)" : "var(--ink)" }}>
                  {makerBook.book || c.k === "live strategies" ? c.v : "…"}
                </strong>
                <span style={{ fontSize: 12.5, color: "var(--ink3)" }}>{c.k}</span>
              </span>
            ))}
          </div>

          <div className={s.pfPair}>
            <CoverageCard book={makerBook.book} loading={makerBook.loading} error={makerBook.error} chainId={chainId} />

            <section className={`${s.card} ${s.cardClip}`}>
              <div className={s.cardHead} style={{ padding: "12px 18px" }}>
                <h2 className={`${s.display} ${s.h3}`} style={{ margin: 0 }}>
                  What happened to your strategies
                </h2>
                <span className={s.labelSm}>Aquifer subgraph</span>
              </div>
              {makerBook.loading && !makerBook.book ? (
                <div style={{ padding: 18 }}>
                  <Shim w="80%" />
                  <Shim w="64%" delay=".08s" />
                </div>
              ) : (
                <ActivityList items={activity} explorer={net.explorer} limit={4} />
              )}
            </section>
          </div>

          <section className={`${s.card} ${s.cardClip}`}>
            <div className={s.cardHead} style={{ padding: "12px 20px" }}>
              <h2 className={`${s.display} ${s.h3}`} style={{ margin: 0 }}>
                Your strategies
              </h2>
              <span className={s.labelSm}>claims read live · backing is shared by every strategy on a token</span>
            </div>
            {rows.length === 0 ? (
              <p style={{ margin: 0, padding: "18px 20px", fontSize: 14, color: "var(--ink3)" }}>
                No active strategy has a decoded pair yet.
              </p>
            ) : (
              <div className={s.scroller}>
                <div style={{ minWidth: 760 }}>
                  <div className={s.thead} style={{ display: "grid", gridTemplateColumns: STRAT_COLS, padding: "9px 20px" }}>
                    <span>Strategy</span>
                    <span className={s.right}>Promises</span>
                    <span className={s.right}>Opcode 35</span>
                    <span className={s.right}>Last event</span>
                    <span className={s.right}>Action</span>
                  </div>
                  {rows.map((r) => {
                    const here = r.chainId === chainId;
                    const last = r.st?.activity[0];
                    return (
                      <div
                        className={`${s.trow} ${r.st?.opcode35?.refusesNow ? s.trowShort : ""}`}
                        style={{ display: "grid", gridTemplateColumns: STRAT_COLS, padding: "12px 20px", alignItems: "center" }}
                        key={`${r.chainId}-${r.strategyHash}`}
                      >
                        <div style={{ minWidth: 0, display: "flex", alignItems: "center", gap: 10 }}>
                          <span style={{ display: "inline-flex", flexShrink: 0 }}>
                            {r.sides.map((sd, i) => (
                              <span key={sd.token} style={{ marginLeft: i ? -6 : 0 }}>
                                <TokenIcon chainId={r.chainId} address={sd.token as Address} symbol={sd.symbol} size={20} />
                              </span>
                            ))}
                          </span>
                          <div style={{ minWidth: 0 }}>
                            <span style={{ display: "block", fontSize: 14 }}>{r.sides.map((sd) => sd.symbol).join(" / ")}</span>
                            <span className={s.mono} style={{ display: "inline-flex", alignItems: "center", fontSize: 9.5, color: "var(--ink3)" }}>
                              {shortAddr(r.strategyHash)}
                              <CopyButton value={r.strategyHash} size={10} />
                              {r.book ? ` · ${r.book}` : ""}
                              {here ? "" : ` · ${NETWORKS[r.chainId].label}`}
                            </span>
                          </div>
                        </div>
                        <div>
                          {r.sides.map((sd) => (
                            <span key={sd.token} className={`${s.num} ${s.right}`} style={{ display: "block", fontSize: 12.5 }}>
                              {units(sd.claim, sd.decimals, sd.decimals > 6 ? 6 : 2)} {sd.symbol}
                            </span>
                          ))}
                        </div>
                        <Opcode35Cell st={r.st} loading={makerBook.loading} />
                        <div style={{ textAlign: "right" }}>
                          {last ? (
                            <a
                              className={s.mono}
                              href={`${NETWORKS[r.chainId].explorer}/tx/${last.txHash}`}
                              target="_blank"
                              rel="noreferrer"
                              style={{ fontSize: 11, color: last.kind === "refusal" ? "var(--warn-ink)" : "var(--ink2)" }}
                            >
                              {last.kind === "refusal" ? "refused" : "filled"} ↗
                              <span style={{ display: "block", fontSize: 9.5, color: "var(--ink3)" }}>
                                {new Date(last.timestamp * 1000).toISOString().slice(5, 16).replace("T", " ")}
                              </span>
                            </a>
                          ) : (
                            <span className={s.mono} style={{ fontSize: 10.5, color: "var(--ink3)" }}>
                              none yet
                            </span>
                          )}
                        </div>
                        {here ? (
                          <DockCell
                            state={dock[r.strategyHash] ?? { k: "idle" }}
                            disabled={Boolean(wrongChain)}
                            explorer={net.explorer}
                            appLink={`${net.explorer}/address/${r.app}`}
                            onAsk={() => setDockFor(r.strategyHash, { k: "confirm" })}
                            onCancel={() => setDockFor(r.strategyHash, { k: "idle" })}
                            onConfirm={() =>
                              runDock(
                                r.strategyHash as Hex,
                                r.app as Address,
                                r.sides.map((sd) => sd.token as Address)
                              )
                            }
                          />
                        ) : (
                          <span className={s.mono} style={{ fontSize: 10.5, color: "var(--ink3)", textAlign: "right" }}>
                            dock on {NETWORKS[r.chainId].label}
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </section>

          <section className={`${s.card} ${s.cardClip}`}>
            <div className={s.cardHead} style={{ padding: "12px 18px" }}>
              {/* This wallet's swaps as a TAKER (Wellhead.Swapped by swapper), not
                  fills against its strategies. */}
              <h2 className={`${s.display} ${s.h3}`} style={{ margin: 0 }}>
                Your swaps
              </h2>
              <span className={s.labelSm}>as a taker · from chain</span>
            </div>
            {!hist ? (
              <div style={{ padding: 18 }}>
                <Shim w="60%" />
              </div>
            ) : hist.swaps.rows.length === 0 ? (
              <p style={{ margin: 0, padding: "14px 18px", fontSize: 13.5, color: "var(--ink3)" }}>
                {hist.swaps.available === false
                  ? (hist.swaps.reason ?? "fills are not indexed on this network")
                  : "No swaps from this wallet yet."}
              </p>
            ) : (
              hist.swaps.rows.slice(0, 3).map((f) => (
                <div
                  style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "11px 18px", borderBottom: "1px solid var(--hair)", flexWrap: "wrap" }}
                  key={f.txHash}
                >
                  <span style={{ fontSize: 13.5, color: "var(--ink2)", display: "inline-flex", alignItems: "center", gap: 6 }}>
                    <TokenIcon chainId={chainId} address={f.tokenIn as Address} symbol={tokenMeta(f.tokenIn).symbol} size={16} />
                    {units(f.amountIn, tokenMeta(f.tokenIn).decimals, 6)} {tokenMeta(f.tokenIn).symbol} →
                    <TokenIcon chainId={chainId} address={f.tokenOut as Address} symbol={tokenMeta(f.tokenOut).symbol} size={16} />
                    {units(f.amountOut, tokenMeta(f.tokenOut).decimals, 8)} {tokenMeta(f.tokenOut).symbol}
                  </span>
                  <a className={s.mono} style={{ fontSize: 10.5, color: "var(--ink3)" }} href={`${net.explorer}/tx/${f.txHash}`} target="_blank" rel="noreferrer">
                    {shortAddr(f.txHash)} ↗ · block {f.blockNumber}
                  </a>
                </div>
              ))
            )}
          </section>
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

/** The opcode-35 verdict for one strategy, as the contract would compute it now. */
function Opcode35Cell({ st, loading }: { st?: BookStrategy; loading: boolean }) {
  const note = { fontSize: 10, color: "var(--ink3)", display: "block", textAlign: "right" as const };
  if (!st) return <span className={s.mono} style={note}>{loading ? "reading…" : "—"}</span>;
  const o = st.opcode35;
  if (!o) {
    return (
      <span className={s.mono} style={note}>
        plain · {st.book}
      </span>
    );
  }
  const util = o.utilBps === null ? "no backing" : `${(o.utilBps / 100).toFixed(1)}%`;
  return (
    <div style={{ textAlign: "right" }}>
      <span className={s.num} style={{ fontSize: 12.5, color: o.refusesNow ? "var(--warn-ink)" : "var(--ink)" }}>
        {util} / {o.maxUtilBps / 100}%
      </span>
      <span className={s.mono} style={{ ...note, color: o.refusesNow ? "var(--warn-ink)" : "var(--ink3)" }}>
        {o.refusesNow ? "refuses now" : `fills · ${o.widenBps} bps widen`} · {o.symbol}
      </span>
    </div>
  );
}
