"use client";

import { useEffect, useMemo, useState } from "react";
import type { Address } from "viem";
import s from "../app.module.css";
import { Bar, Blocked, Shim, Table, Trow, TxSteps, type TxTone } from "./bits";
import { TokenIcon } from "../TokenIcon";
import { CopyButton } from "../CopyButton";
import { units, short as shortAddr } from "@/lib/format";
import type { MakerRow, MakersResponse, PoolResponse, RouteResponse } from "../types";
import type { NetworkId } from "@/lib/networks";

type Token = { address: string; symbol: string; decimals: number };

const BOOK_COLS = "minmax(180px,1.5fr) 118px 128px 128px 116px 58px";

/** Rows per page of the maker book. A maker on a busy token can have well over
 *  a hundred live strategies, and rendering all of them turned the swap card
 *  above into a footnote at the bottom of an endless scroll. */
const PAGE_SIZE = 12;

type BookFilter = "all" | "routed" | "claimable" | "short" | "no-allowance";

const BOOK_FILTERS: { key: BookFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "routed", label: "Routed" },
  { key: "claimable", label: "Claimable" },
  { key: "short", label: "Short" },
  { key: "no-allowance", label: "No allowance" },
];

/** An ERC-20 approval of 2^256-1 is the idiom for "unlimited". Printed as a
 *  number it is 78 digits of noise that pushes every other column off screen,
 *  and it is not a quantity anyone wants read out. Anything past half the range
 *  is unreachable in practice, so it is reported as what it means. */
const UNLIMITED = 1n << 255n;
const allowanceText = (raw: string, decimals: number) =>
  BigInt(raw) >= UNLIMITED ? "unlimited" : units(raw, decimals, 2);

/** What a maker's promise is worth as a percentage of the promise itself. Guards
 *  the zero case explicitly: a maker promising nothing is not 0% covered, it has
 *  nothing to cover, and dividing would say the opposite. */
function coverageOf(promised: bigint, deliverable: bigint): number {
  if (promised === 0n) return 100;
  return Number((deliverable * 10000n) / promised) / 100;
}

export function Swap({
  chainId,
  net,
  tokenIn,
  tokenOut,
  input,
  onInput,
  balance,
  route,
  makers,
  pool,
  busy,
  error,
  connected,
  wrongChain,
  txPhase,
  txHash,
  txNote,
  received,
  onSwap,
  onFlip,
  onPickToken,
  onExplore,
  onLookup,
  quoteStamp,
}: {
  chainId: NetworkId;
  net: { label: string; explorer?: string; aquaIsOurs?: boolean };
  tokenIn: Token;
  tokenOut: Token;
  input: string;
  onInput: (v: string) => void;
  balance: bigint | null;
  route: RouteResponse | null;
  makers: MakersResponse | null;
  pool: PoolResponse | null;
  busy: boolean;
  error: string | null;
  connected: boolean;
  wrongChain: boolean;
  txPhase: "idle" | "approving" | "swapping" | "done";
  txHash?: string;
  txNote?: string;
  received?: bigint;
  onSwap: () => void;
  onFlip: () => void;
  onPickToken: (which: "tokenIn" | "tokenOut") => void;
  onExplore: () => void;
  onLookup: () => void;
  quoteStamp: string;
}) {
  const [primer, setPrimer] = useState(false);
  const [raw, setRaw] = useState(false);
  const [bookFilter, setBookFilter] = useState<BookFilter>("all");
  const [bookPage, setBookPage] = useState(0);

  const hasAmount = Number(input.replace(/,/g, "")) > 0;
  const quoted = route && !route.error && route.amountOut !== "0";
  const improvement = Number(route?.improvementBps ?? "0");

  /**
   * Every row's derived state computed once, not once per filter/page.
   *
   * `used` depends on the route, which is a lookup per row — worth doing a
   * single pass over here rather than repeating inside a render loop that
   * also has to skip the rows a filter or a page excludes.
   */
  const enrichedRows = useMemo(() => {
    if (!makers) return [];
    return makers.makers.map((m: MakerRow, i: number) => {
      const promised = BigInt(m.virtual);
      const deliverable = BigInt(m.depth);
      const slice = route?.slices.find((x) => x.maker.toLowerCase() === m.maker.toLowerCase());
      const noAllowance = BigInt(m.allowance) === 0n;
      return {
        m,
        i,
        promised,
        deliverable,
        cov: coverageOf(promised, deliverable),
        slice,
        used: Boolean(slice),
        noAllowance,
        tag: slice ? "routed" : noAllowance ? "no allowance" : m.solvent ? "backed" : "skipped",
      };
    });
  }, [makers, route]);

  const filteredRows = useMemo(
    () =>
      enrichedRows.filter((r) => {
        switch (bookFilter) {
          case "routed":
            return r.used;
          case "claimable":
            return r.m.solvent;
          case "short":
            return !r.m.solvent;
          case "no-allowance":
            return r.noAllowance;
          default:
            return true;
        }
      }),
    [enrichedRows, bookFilter]
  );

  const bookPages = Math.max(1, Math.ceil(filteredRows.length / PAGE_SIZE));
  const bookPageClamped = Math.min(bookPage, bookPages - 1);
  const pageRows = filteredRows.slice(bookPageClamped * PAGE_SIZE, bookPageClamped * PAGE_SIZE + PAGE_SIZE);

  // A filter that empties the current page, or a fresh quote with fewer rows
  // than where you were reading, should land you back at the top of the list
  // rather than on a page that no longer has anything on it.
  useEffect(() => {
    setBookPage(0);
  }, [bookFilter]);

  const actionLabel = !connected
    ? "Connect wallet to swap"
    : wrongChain
      ? "Switch network to swap"
      : txPhase === "approving"
        ? "Approve in your wallet"
        : txPhase === "swapping"
          ? `Filling from ${route?.makersUsed ?? 0} wallets`
          : txPhase === "done"
            ? txNote
              ? "Reverted — try again"
              : "Filled · swap again"
            : !quoted
              ? "No quote available"
              : "Swap";

  const actionDisabled =
    !connected || wrongChain || txPhase === "approving" || txPhase === "swapping" || !quoted;

  const txSteps: { label: string; detail?: string; tone: TxTone }[] =
    txPhase === "approving"
      ? [{ label: "Awaiting approval", detail: "your wallet is open", tone: "live" }]
      : txPhase === "swapping"
        ? [
            { label: "Approved", tone: "done" },
            { label: "Filling on chain", detail: "one signature, every solvent maker", tone: "live" },
          ]
        : txPhase === "done"
          ? txNote
            ? [
                { label: "Signed", detail: txHash, tone: "done" },
                { label: "Reverted", detail: txNote, tone: "bad" },
              ]
            : [
                { label: "Signed", detail: txHash, tone: "done" },
                {
                  label: "Filled",
                  detail:
                    received !== undefined
                      ? `${units(received, tokenOut.decimals, 6)} ${tokenOut.symbol} landed in your wallet`
                      : undefined,
                  tone: "done",
                },
              ]
          : [];

  return (
    <div className={`${s.cols} ${s.in}`}>
      <div className={s.colNarrow}>
        {/* ── the swap itself ──────────────────────────────────────────── */}
        <section className={`${s.card} ${s.cardPad}`}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, marginBottom: 16 }}>
            <span className={s.label}>Swap</span>
            <button className={`${s.btn} ${s.btnXs}`} onClick={() => setPrimer((p) => !p)}>
              {primer ? "Hide primer" : "New here?"}
            </button>
          </div>

          {primer ? (
            <div className={`${s.primer} ${s.in}`}>
              {[
                "On 1inch Aqua a market maker keeps tokens in their own wallet and publishes standing offers — strategies — against them.",
                "One wallet can back many strategies. Aqua cannot enumerate them, so it cannot tell you the same 100 USDC was promised five times.",
                "Bone Dry totals every promise, prices it against balance and allowance, and routes your swap only to makers that can actually pay.",
              ].map((t, i) => (
                <div className={s.primerRow} key={i}>
                  <span className={s.mono} style={{ fontSize: 10, color: "var(--ink3)", flex: "none", paddingTop: 3 }}>
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <span style={{ fontSize: 14, color: "var(--ink2)" }}>{t}</span>
                </div>
              ))}
            </div>
          ) : null}

          <div className={s.inset}>
            <div className={s.fieldHead}>
              <span className={s.label}>You pay</span>
              {balance !== null ? (
                <div style={{ display: "flex", alignItems: "center", gap: 7 }} className={s.mono}>
                  <span style={{ fontSize: 11, color: "var(--ink3)" }}>
                    {units(balance, tokenIn.decimals, 4)}
                  </span>
                  <button
                    className={s.maxBtn}
                    onClick={() => onInput(units(balance, tokenIn.decimals, 6).replace(/,/g, ""))}
                  >
                    MAX
                  </button>
                </div>
              ) : null}
            </div>
            <div className={s.amountRow}>
              <input
                className={s.amountIn}
                value={input}
                inputMode="decimal"
                onChange={(e) => onInput(e.target.value)}
                aria-label={`Amount of ${tokenIn.symbol} to sell`}
              />
              <button className={s.ticker} onClick={() => onPickToken("tokenIn")}>
                <TokenIcon chainId={chainId} address={tokenIn.address as Address} symbol={tokenIn.symbol} size={20} />
                {tokenIn.symbol}
              </button>
            </div>
          </div>

          <div className={s.flipRow}>
            <button className={s.flip} onClick={onFlip} aria-label="Flip direction">
              ↓
            </button>
          </div>

          <div className={s.inset}>
            <div className={s.fieldHead}>
              <span className={s.label}>You receive</span>
              <span className={s.mono} style={{ fontSize: 11, color: "var(--ink3)" }}>
                {busy ? "…" : quoted ? quoteStamp : "no quote"}
              </span>
            </div>
            <div className={s.amountRow}>
              <span
                className={`${s.amountOut} ${quoted ? s.roll : ""}`}
                style={{ color: quoted ? "var(--ink)" : "var(--ink3)" }}
              >
                {busy ? "quoting…" : quoted ? units(route!.amountOut, tokenOut.decimals, 6) : "—"}
              </span>
              <button className={s.ticker} onClick={() => onPickToken("tokenOut")}>
                <TokenIcon chainId={chainId} address={tokenOut.address as Address} symbol={tokenOut.symbol} size={20} />
                {tokenOut.symbol}
              </button>
            </div>
            {quoted && BigInt(route!.unfilled) > 0n ? (
              <div style={{ marginTop: 8, fontSize: 12, color: "var(--ink3)", lineHeight: 1.4 }}>
                Only {units(route!.amountOut, tokenOut.decimals, 6)} {tokenOut.symbol} deliverable across {route!.makersUsed} solvent wallet{route!.makersUsed === 1 ? "" : "s"} — the rest of the book cannot pay.
              </div>
            ) : null}
          </div>

          {quoted && improvement > 0 && route!.slices.length > 1 ? (
            <div className={`${s.splitWin} ${s.in}`}>
              <span className={s.splitFig}>+{improvement}</span>
              <p style={{ margin: 0, fontSize: 13, color: "var(--ink2)", lineHeight: 1.4 }}>
                bps better than deepest single maker ({units(route!.singleMakerAmountOut, tokenOut.decimals, 6)} {tokenOut.symbol}), split across {route!.slices.length} wallets.
              </p>
            </div>
          ) : null}

          <button
            className={`${s.btnBlock} ${txPhase === "done" && txNote ? s.btnBlockShort : ""}`}
            disabled={actionDisabled}
            onClick={onSwap}
          >
            {actionLabel}
          </button>
          <p style={{ margin: "10px 0 0", textAlign: "center", fontSize: 13, color: "var(--ink3)" }}>
            {!connected
              ? "The book, the quote and the finding all work without connecting."
              : txPhase === "swapping"
                ? "One transaction, every solvent maker, atomic."
                : net.aquaIsOurs
                  ? `${net.label} — faucet tokens are free, contracts are identical.`
                  : `Live on ${net.label} · routes only to makers that pass the check.`}
          </p>

          <TxSteps steps={txSteps} />
          {error ? (
            <p className={s.mono} style={{ margin: "10px 0 0", fontSize: 11, color: "var(--short)" }}>
              {error}
            </p>
          ) : null}
        </section>

        {/* ── route receipt ────────────────────────────────────────────── */}
        <section className={`${s.card} ${s.cardPad}`}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10, marginBottom: 14, flexWrap: "wrap" }}>
            <span className={s.label}>Route receipt</span>
            <span className={s.mono} style={{ fontSize: 9.5, color: "var(--ink3)" }}>
              PoolManager storage
            </span>
          </div>

          {!hasAmount ? (
            <p style={{ margin: 0, fontSize: 14, color: "var(--ink3)" }}>
              Enter an amount to quote every live maker.
            </p>
          ) : busy || !route ? (
            <div>
              {[
                { w: "92%", d: "0s" },
                { w: "70%", d: ".08s" },
                { w: "84%", d: ".16s" },
                { w: "58%", d: ".24s" },
                { w: "76%", d: ".32s" },
              ].map((k) => (
                <Shim key={k.w} w={k.w} delay={k.d} />
              ))}
              <p className={s.mono} style={{ margin: "10px 0 0", fontSize: 10, color: "var(--ink3)" }}>
                quoting {makers?.indexed ?? 0} makers
              </p>
            </div>
          ) : (
            <div>
              {pool ? (
                <div className={s.zeroRow} style={{ alignItems: "center" }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span className={s.label} style={{ margin: 0, letterSpacing: ".12em" }}>
                        Pool liquidity
                      </span>
                      <span
                        className={`${s.pill} ${pool.liquidity === "0" ? s.pillShort : ""}`}
                        style={{ fontSize: 11, padding: "2px 7px" }}
                      >
                        {pool.liquidity === "0" ? "0 · by design" : `${units(pool.liquidity, 18, 2)} TVL`}
                      </span>
                    </div>
                    <p style={{ margin: "4px 0 0", fontSize: 13.5, color: "var(--ink2)" }}>
                      {pool.state === "bone-dry"
                        ? "zero is the mechanism, not a fault"
                        : pool.state === "uninitialized"
                          ? "this pool has not been initialised here"
                          : "this pool holds conventional liquidity"}
                    </p>
                  </div>
                </div>
              ) : null}

              {(() => {
                const filledCount = route.makersUsed;
                const skippedCount = route.makersSkipped.length;
                const unfillableCount = Math.max(
                  0,
                  route.makersConsidered - filledCount - skippedCount
                );
                return [
                  {
                    label: "Pool ID",
                    value: pool ? shortAddr(pool.poolId) : "—",
                    copyValue: pool ? pool.poolId : undefined,
                    color: "var(--ink3)",
                  },
                  {
                    label: "Strategies considered",
                    value: `${route.makersConsidered}`,
                    color: "var(--ink)",
                  },
                  {
                    label: "├─ Filled",
                    value: `${filledCount} wallet${filledCount === 1 ? "" : "s"}`,
                    color: "var(--ink)",
                  },
                  {
                    label: "├─ Skipped — could not pay",
                    value: `${skippedCount}`,
                    color: skippedCount ? "var(--short)" : "var(--ink3)",
                  },
                  {
                    label: "└─ Wrong pair / no depth",
                    value: `${unfillableCount}`,
                    color: "var(--ink3)",
                  },
                  {
                    label: "Unfilled at this size",
                    value: units(route.unfilled, tokenIn.decimals, 2),
                    color: route.unfilled === "0" ? "var(--ink)" : "var(--short)",
                  },
                ];
              })().map((r) => (
                <div className={s.kv} key={r.label}>
                  <span style={{ color: "var(--ink2)" }}>{r.label}</span>
                  <span className={s.kvVal} style={{ color: r.color, display: "inline-flex", alignItems: "center" }}>
                    {r.value}
                    {r.copyValue ? <CopyButton value={r.copyValue} size={11} /> : null}
                  </span>
                </div>
              ))}

              {route.hookData ? (
                <>
                  <button className={s.rawToggle} onClick={() => setRaw((r) => !r)}>
                    {raw ? "▾ " : "▸ "}raw hook data
                  </button>
                  {raw ? (
                    <pre className={`${s.raw} ${s.in}`}>
                      {`makers: [${route.slices.map((x) => shortAddr(x.maker)).join(", ")}]
amounts: [${route.slices.map((x) => units(x.amountIn, tokenIn.decimals, 6)).join(", ")}]
hookData: ${route.hookData}`}
                    </pre>
                  ) : null}
                </>
              ) : null}
            </div>
          )}
        </section>
      </div>

      {/* ── the maker book ─────────────────────────────────────────────── */}
      <section className={`${s.colWide} ${s.card} ${s.cardClip}`}>
        <div
          className={s.cardHead}
          style={{ padding: "18px 22px", alignItems: "flex-end" }}
        >
          <div style={{ minWidth: 0 }}>
            <h2 className={`${s.display} ${s.h2}`} style={{ marginBottom: 3 }}>
              The maker book
            </h2>
            <p style={{ margin: 0, fontSize: 13.5, color: "var(--ink3)" }}>
              Promised vs. actually held, in {tokenOut.symbol}.
            </p>
          </div>
          {makers && makers.makers.length > 0 ? (
            <span
              className={s.mono}
              style={{ fontSize: 11, letterSpacing: ".06em", color: "var(--ink2)", border: "1px solid var(--rule)", padding: "5px 10px", whiteSpace: "nowrap" }}
            >
              {makers.solvent} backed ·{" "}
              <span style={{ color: "var(--short)" }}>{makers.indexed - makers.solvent} short</span> ·{" "}
              {makers.indexed} live
            </span>
          ) : null}
        </div>

        {busy && !makers ? (
          <div style={{ padding: "14px 22px 20px" }}>
            {["0s", ".08s", ".16s", ".24s", ".32s", ".4s"].map((d) => (
              <Shim key={d} delay={d} w="100%" h={10} />
            ))}
            <p className={s.mono} style={{ margin: "12px 0 0", fontSize: 10, color: "var(--ink3)" }}>
              reading balances and allowances
            </p>
          </div>
        ) : !makers || makers.makers.length === 0 ? (
          <Blocked
            tag={makers?.index && !makers.index.ready ? "index behind" : "index healthy · 0 results"}
            title={`No live strategies offer ${tokenOut.symbol} yet.`}
            body={`Nobody is quoting this token on ${net.label} right now — try another pair, or check a wallet directly.`}
            actions={
              <>
                <button className={`${s.btn} ${s.btnSolid}`} onClick={onExplore}>
                  See the network
                </button>
                <button className={s.btn} onClick={onLookup}>
                  Look up a wallet
                </button>
              </>
            }
          />
        ) : (
          <>
            {/* One filter, one page at a time. A token with real depth can carry
                well over a hundred live strategies, and listing all of them
                turned the swap card beside this table into a footnote at the
                bottom of an endless scroll. */}
            <div
              style={{
                padding: "12px 22px",
                borderBottom: "1px solid var(--rule)",
                display: "flex",
                alignItems: "center",
                gap: 12,
                flexWrap: "wrap",
              }}
            >
              <div className={s.seg}>
                {BOOK_FILTERS.map((f) => (
                  <button
                    key={f.key}
                    onClick={() => setBookFilter(f.key)}
                    className={`${s.segBtn} ${bookFilter === f.key ? s.segBtnOn : ""}`}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
              <span className={s.mono} style={{ fontSize: 10.5, color: "var(--ink3)" }}>
                {filteredRows.length} of {makers.makers.length}
              </span>
            </div>

            <Table
              cols={BOOK_COLS}
              min={740}
              head={
                <>
                  <span>Maker</span>
                  <span className={s.right}>Promised</span>
                  <span className={s.right}>Deliverable</span>
                  <span className={s.right}>Shortfall</span>
                  <span className={s.right}>Coverage</span>
                  <span className={s.right}>Oracle</span>
                </>
              }
            >
              {pageRows.length === 0 ? (
                <p style={{ margin: 0, padding: "18px 22px", fontSize: 14, color: "var(--ink3)" }}>
                  No maker on this page matches &ldquo;{BOOK_FILTERS.find((f) => f.key === bookFilter)?.label}&rdquo;.
                </p>
              ) : (
                pageRows.map(({ m, i, cov, slice, used, noAllowance, tag }) => {
                  const dec = makers.token.decimals;
                  return (
                    <Trow cols={BOOK_COLS} tone={used ? "used" : undefined} key={`${m.maker}-${m.strategyHash}-${i}`}>
                      <div style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 0, paddingRight: 14 }}>
                        <span style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                          <span className={s.mono} style={{ fontSize: 13, display: "inline-flex", alignItems: "center" }}>
                            {shortAddr(m.maker)}
                            <CopyButton value={m.maker} />
                          </span>
                          <span className={`${s.pill} ${used ? s.pillRouted : m.solvent ? "" : s.pillShort}`}>
                            {tag}
                          </span>
                        </span>
                        <span className={s.mono} style={{ fontSize: 10.5, color: "var(--ink3)" }}>
                          wallet {units(m.wallet, dec, 2)} · allowance{" "}
                          <span style={{ color: noAllowance ? "var(--short)" : "var(--ink3)" }}>
                            {noAllowance ? "0.00" : allowanceText(m.allowance, dec)}
                          </span>
                        </span>
                      </div>
                      <span className={`${s.num} ${s.right}`} style={{ color: "var(--ink3)", paddingRight: 16 }}>
                        {units(m.virtual, dec, 2)}
                      </span>
                      <span className={`${s.numBig} ${s.right}`} style={{ paddingRight: 16 }}>
                        {units(m.depth, dec, 2)}
                      </span>
                      <span
                        className={`${s.num} ${s.right}`}
                        style={{ color: m.shortfall === "0" ? "var(--ink3)" : "var(--short)", paddingRight: 18 }}
                      >
                        {m.shortfall === "0" ? "—" : units(m.shortfall, dec, 2)}
                      </span>
                      <div style={{ paddingRight: 14 }}>
                        <Bar pct={cov} />
                      </div>
                      <span className={`${s.mono} ${s.right}`} style={{ fontSize: 11.5, color: "var(--ink3)" }}>
                        {slice?.oracleDeviationBps ?? "—"}
                      </span>
                    </Trow>
                  );
                })
              )}
            </Table>

            {bookPages > 1 ? (
              <div
                style={{
                  padding: "11px 22px",
                  borderTop: "1px solid var(--rule)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 12,
                }}
              >
                <button
                  className={`${s.btn} ${s.btnXs}`}
                  disabled={bookPageClamped === 0}
                  onClick={() => setBookPage((p) => Math.max(0, p - 1))}
                >
                  ‹ Prev
                </button>
                <span className={s.mono} style={{ fontSize: 10.5, color: "var(--ink3)" }}>
                  page {bookPageClamped + 1} of {bookPages}
                </span>
                <button
                  className={`${s.btn} ${s.btnXs}`}
                  disabled={bookPageClamped >= bookPages - 1}
                  onClick={() => setBookPage((p) => Math.min(bookPages - 1, p + 1))}
                >
                  Next ›
                </button>
              </div>
            ) : null}

            <div className={s.legend}>
              <span className={s.legendItem}>
                <span className={s.swatch} />
                can deliver
              </span>
              <span className={s.legendItem}>
                <span className={`${s.swatch} ${s.swatchShort}`} />
                short
              </span>
              <span className={s.legendItem}>
                <span className={s.swatchEdge} />
                in this route
              </span>
              <span>amounts shown to 2dp · full precision in raw hook data</span>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
