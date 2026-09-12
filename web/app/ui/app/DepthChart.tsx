"use client";

import { useEffect, useMemo, useState, useRef } from "react";
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
  const [hoverX, setHoverX] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);

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

  // The visible domain: ±30% window around spot
  const domain = spot ? { lo: spot * 0.7, hi: spot * 1.3 } : null;

  const WIDTH = 720;
  const HEIGHT = 220;
  const BASE_Y = 180;
  const PEAK_Y = 38;

  const xForPrice = (price: number) => {
    if (!domain) return 0;
    const t = (price - domain.lo) / (domain.hi - domain.lo);
    return Math.max(0, Math.min(WIDTH, t * WIDTH));
  };

  const priceForX = (x: number) => {
    if (!domain) return 0;
    const t = x / WIDTH;
    return domain.lo + t * (domain.hi - domain.lo);
  };

  const oraclePrice = spot !== null ? spot - (spreadBps ? (spot * spreadBps) / 10000 : 0) : null;

  // Dispersion sigma based on range preset
  const sigma = useMemo(() => {
    if (preset === "10") return 0.09;
    if (preset === "20") return 0.17;
    if (preset === "full") return 0.42;
    return 0.14;
  }, [preset]);

  // Compute depth points across the 720px width
  const points = useMemo(() => {
    if (!spot || !domain) return [];
    const pts: { x: number; y: number; price: number; depthPct: number }[] = [];
    const steps = 80;
    for (let i = 0; i <= steps; i++) {
      const px = (i / steps) * WIDTH;
      const p = domain.lo + (i / steps) * (domain.hi - domain.lo);
      const z = Math.log(p / spot) / sigma;
      const depth = Math.exp(-0.5 * z * z);
      const py = BASE_Y - depth * (BASE_Y - PEAK_Y);
      pts.push({ x: px, y: py, price: p, depthPct: depth });
    }
    return pts;
  }, [spot, domain, sigma]);

  // SVG path definitions for the full curve and area
  const { curvePath, areaPath } = useMemo(() => {
    if (points.length === 0) return { curvePath: "", areaPath: "" };
    const pathD = points.reduce((acc, pt, idx) => {
      return idx === 0 ? `M ${pt.x.toFixed(1)},${pt.y.toFixed(1)}` : `${acc} L ${pt.x.toFixed(1)},${pt.y.toFixed(1)}`;
    }, "");
    const areaD = `${pathD} L ${WIDTH},${BASE_Y} L 0,${BASE_Y} Z`;
    return { curvePath: pathD, areaPath: areaD };
  }, [points]);

  // SVG path definition for the active range highlight area
  const activeAreaPath = useMemo(() => {
    if (!spot || preset === "full" || lowerBound === null || upperBound === null || points.length === 0) {
      return null;
    }
    const xLow = xForPrice(lowerBound);
    const xHigh = xForPrice(upperBound);
    const rangePts = points.filter((p) => p.x >= xLow && p.x <= xHigh);
    if (rangePts.length < 2) return null;

    const topD = rangePts.reduce((acc, pt, idx) => {
      return idx === 0 ? `M ${pt.x.toFixed(1)},${pt.y.toFixed(1)}` : `${acc} L ${pt.x.toFixed(1)},${pt.y.toFixed(1)}`;
    }, "");
    return `${topD} L ${xHigh.toFixed(1)},${BASE_Y} L ${xLow.toFixed(1)},${BASE_Y} Z`;
  }, [spot, preset, lowerBound, upperBound, points]);

  // Mouse hover tracking
  const handleMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    const clientX = e.clientX - rect.left;
    const scaleX = WIDTH / rect.width;
    const boundedX = Math.max(0, Math.min(WIDTH, clientX * scaleX));
    setHoverX(boundedX);
  };

  const handleMouseLeave = () => setHoverX(null);

  const hoverData = useMemo(() => {
    if (hoverX === null || !spot || !domain) return null;
    const price = priceForX(hoverX);
    const pctDiff = ((price - spot) / spot) * 100;
    const z = Math.log(price / spot) / sigma;
    const depth = Math.exp(-0.5 * z * z);
    const y = BASE_Y - depth * (BASE_Y - PEAK_Y);
    return { price, pctDiff, depth, x: hoverX, y };
  }, [hoverX, spot, domain, sigma]);

  const spotX = spot ? xForPrice(spot) : WIDTH / 2;

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
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <span className={s.chartBadge}>
            {pricing === "oracle" ? "Fixed price · oracle mid minus spread" : "Illustrative shape · concentrated liquidity schematic"}
          </span>
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12, flexWrap: "wrap" }}>
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
        {lowerBound !== null && upperBound !== null && preset !== "full" && (
          <span className={s.mono} style={{ fontSize: 11, color: "var(--ink3)", marginLeft: "auto" }}>
            Target window [{$(lowerBound)} → {$(upperBound)}]
          </span>
        )}
      </div>

      {spot === null ? (
        <div className={s.chartEmpty}>
          <p className={s.label} style={{ marginBottom: 6 }}>
            {loading ? "Reading the feed…" : "No oracle feed for this token"}
          </p>
          <p style={{ margin: 0, fontSize: 13, color: "var(--ink3)" }}>
            {loading
              ? "Depth here is sized against a real Chainlink round, once one comes back."
              : `Chainlink is not configured on this network for ${targetToken.symbol}. You can still enter claim amounts on the left.`}
          </p>
        </div>
      ) : (
        <div style={{ position: "relative", width: "100%", userSelect: "none" }}>
          <svg
            ref={svgRef}
            viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
            preserveAspectRatio="none"
            role="img"
            aria-label="AMM Liquidity Depth Curve"
            style={{ width: "100%", height: 220, display: "block", overflow: "visible", cursor: "crosshair" }}
            onMouseMove={handleMouseMove}
            onMouseLeave={handleMouseLeave}
          >
            <defs>
              <linearGradient id="bidGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#059669" stopOpacity={0.28} />
                <stop offset="85%" stopColor="#059669" stopOpacity={0.04} />
                <stop offset="100%" stopColor="#059669" stopOpacity={0.0} />
              </linearGradient>

              <linearGradient id="askGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#4f46e5" stopOpacity={0.28} />
                <stop offset="85%" stopColor="#4f46e5" stopOpacity={0.04} />
                <stop offset="100%" stopColor="#4f46e5" stopOpacity={0.0} />
              </linearGradient>

              <linearGradient id="activeRangeGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--ink)" stopOpacity={0.16} />
                <stop offset="100%" stopColor="var(--ink)" stopOpacity={0.03} />
              </linearGradient>

              <clipPath id="bidClip">
                <rect x={0} y={0} width={spotX} height={HEIGHT} />
              </clipPath>

              <clipPath id="askClip">
                <rect x={spotX} y={0} width={WIDTH - spotX} height={HEIGHT} />
              </clipPath>
            </defs>

            {[0, 1, 2, 3].map((i) => {
              const yPos = 35 + i * 36;
              return (
                <line
                  key={i}
                  x1={0}
                  x2={WIDTH}
                  y1={yPos}
                  y2={yPos}
                  stroke="var(--rule)"
                  strokeWidth={1}
                  strokeDasharray="2 4"
                />
              );
            })}

            {pricing === "xyc" ? (
              <>
                <path d={areaPath} fill="url(#bidGrad)" clipPath="url(#bidClip)" />
                <path d={areaPath} fill="url(#askGrad)" clipPath="url(#askClip)" />
                {activeAreaPath && (
                  <path d={activeAreaPath} fill="url(#activeRangeGrad)" stroke="var(--ink)" strokeWidth={1} strokeOpacity={0.2} />
                )}
                <path
                  d={curvePath}
                  fill="none"
                  stroke="var(--ink)"
                  strokeWidth={2.5}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                <text x={30} y={BASE_Y - 14} fill="#059669" fontSize={11} fontFamily="var(--mono)" fontWeight={600}>
                  ▲ BIDS ({tokenIn.symbol} DEPTH)
                </text>
                <text x={WIDTH - 30} y={BASE_Y - 14} textAnchor="end" fill="#4f46e5" fontSize={11} fontFamily="var(--mono)" fontWeight={600}>
                  ▼ ASKS ({tokenOut.symbol} DEPTH)
                </text>

                {preset !== "full" && lowerBound !== null && upperBound !== null && (
                  <>
                    <g>
                      <line
                        x1={xForPrice(lowerBound)}
                        x2={xForPrice(lowerBound)}
                        y1={24}
                        y2={BASE_Y}
                        stroke="var(--ink2)"
                        strokeWidth={1.5}
                        strokeDasharray="3 3"
                      />
                      <circle cx={xForPrice(lowerBound)} cy={BASE_Y} r={4} fill="var(--ink)" />
                      <rect
                        x={xForPrice(lowerBound) - 34}
                        y={8}
                        width={68}
                        height={18}
                        rx={4}
                        fill="var(--surface)"
                        stroke="var(--rule)"
                      />
                      <text
                        x={xForPrice(lowerBound)}
                        y={20}
                        textAnchor="middle"
                        fill="var(--ink)"
                        fontSize={9.5}
                        fontFamily="var(--mono)"
                        fontWeight={600}
                      >
                        {$(lowerBound)}
                      </text>
                    </g>

                    <g>
                      <line
                        x1={xForPrice(upperBound)}
                        x2={xForPrice(upperBound)}
                        y1={24}
                        y2={BASE_Y}
                        stroke="var(--ink2)"
                        strokeWidth={1.5}
                        strokeDasharray="3 3"
                      />
                      <circle cx={xForPrice(upperBound)} cy={BASE_Y} r={4} fill="var(--ink)" />
                      <rect
                        x={xForPrice(upperBound) - 34}
                        y={8}
                        width={68}
                        height={18}
                        rx={4}
                        fill="var(--surface)"
                        stroke="var(--rule)"
                      />
                      <text
                        x={xForPrice(upperBound)}
                        y={20}
                        textAnchor="middle"
                        fill="var(--ink)"
                        fontSize={9.5}
                        fontFamily="var(--mono)"
                        fontWeight={600}
                      >
                        {$(upperBound)}
                      </text>
                    </g>
                  </>
                )}
              </>
            ) : oraclePrice !== null ? (
              <>
                <circle cx={xForPrice(oraclePrice)} cy={PEAK_Y} r={24} fill="var(--ink)" opacity={0.06} />
                <circle cx={xForPrice(oraclePrice)} cy={PEAK_Y} r={12} fill="var(--ink)" opacity={0.16} />
                <line
                  x1={xForPrice(oraclePrice)}
                  x2={xForPrice(oraclePrice)}
                  y1={BASE_Y}
                  y2={PEAK_Y}
                  stroke="var(--ink)"
                  strokeWidth={3}
                />
                <circle cx={xForPrice(oraclePrice)} cy={PEAK_Y} r={6} fill="var(--ink)" />
                <text
                  x={Math.max(80, Math.min(WIDTH - 80, xForPrice(oraclePrice)))}
                  y={PEAK_Y - 14}
                  textAnchor="middle"
                  fill="var(--ink)"
                  fontSize={12}
                  fontFamily="var(--mono)"
                  fontWeight={600}
                >
                  oracle quote ({$(oraclePrice)})
                </text>
              </>
            ) : null}

            <line x1={0} x2={WIDTH} y1={BASE_Y} y2={BASE_Y} stroke="var(--ink)" strokeWidth={1.5} />

            <line
              x1={spotX}
              x2={spotX}
              y1={24}
              y2={BASE_Y}
              stroke="var(--ink)"
              strokeWidth={1.5}
              strokeDasharray="4 4"
            />
            <circle cx={spotX} cy={PEAK_Y} r={5} fill="var(--ink)" stroke="var(--paper)" strokeWidth={2} />
            <rect
              x={spotX - 44}
              y={6}
              width={88}
              height={18}
              rx={4}
              fill="var(--ink)"
            />
            <text
              x={spotX}
              y={18}
              textAnchor="middle"
              fill="var(--paper)"
              fontSize={9.5}
              fontFamily="var(--mono)"
              fontWeight={600}
            >
              SPOT {$(spot)}
            </text>

            {hoverData && (
              <g>
                <line
                  x1={hoverData.x}
                  x2={hoverData.x}
                  y1={20}
                  y2={BASE_Y}
                  stroke="var(--ink3)"
                  strokeWidth={1}
                  strokeDasharray="2 2"
                />
                <circle
                  cx={hoverData.x}
                  cy={hoverData.y}
                  r={5}
                  fill="var(--short)"
                  stroke="var(--surface)"
                  strokeWidth={2}
                />
              </g>
            )}
          </svg>

          {hoverData && (
            <div
              style={{
                position: "absolute",
                top: Math.max(10, (hoverData.y / HEIGHT) * 220 - 45),
                left: Math.min(WIDTH - 170, Math.max(20, (hoverData.x / WIDTH) * 100)) + "%",
                background: "var(--ink)",
                color: "var(--paper)",
                padding: "6px 10px",
                borderRadius: 6,
                fontSize: 11,
                fontFamily: "var(--mono)",
                pointerEvents: "none",
                boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
                zIndex: 10,
                transform: hoverData.x > WIDTH * 0.7 ? "translateX(-110%)" : "translateX(10px)",
              }}
            >
              <div><strong>Price:</strong> {$(hoverData.price)}</div>
              <div style={{ color: hoverData.pctDiff >= 0 ? "#34d399" : "#f87171" }}>
                <strong>Delta:</strong> {hoverData.pctDiff >= 0 ? "+" : ""}{hoverData.pctDiff.toFixed(2)}%
              </div>
              <div style={{ color: "rgba(255,255,255,0.7)", fontSize: 10 }}>
                Quoted Depth: {(hoverData.depth * 100).toFixed(0)}% peak
              </div>
            </div>
          )}

          <div className={s.chartTicks} style={{ marginTop: 6 }}>
            {domain
              ? [0, 0.25, 0.5, 0.75, 1].map((f) => (
                  <span key={f} className={s.mono} style={{ fontSize: 11 }}>
                    {$(domain.lo + f * (domain.hi - domain.lo))}
                  </span>
                ))
              : null}
          </div>

          {preset !== "full" && lowerBound !== null && upperBound !== null ? (
            <div className={s.boundsRow} style={{ marginTop: 12 }}>
              <div className={s.boundItem}>
                <span className={s.label}>Reference Low (-{preset}%)</span>
                <span className={s.boundVal}>{$(lowerBound)}</span>
              </div>
              <div className={s.boundItem}>
                <span className={s.label}>Mid Spot</span>
                <span className={s.boundValMid} style={{ color: "var(--ink)", fontWeight: 700 }}>{$(spot)}</span>
              </div>
              <div className={s.boundItem}>
                <span className={s.label}>Reference High (+{preset}%)</span>
                <span className={s.boundVal}>{$(upperBound)}</span>
              </div>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
