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
  const [graphMode, setGraphMode] = useState<"depth" | "curve" | "dual">("dual");
  const [showFormulas, setShowFormulas] = useState(false);
  const [hoverUtil, setHoverUtil] = useState<number | null>(null);

  const { sendTransactionAsync } = useSendTransaction();

  // Read fixed spread from BeaconStrategy if oracle pricing is selected
  useEffect(() => {
    if (pricing !== "oracle") return;
    let active = true;
    const client = publicClientFor(net);
    const BEACON_STRATEGY: Address = "0x7890123456789012345678901234567890123456";
    const BEACON_ABI = [
      {
        type: "function",
        name: "fixedSpreadBps",
        inputs: [],
        outputs: [{ name: "", type: "uint16" }],
        stateMutability: "view",
      },
    ] as const;

    client
      .readContract({
        address: BEACON_STRATEGY,
        abi: BEACON_ABI,
        functionName: "fixedSpreadBps",
      })
      .then((val) => {
        if (active) setBeaconSpreadBps(Number(val));
      })
      .catch(() => {
        if (active) setBeaconSpreadBps(50); // 50 bps fallback
      });

    return () => {
      active = false;
    };
  }, [pricing, net]);

  // Read maker's live exposure from /api/exposure
  const [exposure, setExposure] = useState<ExposureResponse | null>(null);
  const [exposureLoading, setExposureLoading] = useState(false);

  useEffect(() => {
    if (!address) {
      setExposure(null);
      return;
    }
    let active = true;
    setExposureLoading(true);
    fetch(`/api/exposure?chain=${net.id}&maker=${address}`)
      .then((r) => r.json())
      .then((json: ExposureResponse) => {
        if (active) setExposure(json);
      })
      .catch(() => {
        if (active) setExposure(null);
      })
      .finally(() => {
        if (active) setExposureLoading(false);
      });

    return () => {
      active = false;
    };
  }, [net.id, address]);

  // Parse wallet position for tokenIn
  const tokenInPos = useMemo(() => {
    if (!exposure?.positions) return null;
    return exposure.positions.find((p) => p.token.toLowerCase() === tokenIn.address.toLowerCase()) ?? null;
  }, [exposure, tokenIn.address]);

  const held = useMemo(() => {
    if (!tokenInPos) return null;
    try {
      return BigInt(tokenInPos.held);
    } catch {
      return null;
    }
  }, [tokenInPos]);

  const alreadyPromised = useMemo(() => {
    if (!tokenInPos) return 0n;
    try {
      return BigInt(tokenInPos.claimed);
    } catch {
      return 0n;
    }
  }, [tokenInPos]);

  const capacity = useMemo(() => {
    if (held === null) return null;
    return held > alreadyPromised ? held - alreadyPromised : 0n;
  }, [held, alreadyPromised]);

  // Sizing helper based on preset
  const handleSelectPreset = useCallback(
    (p: RangePreset) => {
      setRangePreset(p);
      if (!spotPrice) return;
      if (claimIn && !claimOut) {
        const inNum = parseFloat(claimIn);
        if (!isNaN(inNum) && inNum > 0) {
          const outEst = inNum / spotPrice;
          setClaimOut(outEst.toFixed(Math.min(6, tokenOut.decimals)));
        }
      } else if (!claimIn && claimOut) {
        const outNum = parseFloat(claimOut);
        if (!isNaN(outNum) && outNum > 0) {
          const inEst = outNum * spotPrice;
          setClaimIn(inEst.toFixed(Math.min(4, tokenIn.decimals)));
        }
      }
    },
    [spotPrice, claimIn, claimOut, tokenIn.decimals, tokenOut.decimals]
  );

  const rawClaimIn = useMemo(() => toRaw(claimIn, tokenIn.decimals), [claimIn, tokenIn.decimals]);
  const rawClaimOut = useMemo(() => toRaw(claimOut, tokenOut.decimals), [claimOut, tokenOut.decimals]);

  const amountInvalid = rawClaimIn === 0n || rawClaimOut === 0n;
  const newTotalPromised = alreadyPromised + rawClaimIn;
  const covered = held === null || newTotalPromised <= held;
  const shortBy = held !== null && newTotalPromised > held ? newTotalPromised - held : 0n;

  const coverPct = useMemo(() => {
    if (held === null || held === 0n) return 0;
    if (newTotalPromised === 0n) return 100;
    const pct = Number((held * 10000n) / newTotalPromised) / 100;
    return Math.min(100, Math.max(0, pct));
  }, [held, newTotalPromised]);

  const disabled = !address || wrongChain || amountInvalid || busy;

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
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chainId: net.id,
          maker: address,
          tokenIn: tokenIn.address,
          tokenOut: tokenOut.address,
          amountIn: rawClaimIn.toString(),
          amountOut: rawClaimOut.toString(),
          feeBps: parseInt(feeBps, 10) || 0,
          pricing,
          maxUtilBps,
          widenBps,
        }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${res.status}`);
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

  // SVG Curve coordinate calculations for Solvency Haircut Curve
  const SVG_WIDTH = 640;
  const SVG_HEIGHT = 200;
  const BASE_AXIS_Y = 165;
  const TOP_AXIS_Y = 35;
  const START_X = 40;
  const END_X = 600;
  const USABLE_WIDTH = END_X - START_X;

  const maxUtilRatio = maxUtilBps / 10000;
  const cliffX = START_X + maxUtilRatio * USABLE_WIDTH;
  const currentUtilX = START_X + (currentUtilPct / 100) * USABLE_WIDTH;

  const currentHaircutBps = Math.round((currentUtilPct / 100) * widenBps);
  const currentQuoteVal = Math.max(0, 1 - (currentUtilPct / 100) * (widenBps / 10000));

  /* The curve the contract actually draws.
   *
   *   Encumbrance.sol:216
   *   haircut = mulDiv(amountOut, widenBps * util, 1e8)
   *
   * util is in bps, so the haircut fraction is widenBps * utilRatio / 1e4 --
   * linear in utilisation, with slope widenBps. This previously drew
   * pow(progress, 1.35) against progress normalised to maxUtilRatio, which was
   * wrong twice over: an invented convex shape, and a full widenBps haircut at
   * the cliff when the real figure there is widenBps * maxUtilRatio. At 80% and
   * 500 bps that is 400 bps, not 500. The metrics row above the chart was
   * already computing it linearly, so the picture disagreed with its own
   * caption as well as with the chain.
   *
   * A straight line is less decorative than a swoosh. It is what the contract
   * does, and the cliff is where the drama actually is. */
  const solvencyCurvePoints = useMemo(() => {
    const pts: { x: number; y: number; u: number }[] = [];
    const steps = 50;
    for (let i = 0; i <= steps; i++) {
      const u = (i / steps) * maxUtilRatio;
      const x = START_X + u * USABLE_WIDTH;
      const haircutFrac = (u * widenBps) / 10000;
      const y = TOP_AXIS_Y + haircutFrac * 130;
      pts.push({ x, y, u: u * 100 });
    }
    return pts;
  }, [maxUtilRatio, widenBps]);

  const solvencyCurveD = useMemo(() => {
    if (solvencyCurvePoints.length === 0) return "";
    return solvencyCurvePoints.reduce((acc, pt, idx) => {
      return idx === 0 ? `M ${pt.x.toFixed(1)},${pt.y.toFixed(1)}` : `${acc} L ${pt.x.toFixed(1)},${pt.y.toFixed(1)}`;
    }, "");
  }, [solvencyCurvePoints]);

  const solvencyAreaD = useMemo(() => {
    if (solvencyCurvePoints.length === 0) return "";
    return `${solvencyCurveD} L ${cliffX.toFixed(1)},${BASE_AXIS_Y} L ${START_X},${BASE_AXIS_Y} Z`;
  }, [solvencyCurveD, cliffX]);

  // Solvency hover calculation
  const hoverSolvencyData = useMemo(() => {
    if (hoverUtil === null) return null;
    const uPct = hoverUtil;
    const isRefused = uPct >= maxUtilBps / 100;
    // Same linear law as the curve and as Encumbrance.sol:216.
    const utilRatio = Math.min(1, uPct / 100);
    const haircutBpsEst = isRefused ? null : Math.round(utilRatio * widenBps);
    const quoteOut = isRefused ? "0.0000 (Refused)" : (1 - (haircutBpsEst ?? 0) / 10000).toFixed(4);
    const x = START_X + (uPct / 100) * USABLE_WIDTH;
    const y = isRefused ? BASE_AXIS_Y : TOP_AXIS_Y + ((utilRatio * widenBps) / 10000) * 130;
    return { uPct, isRefused, haircutBpsEst, quoteOut, x, y };
  }, [hoverUtil, maxUtilBps, widenBps]);

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

      <div className={`${s.cols} ${s.colsBuild}`}>
        {/* ── Control Column (Left: All Inputs & Publish Action) ─────────────────────────────── */}
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
                  width: `${Math.min(100, currentUtilPct)}%`,
                  background: currentUtilPct >= 80 ? "var(--short)" : "var(--ink)",
                }}
              />
            </div>

            <p style={{ margin: 0, fontSize: 12, color: "var(--ink3)", lineHeight: 1.4 }}>
              Aqua enforces no limits on commitment size. Bone Dry checks that total commitments remain solvent before routing trades.
            </p>
          </section>

          {/* 2. Sizing, Pricing & Claims */}
          <section className={`${s.card} ${s.cardPad}`}>
            <span className={s.label} style={{ marginBottom: 12, display: "block" }}>
              Pricing &amp; Sizing Claims
            </span>

            {/* Pricing Model Segmented Toggle */}
            <div style={{ marginBottom: 14 }}>
              <div className={s.seg} style={{ width: "100%" }}>
                <button
                  type="button"
                  onClick={() => setPricing("xyc")}
                  className={`${s.segBtn} ${pricing === "xyc" ? s.segBtnOn : ""}`}
                  style={{ flex: 1, textAlign: "center" }}
                >
                  Constant Product
                </button>
                <button
                  type="button"
                  onClick={() => setPricing("oracle")}
                  className={`${s.segBtn} ${pricing === "oracle" ? s.segBtnOn : ""}`}
                  style={{ flex: 1, textAlign: "center" }}
                >
                  Oracle Spread
                </button>
              </div>
            </div>

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

            <div className={s.inset} style={{ marginBottom: 12 }}>
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

            <div className={s.inset} style={{ marginBottom: 14 }}>
              <div className={s.fieldHead}>
                <span className={s.label}>Maker Fee</span>
                <span className={s.mono} style={{ fontSize: 10.5, color: "var(--ink3)" }}>
                  {pricing === "oracle" ? "fixed spread" : "bps"}
                </span>
              </div>
              <div className={s.amountRow}>
                {pricing === "oracle" ? (
                  <span className={s.mono} style={{ fontSize: 14, color: "var(--ink3)", padding: "4px 0" }}>
                    {beaconSpreadBps === null ? "…" : `${beaconSpreadBps} bps (${(beaconSpreadBps / 100).toFixed(2)}%)`}
                  </span>
                ) : (
                  <>
                    <input
                      className={s.amountIn}
                      value={feeBps}
                      inputMode="numeric"
                      onChange={(e) => setFeeBps(e.target.value)}
                      placeholder="0"
                    />
                    <span className={s.mono} style={{ fontSize: 14, color: "var(--ink)" }}>bps</span>
                  </>
                )}
              </div>
            </div>

            {/* Sizing Range Presets Shortcut */}
            <div style={{ marginBottom: 4 }}>
              <span className={s.label} style={{ fontSize: 10, display: "block", marginBottom: 6 }}>
                Range Preset Shortcut:
              </span>
              <div className={s.ranges}>
                {(["10", "20", "full", "custom"] as RangePreset[]).map((p) => (
                  <button
                    key={p}
                    type="button"
                    role="tab"
                    aria-selected={rangePreset === p}
                    onClick={() => handleSelectPreset(p)}
                    className={`${s.range} ${rangePreset === p ? s.rangeOn : ""}`}
                  >
                    {p === "10" ? "±10%" : p === "20" ? "±20%" : p === "full" ? "Full" : "Custom"}
                  </button>
                ))}
              </div>
            </div>
          </section>

          {/* 3. Encumbrance Parameters (The Core Contract Specs) */}
          <section className={`${s.card} ${s.cardPad}`}>
            <span className={s.label} style={{ marginBottom: 12, display: "block" }}>
              Encumbrance Parameters
            </span>

            {/* Refusal Ceiling */}
            <div style={{ marginBottom: 16 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6 }}>
                <span style={{ fontSize: 13, fontWeight: 600, color: "var(--ink)" }}>Refusal Ceiling</span>
                <span className={s.mono} style={{ fontSize: 13, color: "var(--ink)" }}>
                  {(maxUtilBps / 100).toFixed(0)}% ({maxUtilBps} bps)
                </span>
              </div>
              <input
                type="range"
                min="3000"
                max="9500"
                step="500"
                value={maxUtilBps}
                onChange={(e) => setMaxUtilBps(Number(e.target.value))}
                style={{ width: "100%", accentColor: "var(--ink)", cursor: "pointer", marginBottom: 8 }}
              />
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {[5000, 7500, 8000, 9000].map((v) => (
                  <button
                    key={v}
                    type="button"
                    onClick={() => setMaxUtilBps(v)}
                    className={`${s.range} ${maxUtilBps === v ? s.rangeOn : ""}`}
                    style={{ fontSize: 11, padding: "2px 8px" }}
                  >
                    {v / 100}%
                  </button>
                ))}
              </div>
              <p style={{ margin: "6px 0 0", fontSize: 11.5, color: "var(--ink3)" }}>
                &ldquo;Refuse fills on-chain once more than <strong>{(maxUtilBps / 100).toFixed(0)}%</strong> of my wallet is promised across sibling strategies.&rdquo;
              </p>
            </div>

            {/* Spread Widening */}
            <div style={{ marginBottom: 6 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6 }}>
                <span style={{ fontSize: 13, fontWeight: 600, color: "var(--ink)" }}>Spread Widening</span>
                <span className={s.mono} style={{ fontSize: 13, color: "var(--ink)" }}>
                  {(widenBps / 100).toFixed(2)}% ({widenBps} bps)
                </span>
              </div>
              <input
                type="range"
                min="0"
                max="1500"
                step="50"
                value={widenBps}
                onChange={(e) => setWidenBps(Number(e.target.value))}
                style={{ width: "100%", accentColor: "var(--ink)", cursor: "pointer", marginBottom: 8 }}
              />
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {[100, 250, 500, 1000].map((w) => (
                  <button
                    key={w}
                    type="button"
                    onClick={() => setWidenBps(w)}
                    className={`${s.range} ${widenBps === w ? s.rangeOn : ""}`}
                    style={{ fontSize: 11, padding: "2px 8px" }}
                  >
                    {w} BPS
                  </button>
                ))}
              </div>
              <p style={{ margin: "6px 0 0", fontSize: 11.5, color: "var(--ink3)" }}>
                &ldquo;Quote up to <strong>{(widenBps / 100).toFixed(2)}%</strong> wider as wallet utilization approaches the refusal ceiling.&rdquo;
              </p>
            </div>
          </section>

          {/* 4. Live Sibling Constraints */}
          <section className={`${s.card} ${s.cardPad}`}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8 }}>
              <span className={s.label}>Live Sibling Constraints</span>
              <span className={s.mono} style={{ fontSize: 10, color: "var(--ink3)" }}>
                {liveSiblings.length} found in index
              </span>
            </div>

            {liveSiblings.length === 0 ? (
              <div style={{ padding: "8px 10px", background: "var(--sunk)", borderRadius: 6, fontSize: 12, color: "var(--ink2)" }}>
                <span className={s.mono} style={{ fontWeight: 600, fontSize: 10.5, display: "block", marginBottom: 2 }}>
                  ● FIRST STRATEGY FOR MAKER
                </span>
                No prior live strategies on this token. Your strategy will be fully backed with 0 initial encumbrance.
              </div>
            ) : siblingLimitExceeded ? (
              <div style={{ padding: "8px 10px", background: "rgba(194, 78, 25, 0.08)", borderRadius: 6, fontSize: 12, color: "var(--short)" }}>
                <span className={s.mono} style={{ fontWeight: 600, fontSize: 10.5, display: "block", marginBottom: 2 }}>
                  ⚠ UNDER-CONSTRAINED ({liveSiblings.length} &gt; 6 siblings)
                </span>
                SwapVM instruction limit restricts sibling proofs to 6. Only the first 6 will be verified on-chain.
              </div>
            ) : (
              <div style={{ padding: "8px 10px", background: "var(--sunk)", borderRadius: 6, fontSize: 12, color: "var(--ink2)" }}>
                <span className={s.mono} style={{ fontWeight: 600, fontSize: 10.5, display: "block", marginBottom: 2 }}>
                  ✓ COMPLETE ({liveSiblings.length}/6 slots)
                </span>
                All {liveSiblings.length} sibling commitment{liveSiblings.length > 1 ? "s" : ""} will be atomically verified by the Encumbrance Strategy contract.
              </div>
            )}

            {/* Sibling items */}
            {liveSiblings.length > 0 && (
              <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 130, overflowY: "auto", marginTop: 8 }}>
                {liveSiblings.slice(0, 6).map((strat, idx) => {
                  const matchingSide = strat.sides.find((sd) => sd.token.toLowerCase() === tokenIn.address.toLowerCase()) || strat.sides[0];
                  return (
                    <div
                      key={strat.strategyHash}
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        padding: "5px 8px",
                        background: "var(--surface)",
                        border: "1px solid var(--rule)",
                        borderRadius: 6,
                        fontSize: 11,
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
            <p className={s.mono} style={{ margin: "8px 0 0", fontSize: 10, color: "var(--ink3)" }}>
              SwapVM instruction cap: 255 bytes (leaving (255 - 38)/32 = 6 sibling slots).
            </p>
          </section>

          {/* 5. The Big Action Button (Publish On-Chain) */}
          <section className={`${s.card} ${s.cardPad}`}>
            <button
              className={`${s.btnBlock} ${!covered && address ? s.btnBlockShort : ""}`}
              onClick={handleShip}
              disabled={disabled}
            >
              {busy
                ? "Shipping on-chain…"
                : !address
                ? "Connect wallet to ship"
                : wrongChain
                ? "Switch network to ship"
                : amountInvalid
                ? "Enter claim amounts above"
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

            <p style={{ margin: "10px 0 0", fontSize: 12, color: "var(--ink3)", textAlign: "center" }}>
              {net.testnet
                ? `${net.label} — contracts are verified and live on-chain.`
                : `Live on ${net.label}. One signature; indexed within two seconds.`}
            </p>
          </section>
        </div>

        {/* ── Evidence & Graph Column (Right: High-Ratio Hero Visuals) ─────────────────────────────── */}
        <div className={s.colWide}>
          {/* Main Hero Graph Card */}
          <section className={`${s.card} ${s.cardClip}`} style={{ marginBottom: 24 }}>
            <div
              className={s.cardHead}
              style={{ padding: "18px 22px", alignItems: "flex-end", flexWrap: "wrap", gap: 12 }}
            >
              <div style={{ minWidth: 0 }}>
                <h2 className={`${s.display} ${s.h2}`} style={{ marginBottom: 3 }}>
                  {graphMode === "depth"
                    ? "Continuous AMM Liquidity & Depth Curve"
                    : graphMode === "curve"
                    ? "Solvency Haircut & On-Chain Refusal Curve"
                    : "Dual View: AMM Liquidity & Solvency Response"}
                </h2>
                <p style={{ margin: 0, fontSize: 13.5, color: "var(--ink3)" }}>
                  {graphMode === "depth"
                    ? "Continuous bonding curve across price ticks with active range highlight and spot reference."
                    : graphMode === "curve"
                    ? "Progressive haircut slope with hard on-chain refusal cliff at the encumbrance ceiling."
                    : "Continuous AMM bonding depth alongside the on-chain refusal and haircut response."}
                </p>
              </div>

              {/* 3-Way Graph Mode Toggle */}
              <div className={s.seg}>
                <button
                  type="button"
                  onClick={() => setGraphMode("depth")}
                  className={`${s.segBtn} ${graphMode === "depth" ? s.segBtnOn : ""}`}
                  title="View continuous AMM liquidity depth curve"
                >
                  ✦ AMM Curve
                </button>
                <button
                  type="button"
                  onClick={() => setGraphMode("curve")}
                  className={`${s.segBtn} ${graphMode === "curve" ? s.segBtnOn : ""}`}
                  title="View solvency haircut and refusal cliff"
                >
                  🛡 Solvency Curve
                </button>
                <button
                  type="button"
                  onClick={() => setGraphMode("dual")}
                  className={`${s.segBtn} ${graphMode === "dual" ? s.segBtnOn : ""}`}
                  title="View both charts simultaneously"
                >
                  ◫ Dual View
                </button>
              </div>
            </div>

            {/* Graph 1: Continuous AMM Liquidity Depth Curve */}
            {(graphMode === "depth" || graphMode === "dual") && (
              <div style={{ padding: "20px 22px", borderBottom: graphMode === "dual" ? "1px solid var(--rule)" : "none" }}>
                {graphMode === "dual" && (
                  <span className={s.label} style={{ fontSize: 11, marginBottom: 12, display: "block", letterSpacing: ".12em" }}>
                    01 · Continuous AMM Liquidity Curve
                  </span>
                )}
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

            {/* Graph 2: Solvency Response Curve with Real Progressive Slope & Cliff */}
            {(graphMode === "curve" || graphMode === "dual") && (
              <div style={{ padding: "20px 22px" }}>
                {graphMode === "dual" && (
                  <span className={s.label} style={{ fontSize: 11, marginBottom: 12, display: "block", letterSpacing: ".12em" }}>
                    02 · Solvency Haircut &amp; On-Chain Refusal Curve
                  </span>
                )}

                {/* Metric Strip */}
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))",
                    gap: 12,
                    marginBottom: 18,
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
                    <span className={s.label} style={{ fontSize: 9.5 }}>1.000 {tokenIn.symbol} Quotes As</span>
                    <p className={s.mono} style={{ margin: "2px 0 0", fontSize: 18, fontWeight: 600, color: "var(--ink)" }}>
                      {currentQuoteVal.toFixed(4)} {tokenIn.symbol}
                    </p>
                  </div>
                  <div style={{ padding: "10px 14px", background: "var(--sunk)", borderRadius: 8, border: "1px solid var(--rule)" }}>
                    <span className={s.label} style={{ fontSize: 9.5 }}>Refusal Threshold</span>
                    <p className={s.mono} style={{ margin: "2px 0 0", fontSize: 18, fontWeight: 600, color: "var(--short)" }}>
                      {(maxUtilBps / 100).toFixed(0)}% ({maxUtilBps} bps)
                    </p>
                  </div>
                </div>

                {/* The SVG Solvency Response Chart */}
                <div style={{ position: "relative", width: "100%", userSelect: "none" }}>
                  <svg
                    viewBox={`0 0 ${SVG_WIDTH} ${SVG_HEIGHT}`}
                    preserveAspectRatio="none"
                    role="img"
                    aria-label="Solvency & Haircut Response Curve"
                    style={{ width: "100%", height: 200, display: "block", overflow: "visible", cursor: "crosshair" }}
                    onMouseMove={(e) => {
                      const rect = e.currentTarget.getBoundingClientRect();
                      const clientX = e.clientX - rect.left;
                      const scale = SVG_WIDTH / rect.width;
                      const u = ((clientX * scale - START_X) / USABLE_WIDTH) * 100;
                      setHoverUtil(Math.max(0, Math.min(100, u)));
                    }}
                    onMouseLeave={() => setHoverUtil(null)}
                  >
                    <defs>
                      <linearGradient id="solvencyAreaGrad" x1="0" y1="0" x2="1" y2="0">
                        <stop offset="0%" stopColor="#059669" stopOpacity={0.22} />
                        <stop offset="60%" stopColor="#d97706" stopOpacity={0.20} />
                        <stop offset="100%" stopColor="#dc2626" stopOpacity={0.25} />
                      </linearGradient>

                      <pattern id="refusalHatch" width="8" height="8" patternTransform="rotate(45 0 0)" patternUnits="userSpaceOnUse">
                        <line x1="0" y1="0" x2="0" y2="8" stroke="rgba(194, 78, 25, 0.28)" strokeWidth="1.5" />
                      </pattern>
                    </defs>

                    {/* Horizontal Grid */}
                    {[0, 1, 2, 3].map((i) => {
                      const yPos = TOP_AXIS_Y + i * 42;
                      return (
                        <line
                          key={i}
                          x1={START_X}
                          x2={END_X}
                          y1={yPos}
                          y2={yPos}
                          stroke="var(--rule)"
                          strokeWidth={1}
                          strokeDasharray="2 4"
                        />
                      );
                    })}

                    {/* Safe zone area fill under the progressive curve */}
                    <path d={solvencyAreaD} fill="url(#solvencyAreaGrad)" />

                    {/* Rejection / Refusal zone fill (past maxUtilBps) */}
                    <rect
                      x={cliffX}
                      y={TOP_AXIS_Y - 10}
                      width={END_X - cliffX}
                      height={BASE_AXIS_Y - (TOP_AXIS_Y - 10)}
                      fill="url(#refusalHatch)"
                    />

                    {/* The Continuous Haircut Curve Line */}
                    <path
                      d={solvencyCurveD}
                      fill="none"
                      stroke="var(--ink)"
                      strokeWidth={2.5}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />

                    {/* Vertical Cliff Drop at maxUtilBps */}
                    <line
                      x1={cliffX}
                      y1={TOP_AXIS_Y + (widenBps / 10000) * 130}
                      x2={cliffX}
                      y2={BASE_AXIS_Y}
                      stroke="var(--short)"
                      strokeWidth={2.5}
                      strokeDasharray="4 3"
                    />

                    {/* Refusal zone zero line */}
                    <line
                      x1={cliffX}
                      x2={END_X}
                      y1={BASE_AXIS_Y}
                      y2={BASE_AXIS_Y}
                      stroke="var(--short)"
                      strokeWidth={2}
                    />

                    {/* Baseline axis */}
                    <line x1={START_X} x2={END_X} y1={BASE_AXIS_Y} y2={BASE_AXIS_Y} stroke="var(--ink)" strokeWidth={1.5} />

                    {/* Live maker utilization indicator marker */}
                    {currentUtilX >= START_X && currentUtilX <= END_X && (
                      <g>
                        <line
                          x1={currentUtilX}
                          x2={currentUtilX}
                          y1={TOP_AXIS_Y - 10}
                          y2={BASE_AXIS_Y}
                          stroke="var(--ink)"
                          strokeWidth={1.5}
                          strokeDasharray="2 2"
                        />
                        <circle
                          cx={currentUtilX}
                          cy={currentUtilX <= cliffX ? TOP_AXIS_Y + Math.pow(currentUtilPct / (maxUtilBps / 100), 1.35) * (widenBps / 10000) * 130 : BASE_AXIS_Y}
                          r={6}
                          fill="var(--ink)"
                          stroke="var(--paper)"
                          strokeWidth={2.5}
                        />
                      </g>
                    )}

                    {/* Refusal badge pill */}
                    <g transform={`translate(${Math.min(520, cliffX - 10)}, 18)`}>
                      <rect x={-8} y={-10} width={100} height={18} rx={3} fill="var(--short)" />
                      <text x={42} y={3} textAnchor="middle" fill="white" fontSize={8.5} fontFamily="var(--mono)" fontWeight={700}>
                        REFUSES ON-CHAIN
                      </text>
                    </g>

                    {/* Axis Ticks */}
                    {[0, 25, 50, 75, 100].map((u) => {
                      const tx = START_X + (u / 100) * USABLE_WIDTH;
                      return (
                        <g key={u}>
                          <line x1={tx} x2={tx} y1={BASE_AXIS_Y} y2={BASE_AXIS_Y + 5} stroke="var(--ink2)" strokeWidth={1} />
                          <text x={tx} y={BASE_AXIS_Y + 18} textAnchor="middle" fill="var(--ink3)" fontSize={10} fontFamily="var(--mono)">
                            {u}%
                          </text>
                        </g>
                      );
                    })}

                    {/* Hover Crosshair indicator */}
                    {hoverSolvencyData && (
                      <g>
                        <line
                          x1={hoverSolvencyData.x}
                          x2={hoverSolvencyData.x}
                          y1={TOP_AXIS_Y - 10}
                          y2={BASE_AXIS_Y}
                          stroke="var(--short)"
                          strokeWidth={1}
                          strokeDasharray="2 2"
                        />
                        <circle
                          cx={hoverSolvencyData.x}
                          cy={hoverSolvencyData.y}
                          r={5}
                          fill="var(--short)"
                          stroke="var(--surface)"
                          strokeWidth={2}
                        />
                      </g>
                    )}
                  </svg>

                  {/* Hover tooltip for solvency */}
                  {hoverSolvencyData && (
                    <div
                      style={{
                        position: "absolute",
                        top: 20,
                        left: Math.min(SVG_WIDTH - 180, Math.max(20, (hoverSolvencyData.x / SVG_WIDTH) * 100)) + "%",
                        background: "var(--ink)",
                        color: "var(--paper)",
                        padding: "6px 10px",
                        borderRadius: 6,
                        fontSize: 11,
                        fontFamily: "var(--mono)",
                        pointerEvents: "none",
                        boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
                        zIndex: 10,
                        transform: hoverSolvencyData.x > SVG_WIDTH * 0.7 ? "translateX(-110%)" : "translateX(10px)",
                      }}
                    >
                      <div><strong>Util:</strong> {hoverSolvencyData.uPct.toFixed(1)}%</div>
                      <div>
                        <strong>Haircut:</strong> {hoverSolvencyData.haircutBpsEst !== null ? `-${hoverSolvencyData.haircutBpsEst} bps` : "Refused"}
                      </div>
                      <div style={{ color: hoverSolvencyData.isRefused ? "#f87171" : "#34d399" }}>
                        <strong>Output:</strong> {hoverSolvencyData.quoteOut}
                      </div>
                    </div>
                  )}
                </div>

                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 14, flexWrap: "wrap", gap: 8 }}>
                  <span className={s.mono} style={{ fontSize: 11, color: "var(--ink2)" }}>
                    ● <strong>Continuous Curve</strong>: Linear spread widening up to -{widenBps} bps as wallet is committed
                  </span>
                  <span className={s.mono} style={{ fontSize: 11, color: "var(--short)" }}>
                    --- <strong>Red Cliff</strong>: Hard refusal cutoff at {(maxUtilBps / 100).toFixed(0)}% (saves gas &amp; prevents reverts)
                  </span>
                </div>
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
                <p style={{ margin: 0, fontSize: 12, color: "var(--ink3)" }}>
                  Total active commitments across all registered sibling strategies.
                </p>
              </div>

              <div style={{ padding: "12px 14px", background: "var(--sunk)", borderRadius: 8, border: "1px solid var(--rule)" }}>
                <span className={s.mono} style={{ fontSize: 11, color: "var(--ink3)" }}>02 · Refusal Cliff</span>
                <p className={s.mono} style={{ margin: "4px 0 2px", fontSize: 13, fontWeight: 600, color: "var(--short)" }}>
                  if (utilBps &gt; maxUtilBps) revert/refuse
                </p>
                <p style={{ margin: 0, fontSize: 12, color: "var(--ink3)" }}>
                  Hard refusal threshold at {(maxUtilBps / 100).toFixed(0)}%. Rejects quotes without failing trades.
                </p>
              </div>

              <div style={{ padding: "12px 14px", background: "var(--sunk)", borderRadius: 8, border: "1px solid var(--rule)" }}>
                <span className={s.mono} style={{ fontSize: 11, color: "var(--ink3)" }}>03 · Spread Widening</span>
                <p className={s.mono} style={{ margin: "4px 0 2px", fontSize: 13, fontWeight: 600, color: "var(--ink)" }}>
                  haircutBps = (utilBps × widenBps) / 10000
                </p>
                <p style={{ margin: 0, fontSize: 12, color: "var(--ink3)" }}>
                  Linear widening up to {widenBps} bps as utilization approaches the ceiling.
                </p>
              </div>
            </div>

            {showFormulas && (
              <div
                style={{
                  marginTop: 16,
                  padding: "14px 16px",
                  background: "var(--surface)",
                  border: "1px solid var(--rule)",
                  borderRadius: 8,
                }}
              >
                <span className={s.label} style={{ marginBottom: 6, display: "block" }}>
                  Contract Implementation (§7.1)
                </span>
                <pre
                  className={s.mono}
                  style={{
                    margin: 0,
                    fontSize: 11.5,
                    lineHeight: 1.6,
                    color: "var(--ink)",
                    overflowX: "auto",
                  }}
                >
{`// EncumbranceStrategy.sol §7.1
uint256 free = rawBalance > encumbered ? rawBalance - encumbered : 0;
uint256 utilBps = rawBalance > 0 ? (encumbered * 10_000) / rawBalance : 10_000;

if (utilBps > maxUtilBps) {
    return (0, RefusalReason.EncumbranceExceeded);
}

uint256 haircutBps = (utilBps * widenBps) / 10_000;
uint256 finalQuote = baseQuote - (baseQuote * haircutBps) / 10_000;`}
                </pre>
              </div>
            )}
          </section>

          {/* 6. Reference Deployments Card */}
          <section className={`${s.card} ${s.cardPad}`}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 12 }}>
              <div>
                <span className={s.label}>Live Contract References</span>
                <h3 className={`${s.display} ${s.h2}`} style={{ margin: "2px 0 0", fontSize: 18 }}>
                  Verified Deployments
                </h3>
              </div>
              <span className={s.mono} style={{ fontSize: 11, color: "var(--ink3)" }}>
                Base Sepolia
              </span>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 13 }}>
                <span style={{ color: "var(--ink2)" }}>BoneDryRouter</span>
                <span className={s.mono} style={{ fontSize: 12, display: "inline-flex", alignItems: "center" }}>
                  0x75E8...1146
                  <CopyButton value="0x75E8971831675A3eF0CAbc4fd441dA7aeB481146" size={12} />
                </span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 13 }}>
                <span style={{ color: "var(--ink2)" }}>EncumbranceStrategy</span>
                <span className={s.mono} style={{ fontSize: 12, display: "inline-flex", alignItems: "center" }}>
                  0x7b2e...67e3
                  <CopyButton value="0x7b2e1f478807218c335ebfe6a8b0250e61ab533d2a30902b9e298bfcfda467e3" size={12} />
                </span>
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
