"use client";

import { useEffect, useRef, useState, useMemo } from "react";
import {
  createChart,
  AreaSeries,
  type IChartApi,
  type ISeriesApi,
  ColorType,
  LineStyle,
  type UTCTimestamp,
} from "lightweight-charts";
import s from "./desk.module.css";
import type { NetworkId } from "@/lib/networks";

export type RangePreset = "10" | "20" | "full" | "custom";

type PriceDataResponse = {
  token: string;
  spotUsd: number | null;
  updatedAt?: number;
  stale?: boolean;
  history?: { time: number; value: number }[];
  hasOracle: boolean;
  source: string;
  message?: string;
};

export function PriceChart({
  chainId,
  tokenIn,
  tokenOut,
  pricing,
  preset,
  onSelectPreset,
  onSpotPrice,
}: {
  chainId: NetworkId;
  tokenIn: { address: string; symbol: string; decimals: number };
  tokenOut: { address: string; symbol: string; decimals: number };
  pricing: "xyc" | "oracle";
  preset: RangePreset;
  onSelectPreset: (p: RangePreset) => void;
  onSpotPrice?: (price: number | null) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Area"> | null>(null);
  const upperLineRef = useRef<ReturnType<ISeriesApi<"Area">["createPriceLine"]> | null>(null);
  const lowerLineRef = useRef<ReturnType<ISeriesApi<"Area">["createPriceLine"]> | null>(null);

  const [priceData, setPriceData] = useState<PriceDataResponse | null>(null);
  const [loading, setLoading] = useState(true);

  // Target token for price query: prioritize WETH or volatile asset over stablecoin
  const targetToken = useMemo(() => {
    const isWethIn = tokenIn.symbol.toUpperCase() === "WETH";
    const isWethOut = tokenOut.symbol.toUpperCase() === "WETH";
    if (isWethIn) return tokenIn;
    if (isWethOut) return tokenOut;
    return tokenOut;
  }, [tokenIn, tokenOut]);

  // Fetch real Chainlink price data
  useEffect(() => {
    let active = true;
    setLoading(true);

    fetch(`/api/price?chain=${chainId}&token=${targetToken.address}`)
      .then((res) => res.json())
      .then((json: PriceDataResponse) => {
        if (!active) return;
        setPriceData(json);
        if (onSpotPrice) {
          onSpotPrice(json.spotUsd ?? null);
        }
      })
      .catch(() => {
        if (!active) return;
        setPriceData(null);
        if (onSpotPrice) onSpotPrice(null);
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [chainId, targetToken.address, onSpotPrice]);

  const spot = priceData?.spotUsd ?? null;

  // Compute range bounds based on preset
  const { lowerBound, upperBound } = useMemo(() => {
    if (!spot) return { lowerBound: null, upperBound: null };
    if (preset === "10") {
      return { lowerBound: spot * 0.9, upperBound: spot * 1.1 };
    }
    if (preset === "20") {
      return { lowerBound: spot * 0.8, upperBound: spot * 1.2 };
    }
    if (preset === "full") {
      return { lowerBound: spot * 0.05, upperBound: spot * 2.5 };
    }
    return { lowerBound: spot * 0.85, upperBound: spot * 1.15 };
  }, [spot, preset]);

  // Initialize and update Lightweight Charts
  useEffect(() => {
    if (!containerRef.current) return;

    if (!chartRef.current) {
      const chart = createChart(containerRef.current, {
        width: containerRef.current.clientWidth || 480,
        height: 180,
        layout: {
          background: { type: ColorType.Solid, color: "transparent" },
          textColor: "#5c5550",
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
          fontSize: 11,
        },
        grid: {
          vertLines: { color: "rgba(216, 210, 194, 0.4)" },
          horzLines: { color: "rgba(216, 210, 194, 0.4)" },
        },
        timeScale: {
          borderColor: "#d8d2c2",
          timeVisible: true,
          secondsVisible: false,
          fixLeftEdge: true,
          fixRightEdge: true,
        },
        rightPriceScale: {
          borderColor: "#d8d2c2",
          scaleMargins: {
            top: 0.2,
            bottom: 0.2,
          },
        },
        handleScroll: false,
        handleScale: false,
      });

      const series = chart.addSeries(AreaSeries, {
        lineColor: "#3e4a5c",
        topColor: "rgba(62, 74, 92, 0.16)",
        bottomColor: "rgba(62, 74, 92, 0.01)",
        lineWidth: 2,
        priceFormat: {
          type: "price",
          precision: 2,
          minMove: 0.01,
        },
      });

      chartRef.current = chart;
      seriesRef.current = series;

      const handleResize = () => {
        if (containerRef.current && chartRef.current) {
          chartRef.current.applyOptions({ width: containerRef.current.clientWidth });
        }
      };

      window.addEventListener("resize", handleResize);
      return () => {
        window.removeEventListener("resize", handleResize);
        chart.remove();
        chartRef.current = null;
        seriesRef.current = null;
      };
    }
  }, []);

  // Update chart series data and bounds
  useEffect(() => {
    if (!seriesRef.current || !priceData?.history || priceData.history.length === 0) return;

    const formatted = priceData.history.map((pt) => ({
      time: pt.time as UTCTimestamp,
      value: pt.value,
    }));

    seriesRef.current.setData(formatted);
    chartRef.current?.timeScale().fitContent();
  }, [priceData?.history]);

  // Update price lines for lower/upper range bounds
  useEffect(() => {
    if (!seriesRef.current) return;

    if (upperLineRef.current) {
      seriesRef.current.removePriceLine(upperLineRef.current);
      upperLineRef.current = null;
    }
    if (lowerLineRef.current) {
      seriesRef.current.removePriceLine(lowerLineRef.current);
      lowerLineRef.current = null;
    }

    if (upperBound !== null && preset !== "full") {
      upperLineRef.current = seriesRef.current.createPriceLine({
        price: upperBound,
        color: "#1b663e",
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: preset === "10" ? "+10%" : preset === "20" ? "+20%" : "Max",
      });
    }

    if (lowerBound !== null && preset !== "full") {
      lowerLineRef.current = seriesRef.current.createPriceLine({
        price: lowerBound,
        color: "#a6300e",
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: preset === "10" ? "-10%" : preset === "20" ? "-20%" : "Min",
      });
    }
  }, [upperBound, lowerBound, preset]);

  return (
    <div className={s.chartBox}>
      <div className={s.chartHead}>
        <div className={s.chartSpotRow}>
          <span className="label">Live oracle spot</span>
          {loading ? (
            <span className={`num ${s.dim}`}>reading Chainlink feed…</span>
          ) : spot !== null ? (
            <div className={s.spotFigureRow}>
              <span className={`num ${s.spotNumber}`}>
                ${spot.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </span>
              <span className={s.livePip} title="Live Chainlink AggregatorV3 feed" />
              <span className="label">{targetToken.symbol}/USD</span>
            </div>
          ) : (
            <span className={`num ${s.dim}`}>no feed for this pair</span>
          )}
        </div>

        <div className={s.shapeBadgeWrap}>
          {pricing === "oracle" ? (
            <span className={`${s.shapeBadge} ${s.shapeStraight}`}>
              Straight Range &middot; Oracle Mid
            </span>
          ) : (
            <span className={`${s.shapeBadge} ${s.shapeCurved}`}>
              Curved Range &middot; XYC Invariant
            </span>
          )}
        </div>
      </div>

      <div className={s.presetBar}>
        <span className="label">Range preset:</span>
        <div className={s.presetTabs} role="tablist" aria-label="Price range preset">
          {(["10", "20", "full", "custom"] as RangePreset[]).map((p) => (
            <button
              key={p}
              type="button"
              role="tab"
              aria-selected={preset === p}
              className={`${s.presetTab} ${preset === p ? s.presetTabOn : ""}`}
              onClick={() => onSelectPreset(p)}
            >
              {p === "10" ? "±10%" : p === "20" ? "±20%" : p === "full" ? "Full range" : "Custom"}
            </button>
          ))}
        </div>
      </div>

      {/* Chart Canvas Area */}
      <div className={s.chartCanvasWrap}>
        {priceData?.hasOracle ? (
          <div ref={containerRef} className={s.chartCanvas} />
        ) : (
          <div className={s.chartEmptyState}>
            <p className="label">Historical oracle series unavailable for this token</p>
            <p className={s.chartEmptyNote}>
              Chainlink feed is not configured on this network for {targetToken.symbol}. Claim amounts below
              configure strategy bounds directly.
            </p>
          </div>
        )}
      </div>

      {/* Bounds Readout */}
      {spot !== null && preset !== "full" && lowerBound && upperBound && (
        <div className={s.boundsRow}>
          <div className={s.boundItem}>
            <span className="label">Min price</span>
            <span className={`num ${s.boundVal}`}>
              ${lowerBound.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </span>
          </div>
          <div className={s.boundItem}>
            <span className="label">Mid spot</span>
            <span className={`num ${s.boundValMid}`}>
              ${spot.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </span>
          </div>
          <div className={s.boundItem}>
            <span className="label">Max price</span>
            <span className={`num ${s.boundVal}`}>
              ${upperBound.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
