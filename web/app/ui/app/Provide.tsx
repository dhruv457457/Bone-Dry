"use client";

import { useState, useEffect, useMemo, useCallback } from "react";
import { useSendTransaction, useSwitchChain, useWriteContract } from "wagmi";
import { keccak256, erc20Abi, maxUint256, type Address, type Hex } from "viem";
import s from "../app.module.css";
import { TokenIcon } from "../TokenIcon";
import { CopyButton } from "../CopyButton";
import { DepthChart, type RangePreset } from "./DepthChart";
import { units, short as shortAddr, toRaw } from "@/lib/format";
import type { ExposureResponse } from "../types";
import { publicClientFor, type Network, BEACON_STRATEGY_ADDRESS } from "@/lib/networks";

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
  const [beaconSpreadError, setBeaconSpreadError] = useState(false);

  // Encumbrance Strategy parameters
  const [maxUtilBps, setMaxUtilBps] = useState(8000); // 80% default
  const [widenBps, setWidenBps] = useState(500); // 500 bps = 5% default
  const [graphMode, setGraphMode] = useState<"depth" | "curve" | "dual">("curve");
  const [hoverUtil, setHoverUtil] = useState<number | null>(null);

  const { sendTransactionAsync } = useSendTransaction();
  const { switchChain } = useSwitchChain();
  const { writeContractAsync } = useWriteContract();
  const [approving, setApproving] = useState(false);
  const [onChainLoading, setOnChainLoading] = useState(false);

  // Oracle pricing is only deployed on Base Sepolia for WETH/USDC (same condition route.ts:82-92 enforces)
  const isWethUsdc = useMemo(() => {
    return (
      (tokenIn.address.toLowerCase() === net.weth.toLowerCase() &&
        tokenOut.address.toLowerCase() === net.usdc.toLowerCase()) ||
      (tokenIn.address.toLowerCase() === net.usdc.toLowerCase() &&
        tokenOut.address.toLowerCase() === net.weth.toLowerCase())
    );
  }, [tokenIn.address, tokenOut.address, net.weth, net.usdc]);

  const oracleAvailable = net.id === 84532 && isWethUsdc;

  // If Oracle pricing becomes unavailable (e.g. user changed chain/pair), reset to xyc
  useEffect(() => {
    if (!oracleAvailable && pricing === "oracle") {
      setPricing("xyc");
    }
  }, [oracleAvailable, pricing]);

  // Read fixed spread from BeaconStrategy if oracle pricing is selected
  useEffect(() => {
    if (pricing !== "oracle" || !oracleAvailable) return;
    let active = true;
    setBeaconSpreadError(false);
    const client = publicClientFor(net);
    const BEACON_ABI = [
      {
        type: "function",
        name: "spreadBps",
        inputs: [],
        outputs: [{ name: "", type: "uint256" }],
        stateMutability: "view",
      },
    ] as const;

    client
      .readContract({
        address: BEACON_STRATEGY_ADDRESS,
        abi: BEACON_ABI,
        functionName: "spreadBps",
      })
      .then((val) => {
        if (active) {
          setBeaconSpreadBps(Number(val));
          setBeaconSpreadError(false);
        }
      })
      .catch((err) => {
        console.warn("[beacon] could not read spread:", err);
        if (active) {
          setBeaconSpreadBps(null);
          setBeaconSpreadError(true);
        }
      });

    return () => {
      active = false;
    };
  }, [pricing, oracleAvailable, net]);

  // Read maker's live exposure from /api/exposure
  const [exposure, setExposure] = useState<ExposureResponse | null>(null);
  const [exposureLoading, setExposureLoading] = useState(false);

  const fetchExposure = useCallback(async () => {
    if (!address) {
      setExposure(null);
      return;
    }
    setExposureLoading(true);
    try {
      const res = await fetch(`/api/exposure?chain=${net.id}&maker=${address}`);
      if (!res.ok) throw new Error("exposure fetch failed");
      const json: ExposureResponse = await res.json();
      setExposure(json);
    } catch {
      setExposure(null);
    } finally {
      setExposureLoading(false);
    }
  }, [net.id, address]);

  useEffect(() => {
    fetchExposure();
  }, [fetchExposure]);

  // Live on-chain balances and allowance for tokenIn and tokenOut
  const [onChainData, setOnChainData] = useState<{
    heldIn: bigint | null;
    balanceOut: bigint | null;
    allowanceOut: bigint | null;
  }>({
    heldIn: null,
    balanceOut: null,
    allowanceOut: null,
  });

  const reloadBalances = useCallback(async () => {
    if (!address) {
      setOnChainData({ heldIn: null, balanceOut: null, allowanceOut: null });
      return;
    }
    setOnChainLoading(true);
    try {
      const client = publicClientFor(net);
      const res = await client.multicall({
        contracts: [
          {
            address: tokenIn.address as Address,
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [address],
          },
          {
            address: tokenOut.address as Address,
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [address],
          },
          {
            address: tokenOut.address as Address,
            abi: erc20Abi,
            functionName: "allowance",
            args: [address, net.aqua as Address],
          },
        ],
        allowFailure: true,
      });
      const bIn = res[0].status === "success" ? (res[0].result as bigint) : null;
      const bOut = res[1].status === "success" ? (res[1].result as bigint) : null;
      const aOut = res[2].status === "success" ? (res[2].result as bigint) : null;
      setOnChainData({ heldIn: bIn, balanceOut: bOut, allowanceOut: aOut });
    } catch {
      setOnChainData({ heldIn: null, balanceOut: null, allowanceOut: null });
    } finally {
      setOnChainLoading(false);
    }
  }, [net, address, tokenIn.address, tokenOut.address]);

  useEffect(() => {
    reloadBalances();
  }, [reloadBalances]);

  const handleApproveAqua = async () => {
    if (!address || !writeContractAsync) return;
    setApproving(true);
    setError(null);
    try {
      const hash = await writeContractAsync({
        address: tokenOut.address as Address,
        abi: erc20Abi,
        functionName: "approve",
        args: [net.aqua as Address, maxUint256],
      });
      const client = publicClientFor(net);
      await client.waitForTransactionReceipt({ hash });
      await reloadBalances();
      await fetchExposure();
    } catch (e) {
      setError(describe(e));
    } finally {
      setApproving(false);
    }
  };

  // Wallet position for tokenIn (used to show held balance on "Offer tokenIn")
  const tokenInPos = useMemo(() => {
    if (!exposure?.positions) return null;
    return exposure.positions.find((p) => p.token.toLowerCase() === tokenIn.address.toLowerCase()) ?? null;
  }, [exposure, tokenIn.address]);

  /** These fall back to index values, which arrive as JSON strings from a
   *  service this component does not control. An unparseable one used to be
   *  caught; inlining the BigInt() dropped that, so a single malformed row
   *  would throw during render and blank the whole tab. */
  const bigOrNull = (v: string | undefined): bigint | null => {
    if (v == null) return null;
    try {
      return BigInt(v);
    } catch {
      return null;
    }
  };

  const heldIn = onChainData.heldIn ?? bigOrNull(tokenInPos?.held);

  // Position for tokenOut: Encumbrance.sol:193-195 evaluates deliverable backing = min(balance, allowance)
  const tokenOutPos = useMemo(() => {
    if (!exposure?.positions) return null;
    return exposure.positions.find((p) => p.token.toLowerCase() === tokenOut.address.toLowerCase()) ?? null;
  }, [exposure, tokenOut.address]);

  const balanceOut = onChainData.balanceOut ?? bigOrNull(tokenOutPos?.held);
  const allowanceOut = onChainData.allowanceOut;

  const backingOut = useMemo(() => {
    if (balanceOut === null || allowanceOut === null) return null;
    return balanceOut < allowanceOut ? balanceOut : allowanceOut;
  }, [balanceOut, allowanceOut]);

  // Sibling strategies filtered to tokenOut (§0.8)
  const liveSiblings = useMemo(() => {
    if (!exposure?.strategies) return [];
    return exposure.strategies.filter((st) =>
      st.sides.some((sd) => sd.token.toLowerCase() === tokenOut.address.toLowerCase())
    );
  }, [exposure, tokenOut.address]);

  const siblingLimitExceeded = liveSiblings.length > 6;

  // Live promised encumbrance across all siblings on tokenOut
  const alreadyPromisedOut = useMemo(() => {
    if (liveSiblings.length > 0) {
      return liveSiblings.reduce((sum, strat) => {
        const side = strat.sides.find((s) => s.token.toLowerCase() === tokenOut.address.toLowerCase());
        if (!side) return sum;
        try {
          return sum + BigInt(side.claimed);
        } catch {
          return sum;
        }
      }, 0n);
    }
    if (tokenOutPos) {
      try {
        return BigInt(tokenOutPos.claimed);
      } catch {
        return 0n;
      }
    }
    return 0n;
  }, [liveSiblings, tokenOutPos, tokenOut.address]);

  const capacityOut = useMemo(() => {
    if (backingOut === null) return null;
    return backingOut > alreadyPromisedOut ? backingOut - alreadyPromisedOut : 0n;
  }, [backingOut, alreadyPromisedOut]);

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
  const newTotalPromisedOut = alreadyPromisedOut + rawClaimOut;
  const covered = backingOut === null || newTotalPromisedOut <= backingOut;
  const shortBy = backingOut !== null && newTotalPromisedOut > backingOut ? newTotalPromisedOut - backingOut : 0n;

  const coverPct = useMemo(() => {
    if (backingOut === null || backingOut === 0n) return 0;
    if (newTotalPromisedOut === 0n) return 100;
    const pct = Number((backingOut * 10000n) / newTotalPromisedOut) / 100;
    return Math.min(100, Math.max(0, pct));
  }, [backingOut, newTotalPromisedOut]);

  const isBackingLoading = Boolean(address) && (exposureLoading || onChainLoading);

  const zeroAllowance = Boolean(
    address && !isBackingLoading && allowanceOut !== null && allowanceOut === 0n
  );
  const zeroBacking = Boolean(
    address && !isBackingLoading && backingOut !== null && backingOut === 0n
  );
  const allowanceBounded =
    balanceOut !== null && allowanceOut !== null && allowanceOut < balanceOut;

  const disabled =
    !address ||
    wrongChain ||
    amountInvalid ||
    busy ||
    approving ||
    zeroBacking ||
    zeroAllowance;

  // Current utilization of maker wallet for tokenOut (0 to 100)
  // Uncapped, because the contract's is.
  //
  // Encumbrance.sol:202 computes util = mulDiv(declaredTotalEncumbrance, 1e4,
  // backing) with no ceiling, and reverts at util >= maxUtilBps. A maker who has
  // promised three times their backing sits at 30,000 bps. Clamping this to 100%
  // would report the single worst position on the network as merely "full" — on
  // the one screen whose entire subject is over-promising. The chart still plots
  // against a 0-100 axis, so clamp there, at the drawing, not here at the number.
  const currentUtilPct =
    backingOut && backingOut > 0n
      ? Number((alreadyPromisedOut * 10000n) / backingOut) / 100
      : 0;
  const utilPlotPct = Math.min(100, currentUtilPct);

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
          siblingHashes: liveSiblings.map((s) => s.strategyHash),
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
      await reloadBalances();
      await fetchExposure();
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
  // Full card width at >=1280px, height 260 per PLAN-PROVIDE.md Phase 3
  const SVG_WIDTH = 720;
  const SVG_HEIGHT = 260;
  const BASE_AXIS_Y = 220;
  const TOP_AXIS_Y = 35;
  const START_X = 40;
  const END_X = 680;
  const USABLE_WIDTH = END_X - START_X;
  const Y_TRAVEL = BASE_AXIS_Y - TOP_AXIS_Y; // 185px

  /**
   * The y axis is scaled to the largest haircut this curve can actually reach,
   * not to a notional 100%.
   *
   * The haircut is `widenBps * util`, so at the cliff it is
   * `widenBps * maxUtilRatio` — 4% at the 80%/500bps defaults. Plotting that
   * against a full-height 0-100% axis spent 7 of 185 pixels and drew the whole
   * curve as a horizontal line: mathematically right, and useless. The chart was
   * reported as "no proper curves", which was a fair reading of a flat one.
   *
   * Scaling to `maxHaircutFrac` puts the cliff point on the bottom axis, so the
   * slope is visible at every setting and moving either slider visibly changes
   * it. The axis is labelled in bps below so the shape cannot be mistaken for a
   * bigger number than it is.
   */
  const maxHaircutFrac = ((maxUtilBps / 10000) * widenBps) / 10000;
  const yForHaircut = useCallback(
    (haircutFrac: number) =>
      TOP_AXIS_Y + (maxHaircutFrac > 0 ? haircutFrac / maxHaircutFrac : 0) * Y_TRAVEL,
    [maxHaircutFrac, TOP_AXIS_Y, Y_TRAVEL]
  );

  const maxUtilRatio = maxUtilBps / 10000;
  const cliffX = START_X + maxUtilRatio * USABLE_WIDTH;
  const currentUtilX = START_X + (utilPlotPct / 100) * USABLE_WIDTH;

  const currentHaircutBps = Math.round((currentUtilPct / 100) * widenBps);
  const currentQuoteVal = Math.max(0, 1 - (currentUtilPct / 100) * (widenBps / 10000));

  // The second refusal threshold (§0.5): EncumbranceInsufficient(amountOut, free)
  // free = backing > declaredTotalEncumbrance ? backing - declaredTotalEncumbrance : 0
  // amountOut > free  <=>  utilRatio > 1 - (amountOut / backing)
  const orderSizeRatio = useMemo(() => {
    if (!backingOut || backingOut === 0n || rawClaimOut === 0n) return null;
    return Number((rawClaimOut * 10000n) / backingOut) / 10000;
  }, [backingOut, rawClaimOut]);

  const freeCliffRatio = useMemo(() => {
    if (orderSizeRatio === null) return null;
    return Math.max(0, 1 - orderSizeRatio);
  }, [orderSizeRatio]);

  const insufficientX = useMemo(() => {
    if (freeCliffRatio === null) return null;
    return START_X + Math.min(1, freeCliffRatio) * USABLE_WIDTH;
  }, [freeCliffRatio, START_X, USABLE_WIDTH]);

  /* The curve the contract actually draws.
   *
   *   Encumbrance.sol:216
   *   haircut = mulDiv(amountOut, widenBps * util, 1e8)
   *
   * util is in bps, so the haircut fraction is widenBps * utilRatio / 1e4 --
   * linear in utilisation, with slope widenBps. */
  const solvencyCurvePoints = useMemo(() => {
    const pts: { x: number; y: number; u: number }[] = [];
    const steps = 50;
    for (let i = 0; i <= steps; i++) {
      const u = (i / steps) * maxUtilRatio;
      const x = START_X + u * USABLE_WIDTH;
      const haircutFrac = (u * widenBps) / 10000;
      const y = yForHaircut(haircutFrac);
      pts.push({ x, y, u: u * 100 });
    }
    return pts;
  }, [maxUtilRatio, widenBps, yForHaircut, USABLE_WIDTH]);

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

  // Solvency hover calculation with dual refusal boundaries (§0.5)
  const hoverSolvencyData = useMemo(() => {
    if (hoverUtil === null) return null;
    const uPct = hoverUtil;
    const uRatio = uPct / 100;
    const isCliffRefused = uRatio >= maxUtilRatio;
    const isSizeRefused = freeCliffRatio !== null && uRatio >= freeCliffRatio;
    const isRefused = isCliffRefused || isSizeRefused;

    let refusalReason: string | null = null;
    if (isCliffRefused) {
      refusalReason = `EncumbranceExceeded (util ${uPct.toFixed(1)}% ≥ ${(maxUtilBps / 100).toFixed(0)}%)`;
    } else if (isSizeRefused) {
      refusalReason = `EncumbranceInsufficient (order size > free capacity)`;
    }

    const utilRatio = Math.min(1, uPct / 100);
    const haircutBpsEst = isRefused ? null : Math.round(utilRatio * widenBps);
    const quoteOut = isRefused ? "0.0000 (Refused)" : (1 - (haircutBpsEst ?? 0) / 10000).toFixed(4);
    const x = START_X + (uPct / 100) * USABLE_WIDTH;
    const y = isRefused ? BASE_AXIS_Y : yForHaircut((utilRatio * widenBps) / 10000);
    return { uPct, isRefused, refusalReason, haircutBpsEst, quoteOut, x, y };
  }, [hoverUtil, maxUtilRatio, freeCliffRatio, widenBps, maxUtilBps, yForHaircut, USABLE_WIDTH]);

  return (
    <div>
      <div style={{ marginBottom: 12, display: "flex", justifyContent: "space-between", alignItems: "flex-end", flexWrap: "wrap", gap: 12 }}>
        <div>
          <h1 className={`${s.display} ${s.h1}`} style={{ fontSize: 32, marginBottom: 3, lineHeight: 1.15 }}>
            Encumbered strategy builder
          </h1>
          <p style={{ margin: 0, color: "var(--ink2)", maxWidth: "60ch", fontSize: 13.5 }}>
            Aqua lets you promise the same tokens twice. Bone Dry enforces on-chain solvency limits that refuse before they fail.
          </p>
        </div>
        {onPickPair && (
          <button
            type="button"
            className={s.ticker}
            onClick={onPickPair}
            style={{ cursor: "pointer", padding: "4px 12px 4px 8px" }}
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
        <div className={s.colNarrow} style={{ gap: 10 }}>
          {/* 1. Your Backing Card */}
          <section className={`${s.card} ${s.cardPad}`} style={{ padding: "11px 14px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8 }}>
              <span className={s.label}>Your Backing ({tokenOut.symbol})</span>
              {address ? (
                <span className={s.mono} style={{ fontSize: 11, color: isBackingLoading ? "var(--ink2)" : "var(--ink3)" }}>
                  {isBackingLoading ? "syncing on-chain…" : shortAddr(address)}
                </span>
              ) : (
                <span className={s.mono} style={{ fontSize: 11, color: "var(--ink3)" }}>
                  Demo preview
                </span>
              )}
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "6px 14px", marginBottom: 10 }}>
              <div>
                <div style={{ fontSize: 11, color: "var(--ink3)" }}>Wallet Backing</div>
                <div className={s.mono} style={{ fontSize: 13.5, fontWeight: 600, color: "var(--ink)" }}>
                  {isBackingLoading ? "…" : backingOut === null ? "—" : units(backingOut, tokenOut.decimals, 4)} {tokenOut.symbol}
                </div>
              </div>
              <div>
                <div style={{ fontSize: 11, color: "var(--ink3)" }}>Current Utilization</div>
                <div className={s.mono} style={{ fontSize: 13.5, fontWeight: 600, color: currentUtilPct >= (maxUtilBps / 100) ? "var(--short)" : "var(--ink)" }}>
                  {isBackingLoading ? "…" : `${currentUtilPct.toFixed(1)}%`}
                </div>
              </div>
              <div>
                <div style={{ fontSize: 11, color: "var(--ink3)" }}>Wallet Balance</div>
                <div className={s.mono} style={{ fontSize: 12, color: "var(--ink2)" }}>
                  {isBackingLoading ? "…" : balanceOut === null ? "—" : units(balanceOut, tokenOut.decimals, 4)} {tokenOut.symbol}
                </div>
              </div>
              <div>
                <div style={{ fontSize: 11, color: "var(--ink3)" }}>Aqua Allowance</div>
                <div className={s.mono} style={{ fontSize: 12, color: allowanceBounded ? "var(--short)" : "var(--ink2)" }}>
                  {isBackingLoading ? "…" : allowanceOut === null ? "—" : units(allowanceOut, tokenOut.decimals, 4)} {tokenOut.symbol}
                </div>
              </div>
              <div>
                <div style={{ fontSize: 11, color: "var(--ink3)" }}>Total Promised (Siblings)</div>
                <div className={s.mono} style={{ fontSize: 12, color: alreadyPromisedOut > 0n ? "var(--ink)" : "var(--ink3)" }}>
                  {isBackingLoading ? "…" : `${units(alreadyPromisedOut, tokenOut.decimals, 4)} ${tokenOut.symbol}`}
                </div>
              </div>
              <div>
                <div style={{ fontSize: 11, color: "var(--ink3)" }}>Free Capacity</div>
                <div className={s.mono} style={{ fontSize: 12, color: "var(--ink)" }}>
                  {isBackingLoading ? "…" : capacityOut === null ? "—" : units(capacityOut, tokenOut.decimals, 4)} {tokenOut.symbol}
                </div>
              </div>
            </div>

            {wrongChain && (
              <div
                style={{
                  marginBottom: 8,
                  padding: "5px 8px",
                  background: "rgba(194, 78, 25, 0.08)",
                  border: "1px solid rgba(194, 78, 25, 0.25)",
                  borderRadius: 4,
                  fontSize: 11,
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  gap: 6,
                }}
              >
                <span style={{ color: "var(--short)" }}>
                  ⚠ Wallet is on wrong network. Switch to {net.label}.
                </span>
                {switchChain && (
                  <button
                    type="button"
                    onClick={() => switchChain({ chainId: net.id })}
                    style={{
                      padding: "2px 6px",
                      fontSize: 10,
                      background: "transparent",
                      color: "var(--short)",
                      border: "1px solid var(--short)",
                      borderRadius: 3,
                      cursor: "pointer",
                      whiteSpace: "nowrap",
                    }}
                  >
                    Switch
                  </button>
                )}
              </div>
            )}

            {zeroAllowance && (
              <div
                style={{
                  marginBottom: 8,
                  padding: "5px 8px",
                  background: "rgba(194, 78, 25, 0.08)",
                  border: "1px solid rgba(194, 78, 25, 0.25)",
                  borderRadius: 4,
                  fontSize: 11,
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  gap: 6,
                }}
              >
                <span style={{ color: "var(--short)" }}>
                  ⚠ Zero Aqua allowance: Approve Aqua to move {tokenOut.symbol}.
                </span>
                <button
                  type="button"
                  onClick={handleApproveAqua}
                  disabled={approving}
                  style={{
                    padding: "2px 6px",
                    fontSize: 10,
                    background: "transparent",
                    color: "var(--short)",
                    border: "1px solid var(--short)",
                    borderRadius: 3,
                    cursor: approving ? "not-allowed" : "pointer",
                    whiteSpace: "nowrap",
                  }}
                >
                  {approving ? "Approving…" : "Approve"}
                </button>
              </div>
            )}

            {allowanceBounded && !zeroAllowance && (
              <div
                style={{
                  marginBottom: 8,
                  padding: "4px 8px",
                  background: "rgba(194, 78, 25, 0.08)",
                  border: "1px solid rgba(194, 78, 25, 0.25)",
                  borderRadius: 4,
                  fontSize: 11,
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  gap: 6,
                }}
              >
                <span style={{ color: "var(--short)" }}>
                  ⚠ Allowance &lt; balance: Aqua approval ({allowanceOut === null ? "0" : units(allowanceOut, tokenOut.decimals, 4)} {tokenOut.symbol}) limits deliverable backing.
                </span>
                <button
                  type="button"
                  onClick={handleApproveAqua}
                  disabled={approving}
                  style={{
                    padding: "2px 6px",
                    fontSize: 10,
                    background: "transparent",
                    color: "var(--short)",
                    border: "1px solid var(--short)",
                    borderRadius: 3,
                    cursor: approving ? "not-allowed" : "pointer",
                    whiteSpace: "nowrap",
                  }}
                >
                  {approving ? "Approving…" : "Increase"}
                </button>
              </div>
            )}

            <div className={s.bar} style={{ height: 5, width: "100%", marginBottom: 8 }}>
              <span
                className={s.barFill}
                style={{
                  width: `${Math.min(100, currentUtilPct)}%`,
                  background: currentUtilPct >= (maxUtilBps / 100) ? "var(--short)" : "var(--ink)",
                }}
              />
            </div>

            <p style={{ margin: 0, fontSize: 11, color: "var(--ink3)", lineHeight: 1.3 }}>
              {address
                ? `Encumbrance backing is evaluated on ${tokenOut.symbol} as min(balance, allowance).`
                : `Encumbrance backing is evaluated on ${tokenOut.symbol} as min(balance, allowance). Connect a wallet to view live balances.`}
            </p>
          </section>

          {/* 2. The Promise Card */}
          <section className={`${s.card} ${s.cardPad}`} style={{ padding: "11px 14px" }}>
            <span className={s.label} style={{ marginBottom: 8, display: "block" }}>
              The Promise ({tokenIn.symbol} → {tokenOut.symbol})
            </span>

            {/* Pricing Model Segmented Toggle */}
            {oracleAvailable ? (
              <div style={{ marginBottom: 10 }}>
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
            ) : (
              <div style={{ marginBottom: 8, fontSize: 11, color: "var(--ink3)", lineHeight: 1.3 }}>
                Pricing model: <strong>Constant Product (xy=k)</strong>. Oracle pricing via BeaconStrategy is only deployed on Base Sepolia for WETH/USDC.
              </div>
            )}

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6, marginBottom: 2 }}>
              <div className={s.inset} style={{ padding: "6px 8px", minWidth: 0 }}>
                <div className={s.fieldHead} style={{ marginBottom: 3, gap: 4 }}>
                  <span className={s.label} style={{ fontSize: 10 }}>Offer {tokenIn.symbol}</span>
                  <span className={s.mono} style={{ fontSize: 9, color: "var(--ink3)" }}>
                    {heldIn === null ? "—" : units(heldIn, tokenIn.decimals, 1)}
                  </span>
                </div>
                <div className={s.amountRow} style={{ gap: 4 }}>
                  <input
                    className={s.amountIn}
                    style={{ fontSize: 16, minWidth: 0 }}
                    value={claimIn}
                    inputMode="decimal"
                    onChange={(e) => {
                      setClaimIn(e.target.value);
                      setRangePreset("custom");
                    }}
                    placeholder="0.0"
                  />
                  <span className={s.mono} style={{ fontSize: 11, color: "var(--ink)", flexShrink: 0 }}>
                    {tokenIn.symbol}
                  </span>
                </div>
              </div>

              <div className={s.inset} style={{ padding: "6px 8px", minWidth: 0 }}>
                <div className={s.fieldHead} style={{ marginBottom: 3, gap: 4 }}>
                  <span className={s.label} style={{ fontSize: 10 }}>Ask {tokenOut.symbol}</span>
                </div>
                <div className={s.amountRow} style={{ gap: 4 }}>
                  <input
                    className={s.amountIn}
                    style={{ fontSize: 16, minWidth: 0 }}
                    value={claimOut}
                    inputMode="decimal"
                    onChange={(e) => {
                      setClaimOut(e.target.value);
                      setRangePreset("custom");
                    }}
                    placeholder="0.0"
                  />
                  <span className={s.mono} style={{ fontSize: 11, color: "var(--ink)", flexShrink: 0 }}>
                    {tokenOut.symbol}
                  </span>
                </div>
              </div>

              <div className={s.inset} style={{ padding: "6px 8px", minWidth: 0 }}>
                <div className={s.fieldHead} style={{ marginBottom: 3, gap: 4 }}>
                  <span className={s.label} style={{ fontSize: 10 }}>Fee</span>
                  <span className={s.mono} style={{ fontSize: 9, color: "var(--ink3)" }}>
                    {pricing === "oracle" ? "spread" : "bps"}
                  </span>
                </div>
                <div className={s.amountRow} style={{ gap: 4 }}>
                  {pricing === "oracle" ? (
                    <span className={s.mono} style={{ fontSize: 12, color: beaconSpreadError ? "var(--short)" : "var(--ink3)", padding: "2px 0", whiteSpace: "nowrap" }}>
                      {beaconSpreadError
                        ? "—"
                        : beaconSpreadBps === null
                          ? "…"
                          : `${beaconSpreadBps} bps`}
                    </span>
                  ) : (
                    <>
                      <input
                        className={s.amountIn}
                        style={{ fontSize: 16, minWidth: 0 }}
                        value={feeBps}
                        inputMode="numeric"
                        onChange={(e) => setFeeBps(e.target.value)}
                        placeholder="0"
                      />
                      <span className={s.mono} style={{ fontSize: 11, color: "var(--ink)", flexShrink: 0 }}>bps</span>
                    </>
                  )}
                </div>
              </div>
            </div>
          </section>

          {/* 3. The Limits & Publish */}
          <section className={`${s.card} ${s.cardPad}`} style={{ padding: "11px 14px" }}>
            <span className={s.label} style={{ marginBottom: 10, display: "block" }}>
              The Limits
            </span>

            {/* Sliders Grid: Refusal Ceiling & Spread Widening */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 10 }}>
              {/* Refusal Ceiling */}
              <div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 3 }}>
                  <span style={{ fontSize: 11.5, fontWeight: 600, color: "var(--ink)" }}>Refusal Ceiling</span>
                  <span className={s.mono} style={{ fontSize: 11.5, color: "var(--ink)" }}>
                    {(maxUtilBps / 100).toFixed(0)}%
                  </span>
                </div>
                <input
                  type="range"
                  min="3000"
                  max="9500"
                  step="500"
                  value={maxUtilBps}
                  onChange={(e) => setMaxUtilBps(Number(e.target.value))}
                  style={{ width: "100%", accentColor: "var(--ink)", cursor: "pointer", marginBottom: 4 }}
                />
                <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                  {[5000, 7500, 8000, 9000].map((v) => (
                    <button
                      key={v}
                      type="button"
                      onClick={() => setMaxUtilBps(v)}
                      className={`${s.range} ${maxUtilBps === v ? s.rangeOn : ""}`}
                      style={{ fontSize: 10, padding: "1px 5px" }}
                    >
                      {v / 100}%
                    </button>
                  ))}
                </div>
                <p style={{ margin: "4px 0 0", fontSize: 10.5, color: "var(--ink3)", lineHeight: 1.25 }}>
                  Refuse fills when &gt;<strong>{(maxUtilBps / 100).toFixed(0)}%</strong> promised.
                </p>
              </div>

              {/* Spread Widening */}
              <div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 3 }}>
                  <span style={{ fontSize: 11.5, fontWeight: 600, color: "var(--ink)" }}>Spread Widening</span>
                  <span className={s.mono} style={{ fontSize: 11.5, color: "var(--ink)" }}>
                    {widenBps} bps
                  </span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="1500"
                  step="50"
                  value={widenBps}
                  onChange={(e) => setWidenBps(Number(e.target.value))}
                  style={{ width: "100%", accentColor: "var(--ink)", cursor: "pointer", marginBottom: 4 }}
                />
                <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                  {[100, 250, 500, 1000].map((w) => (
                    <button
                      key={w}
                      type="button"
                      onClick={() => setWidenBps(w)}
                      className={`${s.range} ${widenBps === w ? s.rangeOn : ""}`}
                      style={{ fontSize: 10, padding: "1px 5px" }}
                    >
                      {w}
                    </button>
                  ))}
                </div>
                <p style={{ margin: "4px 0 0", fontSize: 10.5, color: "var(--ink3)", lineHeight: 1.25 }}>
                  Widen up to <strong>{(widenBps / 100).toFixed(2)}%</strong> near ceiling.
                </p>
              </div>
            </div>

            {/* Live Sibling Constraints */}
            <div style={{ borderTop: "1px solid var(--rule)", paddingTop: 8, marginBottom: 8 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 4 }}>
                <span style={{ fontSize: 11.5, fontWeight: 600, color: "var(--ink)" }}>Sibling Constraints</span>
                <span className={s.mono} style={{ fontSize: 9.5, color: "var(--ink3)" }}>
                  {liveSiblings.length} on {tokenOut.symbol} · max 6
                </span>
              </div>

              {liveSiblings.length === 0 ? (
                <div style={{ padding: "5px 8px", background: "var(--sunk)", borderRadius: 5, fontSize: 11, color: "var(--ink2)" }}>
                  <span className={s.mono} style={{ fontWeight: 600, fontSize: 9.5, display: "block", marginBottom: 1 }}>
                    ● FIRST STRATEGY FOR MAKER
                  </span>
                  No prior live strategies on this token. Fully backed with 0 initial encumbrance.
                </div>
              ) : siblingLimitExceeded ? (
                <div style={{ padding: "5px 8px", background: "rgba(194, 78, 25, 0.08)", borderRadius: 5, fontSize: 11, color: "var(--short)" }}>
                  <span className={s.mono} style={{ fontWeight: 600, fontSize: 9.5, display: "block", marginBottom: 1 }}>
                    ⚠ UNDER-CONSTRAINED ({liveSiblings.length} &gt; 6 siblings)
                  </span>
                  SwapVM limit restricts sibling proofs to 6. Only first 6 verified on-chain.
                </div>
              ) : (
                <div style={{ padding: "5px 8px", background: "var(--sunk)", borderRadius: 5, fontSize: 11, color: "var(--ink2)" }}>
                  <span className={s.mono} style={{ fontWeight: 600, fontSize: 9.5, display: "block", marginBottom: 1 }}>
                    ✓ COMPLETE ({liveSiblings.length}/6 slots)
                  </span>
                  All {liveSiblings.length} sibling commitment{liveSiblings.length > 1 ? "s" : ""} verified on-chain.
                </div>
              )}

              {/* Sibling items */}
              {liveSiblings.length > 0 && (
                <div style={{ display: "flex", flexDirection: "column", gap: 4, maxHeight: 75, overflowY: "auto", marginTop: 5 }}>
                  {liveSiblings.slice(0, 6).map((strat, idx) => {
                    const matchingSide = strat.sides.find((sd) => sd.token.toLowerCase() === tokenOut.address.toLowerCase()) || strat.sides[0];
                    return (
                      <div
                        key={strat.strategyHash}
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                          padding: "3px 6px",
                          background: "var(--surface)",
                          border: "1px solid var(--rule)",
                          borderRadius: 4,
                          fontSize: 10,
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
            </div>

            {/* Action Section */}
            <div
              style={{
                position: "sticky",
                bottom: 8,
                background: "var(--surface)",
                paddingTop: 8,
                marginTop: 8,
                borderTop: "1px solid var(--rule)",
                zIndex: 5,
              }}
            >
              <button
                className={`${s.btnBlock} ${!covered && address ? s.btnBlockShort : ""}`}
                onClick={() => {
                  if (wrongChain && switchChain) {
                    switchChain({ chainId: net.id });
                    return;
                  }
                  if (zeroAllowance) {
                    handleApproveAqua();
                    return;
                  }
                  handleShip();
                }}
                disabled={
                  busy ||
                  approving ||
                  (!wrongChain && !zeroAllowance && (amountInvalid || zeroBacking || !address))
                }
              >
                {busy
                  ? "Shipping on-chain…"
                  : approving
                  ? "Approving Aqua…"
                  : !address
                  ? "Connect wallet to ship"
                  : wrongChain
                  ? `Switch network to ${net.label}`
                  : zeroAllowance
                  ? `Approve ${tokenOut.symbol} before publishing`
                  : zeroBacking
                  ? `0 ${tokenOut.symbol} backing — deposit or fund wallet`
                  : amountInvalid
                  ? "Enter claim amounts above"
                  : siblingLimitExceeded
                  ? (covered ? "Publish strategy (first 6 siblings proved)" : "Publish anyway — over-promised")
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
            </div>
          </section>
        </div>

        {/* ── Evidence & Graph Column (Right: High-Ratio Hero Visuals) ─────────────────────────────── */}
        <div className={s.colWide}>
          {/* Main Hero Graph Card */}
          <section className={`${s.card} ${s.cardClip}`} style={{ marginBottom: 24 }}>
            <div
              className={s.cardHead}
              style={{ padding: "16px 22px", flexDirection: "column", alignItems: "stretch", gap: 14 }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", flexWrap: "wrap", gap: 12 }}>
                <div style={{ minWidth: 0 }}>
                  <h2 className={`${s.display} ${s.h2}`} style={{ marginBottom: 3 }}>
                    {graphMode === "depth"
                      ? "Illustrative Liquidity Shape"
                      : graphMode === "curve"
                      ? "Solvency Haircut & On-Chain Refusal Curve"
                      : "Dual View: Liquidity Shape & Solvency Response"}
                  </h2>
                  <p style={{ margin: 0, fontSize: 13.5, color: "var(--ink3)" }}>
                    {graphMode === "depth"
                      ? "Illustrative liquidity schematic across price ticks with active range highlight and spot reference."
                      : graphMode === "curve"
                      ? "Progressive haircut slope with dual on-chain refusal boundaries: order floor & utilization cliff."
                      : "Illustrative bonding depth alongside the on-chain refusal and haircut response."}
                  </p>
                </div>

                {/* 3-Way Graph Mode Toggle */}
                <div className={s.seg}>
                  <button
                    type="button"
                    onClick={() => setGraphMode("depth")}
                    className={`${s.segBtn} ${graphMode === "depth" ? s.segBtnOn : ""}`}
                    title="View illustrative liquidity depth curve"
                  >
                    ✦ Liquidity Shape
                  </button>
                  <button
                    type="button"
                    onClick={() => setGraphMode("curve")}
                    className={`${s.segBtn} ${graphMode === "curve" ? s.segBtnOn : ""}`}
                    title="View solvency haircut and dual refusal boundaries"
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

              {/* Compact Metric Row in Card Head */}
              {(graphMode === "curve" || graphMode === "dual") && (
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    flexWrap: "wrap",
                    gap: "8px 18px",
                    padding: "8px 12px",
                    background: "var(--sunk)",
                    borderRadius: 6,
                    border: "1px solid var(--rule)",
                    fontSize: 12,
                  }}
                >
                  <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
                    <span className={s.label} style={{ fontSize: 10 }}>Current Util</span>
                    <span className={s.mono} style={{ fontWeight: 600, color: currentUtilPct >= (maxUtilBps / 100) ? "var(--short)" : "var(--ink)" }}>
                      {currentUtilPct.toFixed(1)}%
                    </span>
                  </div>
                  <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
                    <span className={s.label} style={{ fontSize: 10 }}>Haircut</span>
                    <span className={s.mono} style={{ fontWeight: 600, color: "var(--ink)" }}>
                      -{currentHaircutBps} bps
                    </span>
                  </div>
                  <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
                    <span className={s.label} style={{ fontSize: 10 }}>1.000 Quotes As</span>
                    <span className={s.mono} style={{ fontWeight: 600, color: "var(--ink)" }}>
                      {currentQuoteVal.toFixed(4)} {tokenIn.symbol}
                    </span>
                  </div>
                  <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
                    <span className={s.label} style={{ fontSize: 10 }}>Refusal Ceiling</span>
                    <span className={s.mono} style={{ fontWeight: 600, color: "var(--short)" }}>
                      {(maxUtilBps / 100).toFixed(0)}% ({maxUtilBps} bps)
                    </span>
                  </div>
                  {freeCliffRatio !== null && freeCliffRatio < maxUtilRatio && (
                    <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
                      <span className={s.label} style={{ fontSize: 10, color: "#d97706" }}>Order Size Floor</span>
                      <span className={s.mono} style={{ fontWeight: 600, color: "#d97706" }}>
                        {(freeCliffRatio * 100).toFixed(1)}% (amountOut &gt; free)
                      </span>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Graph 1: Continuous AMM Liquidity Depth Curve */}
            {(graphMode === "depth" || graphMode === "dual") && (
              <div style={{ padding: "20px 22px", borderBottom: graphMode === "dual" ? "1px solid var(--rule)" : "none" }}>
                {graphMode === "dual" && (
                  <span className={s.label} style={{ fontSize: 11, marginBottom: 12, display: "block", letterSpacing: ".12em" }}>
                    01 · Illustrative Liquidity Shape
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

            {/* Graph 2: Solvency Response Curve with Dual On-Chain Refusal Boundaries */}
            {(graphMode === "curve" || graphMode === "dual") && (
              <div style={{ padding: "20px 22px" }}>
                {graphMode === "dual" && (
                  <span className={s.label} style={{ fontSize: 11, marginBottom: 12, display: "block", letterSpacing: ".12em" }}>
                    02 · Solvency Haircut &amp; On-Chain Refusal Curve
                  </span>
                )}

                {/* The SVG Solvency Response Chart */}
                <div style={{ position: "relative", width: "100%", userSelect: "none" }}>
                  <svg
                    viewBox={`0 0 ${SVG_WIDTH} ${SVG_HEIGHT}`}
                    preserveAspectRatio="none"
                    role="img"
                    aria-label="Solvency & Haircut Response Curve"
                    style={{ width: "100%", height: 260, display: "block", overflow: "visible", cursor: "crosshair" }}
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

                      {/* Pattern for Refusal Cliff (util >= maxUtilBps) */}
                      <pattern id="refusalHatch" width="8" height="8" patternTransform="rotate(45 0 0)" patternUnits="userSpaceOnUse">
                        <line x1="0" y1="0" x2="0" y2="8" stroke="rgba(194, 78, 25, 0.32)" strokeWidth="1.5" />
                      </pattern>

                      {/* Pattern for Second Ceiling (amountOut > free capacity) */}
                      <pattern id="insufficientHatch" width="8" height="8" patternTransform="rotate(-45 0 0)" patternUnits="userSpaceOnUse">
                        <line x1="0" y1="0" x2="0" y2="8" stroke="rgba(217, 119, 6, 0.35)" strokeWidth="1.5" />
                      </pattern>
                    </defs>

                    {/* Horizontal grid, labelled in bps.
                        The axis is scaled to the cliff haircut, so without these
                        labels a full-height slope could be read as a far larger
                        haircut than widenBps ever applies. */}
                    {[0, 1, 2, 3, 4].map((i) => {
                      const yPos = TOP_AXIS_Y + i * (Y_TRAVEL / 4);
                      const bpsAtLine = Math.round(maxHaircutFrac * 10000 * (i / 4));
                      return (
                        <g key={i}>
                          <line
                            x1={START_X}
                            x2={END_X}
                            y1={yPos}
                            y2={yPos}
                            stroke="var(--rule)"
                            strokeWidth={1}
                            strokeDasharray="2 4"
                          />
                          <text
                            x={START_X - 6}
                            y={yPos + 3}
                            textAnchor="end"
                            fill="var(--ink3)"
                            fontSize={9}
                            fontFamily="var(--mono)"
                          >
                            {i === 0 ? "0" : `-${bpsAtLine}`}
                          </text>
                        </g>
                      );
                    })}
                    <text
                      x={START_X}
                      y={TOP_AXIS_Y - 14}
                      textAnchor="start"
                      fill="var(--ink3)"
                      fontSize={8.5}
                      fontFamily="var(--mono)"
                      letterSpacing=".06em"
                    >
                      HAIRCUT (BPS)
                    </text>

                    {/* Safe zone area fill under the progressive curve */}
                    <path d={solvencyAreaD} fill="url(#solvencyAreaGrad)" />

                    {/* Second Ceiling Zone: amountOut > free capacity (§0.5) */}
                    {insufficientX !== null && insufficientX < cliffX && (
                      <rect
                        x={insufficientX}
                        y={TOP_AXIS_Y - 10}
                        width={cliffX - insufficientX}
                        height={BASE_AXIS_Y - (TOP_AXIS_Y - 10)}
                        fill="url(#insufficientHatch)"
                      />
                    )}

                    {/* Refusal Cliff Zone: util >= maxUtilBps */}
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

                    {/* Boundary 2 Vertical Line: amountOut > free (EncumbranceInsufficient) */}
                    {insufficientX !== null && insufficientX < cliffX && (
                      <line
                        x1={insufficientX}
                        y1={TOP_AXIS_Y - 10}
                        x2={insufficientX}
                        y2={BASE_AXIS_Y}
                        stroke="#d97706"
                        strokeWidth={2}
                        strokeDasharray="4 3"
                      />
                    )}

                    {/* Boundary 1 Vertical Line: Cliff Drop at maxUtilBps (EncumbranceExceeded) */}
                    <line
                      x1={cliffX}
                      y1={yForHaircut(maxHaircutFrac)}
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
                          cy={
                            currentUtilX <= cliffX && (insufficientX === null || currentUtilX <= insufficientX)
                              ? yForHaircut((utilPlotPct / 100) * widenBps / 10000)
                              : BASE_AXIS_Y
                          }
                          r={6}
                          fill={
                            currentUtilX > cliffX
                              ? "var(--short)"
                              : insufficientX !== null && currentUtilX > insufficientX
                              ? "#d97706"
                              : "var(--ink)"
                          }
                          stroke="var(--paper)"
                          strokeWidth={2.5}
                        />
                      </g>
                    )}

                    {/* Refusal Badges */}
                    {insufficientX !== null && insufficientX < cliffX ? (
                      <>
                        <g transform={`translate(${Math.min(END_X - 160, Math.max(START_X, insufficientX - 8))}, 18)`}>
                          <rect x={0} y={-10} width={138} height={18} rx={3} fill="#d97706" />
                          <text x={69} y={3} textAnchor="middle" fill="white" fontSize={8} fontFamily="var(--mono)" fontWeight={700}>
                            REFUSES: amountOut &gt; free
                          </text>
                        </g>
                        <g transform={`translate(${Math.min(END_X - 110, Math.max(START_X + 140, cliffX + 6))}, 18)`}>
                          <rect x={0} y={-10} width={100} height={18} rx={3} fill="var(--short)" />
                          <text x={50} y={3} textAnchor="middle" fill="white" fontSize={8} fontFamily="var(--mono)" fontWeight={700}>
                            CLIFF: util ≥ max
                          </text>
                        </g>
                      </>
                    ) : (
                      <g transform={`translate(${Math.min(END_X - 120, cliffX - 10)}, 18)`}>
                        <rect x={-8} y={-10} width={116} height={18} rx={3} fill="var(--short)" />
                        <text x={50} y={3} textAnchor="middle" fill="white" fontSize={8.5} fontFamily="var(--mono)" fontWeight={700}>
                          REFUSAL CLIFF ({(maxUtilBps / 100).toFixed(0)}%)
                        </text>
                      </g>
                    )}

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
                      {hoverSolvencyData.refusalReason && (
                        <div style={{ fontSize: 9.5, color: "#fca5a5", marginTop: 2, maxWidth: 220 }}>
                          {hoverSolvencyData.refusalReason}
                        </div>
                      )}
                    </div>
                  )}
                </div>

                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 14, flexWrap: "wrap", gap: 10 }}>
                  <span className={s.mono} style={{ fontSize: 11, color: "var(--ink2)" }}>
                    ● <strong>Haircut Law</strong>: Linear widening (-{widenBps} bps max)
                  </span>
                  {insufficientX !== null && insufficientX < cliffX && (
                    <span className={s.mono} style={{ fontSize: 11, color: "#d97706" }}>
                      --- <strong>Amber Zone</strong>: Refused if amountOut &gt; free capacity
                    </span>
                  )}
                  <span className={s.mono} style={{ fontSize: 11, color: "var(--short)" }}>
                    --- <strong>Red Cliff</strong>: Refused at {(maxUtilBps / 100).toFixed(0)}% util (EncumbranceExceeded)
                  </span>
                </div>
                {/* Solvency Formulas Disclosure (§0.4 verbatim contract lines) */}
                <details
                  style={{
                    marginTop: 16,
                    borderTop: "1px solid var(--rule)",
                    paddingTop: 12,
                  }}
                >
                  <summary
                    style={{
                      cursor: "pointer",
                      fontFamily: "var(--mono)",
                      fontSize: 11.5,
                      fontWeight: 600,
                      color: "var(--ink2)",
                      userSelect: "none",
                    }}
                  >
                    ▸ Exact On-Chain Solvency Formulas (Encumbrance.sol:194–233)
                  </summary>

                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
                      gap: 10,
                      marginTop: 12,
                    }}
                  >
                    <div style={{ padding: "10px 12px", background: "var(--sunk)", borderRadius: 6, border: "1px solid var(--rule)" }}>
                      <span className={s.mono} style={{ fontSize: 10.5, color: "var(--ink3)" }}>01 · Backing &amp; Utilization</span>
                      <p className={s.mono} style={{ margin: "4px 0 2px", fontSize: 12, fontWeight: 600, color: "var(--ink)" }}>
                        backing = min(balOut, allowOut)
                      </p>
                      <p className={s.mono} style={{ margin: 0, fontSize: 11, color: "var(--ink2)" }}>
                        util = (declaredTotal * 1e4) / backing
                      </p>
                    </div>

                    <div style={{ padding: "10px 12px", background: "var(--sunk)", borderRadius: 6, border: "1px solid var(--rule)" }}>
                      <span className={s.mono} style={{ fontSize: 10.5, color: "var(--ink3)" }}>02 · Refusal Cliff &amp; Floor</span>
                      <p className={s.mono} style={{ margin: "4px 0 2px", fontSize: 12, fontWeight: 600, color: "var(--short)" }}>
                        if (util &gt;= maxUtilBps) revert
                      </p>
                      <p className={s.mono} style={{ margin: 0, fontSize: 11, color: "#d97706" }}>
                        if (amountOut &gt; free) revert
                      </p>
                    </div>

                    <div style={{ padding: "10px 12px", background: "var(--sunk)", borderRadius: 6, border: "1px solid var(--rule)" }}>
                      <span className={s.mono} style={{ fontSize: 10.5, color: "var(--ink3)" }}>03 · Spread Widening</span>
                      <p className={s.mono} style={{ margin: "4px 0 2px", fontSize: 12, fontWeight: 600, color: "var(--ink)" }}>
                        haircut = (amountOut * widenBps * util) / 1e8
                      </p>
                      <p className={s.mono} style={{ margin: 0, fontSize: 11, color: "var(--ink2)" }}>
                        amountOut -= haircut (exact-in)
                      </p>
                    </div>
                  </div>

                  <pre
                    className={s.mono}
                    style={{
                      marginTop: 12,
                      padding: "12px 14px",
                      background: "var(--sunk)",
                      border: "1px solid var(--rule)",
                      borderRadius: 6,
                      fontSize: 11,
                      lineHeight: 1.5,
                      color: "var(--ink)",
                      overflowX: "auto",
                    }}
                  >
{`// Encumbrance.sol:194-208, 216-218, 230-233
uint256 balOut   = IERC20(ctx.query.tokenOut).balanceOf(ctx.query.maker);
uint256 allowOut = IERC20(ctx.query.tokenOut).allowance(ctx.query.maker, address(aqua));
uint256 backing  = Math.min(balOut, allowOut);

if (backing == 0) revert EncumbranceZeroBacking();

// 512-bit intermediate multiplication avoids overflow even on arbitrarily massive commitments
uint256 util = Math.mulDiv(declaredTotalEncumbrance, 1e4, backing);

// Report true untruncated utilization in EncumbranceExceeded
if (util >= maxUtilBps) {
    revert EncumbranceExceeded(util, maxUtilBps);
}

if (widenBps > 0 && util > 0 && ctx.query.isExactIn && ctx.swap.amountOut > 0) {
    uint256 haircut = Math.mulDiv(ctx.swap.amountOut, uint256(widenBps) * util, 1e8);
    ctx.swap.amountOut -= haircut;
}

// Hard solvency floor: deliverable amountOut cannot exceed free backing
uint256 free = backing > declaredTotalEncumbrance ? backing - declaredTotalEncumbrance : 0;
if (ctx.swap.amountOut > free) {
    revert EncumbranceInsufficient(ctx.swap.amountOut, free);
}`}
                  </pre>
                </details>
              </div>
            )}
          </section>

          {/* Verified Deployments Card (Dynamic per active network, §0.9) */}
          <section className={`${s.card} ${s.cardPad}`}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 12 }}>
              <div>
                <span className={s.label}>Live Contract References</span>
                <h3 className={`${s.display} ${s.h2}`} style={{ margin: "2px 0 0", fontSize: 18 }}>
                  Verified Deployments
                </h3>
              </div>
              <span className={s.mono} style={{ fontSize: 11, color: "var(--ink)" }}>
                {net.label}
              </span>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 13 }}>
                <span style={{ color: "var(--ink2)" }}>BoneDryRouter (Opcode 35)</span>
                {net.boneDryRouter ? (
                  <span className={s.mono} style={{ fontSize: 12, display: "inline-flex", alignItems: "center" }}>
                    {shortAddr(net.boneDryRouter)}
                    <CopyButton value={net.boneDryRouter} size={12} />
                  </span>
                ) : (
                  <span className={s.mono} style={{ fontSize: 12, color: "var(--ink3)" }}>
                    — (Not deployed on {net.label})
                  </span>
                )}
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 13 }}>
                <span style={{ color: "var(--ink2)" }}>Aqua Settlement</span>
                <span className={s.mono} style={{ fontSize: 12, display: "inline-flex", alignItems: "center" }}>
                  {shortAddr(net.aqua)}
                  <CopyButton value={net.aqua} size={12} />
                </span>
              </div>
              {net.wellhead && (
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 13 }}>
                  <span style={{ color: "var(--ink2)" }}>Wellhead Pool</span>
                  <span className={s.mono} style={{ fontSize: 12, display: "inline-flex", alignItems: "center" }}>
                    {shortAddr(net.wellhead)}
                    <CopyButton value={net.wellhead} size={12} />
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
