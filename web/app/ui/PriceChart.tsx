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

  // Initialize and update Lightweight Charts container
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

  // Real Chainlink rounds, always -- regardless of which pricing model is
  // selected. There used to be a separate branch here for "xyc" that drew a
  // synthetic ±20% line labelled as a bonding-curve visualization; it wasn't
  // one (the math was linear, not y = k/x) and its timestamps were invented
  // rather than real rounds walked from the feed. XYC's own price is whatever
  // the pool's reserve ratio implies at fill time, which this app has no way
  // to chart historically -- so instead of fabricating a curve for it, both
  // pricing models get the one thing this app actually has: the real feed
  // this maker's claim amounts are being sized against.
  useEffect(() => {
    if (!seriesRef.current || !spot) return;

    if (priceData?.history && priceData.history.length >= 2) {
      const formatted = priceData.history.map((pt) => ({
        time: pt.time as UTCTimestamp,
        value: pt.value,
      }));
      seriesRef.current.setData(formatted);
      chartRef.current?.timeScale().fitContent();
    } else {
      // Honest flat line over the last hour if the feed only returned one round.
      const now = priceData?.updatedAt ?? Math.floor(Date.now() / 1000);
      seriesRef.current.setData([
        { time: (now - 3600) as UTCTimestamp, value: spot },
        { time: now as UTCTimestamp, value: spot },
      ]);
      chartRef.current?.timeScale().fitContent();
    }
  }, [spot, priceData?.history, priceData?.updatedAt]);

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
          {loading && spot === null ? (
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
              Fixed price &middot; Oracle mid minus spread
            </span>
          ) : (
            <span className={`${s.shapeBadge} ${s.shapeCurved}`}>
              No price bound &middot; Constant-product
            </span>
          )}
        </div>
      </div>

      <div className={s.presetBar}>
        <span className="label">Size claim near:</span>
        <div className={s.presetTabs} role="tablist" aria-label="Claim size reference">
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
        <p className={s.chartEmptyNote}>
          A sizing reference only &mdash; neither pricing model below enforces a price
          bound on chain. This strategy will quote at any price once shipped.
        </p>
      </div>

      {/* Chart Canvas Area: Always mounted in DOM to ensure canvas initialization */}
      <div className={s.chartCanvasWrap}>
        <div
          ref={containerRef}
          className={s.chartCanvas}
          style={{ display: spot !== null ? "block" : "none" }}
        />
        {!loading && spot === null && (
          <div className={s.chartEmptyState}>
            <p className="label">Historical oracle series unavailable for this token</p>
            <p className={s.chartEmptyNote}>
              Chainlink feed is not configured on this network for {targetToken.symbol}. You can
              still enter claim amounts below &mdash; there is nothing here to size them against.
            </p>
          </div>
        )}
      </div>

      {/* Reference readout for the sizing preset above -- not an on-chain bound. */}
      {spot !== null && preset !== "full" && lowerBound && upperBound && (
        <div className={s.boundsRow}>
          <div className={s.boundItem}>
            <span className="label">Reference low</span>
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
            <span className="label">Reference high</span>
            <span className={`num ${s.boundVal}`}>
              ${upperBound.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
