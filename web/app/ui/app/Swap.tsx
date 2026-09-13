"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Address } from "viem";
import s from "../app.module.css";
import { Bar, Blocked, Shim, Table, Trow, TxSteps, type TxTone } from "./bits";
import { FindingLine } from "./Shell";
import { RouteInspector } from "../RouteInspector";
import { BookDepth } from "./BookDepth";
import { TokenIcon } from "../TokenIcon";
import { CopyButton } from "../CopyButton";
import { units, short as shortAddr, toRaw } from "@/lib/format";
import type { CoverageResponse, MakerRow, MakersResponse, PoolResponse, RouteResponse } from "../types";
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
  finding,
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
  finding: CoverageResponse | null;
}) {
  const [primer, setPrimer] = useState(false);
  const [raw, setRaw] = useState(false);
  const [bookFilter, setBookFilter] = useState<BookFilter>("all");
  const [bookPage, setBookPage] = useState(0);
  // Pre-sign animation state. null = not animating. 0/1/2 = step index.
  // The wallet is opened AFTER step 2 completes, so the user sees the full
  // verification sequence before the popup interrupts focus.
  const [animStep, setAnimStep] = useState<null | 0 | 1 | 2>(null);

  // Reset the animation whenever a transaction cycle completes or is aborted,
  // so the next trade re-runs the sequence from the top.
  useEffect(() => {
    if (txPhase !== "idle") setAnimStep(null);
  }, [txPhase]);

  const hasAmount = Number(input.replace(/,/g, "")) > 0;

  /**
   * How far below the oracle this quote actually lands.
   *
   * The API has computed `oracleDeviationBps` per slice all along and nothing
   * displayed it. That mattered once the router started picking between books:
   * a 100 USDC quote filled from three tiny XYC positions returned 0.030% of
   * oracle value -- $99.97 destroyed -- while the receipt read "100% backed
   * fill" and "Fully solvent fill". Both were true. A maker being able to
   * deliver says nothing about whether what they deliver is worth taking, and
   * this app measures the first and was silent on the second.
   *
   * Worst slice, not the average: one leg pricing far off is the thing to
   * surface, and averaging it against good legs hides exactly the case worth
   * seeing.
   */
  const worstDeviationBps = useMemo(() => {
    if (!route?.slices?.length) return null;
    let worst: number | null = null;
    for (const sl of route.slices) {
      if (sl.oracleDeviationBps == null) continue;
      const d = Number(sl.oracleDeviationBps);
      if (worst === null || d < worst) worst = d;
    }
    return worst;
  }, [route]);

  /** −100 bps is a 1% haircut against oracle: worth saying. −500 bps is worth
   *  shouting about, and is where the button stops looking like a plain yes. */
  const priceWarn = worstDeviationBps !== null && worstDeviationBps <= -100;
  const priceSevere = worstDeviationBps !== null && worstDeviationBps <= -500;
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

  // Base carries two stablecoins whose names differ by one letter — native USDC
  // (0x833589fC…) and the bridged USDbC (0xd9aaEc86…). A wallet holding one and
  // quoted in the other reads a truthful 0 as a broken app, so the shortfall is
  // named here with the symbol spelled out, before the button is pressed rather
  // than after it silently refuses.
  const wantRaw = toRaw(input, tokenIn.decimals);
  const shortOnBalance = connected && balance !== null && wantRaw > 0n && balance < wantRaw;

  const actionLabel = !connected
    ? "Connect wallet to swap"
    : wrongChain
      ? "Switch network to swap"
      : shortOnBalance
        ? `Not enough ${tokenIn.symbol}`
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
    !connected ||
    wrongChain ||
    shortOnBalance ||
    txPhase === "approving" ||
    txPhase === "swapping" ||
    !quoted;

  /**
   * The whole pipeline, not just the part after you sign.
   *
   * TxSteps only appeared once a wallet was open, so everything this app does
   * BEFORE that -- read the book, re-read every candidate's depth live, replay
   * Tap's own algorithm, pick between two books -- happened behind a spinner and
   * a number that changed. That work is the product. A taker who cannot see it
   * has to take "routes only to makers that pass the check" on faith, which is
   * the one thing this project argues nobody should have to do.
   *
   * Every stage is driven by real state: if the quote is instant the rows land
   * done, because they were. The one exception is the replay below, which re-plays
   * these same facts on a timer after Swap is pressed -- the facts are real, the
   * pacing is not, and it says so rather than pretending otherwise.
   */
  const txSteps: { label: string; detail?: ReactNode; tone: TxTone }[] = (() => {
    if (txPhase === "approving") {
      return [
        { label: "Route verified", tone: "done" as TxTone },
        { label: "Awaiting approval", detail: "your wallet is open", tone: "live" as TxTone },
      ];
    }
    if (txPhase === "swapping") {
      return [
        { label: "Approved", tone: "done" as TxTone },
        { label: "Filling on chain", detail: "one signature, every solvent maker", tone: "live" as TxTone },
      ];
    }
    if (txPhase === "done") {
      return txNote
        ? [
            { label: "Signed", detail: txHash, tone: "done" as TxTone },
            { label: "Reverted", detail: txNote, tone: "bad" as TxTone },
          ]
        : [
            { label: "Signed", detail: txHash, tone: "done" as TxTone },
            {
              label: "Filled",
              detail:
                received !== undefined
                  ? `${units(received, tokenOut.decimals, 6)} ${tokenOut.symbol} landed in your wallet`
                  : undefined,
              tone: "done" as TxTone,
            },
          ];
    }

    if (!hasAmount) return [];

    const bookRead = Boolean(makers);
    const quoting = busy || (!route && hasAmount);

    const steps: { label: string; detail?: ReactNode; tone: TxTone }[] = [
      {
        label: "Read the book",
        detail: bookRead ? `${makers!.makers.length} live strategies on ${tokenOut.symbol}` : "asking the index",
        tone: bookRead ? "done" : "live",
      },
      {
        label: "Re-read every maker on chain",
        detail: quoting
          ? "balance and allowance, not the index"
          : route
            ? `${route.makersConsidered} checked · ${route.makersSkipped.length} can't pay`
            : undefined,
        tone: quoting ? "live" : route ? "done" : "idle",
      },
    ];

    if (route && !quoted) {
      steps.push({ label: "No solvent maker can fill this", detail: route.reason, tone: "bad" });
      return steps;
    }

    if (route && quoted) {
      steps.push({
        label: "Route found",
        detail: `${route.makersUsed} wallet${route.makersUsed === 1 ? "" : "s"} · ${route.bookLabel ?? ""} book${route.encumbranceAware ? " · opcode 35" : ""}`,
        tone: "done",
      });
      steps.push({
        label: connected ? "Ready to sign" : "Connect a wallet to sign",
        detail: priceSevere ? "check the rate first" : undefined,
        tone: connected ? "live" : "idle",
      });
    }

    return steps;
  })();

  // When animStep is running we replace the static pipeline with a sequenced
  // replay of the same facts — one step appearing every 800 ms. The data is
  // real; only the timing is artificial. The wallet opens on the 3rd tick.
  const animatingSteps: typeof txSteps | null = (() => {
    if (animStep === null || txPhase !== "idle") return null;
    const bookDetail = makers
      ? `${makers.makers.length} live strategies on ${tokenOut.symbol}`
      : "…";
    const solventDetail = route
      ? `${route.makersConsidered} checked · ${route.makersSkipped.length} can't pay`
      : "…";
    const routeDetail = route
      ? `${route.makersUsed} wallet${route.makersUsed === 1 ? "" : "s"} · ${route.bookLabel ?? ""} book${route.encumbranceAware ? " · opcode 35" : ""}`
      : "…";
    return [
      {
        label: "Read the book",
        detail: animStep >= 0 ? bookDetail : "…",
        tone: (animStep >= 1 ? "done" : "live") as TxTone,
      },
      {
        label: "Re-read every maker on chain",
        detail: animStep >= 1 ? solventDetail : "balance and allowance, not the index",
        tone: (animStep === 0 ? "idle" : animStep >= 2 ? "done" : "live") as TxTone,
      },
      {
        label: "Route found",
        detail: animStep >= 2 ? routeDetail : undefined,
        tone: (animStep < 2 ? "idle" : "done") as TxTone,
      },
      {
        label: "Opening wallet…",
        detail: undefined,
        tone: (animStep < 2 ? "idle" : "live") as TxTone,
      },
    ];
  })();

  const visibleSteps = animatingSteps ?? txSteps;

  // Intercept the swap button: play the pre-sign animation, then open the wallet.
  // Latest onSwap, not the one captured at click time: a quote that refreshes
  // during the replay must be the one that gets signed.
  const onSwapRef = useRef(onSwap);
  onSwapRef.current = onSwap;
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  const handleSwapClick = () => {
    if (animStep !== null) return; // already animating
    setAnimStep(0);
    timers.current = [
      setTimeout(() => setAnimStep(1), 800),
      setTimeout(() => setAnimStep(2), 1600),
      setTimeout(() => {
        onSwapRef.current();
        // Hand back to the real pipeline immediately. executeSwap's pre-flight
        // refusals (wrong network, no hook code, short balance) return with the
        // phase still "idle", so the txPhase effect above never fires -- without
        // this the button stayed disabled and "Opening wallet" spun until reload.
        setAnimStep(null);
      }, 2400),
    ];
  };

  return (
    <>
      {/* One line, as every other tab uses. The full card put the Swap button
          near y=600 -- below the fold on a laptop -- to repeat a number the rail
          already carries. The histogram version stays on Explore, where the
          distribution is the subject rather than an interruption. */}
      <FindingLine
        finding={finding}
        chainLabel={net.aquaIsOurs ? "Base" : net.label}
        onEvidence={onExplore}
        stamp={quoteStamp}
      />
    <div className={`${s.cols} ${s.colsSwap} ${s.in}`}>
      <div className={`${s.colNarrow} ${s.swapCol}`}>

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

            {quoted && priceWarn ? (
              <div
                style={{
                  marginTop: 10,
                  padding: "8px 10px",
                  borderRadius: 6,
                  background: priceSevere ? "rgba(194, 78, 25, 0.10)" : "var(--sunk)",
                  border: `1px solid ${priceSevere ? "rgba(194, 78, 25, 0.30)" : "var(--rule)"}`,
                  fontSize: 12,
                  lineHeight: 1.45,
                  color: priceSevere ? "var(--short)" : "var(--ink2)",
                }}
              >
                <strong>
                  {(Math.abs(worstDeviationBps!) / 100).toFixed(priceSevere ? 1 : 2)}% below the Chainlink price
                </strong>
                {priceSevere
                  ? " — this book is solvent but shallow, so the curve prices you out at this size. Try a smaller amount."
                  : " — solvency is not price; check the rate before signing."}
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
            disabled={actionDisabled || animStep !== null}
            onClick={handleSwapClick}
          >
            {actionLabel}
          </button>

          {/* executeSwap refuses before it ever opens a wallet — not enough
              balance, or the wallet pointed at a different network than the app
              is reading — and reports why by returning to `idle` with a note.
              That note was only ever rendered in the `done` phase, so those two
              refusals set a message into state that nothing displayed: the
              button was pressed, the wallet never opened, and the screen said
              nothing at all. A check that cannot be seen is indistinguishable
              from a dead button. */}
          {txPhase === "idle" && txNote ? (
            <p
              style={{
                margin: "10px 0 0",
                textAlign: "center",
                fontSize: 13,
                color: "var(--short)",
                lineHeight: 1.45,
              }}
            >
              {txNote}
            </p>
          ) : null}

          <p style={{ margin: "10px 0 0", textAlign: "center", fontSize: 13, color: "var(--ink3)" }}>
            {!connected
              ? "The book, the quote and the finding all work without connecting."
              : txPhase === "swapping"
                ? "One transaction, every solvent maker, atomic."
                : net.aquaIsOurs
                  ? `${net.label} — faucet tokens are free, contracts are identical.`
                  : `Live on ${net.label} · routes only to makers that pass the check.`}
          </p>

          <TxSteps steps={visibleSteps} />
          {error ? (
            <p className={s.mono} style={{ margin: "10px 0 0", fontSize: 11, color: "var(--short)" }}>
              {error}
            </p>
          ) : null}
        </section>

        {/* ── route receipt ────────────────────────────────────────────── */}
      </div>

      {/* ── the maker book & route inspector ───────────────────────────── */}
      <div className={s.colWide}>
        {/* The chart the right column needed. 55 bars regardless of what the
            route did, so this side holds its weight whether one maker fills or
            fifty -- and it is the project's claim drawn rather than asserted. */}
        {makers && makers.makers.length > 0 ? (
          <section className={`${s.card} ${s.cardPad}`} style={{ marginBottom: 20 }}>
            <BookDepth makers={makers} route={route} tokenOut={tokenOut} />
          </section>
        ) : null}

        <RouteInspector
          route={route}
          tokenIn={tokenIn}
          tokenOut={tokenOut}
          net={net}
        />
        {/* Metadata reads after the result, not before it: what filled, then
            the pool and book it filled through. */}
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
              {/* Side by side at this width. These two are metadata about the
                  fill -- what the pool holds, and which book it routed through --
                  and stacking them turned a 920px card into 423px of vertical
                  scroll for content that fits in a strip. */}
              {/* The ROUTED THROUGH panel stood here saying what the breakdown's
                  subtitle says one card up, and what the pipeline's "Route found"
                  row now says in the swap card itself -- three copies of one fact.
                  The breakdown keeps it, beside the rows it describes. This card is
                  left with only what nothing else states: what the pool holds, and
                  the identifiers. With one cell left there is no grid to make. */}
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
                  // The considered/filled/skipped/unfillable tree lived here and
                  // in the breakdown's filter pills 400px to the right, same four
                  // numbers under two headings. The pills won: they are beside the
                  // rows they filter. Only "unfilled" survives, because nothing
                  // else on the page says the route could not absorb the input.
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
        {/* The 55-row maker book lived here: 1,113px of a 1,636px page, and since
            the router started choosing between books it was listing the EVIDENCE
            book's wallets under a trade filled from the Bone Dry book, with
            nothing saying they were different. It also duplicated Explore's
            "Coverage per maker", which does the same job across every token with
            network totals and a distribution beside it.

            So the rows moved to the tab that already had them, and the number --
            which is the finding, and the reason this project exists -- stays here
            as one line. */}
        {makers && makers.makers.length > 0 ? (
          <section className={`${s.card} ${s.cardPad}`} style={{ marginTop: 20 }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
              <span className={s.label}>The rest of the book</span>
              <span style={{ fontSize: 14, color: "var(--ink2)" }}>
                <strong style={{ color: "var(--ink)" }}>{enrichedRows.length}</strong> wallets quote{" "}
                {tokenOut.symbol} on {net.label}
                {(() => {
                  const short = enrichedRows.filter((r) => !r.m.solvent).length;
                  return short > 0 ? (
                    <>
                      {" · "}
                      <strong style={{ color: "var(--short)" }}>{short}</strong> can&apos;t deliver what they promised
                    </>
                  ) : null;
                })()}
              </span>
              <button className={s.btnQuiet} onClick={onExplore} style={{ marginLeft: "auto" }}>
                See the evidence →
              </button>
            </div>
          </section>
        ) : null}
      </div>
    </div>
    </>
  );
}
