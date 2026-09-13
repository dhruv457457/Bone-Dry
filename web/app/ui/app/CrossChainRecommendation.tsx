"use client";

import { useSwapGas } from "./useSwapGas";
import { useEffect, useMemo, useRef, useState } from "react";
import { useAccount } from "wagmi";
import type { Address } from "viem";
import s from "../app.module.css";
import { units, toRaw } from "@/lib/format";
import { NETWORKS, publicClientFor, type NetworkId } from "@/lib/networks";
import { erc20Abi } from "@/lib/chain";
import {
  getAlternateChain,
  findCounterpartToken,
  evaluateCrossChainAdvantage,
  type CrossChainComparison,
} from "@/lib/crossChain";
import { getFromCache, setInCache, routeCacheKey } from "@/lib/cache";
import type { RouteResponse } from "../types";

type Token = { address: string; symbol: string; decimals: number };

export function CrossChainRecommendation({
  chainId,
  tokenIn,
  tokenOut,
  input,
  currentRoute,
  onSwitchChain,
  onInspectMatrix,
  onAltRouteLoaded,
  onOpenAudit,
  mode = "pill",
}: {
  chainId: NetworkId;
  tokenIn: Token;
  tokenOut: Token;
  input: string;
  currentRoute: RouteResponse | null;
  onSwitchChain?: (targetChainId: NetworkId) => void;
  onInspectMatrix?: () => void;
  onAltRouteLoaded?: (route: RouteResponse | null, targetChainId: NetworkId) => void;
  onOpenAudit?: () => void;
  mode?: "pill" | "card";
}) {
  const [altRoute, setAltRoute] = useState<RouteResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [altBalance, setAltBalance] = useState<bigint | null>(null);

  const { address } = useAccount();

  const targetChainId = getAlternateChain(chainId);
  const targetNet = NETWORKS[targetChainId];
  // Before any early return: hooks run in the same order every render.
  const gasNote = useSwapGas(targetChainId);

  const altTokenIn = useMemo(
    () => findCounterpartToken(tokenIn, targetChainId),
    [tokenIn, targetChainId]
  );
  const altTokenOut = useMemo(
    () => findCounterpartToken(tokenOut, targetChainId),
    [tokenOut, targetChainId]
  );

  const amountIn = useMemo(
    () => (altTokenIn ? toRaw(input, altTokenIn.decimals) : 0n),
    [input, altTokenIn]
  );

  const gen = useRef(0);
  // Swap passes this as an inline arrow and re-renders on every result it reports,
  // so depending on it re-ran the fetch forever -- 121 identical Ethereum route
  // calls for one amount. Read the latest through a ref instead.
  const onLoadedRef = useRef(onAltRouteLoaded);
  onLoadedRef.current = onAltRouteLoaded;

  useEffect(() => {
    if (!altTokenIn || !altTokenOut || amountIn === 0n) {
      setAltRoute(null);
      setLoading(false);
      onLoadedRef.current?.(null, targetChainId);
      return;
    }

    const rKey = routeCacheKey(targetChainId, altTokenIn.address, altTokenOut.address, amountIn);
    const cached = getFromCache<RouteResponse>(rKey);
    if (cached) {
      setAltRoute(cached.error ? null : cached);
      setLoading(false);
      onLoadedRef.current?.(cached.error ? null : cached, targetChainId);
      return;
    }

    const mine = ++gen.current;
    setLoading(true);

    const timer = setTimeout(async () => {
      try {
        const q = `chain=${targetChainId}&tokenIn=${altTokenIn.address}&tokenOut=${altTokenOut.address}&amountIn=${amountIn}`;
        const res = await fetch(`/api/route?${q}`);
        if (!res.ok) return;
        const data = (await res.json()) as RouteResponse;
        if (mine === gen.current) {
          const loaded = data.error ? null : data;
          if (loaded) setInCache(rKey, loaded, 30_000);
          setAltRoute(loaded);
          onLoadedRef.current?.(loaded, targetChainId);
        }
      } catch {
        if (mine === gen.current) {
          setAltRoute(null);
          onLoadedRef.current?.(null, targetChainId);
        }
      } finally {
        if (mine === gen.current) {
          setLoading(false);
        }
      }
    }, 250);

    return () => clearTimeout(timer);
  // Keyed on addresses: the token objects are rebuilt whenever their inputs change identity.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetChainId, altTokenIn?.address, altTokenOut?.address, amountIn]);

  // Read wallet balance on the alternate chain (Idea D: Balance Radar)
  useEffect(() => {
    if (!address || !altTokenIn || !targetNet) {
      setAltBalance(null);
      return;
    }
    let live = true;
    publicClientFor(targetNet)
      .readContract({
        address: altTokenIn.address as Address,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [address],
      })
      .then((b) => live && setAltBalance(b as bigint))
      .catch(() => live && setAltBalance(null));
    return () => {
      live = false;
    };
  }, [address, altTokenIn, targetNet]);

  const adv: CrossChainComparison = useMemo(() => {
    return evaluateCrossChainAdvantage(currentRoute, altRoute, chainId, targetChainId);
  }, [currentRoute, altRoute, chainId, targetChainId]);

  if (mode === "pill") {
    if (loading) {
      return (
        <div className={s.mirrorShimmer}>
          <span className={s.crossChainPulse} />
          <span>Auditing Base & Ethereum solvency…</span>
        </div>
      );
    }
    if (adv.hasAdvantage && altRoute) {
      return (
        <div
          className={s.solvencySignalPill}
          onClick={onOpenAudit}
          title="Click to review cross-chain solvency in Pre-Flight audit"
        >
          <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
            <span className={s.crossChainPulse} />
            <strong style={{ whiteSpace: "nowrap" }}>Solvency signal:</strong>
            <span style={{ textOverflow: "ellipsis", overflow: "hidden", whiteSpace: "nowrap" }}>
              {adv.multiplier >= 1.2 ? `${adv.multiplier.toFixed(1)}× more on ${targetNet.label}` : adv.title}
            </span>
          </div>
          <span style={{ fontSize: 11, textDecoration: "underline", fontWeight: 600, flexShrink: 0 }}>
            Inspect in Swap →
          </span>
        </div>
      );
    }
    return null;
  }

  if (!adv.hasAdvantage || !altRoute) return null;

  const currentNet = NETWORKS[chainId];
  const curDevBps = adv.currentDeviationBps;
  const altDevBps = adv.altDeviationBps;

  const curDevStr =
    curDevBps === null
      ? ""
      : curDevBps < 0
        ? `${(Math.abs(curDevBps) / 100).toFixed(0)}% below oracle`
        : `+${(curDevBps / 100).toFixed(1)}% vs oracle`;

  const altDevStr =
    altDevBps === null
      ? ""
      : altDevBps < 0
        ? `${(Math.abs(altDevBps) / 100).toFixed(1)}% slippage`
        : `+${(altDevBps / 100).toFixed(1)}% vs oracle`;

  const curOutStr = currentRoute?.amountOut
    ? `${units(currentRoute.amountOut, tokenOut.decimals, 6)} ${tokenOut.symbol}`
    : "unfilled";

  const altOutStr = altRoute?.amountOut
    ? `${units(altRoute.amountOut, altTokenOut?.decimals ?? 18, 6)} ${altTokenOut?.symbol ?? tokenOut.symbol}`
    : "—";

  const gain =
    adv.altAmountOut > adv.currentAmountOut ? adv.altAmountOut - adv.currentAmountOut : 0n;
  const gainStr =
    gain > 0n
      ? `+${units(gain, altTokenOut?.decimals ?? 18, 6)} ${altTokenOut?.symbol ?? tokenOut.symbol}`
      : null;

  const buttonLabel = switching
    ? "Switching…"
    : adv.multiplier >= 1.3
      ? `Switch to ${targetNet.label} (${adv.multiplier.toFixed(0)}×) ↗`
      : `Switch to ${targetNet.label} ↗`;


  const handleSwitch = async () => {
    if (!onSwitchChain) return;
    setSwitching(true);
    try {
      await onSwitchChain(targetChainId);
    } finally {
      setSwitching(false);
    }
  };

  return (
    <div className={`${s.crossChainCard} ${s.in}`}>
      <div className={s.crossChainHead}>
        <span className={s.crossChainSignal}>
          <span className={s.crossChainPulse} />
          Cross-chain solvency opportunity
        </span>
        <span className={s.crossChainBadge}>
          {currentNet.label} → {targetNet.label}
        </span>
      </div>

      <div>
        <h4 className={s.crossChainTitle}>{adv.title}</h4>
        <p style={{ margin: "3px 0 0", fontSize: 12.5, color: "var(--ink2)", lineHeight: 1.4 }}>
          {adv.detail}
        </p>
      </div>

      <div className={s.crossChainCompare}>
        <div className={s.crossChainCol}>
          <span className={s.crossChainColLabel}>{currentNet.label} (current)</span>
          <span className={s.crossChainColVal} style={{ opacity: 0.85 }}>{curOutStr}</span>
          <span className={s.crossChainColMeta}>
            {adv.currentMakers} maker{adv.currentMakers === 1 ? "" : "s"} {curDevStr ? `· ${curDevStr}` : ""}
          </span>
        </div>

        <div className={s.crossChainCol}>
          <span className={s.crossChainColLabel} style={{ color: "var(--warn-ink)", fontWeight: 600 }}>
            {targetNet.label} (recommended)
          </span>
          <span className={s.crossChainColVal} style={{ color: "var(--warn-ink)", fontSize: 14 }}>
            {altOutStr}
          </span>
          <span className={s.crossChainColMeta}>
            {adv.altMakers} wallet{adv.altMakers === 1 ? "" : "s"} filling {altDevStr ? `· ${altDevStr}` : ""}
          </span>
        </div>
      </div>

      {gainStr && adv.multiplier >= 1.2 ? (
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            padding: "4px 8px",
            borderRadius: 4,
            background: "rgba(186, 74, 24, 0.08)",
            fontSize: 11.5,
            fontFamily: "var(--mono)",
            color: "var(--warn-ink)",
          }}
        >
          <span>Net deliverable gain:</span>
          <strong>{gainStr} ({adv.multiplier.toFixed(1)}× more tokens)</strong>
        </div>
      ) : null}

      {/* Idea D: Pre-flight Wallet Balance Radar */}
      {altBalance !== null && altBalance > 0n && altTokenIn ? (
        <div style={{ fontSize: 11.5, color: "var(--ink2)", display: "flex", alignItems: "center", gap: 5 }}>
          <span style={{ color: "var(--warn-ink)", fontWeight: 600 }}>✓</span>
          <span>
            <strong>{units(altBalance, altTokenIn.decimals, 2)} {altTokenIn.symbol}</strong> ready in your {targetNet.label} wallet
          </span>
        </div>
      ) : null}

      <div className={s.crossChainFoot}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0, flexWrap: "wrap" }}>
          <span className={s.crossChainSources}>{gasNote}</span>
          {onInspectMatrix ? (
            <button
              className={s.btnQuiet}
              onClick={onInspectMatrix}
              style={{ fontSize: 11, padding: "2px 6px" }}
              title="Inspect dual-chain depth matrix"
            >
              Matrix
            </button>
          ) : null}
        </div>
        <button
          className={s.crossChainActionBtn}
          onClick={handleSwitch}
          disabled={switching}
        >
          {buttonLabel}
        </button>
      </div>
    </div>
  );
}
