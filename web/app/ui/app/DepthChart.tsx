"use client";

import { useEffect, useMemo, useState } from "react";
import s from "../app.module.css";
import type { NetworkId } from "@/lib/networks";

export type RangePreset = "10" | "20" | "full" | "custom";

type PriceDataResponse = {
  token: string;
  spotUsd: number | null;
  updatedAt?: number;
  stale?: boolean;
  hasOracle: boolean;
  source: string;
  message?: string;
};

const $ = (v: number) => `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * "The depth your strategy offers at each price" — drawn as what that actually
 * is, not as a historical price chart.
 *
 * This used to be a candlestick-library area chart of the Chainlink feed's past
 * rounds. That was itself a fix for something worse it replaced (a fabricated
 * bell curve, invented timestamps, labelled as a bonding curve it did not
 * compute) — but a real estate-agent's line chart of recent prices was never
 * what the design called for here, and it still is not depth.
 *
 * What actually determines depth-by-price for the two pricing models this app
 * offers is simple and real, not invented:
 *
 * - Constant product (x·y=k) has *no* price-dependent depth. Its marginal
 *   liquidity is the textbook-flat "constant liquidity" property of a CPMM —
 *   it quotes at every price with the same shape, which is exactly what the
 *   "No price bound" badge above it already says. So it is drawn flat: a
 *   filled band the width of the visible range, with the ±10/20%/custom
 *   selection overlaid as a highlighted window rather than as a shape change.
 * - The oracle model quotes at exactly one price — spot minus a fixed spread —
 *   and nowhere else. It is drawn as what it is: a single spike, not a curve.
 *
 * Both are computed from the real oracle spot this maker's claim is sized
 * against; neither one is a guess at what the curve "should" look like.
 */
export function DepthChart({
  chainId,
  tokenIn,
  tokenOut,
  pricing,
  preset,
  spreadBps,
  onSelectPreset,
  onSpotPrice,
}: {
  chainId: NetworkId;
  tokenIn: { address: string; symbol: string; decimals: number };
  tokenOut: { address: string; symbol: string; decimals: number };
  pricing: "xyc" | "oracle";
  preset: RangePreset;
  spreadBps?: number | null;
  onSelectPreset: (p: RangePreset) => void;
  onSpotPrice?: (price: number | null) => void;
}) {
  const [priceData, setPriceData] = useState<PriceDataResponse | null>(null);
  const [loading, setLoading] = useState(true);

  const targetToken = useMemo(() => {
    const isWethIn = tokenIn.symbol.toUpperCase() === "WETH";
    return isWethIn ? tokenIn : tokenOut;
  }, [tokenIn, tokenOut]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    fetch(`/api/price?chain=${chainId}&token=${targetToken.address}`)
      .then((res) => res.json())
      .then((json: PriceDataResponse) => {
        if (!active) return;
        setPriceData(json);
        onSpotPrice?.(json.spotUsd ?? null);
      })
      .catch(() => {
        if (!active) return;
        setPriceData(null);
        onSpotPrice?.(null);
      })
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [chainId, targetToken.address, onSpotPrice]);

  const spot = priceData?.spotUsd ?? null;

  const { lowerBound, upperBound } = useMemo(() => {
    if (!spot) return { lowerBound: null, upperBound: null };
    if (preset === "10") return { lowerBound: spot * 0.9, upperBound: spot * 1.1 };
    if (preset === "20") return { lowerBound: spot * 0.8, upperBound: spot * 1.2 };
    if (preset === "full") return { lowerBound: spot * 0.05, upperBound: spot * 2.5 };
    return { lowerBound: spot * 0.85, upperBound: spot * 1.15 };
  }, [spot, preset]);

  // The visible axis: a fixed ±30% window around spot. Wide enough to hold
  // every band preset except "full" (which is unbounded by definition and is
  // drawn as its own honest state below, not squeezed to fit this window).
  const domain = spot ? { lo: spot * 0.7, hi: spot * 1.3 } : null;
  const x = (price: number) => {
    if (!domain) return 0;
    const t = (price - domain.lo) / (domain.hi - domain.lo);
    return Math.max(0, Math.min(640, t * 640));
  };

  const BASE_Y = 118;
  const oraclePrice = spot !== null ? spot - (spreadBps ? (spot * spreadBps) / 10000 : 0) : null;

  return (
    <div>
      <div className={s.chartHead}>
        <div>
          <span className={s.label}>Live oracle spot</span>
          <div className={s.spotRow}>
            {loading && spot === null ? (
              <span className={s.mono} style={{ fontSize: 13, color: "var(--ink3)" }}>
                reading Chainlink feed…
              </span>
            ) : spot !== null ? (
              <>
                <p className={s.spotFig}>{$(spot)}</p>
                <span className={s.spotPip} title="Live Chainlink AggregatorV3 feed" />
                <span className={s.label}>{targetToken.symbol}/USD</span>
              </>
            ) : (
              <span className={s.mono} style={{ fontSize: 13, color: "var(--ink3)" }}>
                no feed for this pair
              </span>
            )}
          </div>
        </div>
        <span className={s.chartBadge}>
          {pricing === "oracle" ? "Fixed price · oracle mid minus spread" : "No price bound · constant-product"}
        </span>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4, flexWrap: "wrap" }}>
        <span className={s.label}>Size claim near:</span>
        <div className={s.ranges}>
          {(["10", "20", "full", "custom"] as RangePreset[]).map((p) => (
            <button
              key={p}
              type="button"
              role="tab"
              aria-selected={preset === p}
              onClick={() => onSelectPreset(p)}
              className={`${s.range} ${preset === p ? s.rangeOn : ""}`}
            >
              {p === "10" ? "±10%" : p === "20" ? "±20%" : p === "full" ? "Full range" : "Custom"}
            </button>
          ))}
        </div>
      </div>
      <p style={{ margin: "0 0 12px", fontSize: 13, color: "var(--ink3)" }}>
        A sizing reference only — neither pricing model enforces a price bound on chain. This
        strategy will quote at any price once shipped.
      </p>

      {spot === null ? (
        <div className={s.chartEmpty}>
          <p className={s.label} style={{ marginBottom: 6 }}>
            {loading ? "Reading the feed…" : "No oracle feed for this token"}
          </p>
          <p style={{ margin: 0, fontSize: 13, color: "var(--ink3)" }}>
            {loading
              ? "Depth here is sized against a real Chainlink round, once one comes back."
              : `Chainlink is not configured on this network for ${targetToken.symbol}. You can still enter claim amounts below — there is nothing here to size them against.`}
          </p>
        </div>
      ) : (
        <>
          <svg
            viewBox="0 0 640 150"
            preserveAspectRatio="none"
            role="img"
            aria-label={
              pricing === "oracle"
                ? "This strategy quotes at one fixed price"
                : "This strategy quotes with no price bound"
            }
            style={{ width: "100%", height: 150, display: "block", overflow: "visible" }}
          >
            {[0, 1, 2, 3].map((i) => (
              <line
                key={i}
                x1={0}
                x2={640}
                y1={22 + i * 32}
                y2={22 + i * 32}
                stroke="var(--rule)"
                strokeWidth={1}
              />
            ))}

            {pricing === "xyc" ? (
              <>
                {/* Constant depth: this is not a stand-in for a curve we could not
                    compute — a CPMM's marginal liquidity really is flat across
                    price, which is what "no price bound" above already says. */}
                <rect x={0} y={30} width={640} height={BASE_Y - 30} fill="var(--ink)" opacity={0.14} />
                <line x1={0} x2={640} y1={30} y2={30} stroke="var(--ink)" strokeWidth={1.5} opacity={0.5} />
                <line x1={0} x2={640} y1={BASE_Y} y2={BASE_Y} stroke="var(--ink)" strokeWidth={1.5} opacity={0.5} />
                <text
                  x={320}
                  y={74}
                  textAnchor="middle"
                  fill="var(--ink2)"
                  fontSize={11}
                  fontFamily="var(--mono)"
                  letterSpacing="0.02em"
                  opacity={0.85}
                >
                  flat: this pricing model quotes uniform depth across all prices
                </text>
              </>
            ) : oraclePrice !== null ? (
              <>
                {/* One price, one spike — an oracle strategy has no other shape. */}
                <circle cx={x(oraclePrice)} cy={34} r={14} fill="var(--ink)" opacity={0.08} />
                <circle cx={x(oraclePrice)} cy={34} r={8} fill="var(--ink)" opacity={0.20} />
                <line
                  x1={x(oraclePrice)}
                  x2={x(oraclePrice)}
                  y1={BASE_Y}
                  y2={34}
                  stroke="var(--ink)"
                  strokeWidth={3.5}
                />
                <circle cx={x(oraclePrice)} cy={34} r={5} fill="var(--ink)" />
                <text
                  x={Math.max(60, Math.min(580, x(oraclePrice)))}
                  y={22}
                  textAnchor="middle"
                  fill="var(--ink)"
                  fontSize={11}
                  fontFamily="var(--mono)"
                  fontWeight={600}
                >
                  oracle quote ({$(oraclePrice)})
                </text>
              </>
            ) : null}

            <line x1={0} x2={640} y1={BASE_Y} y2={BASE_Y} stroke="var(--ink)" strokeWidth={1} />

            {preset !== "full" && lowerBound !== null && upperBound !== null ? (
              <>
                <rect
                  x={x(lowerBound)}
                  y={0}
                  width={Math.max(0, x(upperBound) - x(lowerBound))}
                  height={126}
                  fill="var(--ink)"
                  opacity={0.045}
                />
                <line
                  x1={x(lowerBound)}
                  x2={x(lowerBound)}
                  y1={0}
                  y2={126}
                  stroke="var(--ink3)"
                  strokeWidth={1}
                  vectorEffect="non-scaling-stroke"
                />
                <line
                  x1={x(upperBound)}
                  x2={x(upperBound)}
                  y1={0}
                  y2={126}
                  stroke="var(--ink3)"
                  strokeWidth={1}
                  vectorEffect="non-scaling-stroke"
                />
                <circle cx={x(lowerBound)} cy={126} r={4} fill="var(--ink3)" />
                <circle cx={x(upperBound)} cy={126} r={4} fill="var(--ink3)" />
              </>
            ) : null}

            {/* Spot itself — always centred, since the visible axis is ±30% of it. */}
            <line
              x1={320}
              x2={320}
              y1={0}
              y2={126}
              stroke="var(--ink)"
              strokeWidth={1}
              strokeDasharray="3 4"
              vectorEffect="non-scaling-stroke"
            />
          </svg>

          <div className={s.chartTicks}>
            {domain
              ? [0, 0.25, 0.5, 0.75, 1].map((f) => (
                  <span key={f}>{$(domain.lo + f * (domain.hi - domain.lo))}</span>
                ))
              : null}
          </div>

          {preset !== "full" && lowerBound !== null && upperBound !== null ? (
            <div className={s.boundsRow}>
              <div className={s.boundItem}>
                <span className={s.label}>Reference low</span>
                <span className={s.boundVal}>{$(lowerBound)}</span>
              </div>
              <div className={s.boundItem}>
                <span className={s.label}>Mid spot</span>
                <span className={s.boundValMid}>{$(spot)}</span>
              </div>
              <div className={s.boundItem}>
                <span className={s.label}>Reference high</span>
                <span className={s.boundVal}>{$(upperBound)}</span>
              </div>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
