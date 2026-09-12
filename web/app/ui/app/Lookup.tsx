"use client";

import { useCallback, useEffect, useState } from "react";
import s from "../app.module.css";
import { Bar, Shim, Spinner, covColor } from "./bits";
import { units } from "@/lib/format";
import { CopyButton } from "../CopyButton";
import type { ExposureResponse } from "../types";
import type { NetworkId } from "@/lib/networks";

type State =
  | { k: "idle" }
  | { k: "loading" }
  | { k: "done"; data: ExposureResponse }
  | { k: "empty"; addr: string }
  | { k: "error"; why: string };

const ADDR = /^0x[0-9a-fA-F]{40}$/;

/**
 * The one surface that needs no wallet and no index — it reads a wallet's claims
 * and balances straight from chain. That makes it the fallback everywhere else
 * in the app points to when the index is down, so it must not depend on it.
 */
export function Lookup({
  chainId,
  netName,
  initial,
}: {
  chainId: NetworkId;
  netName: string;
  initial?: string;
}) {
  const [input, setInput] = useState(initial ?? "");
  const [state, setState] = useState<State>({ k: "idle" });

  const run = useCallback(
    async (addr: string) => {
      const a = addr.trim();
      if (!ADDR.test(a)) {
        setState({ k: "error", why: "That is not a 20-byte address." });
        return;
      }
      setState({ k: "loading" });
      try {
        const res = await fetch(`/api/exposure?chain=${chainId}&maker=${a}`);
        const d = (await res.json()) as ExposureResponse;
        if (d.error) return setState({ k: "error", why: d.error });
        if (d.available === false) return setState({ k: "error", why: d.reason ?? "unavailable here" });
        if (d.totalPositions === 0) return setState({ k: "empty", addr: a });
        setState({ k: "done", data: d });
        // Sharing a finding should not require a screenshot.
        const url = new URL(window.location.href);
        url.searchParams.set("tab", "lookup");
        url.searchParams.set("address", a);
        window.history.replaceState(null, "", url.toString());
      } catch (e) {
        setState({ k: "error", why: (e as Error).message });
      }
    },
    [chainId]
  );

  // A pasted ?address= should resolve on arrival, not sit waiting for a click.
  useEffect(() => {
    if (initial && ADDR.test(initial)) void run(initial);
  }, [initial, run]);

  return (
    <div className={`${s.lookupWrap} ${s.in}`}>
      <h1 className={`${s.display} ${s.h1}`}>Lookup</h1>
      <p style={{ margin: "0 0 18px", fontSize: 15, color: "var(--ink2)" }}>
        No wallet needed · works on every network.
      </p>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 14 }}>
        <input
          className={s.lookupIn}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && run(input)}
          placeholder="0x0000000000000000000000000000000000000000"
          aria-label="Wallet address"
          spellCheck={false}
        />
        <button className={s.lookupGo} onClick={() => run(input)}>
          Check wallet
        </button>
      </div>

      {state.k === "idle" ? (
        <div className={s.lookupIdle}>
          <p style={{ margin: 0, fontSize: 14.5, color: "var(--ink2)", maxWidth: "52ch" }}>
            Results land here: claimed vs. held, per token. Coverage is computed the same way the
            router computes it before it agrees to route to someone.
          </p>
        </div>
      ) : null}

      {state.k === "loading" ? (
        <div className={`${s.card} ${s.cardPad}`}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
            <Spinner />
            <span className={s.mono} style={{ fontSize: 10.5, color: "var(--ink3)" }}>
              reading strategies, balances, allowances · 2–4s
            </span>
          </div>
          {["88%", "72%", "94%", "64%"].map((w, i) => (
            <Shim key={w} w={w} delay={`${i * 0.08}s`} />
          ))}
        </div>
      ) : null}

      {state.k === "done" ? <Result data={state.data} netName={netName} /> : null}

      {state.k === "empty" ? (
        <div className={`${s.card} ${s.cardPad}`} style={{ maxWidth: "62ch" }}>
          <p className={s.blockTag}>Valid address · 0 strategies</p>
          <h3 className={s.display} style={{ fontSize: 26, margin: "0 0 10px" }}>
            This wallet has never published on Aqua.
          </h3>
          <p style={{ margin: 0, color: "var(--ink2)", fontSize: 14.5 }}>
            Coverage is undefined, not 100%. Checked on {netName}.
          </p>
        </div>
      ) : null}

      {state.k === "error" ? (
        <div className={s.warn} style={{ display: "block", marginTop: 0, maxWidth: "62ch", padding: 26 }}>
          <p className={s.warnTag} style={{ margin: "0 0 9px" }}>
            Could not complete the read
          </p>
          <h3 className={s.display} style={{ fontSize: 26, margin: "0 0 10px" }}>
            Partial read — and we won&apos;t publish it.
          </h3>
          <p style={{ margin: "0 0 18px", color: "var(--ink2)", fontSize: 14.5 }}>
            {state.why}. A partial figure would flatter, so it is withheld.
          </p>
          <button className={`${s.btn} ${s.btnSolid}`} onClick={() => run(input)}>
            Try again
          </button>
        </div>
      ) : null}
    </div>
  );
}

function Result({ data, netName }: { data: ExposureResponse; netName: string }) {
  // Coverage across tokens of different decimals cannot be summed into one
  // number, so the headline is the count of tokens that are actually covered —
  // a figure that means the same thing whatever the units underneath.
  //
  // Counted over tokens this wallet has actually promised something on. The
  // API's `covered` flag is `backed >= totalCommitted`, which is vacuously true
  // at zero commitment, so a wallet with one real promise and one untouched
  // token was reading "2/2 covered" — inflating the denominator with a row that
  // says nothing.
  const promised = data.positions.filter((p) => BigInt(p.claimed) > 0n);
  const idle = data.positions.length - promised.length;
  const covered = promised.filter((p) => p.covered).length;
  const total = promised.length;
  const pct = total === 0 ? 100 : Math.round((covered / total) * 100);
  const color = covColor(pct);

  return (
    <div className={`${s.card} ${s.cardClip} ${s.in}`}>
      <div className={s.cardHead} style={{ padding: 22, alignItems: "flex-end" }}>
        <div style={{ minWidth: 0 }}>
          <p className={s.mono} style={{ margin: "0 0 6px", fontSize: 11.5, color: "var(--ink3)", wordBreak: "break-all", display: "inline-flex", alignItems: "center" }}>
            <span>{data.maker}</span>
            <CopyButton value={data.maker} title="Copy maker address" />
          </p>
          <h2 className={s.display} style={{ fontSize: 24, color }}>
            {total === 0
              ? "This wallet has strategies open, but promises nothing right now."
              : covered === total
              ? "Every promise this wallet has out is covered."
              : `Promises more than it holds, on ${total - covered} of ${total} tokens.`}
          </h2>
          {idle > 0 && total > 0 ? (
            <p className={s.mono} style={{ margin: "6px 0 0", fontSize: 11, color: "var(--ink3)" }}>
              {idle} further token{idle > 1 ? "s" : ""} carried with nothing promised — not counted
            </p>
          ) : null}
        </div>
        <div style={{ textAlign: "right" }}>
          <p className={s.lookupFig} style={{ color }}>
            {total === 0 ? "—" : `${covered}/${total}`}
          </p>
          <p className={s.labelSm} style={{ margin: "4px 0 0" }}>
            {total === 0 ? "nothing promised" : "tokens fully covered"}
          </p>
        </div>
      </div>

      {data.positions.map((p) => {
        const claimed = BigInt(p.claimed);
        const held = BigInt(p.held);
        // A wallet promising nothing is not "100% covered" — it is uncommitted,
        // and a full bar beside `claimed 0 / held 0` reads as data when it is
        // the absence of it. The empty state above already says this in words
        // ("Coverage is undefined, not 100%"); this row used to contradict it
        // sixty lines later.
        const cov = claimed === 0n ? null : Number((held * 10000n) / claimed) / 100;
        return (
          <div style={{ padding: "14px 22px", borderBottom: "1px solid var(--hair)" }} key={p.token}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8, gap: 10 }}>
              <span style={{ fontSize: 14.5 }}>{p.symbol}</span>
              {cov === null ? (
                <span className={s.mono} style={{ fontSize: 11, color: "var(--ink3)" }}>
                  nothing promised
                </span>
              ) : (
                <Bar pct={Math.min(100, cov)} width={90} labelWidth={44} />
              )}
            </div>
            <div className={s.mono} style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "var(--ink3)" }}>
              <span>claimed {units(p.claimed, p.decimals, 2)}</span>
              <span>held {units(p.held, p.decimals, 2)}</span>
            </div>
          </div>
        );
      })}

      <p className={s.mono} style={{ margin: 0, padding: "13px 22px", fontSize: 10, color: "var(--ink3)" }}>
        {netName}
        {data.sources ? ` · balances via ${data.sources.balances}` : ""} · link copied to the URL
      </p>
    </div>
  );
}
