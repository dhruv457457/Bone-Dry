"use client";

import { useState, useEffect, useMemo, useCallback } from "react";
import { useSendTransaction } from "wagmi";
import { keccak256, type Address, type Hex } from "viem";
import s from "../app.module.css";
import { TokenIcon } from "../TokenIcon";
import { CopyButton } from "../CopyButton";
import { DepthChart, type RangePreset } from "./DepthChart";
import { units, short as shortAddr, toRaw } from "@/lib/format";
import type { ExposureResponse } from "../types";
import { publicClientFor, type Network } from "@/lib/networks";

type Token = { address: string; symbol: string; decimals: number };

function describe(e: unknown): string {
  if (e instanceof Error) {
    const msg = e.message;
    if (msg.includes("User rejected")) return "Transaction rejected in wallet";
    return msg.slice(0, 120);
  }
  return String(e).slice(0, 120);
}

export function Provide({
  net,
  tokenIn,
  tokenOut,
  address,
  wrongChain,
  onShipped,
  onPickPair,
}: {
  net: Network;
  tokenIn: Token;
  tokenOut: Token;
  address?: Address;
  wrongChain: boolean;
  onShipped: () => void;
  onPickPair?: () => void;
}) {
  const [claimIn, setClaimIn] = useState("");
  const [claimOut, setClaimOut] = useState("");
  const [feeBps, setFeeBps] = useState("0");
  const [pricing, setPricing] = useState<"xyc" | "oracle">("xyc");
  const [rangePreset, setRangePreset] = useState<RangePreset>("10");
  const [spotPrice, setSpotPrice] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shippedHash, setShippedHash] = useState<Hex | null>(null);
  const [beaconSpreadBps, setBeaconSpreadBps] = useState<number | null>(null);

  // Encumbrance Strategy parameters
  const [maxUtilBps, setMaxUtilBps] = useState(8000); // 80% default
  const [widenBps, setWidenBps] = useState(500); // 500 bps = 5% default
  const [graphMode, setGraphMode] = useState<"curve" | "depth">("curve");
  const [showFormulas, setShowFormulas] = useState(false);

  const { sendTransactionAsync } = useSendTransaction();

  // Exposure data from the index
  const [exposure, setExposure] = useState<ExposureResponse | null>(null);
  const [loadingExposure, setLoadingExposure] = useState(false);

  // Target query maker: connected address, or sample maker on Base Sepolia
  const queryMaker = address || (net.id === 84532 ? "0xe788c06F4f71EebE7F71b00661CA706Ed66fCABe" : undefined);

  useEffect(() => {
    if (!queryMaker) {
      setExposure(null);
      return;
    }
    let live = true;
    setLoadingExposure(true);
    fetch(`/api/exposure?chain=${net.id}&maker=${queryMaker}`)
      .then((r) => r.json())
      .then((d: ExposureResponse) => {
        if (live && !d.error && d.available !== false) setExposure(d);
      })
      .catch(() => {})
      .finally(() => live && setLoadingExposure(false));
    return () => {
      live = false;
    };
  }, [queryMaker, net.id, shippedHash]);

  const isBeaconEligible =
    net.id === 84532 &&
    ((tokenIn.address.toLowerCase() === net.weth.toLowerCase() && tokenOut.address.toLowerCase() === net.usdc.toLowerCase()) ||
     (tokenIn.address.toLowerCase() === net.usdc.toLowerCase() && tokenOut.address.toLowerCase() === net.weth.toLowerCase()));

  useEffect(() => {
    setShippedHash(null);
    setError(null);
    setBusy(false);
    setPricing("xyc");
  }, [net.id]);

  useEffect(() => {
    if (!isBeaconEligible && pricing === "oracle") {
      setPricing("xyc");
    }
  }, [isBeaconEligible, pricing]);

  useEffect(() => {
    if (!isBeaconEligible) return;
    let active = true;
    fetch(`/api/beacon-spread?chain=${net.id}`)
      .then((r) => r.json())
      .then((json: { available: boolean; spreadBps?: number }) => {
        if (active) setBeaconSpreadBps(json.available ? json.spreadBps ?? null : null);
      })
      .catch(() => {
        if (active) setBeaconSpreadBps(null);
      });
    return () => {
      active = false;
    };
  }, [isBeaconEligible, net.id]);

  const calcClaimOut = useCallback(
    (inStr: string, _preset: RangePreset, spot: number | null) => {
      if (!spot || spot <= 0) return;
      const numIn = parseFloat(inStr);
      if (isNaN(numIn) || numIn <= 0) return;

      const isWethIn = tokenIn.symbol.toUpperCase() === "WETH";
      const isWethOut = tokenOut.symbol.toUpperCase() === "WETH";

      if (isWethIn) {
        const out = numIn * spot;
        setClaimOut(out.toFixed(2));
      } else if (isWethOut) {
        const out = numIn / spot;
        setClaimOut(out.toFixed(4));
      } else {
        const out = numIn * spot;
        setClaimOut(out.toFixed(tokenOut.decimals <= 6 ? 2 : 4));
      }
    },
    [tokenIn.symbol, tokenOut.symbol, tokenOut.decimals]
  );

  const handleSelectPreset = useCallback(
    (p: RangePreset) => {
      setRangePreset(p);
      if (!spotPrice || spotPrice <= 0) return;

      let currentIn = claimIn;
      if (!currentIn || parseFloat(currentIn) <= 0 || isNaN(parseFloat(currentIn))) {
        const isWethIn = tokenIn.symbol.toUpperCase() === "WETH";
        currentIn = isWethIn ? "0.5" : "1000";
        setClaimIn(currentIn);
      }
      calcClaimOut(currentIn, p, spotPrice);
    },
    [claimIn, spotPrice, tokenIn.symbol, calcClaimOut]
  );

  useEffect(() => {
    if (spotPrice && spotPrice > 0 && !claimIn && !claimOut) {
      const isWethIn = tokenIn.symbol.toUpperCase() === "WETH";
      const isWethOut = tokenOut.symbol.toUpperCase() === "WETH";
      const initialIn = isWethIn ? "0.5" : "1000";
      setClaimIn(initialIn);
      const initialOut = isWethIn
        ? (0.5 * spotPrice).toFixed(2)
        : isWethOut
        ? (1000 / spotPrice).toFixed(4)
        : "1000";
      setClaimOut(initialOut);
    }
  }, [spotPrice, tokenIn.symbol, tokenOut.symbol, claimIn, claimOut]);

  const parsedIn = toRaw(claimIn, tokenIn.decimals);
  const parsedOut = toRaw(claimOut, tokenOut.decimals);
  const amountInvalid = parsedIn === 0n || parsedOut === 0n;
  const disabled = !address || wrongChain || amountInvalid || busy;

  // Exposure metrics for tokenIn
  const pos = exposure?.positions.find(
    (x) => x.token.toLowerCase() === tokenIn.address.toLowerCase()
  );
  const held = pos ? BigInt(pos.held) : null;
  const alreadyPromised = pos ? BigInt(pos.claimed) : 0n;
  const capacity = held === null ? null : held > alreadyPromised ? held - alreadyPromised : 0n;
  const thisClaim = (() => {
    try {
      return BigInt(toRaw(claimIn || "0", tokenIn.decimals));
    } catch {
      return 0n;
    }
  })();
  const coverPct =
    capacity === null || thisClaim === 0n
      ? 100
      : Math.min(100, Number((capacity * 10000n) / thisClaim) / 100);
  const covered = coverPct >= 100;
  const shortBy = capacity !== null && thisClaim > capacity ? thisClaim - capacity : 0n;

  // Current utilization of maker wallet for this token (0 to 100)
  const currentUtilPct = held && held > 0n ? Math.min(100, Number((alreadyPromised * 10000n) / held) / 100) : 0;

  // Sibling strategies from index
  const liveSiblings = useMemo(() => {
    if (!exposure?.strategies) return [];
    return exposure.strategies;
  }, [exposure]);

  const siblingLimitExceeded = liveSiblings.length > 6;

  const handleShip = async () => {
    if (disabled || !address) return;
    const forChain = net.id;
    setBusy(true);
    setError(null);
    setShippedHash(null);

    try {
      const res = await fetch("/api/strategy", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          maker: address,
          chainId: net.id,
          tokenIn: tokenIn.address,
          tokenOut: tokenOut.address,
          amountIn: parsedIn.toString(),
          amountOut: parsedOut.toString(),
          feeBps: pricing === "oracle" ? 0 : feeBps ? Number(feeBps) : 0,
          pricing,
        }),
      });

      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `failed to assemble strategy (${res.status})`);
      }

      const built = (await res.json()) as { to: Address; data: Hex; strategy: Hex };
      if (forChain !== net.id) return;

      const hash = await sendTransactionAsync({
        to: built.to,
        data: built.data,
      });

      const rpc = publicClientFor(net);
      const receipt = await rpc.waitForTransactionReceipt({ hash });
      if (forChain !== net.id) return;

      if (receipt.status !== "success") {
        throw new Error("reverted on chain");
      }

      const strategyHash = keccak256(built.strategy);
      setShippedHash(strategyHash);
      onShipped();
    } catch (e) {
      if (forChain === net.id) {
        setError(describe(e));
      }
    } finally {
      if (forChain === net.id) {
        setBusy(false);
      }
    }
  };

  // SVG Curve coordinate calculations
  // Width: 600, Height: 180, Padding: X: 40-580, Y: 20-140
  const maxUtilRatio = maxUtilBps / 10000;
  const cliffX = 40 + maxUtilRatio * 540;
  const currentUtilX = 40 + (currentUtilPct / 100) * 540;
  const currentHaircutBps = Math.round((currentUtilPct / 100) * widenBps);
  const currentQuoteVal = Math.max(0, 1 - (currentUtilPct / 100) * (widenBps / 10000));

  // Path for the haircut curve from 0 to maxUtil
  const curveStartX = 40;
  const curveStartY = 35;
  const curveEndUtilY = 35 + (widenBps / 10000) * 120;

  return (
    <div>
      <div style={{ marginBottom: 20, display: "flex", justifyContent: "space-between", alignItems: "flex-end", flexWrap: "wrap", gap: 16 }}>
        <div>
          <h1 className={`${s.display} ${s.h1}`}>Encumbered strategy builder</h1>
          <p style={{ margin: 0, color: "var(--ink2)", maxWidth: "60ch", fontSize: 15 }}>
            Aqua lets you promise the same tokens twice. Bone Dry enforces on-chain solvency limits that refuse before they fail.
          </p>
        </div>
        {onPickPair && (
          <button
            type="button"
            className={s.ticker}
            onClick={onPickPair}
            style={{ cursor: "pointer", padding: "5px 14px 5px 8px" }}
            title="Change trading pair"
          >
            <div style={{ display: "flex", alignItems: "center", marginRight: 2 }}>
              <TokenIcon chainId={net.id} address={tokenIn.address as Address} symbol={tokenIn.symbol} size={20} />
              <span style={{ marginLeft: -4 }}>
                <TokenIcon chainId={net.id} address={tokenOut.address as Address} symbol={tokenOut.symbol} size={20} />
              </span>
            </div>
            <span style={{ fontWeight: 600 }}>{tokenIn.symbol} / {tokenOut.symbol}</span>
            <span style={{ fontSize: 10, color: "var(--ink3)", marginLeft: 4 }}>▾</span>
          </button>
        )}
      </div>

      <div className={s.cols}>
        {/* ── Control Column ─────────────────────────────────────────────── */}
        <div className={s.colNarrow}>
          {/* 1. Live Exposure Card */}
          <section className={`${s.card} ${s.cardPad}`}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 12 }}>
              <span className={s.label}>Your Live Exposure</span>
              {address ? (
                <span className={s.mono} style={{ fontSize: 11, color: "var(--ink3)" }}>
                  {shortAddr(address)}
                </span>
              ) : (
                <span className={s.mono} style={{ fontSize: 11, color: "var(--ink3)" }}>
                  Demo preview
                </span>
              )}
            </div>

            <div style={{ marginBottom: 14 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                <span style={{ fontSize: 13.5, color: "var(--ink2)" }}>Wallet Backing</span>
                <span className={s.mono} style={{ fontSize: 14, fontWeight: 600, color: "var(--ink)" }}>
                  {held === null ? "—" : units(held, tokenIn.decimals, 2)} {tokenIn.symbol}
                </span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginTop: 4 }}>
                <span style={{ fontSize: 13.5, color: "var(--ink2)" }}>Total Promised (Live Siblings)</span>
                <span className={s.mono} style={{ fontSize: 14, color: alreadyPromised > 0n ? "var(--ink)" : "var(--ink3)" }}>
                  {units(alreadyPromised, tokenIn.decimals, 2)} {tokenIn.symbol}
                </span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginTop: 4 }}>
                <span style={{ fontSize: 13.5, color: "var(--ink2)" }}>Free Capacity</span>
                <span className={s.mono} style={{ fontSize: 14, color: "var(--ink)" }}>
                  {capacity === null ? "—" : units(capacity, tokenIn.decimals, 2)} {tokenIn.symbol}
                </span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginTop: 4 }}>
                <span style={{ fontSize: 13.5, color: "var(--ink2)" }}>Current Utilization</span>
                <span className={s.mono} style={{ fontSize: 14, fontWeight: 600, color: currentUtilPct >= 80 ? "var(--short)" : "var(--ink)" }}>
                  {currentUtilPct.toFixed(1)}%
                </span>
              </div>
            </div>

            <div className={s.bar} style={{ height: 6, width: "100%", marginBottom: 12 }}>
              <span
                className={s.barFill}
                style={{
                  width: `${currentUtilPct}%`,
                  background: currentUtilPct >= 80 ? "var(--short)" : "var(--ink)",
                }}
              />
            </div>
          </section>

          {/* 2. The Two Encumbrance Parameters */}
          <section className={`${s.card} ${s.cardPad}`}>
            <span className={s.label} style={{ marginBottom: 12, display: "block" }}>
              Encumbrance Parameters
            </span>

            {/* Parameter A: maxUtilBps */}
            <div style={{ marginBottom: 18 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6 }}>
                <span style={{ fontSize: 13.5, fontWeight: 500, color: "var(--ink)" }}>Refusal Ceiling</span>
                <span className={s.mono} style={{ fontSize: 13, fontWeight: 600, color: "var(--ink)" }}>
                  {(maxUtilBps / 100).toFixed(0)}% ({maxUtilBps} bps)
                </span>
              </div>
              <input
                type="range"
                min={2000}
                max={9900}
                step={100}
                value={maxUtilBps}
                onChange={(e) => setMaxUtilBps(Number(e.target.value))}
                style={{ width: "100%", accentColor: "var(--ink)", cursor: "pointer", marginBottom: 6 }}
              />
              <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
                {[5000, 7500, 8000, 9000].map((bps) => (
                  <button
                    key={bps}
                    type="button"
                    onClick={() => setMaxUtilBps(bps)}
                    className={`${s.btn} ${s.btnXs} ${maxUtilBps === bps ? s.btnSolid : ""}`}
                    style={{ flex: 1, padding: "2px 0" }}
                  >
                    {bps / 100}%
                  </button>
                ))}
              </div>
              <p style={{ margin: 0, fontSize: 12.5, color: "var(--ink2)", lineHeight: 1.4 }}>
                &ldquo;Refuse fills on-chain once more than <strong>{(maxUtilBps / 100).toFixed(0)}%</strong> of my wallet is promised across sibling strategies.&rdquo;
              </p>
            </div>

            {/* Parameter B: widenBps */}
            <div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6 }}>
                <span style={{ fontSize: 13.5, fontWeight: 500, color: "var(--ink)" }}>Spread Widening</span>
                <span className={s.mono} style={{ fontSize: 13, fontWeight: 600, color: "var(--ink)" }}>
                  {(widenBps / 100).toFixed(2)}% ({widenBps} bps)
                </span>
              </div>
              <input
                type="range"
                min={0}
                max={1500}
                step={50}
                value={widenBps}
                onChange={(e) => setWidenBps(Number(e.target.value))}
                style={{ width: "100%", accentColor: "var(--ink)", cursor: "pointer", marginBottom: 6 }}
              />
              <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
                {[100, 250, 500, 1000].map((bps) => (
                  <button
                    key={bps}
                    type="button"
                    onClick={() => setWidenBps(bps)}
                    className={`${s.btn} ${s.btnXs} ${widenBps === bps ? s.btnSolid : ""}`}
                    style={{ flex: 1, padding: "2px 0" }}
                  >
                    {bps} bps
                  </button>
                ))}
              </div>
              <p style={{ margin: 0, fontSize: 12.5, color: "var(--ink2)", lineHeight: 1.4 }}>
                &ldquo;Quote up to <strong>{(widenBps / 100).toFixed(2)}%</strong> wider as wallet utilization approaches the refusal ceiling.&rdquo;
              </p>
            </div>
          </section>

          {/* 3. Sibling List & Completeness */}
          <section className={`${s.card} ${s.cardPad}`}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8 }}>
              <span className={s.label}>Live Sibling Constraints</span>
              <span className={s.mono} style={{ fontSize: 11, color: "var(--ink3)" }}>
                {liveSiblings.length} found in index
              </span>
            </div>

            {/* Completeness warning or success */}
            <div
              style={{
                padding: "10px 12px",
                borderRadius: 8,
                background: siblingLimitExceeded ? "rgba(194, 78, 25, 0.08)" : "var(--sunk)",
                border: siblingLimitExceeded ? "1px solid var(--short)" : "1px solid var(--rule)",
                marginBottom: 12,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                <span
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: "50%",
                    background: siblingLimitExceeded ? "var(--short)" : "var(--ink)",
                  }}
                />
                <span
                  className={s.mono}
                  style={{
                    fontSize: 11,
                    fontWeight: 600,
                    color: siblingLimitExceeded ? "var(--short)" : "var(--ink)",
                  }}
                >
                  {siblingLimitExceeded
                    ? "UNDER-CONSTRAINED LIST"
                    : liveSiblings.length > 0
                    ? "COMPLETE CONSTRAINT SET"
                    : "FIRST STRATEGY FOR MAKER"}
                </span>
              </div>
              <p style={{ margin: 0, fontSize: 12.5, color: "var(--ink2)", lineHeight: 1.4 }}>
                {siblingLimitExceeded
                  ? `You have ${liveSiblings.length} live strategies. SwapVM caps instruction args at 255 bytes (max 6 siblings). The remaining ${liveSiblings.length - 6} strategies cannot be constrained on-chain.`
                  : liveSiblings.length > 0
                  ? `All ${liveSiblings.length} live siblings on this token will be registered into declaredTotalEncumbrance.`
                  : "No prior live strategies on this token. Your strategy will be fully backed."}
              </p>
            </div>

            {/* Sibling items */}
            {liveSiblings.length > 0 && (
              <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 160, overflowY: "auto" }}>
                {liveSiblings.slice(0, 6).map((strat, idx) => {
                  const matchingSide = strat.sides.find(sd => sd.token.toLowerCase() === tokenIn.address.toLowerCase()) || strat.sides[0];
                  return (
                    <div
                      key={strat.strategyHash}
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        padding: "6px 8px",
                        background: "var(--surface)",
                        border: "1px solid var(--rule)",
                        borderRadius: 6,
                        fontSize: 11.5,
                      }}
                    >
                      <span className={s.mono} style={{ color: "var(--ink2)" }}>
                        #{idx + 1} {shortAddr(strat.strategyHash)}
                      </span>
                      <span className={s.mono} style={{ color: "var(--ink)" }}>
                        {matchingSide ? `${units(matchingSide.claimed, matchingSide.decimals, 2)} ${matchingSide.symbol}` : "0"}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
            <p className={s.mono} style={{ margin: "10px 0 0", fontSize: 10, color: "var(--ink3)" }}>
              SwapVM instruction cap: 255 bytes (leaving (255 - 38)/32 = 6 sibling slots).
            </p>
          </section>

          {/* 4. Claim Inputs & Ship Action */}
          <section className={`${s.card} ${s.cardPad}`}>
            <span className={s.label} style={{ marginBottom: 12, display: "block" }}>
              Ship Strategy
            </span>

            <div className={s.inset} style={{ marginBottom: 12 }}>
              <div className={s.fieldHead}>
                <span className={s.label}>Offer {tokenIn.symbol}</span>
                <span className={s.mono} style={{ fontSize: 10.5, color: "var(--ink3)" }}>
                  held {held === null ? "—" : units(held, tokenIn.decimals, 2)}
                </span>
              </div>
              <div className={s.amountRow}>
                <input
                  className={s.amountIn}
                  value={claimIn}
                  inputMode="decimal"
                  onChange={(e) => {
                    setClaimIn(e.target.value);
                    setRangePreset("custom");
                  }}
                  placeholder="0.0"
                />
                <span className={s.mono} style={{ fontSize: 14, color: "var(--ink)" }}>
                  {tokenIn.symbol}
                </span>
              </div>
            </div>

            <div className={s.inset} style={{ marginBottom: 14 }}>
              <div className={s.fieldHead}>
                <span className={s.label}>Ask {tokenOut.symbol}</span>
              </div>
              <div className={s.amountRow}>
                <input
                  className={s.amountIn}
                  value={claimOut}
                  inputMode="decimal"
                  onChange={(e) => {
                    setClaimOut(e.target.value);
                    setRangePreset("custom");
                  }}
                  placeholder="0.0"
                />
                <span className={s.mono} style={{ fontSize: 14, color: "var(--ink)" }}>
                  {tokenOut.symbol}
                </span>
              </div>
            </div>

            <button
              className={`${s.btnBlock} ${!covered && address ? s.btnBlockShort : ""}`}
              onClick={handleShip}
              disabled={disabled}
            >
              {busy
                ? "Shipping…"
                : !address
                ? "Connect wallet to ship"
                : wrongChain
                ? "Switch network to ship"
                : amountInvalid
                ? "Enter claim amounts"
                : covered
                ? "Publish Encumbered Strategy"
                : "Publish anyway — over-promised"}
            </button>

            {shippedHash && (
              <p style={{ margin: "10px 0 0", fontSize: 13, color: "var(--ink2)", display: "inline-flex", alignItems: "center" }}>
                <span>Shipped: </span>
                <span className={s.mono} style={{ fontSize: 11.5, margin: "0 4px" }}>
                  {shortAddr(shippedHash)}
                </span>
                <CopyButton value={shippedHash} size={11} />
              </p>
            )}

            {error && (
              <p className={s.mono} style={{ margin: "10px 0 0", fontSize: 11, color: "var(--short)" }}>
                {error}
              </p>
            )}
          </section>
        </div>

        {/* ── Evidence & Graph Column (Wide) ─────────────────────────────── */}
        <div className={s.colWide}>
          {/* Main Hero Graph Card */}
          <section className={`${s.card} ${s.cardClip}`} style={{ marginBottom: 24 }}>
            <div
              className={s.cardHead}
              style={{ padding: "18px 22px", alignItems: "flex-end", flexWrap: "wrap", gap: 12 }}
            >
              <div style={{ minWidth: 0 }}>
                <h2 className={`${s.display} ${s.h2}`} style={{ marginBottom: 3 }}>
                  {graphMode === "curve"
                    ? "Live Solvency & Haircut Response Curve"
                    : "Depth & Price Range (Oracle Sizing)"}
                </h2>
                <p style={{ margin: 0, fontSize: 13.5, color: "var(--ink3)" }}>
                  {graphMode === "curve"
                    ? "Real-time haircut curve over wallet utilization with the on-chain refusal cliff."
                    : "Sizing depth against live Chainlink AggregatorV3 spot rounds."}
                </p>
              </div>

              {/* Graph Toggle */}
              <div className={s.seg}>
                <button
                  type="button"
                  onClick={() => setGraphMode("curve")}
                  className={`${s.segBtn} ${graphMode === "curve" ? s.segBtnOn : ""}`}
                >
                  Solvency Curve
                </button>
                <button
                  type="button"
                  onClick={() => setGraphMode("depth")}
                  className={`${s.segBtn} ${graphMode === "depth" ? s.segBtnOn : ""}`}
                >
                  Depth &amp; Range
                </button>
              </div>
            </div>

            {/* Graph 1: Solvency Response Curve */}
            {graphMode === "curve" ? (
              <div style={{ padding: "20px 22px" }}>
                {/* Stat strip over the curve */}
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
                    gap: 12,
                    marginBottom: 20,
                  }}
                >
                  <div style={{ padding: "10px 14px", background: "var(--sunk)", borderRadius: 8, border: "1px solid var(--rule)" }}>
                    <span className={s.label} style={{ fontSize: 9.5 }}>Current Maker Util</span>
                    <p className={s.mono} style={{ margin: "2px 0 0", fontSize: 18, fontWeight: 600, color: "var(--ink)" }}>
                      {currentUtilPct.toFixed(1)}%
                    </p>
                  </div>
                  <div style={{ padding: "10px 14px", background: "var(--sunk)", borderRadius: 8, border: "1px solid var(--rule)" }}>
                    <span className={s.label} style={{ fontSize: 9.5 }}>Effective Haircut</span>
                    <p className={s.mono} style={{ margin: "2px 0 0", fontSize: 18, fontWeight: 600, color: "var(--ink)" }}>
                      -{currentHaircutBps} bps
                    </p>
                  </div>
                  <div style={{ padding: "10px 14px", background: "var(--sunk)", borderRadius: 8, border: "1px solid var(--rule)" }}>
                    <span className={s.label} style={{ fontSize: 9.5 }}>1.000 WETH Quotes As</span>
                    <p className={s.mono} style={{ margin: "2px 0 0", fontSize: 18, fontWeight: 600, color: "var(--ink)" }}>
                      {currentQuoteVal.toFixed(4)} WETH
                    </p>
                  </div>
                  <div style={{ padding: "10px 14px", background: "var(--sunk)", borderRadius: 8, border: "1px solid var(--rule)" }}>
                    <span className={s.label} style={{ fontSize: 9.5 }}>Refusal Threshold</span>
                    <p className={s.mono} style={{ margin: "2px 0 0", fontSize: 18, fontWeight: 600, color: "var(--short)" }}>
                      {(maxUtilBps / 100).toFixed(0)}% ({maxUtilBps} bps)
                    </p>
                  </div>
                </div>

                {/* SVG Visualization */}
                <div style={{ position: "relative", width: "100%", height: 210, background: "var(--surface)", border: "1px solid var(--rule)", borderRadius: 8, overflow: "hidden" }}>
                  <svg
                    viewBox="0 0 600 180"
                    preserveAspectRatio="none"
                    style={{ width: "100%", height: "100%", display: "block" }}
                  >
                    {/* Horizontal Grid lines */}
                    {[35, 75, 115, 155].map((y, idx) => (
                      <line key={y} x1={40} y1={y} x2={580} y2={y} stroke="var(--rule)" strokeWidth={1} />
                    ))}

                    {/* Utilization grid verticals */}
                    {[0, 25, 50, 75, 100].map((pct) => {
                      const gx = 40 + (pct / 100) * 540;
                      return (
                        <g key={pct}>
                          <line x1={gx} y1={20} x2={gx} y2={155} stroke="var(--rule)" strokeWidth={1} strokeDasharray="3 3" />
                          <text x={gx} y={170} textAnchor="middle" fill="var(--ink3)" fontSize={9.5} fontFamily="var(--mono)">
                            {pct}%
                          </text>
                        </g>
                      );
                    })}

                    {/* Safe zone fill */}
                    <polygon
                      points={`40,155 40,${curveStartY} ${cliffX},${curveEndUtilY} ${cliffX},155`}
                      fill="var(--ink)"
                      opacity={0.06}
                    />

                    {/* Rejection zone fill (past maxUtilBps) */}
                    <rect
                      x={cliffX}
                      y={20}
                      width={580 - cliffX}
                      height={135}
                      fill="rgba(194, 78, 25, 0.05)"
                    />

                    {/* Haircut Curve (Linear slope down to maxUtil) */}
                    <line
                      x1={curveStartX}
                      y1={curveStartY}
                      x2={cliffX}
                      y2={curveEndUtilY}
                      stroke="var(--ink)"
                      strokeWidth={2.5}
                    />

                    {/* Cliff Drop at maxUtil */}
                    <line
                      x1={cliffX}
                      y1={curveEndUtilY}
                      x2={cliffX}
                      y2={155}
                      stroke="var(--short)"
                      strokeWidth={2.5}
                      strokeDasharray="4 3"
                    />

                    {/* Refusal zone flat zero line */}
                    <line
                      x1={cliffX}
                      y1={155}
                      x2={580}
                      y2={155}
                      stroke="var(--short)"
                      strokeWidth={2}
                    />

                    {/* Current utilization indicator marker */}
                    {currentUtilX >= 40 && currentUtilX <= 580 && (
                      <g>
                        <line
                          x1={currentUtilX}
                          y1={20}
                          x2={currentUtilX}
                          y2={155}
                          stroke="var(--ink)"
                          strokeWidth={1.5}
                          strokeDasharray="2 2"
                        />
                        <circle
                          cx={currentUtilX}
                          cy={currentUtilX <= cliffX ? 35 + (currentUtilPct / 100) * (widenBps / 10000) * 120 : 155}
                          r={5}
                          fill="var(--ink)"
                          stroke="var(--paper)"
                          strokeWidth={2}
                        />
                      </g>
                    )}

                    {/* Refusal threshold badge in SVG */}
                    <g transform={`translate(${Math.min(480, cliffX - 10)}, 24)`}>
                      <rect x={-8} y={-10} width={90} height={18} rx={3} fill="var(--short)" />
                      <text x={37} y={3} textAnchor="middle" fill="white" fontSize={8.5} fontFamily="var(--mono)" fontWeight={600}>
                        REFUSES ON-CHAIN
                      </text>
                    </g>
                  </svg>
                </div>

                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 12, flexWrap: "wrap", gap: 8 }}>
                  <span className={s.mono} style={{ fontSize: 11, color: "var(--ink2)" }}>
                    ● <strong>Black line</strong>: Quotable output with linear spread widening (-{widenBps} bps at limit)
                  </span>
                  <span className={s.mono} style={{ fontSize: 11, color: "var(--short)" }}>
                    --- <strong>Red dashed cliff</strong>: On-chain refusal threshold (saves gas &amp; prevents revert)
                  </span>
                </div>
              </div>
            ) : (
              /* Graph 2: Depth & Range */
              <div style={{ padding: "20px 22px" }}>
                <DepthChart
                  chainId={net.id}
                  tokenIn={tokenIn}
                  tokenOut={tokenOut}
                  pricing={pricing}
                  preset={rangePreset}
                  spreadBps={beaconSpreadBps}
                  onSelectPreset={handleSelectPreset}
                  onSpotPrice={setSpotPrice}
                />
              </div>
            )}
          </section>

          {/* Mathematical Formulations ("Show the maths", §7.1) */}
          <section className={`${s.card} ${s.cardPad}`} style={{ marginBottom: 24 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
              <div>
                <span className={s.label}>Exact On-Chain Arithmetic</span>
                <h3 className={`${s.display} ${s.h2}`} style={{ margin: "2px 0 0", fontSize: 20 }}>
                  How the Encumbrance Strategy computes quotes
                </h3>
              </div>
              <button
                type="button"
                className={`${s.btn} ${s.btnXs}`}
                onClick={() => setShowFormulas((f) => !f)}
              >
                {showFormulas ? "Hide formulas" : "Show formulas"}
              </button>
            </div>

            <p style={{ margin: "0 0 14px", fontSize: 13.5, color: "var(--ink2)", lineHeight: 1.5 }}>
              Unlike conventional AMM pools that assume deposited liquidity is immutable, Bone Dry evaluates maker commitments against live wallet balances and sibling allocations:
            </p>

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
                gap: 12,
              }}
            >
              <div style={{ padding: "12px 14px", background: "var(--sunk)", borderRadius: 8, border: "1px solid var(--rule)" }}>
                <span className={s.mono} style={{ fontSize: 11, color: "var(--ink3)" }}>01 · Encumbrance</span>
                <p className={s.mono} style={{ margin: "4px 0 2px", fontSize: 13, fontWeight: 600, color: "var(--ink)" }}>
                  encumbered = Σ rawBalances(maker, sibling_i)
                </p>
                <span style={{ fontSize: 12, color: "var(--ink2)" }}>
                  Sums commitments across all live sibling strategies for this token.
                </span>
              </div>

              <div style={{ padding: "12px 14px", background: "var(--sunk)", borderRadius: 8, border: "1px solid var(--rule)" }}>
                <span className={s.mono} style={{ fontSize: 11, color: "var(--ink3)" }}>02 · Utilization</span>
                <p className={s.mono} style={{ margin: "4px 0 2px", fontSize: 13, fontWeight: 600, color: "var(--ink)" }}>
                  util = encumbered / backing
                </p>
                <span style={{ fontSize: 12, color: "var(--ink2)" }}>
                  Ratio of promised capital to total deliverable backing.
                </span>
              </div>

              <div style={{ padding: "12px 14px", background: "var(--sunk)", borderRadius: 8, border: "1px solid var(--rule)" }}>
                <span className={s.mono} style={{ fontSize: 11, color: "var(--ink3)" }}>03 · Spread Widening</span>
                <p className={s.mono} style={{ margin: "4px 0 2px", fontSize: 13, fontWeight: 600, color: "var(--ink)" }}>
                  haircut = amountOut × widenBps × util / 1e8
                </p>
                <span style={{ fontSize: 12, color: "var(--ink2)" }}>
                  Linear price adjustment compensating for higher utilization.
                </span>
              </div>

              <div style={{ padding: "12px 14px", background: "var(--sunk)", borderRadius: 8, border: "1px solid var(--rule)" }}>
                <span className={s.mono} style={{ fontSize: 11, color: "var(--ink3)" }}>04 · Rejection Guard</span>
                <p className={s.mono} style={{ margin: "4px 0 2px", fontSize: 13, fontWeight: 600, color: "var(--short)" }}>
                  if (util &gt; maxUtilBps) revert Refusal()
                </p>
                <span style={{ fontSize: 12, color: "var(--ink2)" }}>
                  On-chain circuit breaker that saves transactions from failing mid-fill.
                </span>
              </div>
            </div>
          </section>

          {/* Reference Deployed Contracts */}
          <section className={`${s.card} ${s.cardPad}`}>
            <span className={s.label} style={{ marginBottom: 8, display: "block" }}>
              Verified Deployments · {net.label}
            </span>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 12.5 }}>
                <span style={{ color: "var(--ink2)" }}>Aqua Settlement Contract</span>
                <span className={s.mono} style={{ display: "inline-flex", alignItems: "center" }}>
                  {shortAddr(net.aqua)}
                  <CopyButton value={net.aqua} size={11} />
                </span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 12.5 }}>
                <span style={{ color: "var(--ink2)" }}>BoneDryRouter</span>
                <span className={s.mono} style={{ display: "inline-flex", alignItems: "center" }}>
                  {shortAddr(net.router)}
                  <CopyButton value={net.router} size={11} />
                </span>
              </div>
              {net.id === 84532 && (
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 12.5 }}>
                  <span style={{ color: "var(--ink2)" }}>Live Encumbrance Strategy Example</span>
                  <span className={s.mono} style={{ display: "inline-flex", alignItems: "center" }}>
                    0x7b2e…67e3
                    <CopyButton value="0x7b2e1f478807218c335ebfe6a8b0250e61ab533d2a30902b9e298bfcfda467e3" size={11} />
                  </span>
                </div>
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
