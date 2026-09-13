"use client";

import { useEffect, useMemo, useState } from "react";
import s from "../app.module.css";
import { Shim } from "./bits";
import { TokenIcon } from "../TokenIcon";
import type { Address } from "viem";
import { units, short as shortAddr } from "@/lib/format";
import { NETWORKS, type NetworkId } from "@/lib/networks";
import type { BookActivity, BookStrategy, MakerBook } from "@/lib/makerBook";

/**
 * The maker's book across chains, drawn for Provide and Portfolio.
 *
 * Everything here is read from /api/maker-book, which re-reads every claim,
 * balance and allowance from chain. Nothing is estimated. The one modelling
 * choice -- treating the same token on two chains as one inventory in the
 * "combined" row -- is stated on screen where it is used.
 */

export function useMakerBook(address: string | undefined, reloadKey = 0) {
  const [book, setBook] = useState<MakerBook | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!address) {
      setBook(null);
      setError(null);
      return;
    }
    let live = true;
    setLoading(true);
    setError(null);
    fetch(`/api/maker-book?maker=${address}`)
      .then((r) => r.json())
      .then((d: MakerBook & { error?: string }) => {
        if (!live) return;
        if (d.error) setError(d.error);
        else setBook(d);
      })
      .catch((e) => live && setError((e as Error).message))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [address, reloadKey]);

  return { book, loading, error };
}

const bps = (num: bigint, den: bigint) => (den === 0n ? null : Number((num * 10_000n) / den));
const pctLabel = (b: number | null) => (b === null ? "—" : `${(b / 100).toFixed(b >= 10_000 ? 0 : 1)}%`);

/** The same token on each chain, promised against backing, plus the combined row. */
export function bookRows(book: MakerBook, symbol: string, decimals: number) {
  const rows = book.chains.map((c) => {
    const t = c.tokens.find((x) => x.symbol === symbol && x.decimals === decimals);
    const promised = t ? BigInt(t.promised) : 0n;
    const backing = t ? BigInt(t.backing) : 0n;
    return {
      chainId: c.chainId,
      label: c.label,
      available: c.available,
      reason: c.reason,
      source: c.source,
      promised,
      backing,
      utilBps: bps(promised, backing),
      strategies: c.strategies.filter((st) => st.sides.some((sd) => sd.symbol === symbol && sd.decimals === decimals)).length,
    };
  });
  const combinedT = book.combined.find((x) => x.symbol === symbol && x.decimals === decimals);
  const promised = combinedT ? BigInt(combinedT.promised) : 0n;
  const backing = combinedT ? BigInt(combinedT.backing) : 0n;
  return { rows, combined: { promised, backing, utilBps: bps(promised, backing) } };
}

type StripToken = { address: string; symbol: string; decimals: number };

const utilColor = (b: number | null, ceiling?: number) =>
  b === null
    ? "var(--ink3)"
    : b > 10_000
      ? "var(--short)"
      : ceiling !== undefined && b >= ceiling
        ? "var(--warn-ink)"
        : "var(--ink)";

/** One chain's utilisation as a chip: name, a 36px bar, the percentage. */
function ChainChip({
  label,
  promised,
  utilBps,
  ceiling,
  strong,
  title,
}: {
  label: string;
  promised: bigint;
  utilBps: number | null;
  ceiling?: number;
  strong?: boolean;
  title?: string;
}) {
  const empty = promised === 0n;
  const color = empty ? "var(--ink3)" : utilColor(utilBps, ceiling);
  return (
    <span
      title={title}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "3px 9px",
        borderRadius: 999,
        border: `1px solid ${strong ? "var(--line)" : "var(--rule)"}`,
        background: strong ? "var(--sunk)" : "var(--surface)",
        whiteSpace: "nowrap",
      }}
    >
      <span style={{ fontSize: 12, fontWeight: strong ? 600 : 400, color: "var(--ink2)" }}>{label}</span>
      <span style={{ position: "relative", width: 36, height: 4, background: "var(--track)", borderRadius: 2 }}>
        <span
          style={{
            position: "absolute",
            inset: 0,
            width: `${empty || utilBps === null ? 0 : Math.min(100, utilBps / 100)}%`,
            background: color,
            borderRadius: 2,
          }}
        />
      </span>
      <span className={s.mono} style={{ fontSize: 11, color, fontWeight: strong ? 600 : 400 }}>
        {empty ? "empty" : pctLabel(utilBps)}
      </span>
    </span>
  );
}

/**
 * Provide: the maker's book for the token being promised, on one line. Chips per
 * chain and combined; the cross-chain switch sits at the end with its explanation
 * in the tooltip, not in a paragraph that pushes the builder down the page.
 */
export function BookStrip({
  book,
  loading,
  error,
  token,
  chainId,
  crossChain,
  onToggleCrossChain,
  maxUtilBps,
}: {
  book: MakerBook | null;
  loading: boolean;
  error: string | null;
  token: StripToken;
  chainId: NetworkId;
  crossChain: boolean;
  onToggleCrossChain: (on: boolean) => void;
  maxUtilBps: number;
}) {
  const data = book ? bookRows(book, token.symbol, token.decimals) : null;
  const here = data?.rows.find((r) => r.chainId === chainId);
  const worse = Boolean(
    data && here && data.combined.utilBps !== null && here.utilBps !== null && data.combined.utilBps > here.utilBps
  );
  return (
    <section
      className={s.card}
      style={{ display: "flex", alignItems: "center", gap: "8px 12px", flexWrap: "wrap", padding: "8px 14px" }}
    >
      <span style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>
        <TokenIcon chainId={chainId} address={token.address as Address} symbol={token.symbol} size={18} />
        <span className={s.label} style={{ margin: 0 }}>
          Your {token.symbol} book
        </span>
      </span>
      {error ? (
        <span style={{ fontSize: 12.5, color: "var(--short)" }}>could not read: {error}</span>
      ) : !data ? (
        <span className={s.mono} style={{ fontSize: 11, color: "var(--ink3)" }}>
          {loading ? "reading Base and Ethereum..." : "connect a wallet to read your book"}
        </span>
      ) : (
        <>
          {data.rows.map((r) => (
            <ChainChip
              key={r.chainId}
              label={r.label}
              promised={r.promised}
              utilBps={r.utilBps}
              ceiling={maxUtilBps}
              title={
                r.available
                  ? `${r.strategies} strategies · ${units(r.promised, token.decimals, 8)} promised of ${units(r.backing, token.decimals, 8)} ${token.symbol} backing · ${r.source === "subgraph" ? "Aquifer subgraph" : "1inch index + Shipped logs"}, amounts read live`
                  : r.reason
              }
            />
          ))}
          <span style={{ color: "var(--ink3)" }}>=</span>
          <ChainChip
            label="All chains"
            promised={data.combined.promised}
            utilBps={data.combined.utilBps}
            ceiling={maxUtilBps}
            strong
            title="Treats the same token on each chain as one inventory: true only if you bridge to settle."
          />
        </>
      )}
      <label
        style={{
          marginLeft: "auto",
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          cursor: "pointer",
          fontSize: 12,
          color: worse ? "var(--warn-ink)" : "var(--ink2)",
        }}
        title="Opcode 35 can only read this chain. With this on, the declared total becomes max(this chain's promises, all-chains % x this chain's backing), so the strategy refuses when either is over the ceiling. The contract only rejects a declaration below what it can sample, so declaring more is always accepted. Fixed at publish."
      >
        <input type="checkbox" checked={crossChain} onChange={(e) => onToggleCrossChain(e.target.checked)} />
        Count other chains in opcode 35
        <span aria-hidden style={{ color: "var(--ink3)" }}>ⓘ</span>
      </label>
    </section>
  );
}

/**
 * Portfolio: one row per token -- promised against backing on all chains, then a
 * chip per chain. Replaces three places that each showed a slice of the same numbers.
 */
export function CoverageCard({
  book,
  loading,
  error,
  chainId,
  currentChainId,
  tokens: _tokensProp,
}: {
  book: MakerBook | null;
  loading: boolean;
  error: string | null;
  chainId?: NetworkId;
  currentChainId?: NetworkId;
  tokens?: { symbol: string; decimals: number }[];
}) {
  const activeChainId = chainId ?? currentChainId ?? 8453;
  const tokens = (book?.combined ?? []).filter((t) => t.promised !== "0");
  const addrOn = (symbol: string, decimals: number) => {
    const all = book?.chains ?? [];
    const here = all.find((c) => c.chainId === activeChainId)?.tokens.find((t) => t.symbol === symbol && t.decimals === decimals);
    return (here ?? all.flatMap((c) => c.tokens).find((t) => t.symbol === symbol && t.decimals === decimals))?.token;
  };
  return (
    <section className={`${s.card} ${s.cardClip}`}>
      <div className={s.cardHead} style={{ padding: "12px 18px" }}>
        <h2 className={`${s.display} ${s.h3}`} style={{ margin: 0 }}>
          Promised against backing
        </h2>
        <span className={s.labelSm}>every chain · read live</span>
      </div>
      {error ? (
        <p style={{ margin: 0, padding: "14px 18px", fontSize: 13, color: "var(--short)" }}>Could not read your book: {error}</p>
      ) : !book ? (
        <div style={{ padding: "14px 18px" }}>{loading ? <Shim w="70%" /> : null}</div>
      ) : tokens.length === 0 ? (
        <p style={{ margin: 0, padding: "14px 18px", fontSize: 13.5, color: "var(--ink3)" }}>Nothing promised on any chain.</p>
      ) : (
        tokens.map((t) => {
          const d = bookRows(book, t.symbol, t.decimals);
          const addr = addrOn(t.symbol, t.decimals);
          const u = d.combined.utilBps;
          const dp = t.decimals > 6 ? 6 : 2;
          return (
            <div
              key={`${t.symbol}-${t.decimals}`}
              style={{
                display: "grid",
                gridTemplateColumns: "96px minmax(0,1fr)",
                gap: 14,
                alignItems: "center",
                padding: "12px 18px",
                borderBottom: "1px solid var(--hair)",
              }}
            >
              <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                {addr ? <TokenIcon chainId={activeChainId} address={addr as Address} symbol={t.symbol} size={22} /> : null}
                <span style={{ fontSize: 15 }}>{t.symbol}</span>
              </span>
              <div style={{ minWidth: 0 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10, marginBottom: 5 }}>
                  <span className={s.mono} style={{ fontSize: 11.5, color: "var(--ink3)", whiteSpace: "nowrap" }}>
                    <strong style={{ color: utilColor(u), fontSize: 13 }}>{pctLabel(u)}</strong> promised
                  </span>
                  <span className={s.mono} style={{ fontSize: 11, color: "var(--ink3)", whiteSpace: "nowrap" }}>
                    {units(d.combined.promised, t.decimals, dp)} of {units(d.combined.backing, t.decimals, dp)}
                  </span>
                </div>
                <div style={{ position: "relative", height: 6, background: "var(--track)", borderRadius: 3 }}>
                  <div
                    style={{
                      position: "absolute",
                      inset: 0,
                      width: `${u === null ? 0 : Math.min(100, u / 100)}%`,
                      background: utilColor(u),
                      borderRadius: 3,
                    }}
                  />
                </div>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 7 }}>
                  {d.rows.map((r) => (
                    <ChainChip key={r.chainId} label={r.label} promised={r.promised} utilBps={r.utilBps} />
                  ))}
                </div>
              </div>
            </div>
          );
        })
      )}
    </section>
  );
}

export const CrossChainBook = CoverageCard;

/**
 * The histogram: every strategy's promise stacked in turn, against the backing
 * that has to pay all of them. The bar that crosses the dashed line is where the
 * book stops being deliverable. The strategy being drafted is the last, dashed bar.
 */
export function BookHistogram({
  book,
  chainId,
  symbol,
  decimals,
  draft,
  includeOtherChains,
  maxUtilBps,
}: {
  book: MakerBook | null;
  chainId: NetworkId;
  symbol: string;
  decimals: number;
  draft: bigint;
  includeOtherChains: boolean;
  maxUtilBps: number;
}) {
  const [hover, setHover] = useState<number | null>(null);

  const model = useMemo(() => {
    if (!book) return null;
    const chains = book.chains.filter((c) => c.chainId === chainId || includeOtherChains);
    type BarT = { label: string; claim: bigint; chainId: NetworkId; st?: BookStrategy; draft?: boolean };
    const bars: BarT[] = [];
    let backing = 0n;
    for (const c of chains) {
      const t = c.tokens.find((x) => x.symbol === symbol && x.decimals === decimals);
      if (t) backing += BigInt(t.backing);
      for (const st of c.strategies) {
        const sd = st.sides.find((x) => x.symbol === symbol && x.decimals === decimals);
        if (!sd || BigInt(sd.claim) === 0n) continue;
        bars.push({ label: shortAddr(st.strategyHash), claim: BigInt(sd.claim), chainId: c.chainId, st });
      }
    }
    // Current chain first, then by size, so the crossing point is readable.
    bars.sort((a, b) => (a.chainId === chainId ? 0 : 1) - (b.chainId === chainId ? 0 : 1) || (b.claim > a.claim ? 1 : -1));
    if (draft > 0n) bars.push({ label: "this draft", claim: draft, chainId, draft: true });
    let run = 0n;
    const stacked = bars.map((b) => {
      const before = run;
      run += b.claim;
      return { ...b, before, after: run };
    });
    const top = [run, backing, 1n].reduce((a, b) => (b > a ? b : a));
    return { stacked, backing, total: run, top: (top * 11n) / 10n };
  }, [book, chainId, symbol, decimals, draft, includeOtherChains]);

  if (!model) return null;
  const W = 720;
  const H = 230;
  const L = 44;
  const R = 700;
  const T = 18;
  const B = 196;
  const n = Math.max(1, model.stacked.length);
  const gap = n > 30 ? 2 : 6;
  const bw = Math.max(4, Math.min(88, (R - L - 40 - gap * (n - 1)) / n));
  // A book of four strategies should not huddle in the left third of the chart.
  const x0 = L + 20 + Math.max(0, (R - L - 40 - (n * bw + gap * (n - 1))) / 2);
  const y = (v: bigint) => B - Number((v * 10_000n) / (model.top === 0n ? 1n : model.top)) / 10_000 * (B - T);
  const backingY = y(model.backing);
  const ceilingY = y((model.backing * BigInt(maxUtilBps)) / 10_000n);
  const withoutDraft = model.stacked.filter((b) => !b.draft).reduce((a, b) => a + b.claim, 0n);
  const nowBps = bps(withoutDraft, model.backing);
  const afterBps = bps(model.total, model.backing);
  const h = hover !== null ? model.stacked[hover] : null;

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 8, marginBottom: 8 }}>
        <p style={{ margin: 0, fontSize: 13.5, color: "var(--ink2)" }}>
          <strong style={{ color: "var(--ink)" }}>{pctLabel(nowBps)}</strong> of your {symbol} backing is promised
          {draft > 0n ? (
            <>
              {" "}· <strong style={{ color: (afterBps ?? 0) >= maxUtilBps ? "var(--warn-ink)" : "var(--ink)" }}>{pctLabel(afterBps)}</strong> with
              this draft
            </>
          ) : null}
          {includeOtherChains ? " · all chains" : ` · ${NETWORKS[chainId].label}`}
        </p>
        <span className={s.mono} style={{ fontSize: 10.5, color: "var(--ink3)" }}>
          {model.stacked.filter((b) => !b.draft).length} strategies · backing {units(model.backing, decimals, decimals > 6 ? 6 : 2)} {symbol}
        </span>
      </div>

      {model.stacked.length === 0 ? (
        <p style={{ margin: "18px 0", fontSize: 13, color: "var(--ink3)" }}>
          Nothing promised in {symbol} yet. Enter an amount and your first strategy appears here against your backing.
        </p>
      ) : (
        <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={`Your ${symbol} promises stacked against backing`} onMouseLeave={() => setHover(null)}>
          <line x1={L} x2={R} y1={B} y2={B} stroke="var(--rule)" />
          {model.backing > 0n ? (
            <>
              <line x1={L} x2={R} y1={ceilingY} y2={ceilingY} stroke="var(--warn-ink)" strokeDasharray="2 4" opacity={0.7} />
              <text x={R} y={ceilingY - 4} textAnchor="end" fontSize="10" fill="var(--warn-ink)" fontFamily="var(--mono)">
                refusal ceiling {maxUtilBps / 100}%
              </text>
              <line x1={L} x2={R} y1={backingY} y2={backingY} stroke="var(--ink)" strokeDasharray="6 4" />
              <text x={L} y={backingY - 4} fontSize="10" fill="var(--ink)" fontFamily="var(--mono)">
                backing · min(balance, allowance)
              </text>
            </>
          ) : null}
          {model.stacked.map((b, i) => {
            const x = x0 + i * (bw + gap);
            const yBefore = y(b.before);
            const yAfter = y(b.after);
            const over = b.after > model.backing;
            const other = b.chainId !== chainId;
            const fill = b.draft ? "none" : over ? "var(--short)" : other ? "var(--tan)" : "var(--ink)";
            return (
              <g key={`${b.label}-${i}`} onMouseEnter={() => setHover(i)} style={{ cursor: "default" }}>
                <rect x={x} y={yBefore} width={bw} height={Math.max(0, B - yBefore)} fill="var(--track)" />
                <rect
                  x={x}
                  y={yAfter}
                  width={bw}
                  height={Math.max(1.5, yBefore - yAfter)}
                  fill={fill}
                  stroke={b.draft ? (over ? "var(--short)" : "var(--ink)") : "none"}
                  strokeDasharray={b.draft ? "4 3" : undefined}
                  strokeWidth={b.draft ? 1.5 : 0}
                  opacity={hover === null || hover === i ? 1 : 0.55}
                />
                {b.st?.opcode35 ? (
                  <text
                    x={x + bw / 2}
                    y={yAfter - 4}
                    textAnchor="middle"
                    fontSize="9"
                    fontFamily="var(--mono)"
                    fill={b.st.opcode35.refusesNow ? "var(--warn-ink)" : "var(--ink3)"}
                  >
                    {b.st.opcode35.refusesNow ? "35×" : "35"}
                  </text>
                ) : null}
              </g>
            );
          })}
          <text x={L - 6} y={B + 3} textAnchor="end" fontSize="10" fill="var(--ink3)" fontFamily="var(--mono)">
            0
          </text>
        </svg>
      )}

      <div className={s.mono} style={{ minHeight: 18, fontSize: 11, color: "var(--ink2)", display: "flex", gap: 14, flexWrap: "wrap" }}>
        {h ? (
          <>
            <span>{h.draft ? "this draft" : `${h.label} · ${h.st?.book} book · ${NETWORKS[h.chainId].label}`}</span>
            <span>
              promises {units(h.claim, decimals, decimals > 6 ? 8 : 2)} {symbol}
            </span>
            <span>running total {pctLabel(bps(h.after, model.backing))}</span>
            {h.st?.opcode35 ? (
              <span style={{ color: h.st.opcode35.refusesNow ? "var(--warn-ink)" : "var(--ink2)" }}>
                opcode 35 · {pctLabel(h.st.opcode35.utilBps)} / {h.st.opcode35.maxUtilBps / 100}%{" "}
                {h.st.opcode35.refusesNow ? "· refuses now" : "· fills"}
              </span>
            ) : null}
          </>
        ) : (
          <span style={{ color: "var(--ink3)" }}>
            ■ this chain{includeOtherChains ? " · ■ other chains (tan)" : ""} · ■ past backing (red) · ⌗ dashed: this draft · 35 = opcode-35
            strategy, 35× = refuses now
          </span>
        )}
      </div>
    </div>
  );
}

export function ActivityList({ items, explorer, limit = 8 }: { items: (BookActivity & { strategyHash?: string })[]; explorer: string; limit?: number }) {
  if (items.length === 0) {
    return <p style={{ margin: 0, padding: "14px 18px", fontSize: 13.5, color: "var(--ink3)" }}>No fills or refusals on your strategies yet.</p>;
  }
  return (
    <>
      {items.slice(0, limit).map((a) => (
        <div
          key={`${a.txHash}-${a.kind}-${a.detail}-${a.strategyHash ?? ""}`}
          style={{ display: "grid", gridTemplateColumns: "84px minmax(0,1fr)", gap: 10, padding: "11px 18px", borderBottom: "1px solid var(--hair)", alignItems: "baseline" }}
        >
          <span
            className={s.mono}
            style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: ".08em", color: a.kind === "refusal" ? "var(--warn-ink)" : "var(--ink)" }}
          >
            {a.kind === "refusal" ? "refused" : "filled · 35"}
          </span>
          <div style={{ minWidth: 0 }}>
            <p style={{ margin: 0, fontSize: 13, color: "var(--ink2)" }}>{a.detail}</p>
            <p className={s.mono} style={{ margin: "2px 0 0", fontSize: 10, color: "var(--ink3)" }}>
              {a.strategyHash ? `${shortAddr(a.strategyHash)} · ` : ""}
              <a href={`${explorer}/tx/${a.txHash}`} target="_blank" rel="noreferrer">
                {shortAddr(a.txHash)} ↗
              </a>{" "}
              · {new Date(a.timestamp * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC
            </p>
          </div>
        </div>
      ))}
    </>
  );
}
