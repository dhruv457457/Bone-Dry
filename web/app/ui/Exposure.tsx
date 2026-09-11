"use client";

import { useEffect, useState } from "react";
import s from "./desk.module.css";
import { compact, short } from "@/lib/format";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import type { Address } from "viem";
import type { NetworkId } from "@/lib/networks";
import { TokenIcon } from "./TokenIcon";
import type {
  ExposurePosition,
  ExposureResponse,
  ExposureSources,
  HistoryResponse,
} from "./types";

export type { ExposurePosition, ExposureResponse, ExposureSources };

/* The table of a single maker's Aqua commitments against their actual wallet balance.
   Shared between the connected-wallet exposure card and the public lookup page. */
export function ExposureTable({
  positions,
  chainId = 8453,
  sources,
}: {
  positions: ExposurePosition[];
  chainId?: number;
  sources?: ExposureSources;
}) {
  return (
    <div className={s.tableWrap}>
      <table className={s.table}>
        <thead>
          <tr>
            <th>Token</th>
            <th>Claimed</th>
            <th>Held in wallet</th>
            <th>Coverage</th>
          </tr>
        </thead>
        <tbody>
          {positions.map((p) => {
            const dec = p.decimals ?? 18;
            return (
              <tr key={p.token}>
                <td>
                  <span className={s.tokenCell}>
                    <TokenIcon chainId={chainId} address={p.token} symbol={p.symbol} size={20} />
                    <span className="num">{p.symbol}</span>
                    <span className={`num ${s.dim}`}>{short(p.token)}</span>
                  </span>
                </td>
                <td className={`num ${s.dim}`}>{compact(p.claimed, dec)}</td>
                <td className="num">{compact(p.held, dec)}</td>
                <td>
                  <span className={`${s.badge} ${p.covered ? s.badgeOk : s.badgeLoss}`}>
                    {p.covered ? "covered" : "shortfall"}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {sources && (
        <p className={`label ${s.sourcesLine}`}>
          Commitments from the Aquifer subgraph &middot; balances from{" "}
          {sources.balances === "token-api" ? "The Graph Token API" : "RPC"}{" "}
          &middot; allowances from RPC
        </p>
      )}
    </div>
  );
}

/* A connected maker's own coverage ratio across every strategy they have shipped.
   Aqua cannot total this on-chain because the mapping is not enumerable; this view
   reads the index so a maker can verify whether their own book is solvent. */
/* What a snapshot alone cannot show: how a wallet got to the position it is
   currently in. Swaps made as a taker, strategies shipped or docked as a
   maker -- the portfolio's own history, not just its current balance. */
function PortfolioHistory({ chainId, address }: { chainId: NetworkId; address: Address }) {
  const [data, setData] = useState<HistoryResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let live = true;
    setLoading(true);
    fetch(`/api/history?chain=${chainId}&address=${address}`)
      .then((r) => r.json())
      .then((json: HistoryResponse) => {
        if (live) setData(json);
      })
      .catch(() => {
        if (live) setData(null);
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [chainId, address]);

  const fmtTime = (ts: number | null) =>
    ts === null ? "--" : new Date(ts * 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

  return (
    <section className={s.exposure} style={{ marginTop: "32px" }}>
      <div className={s.sectionHead}>
        <h2 className={s.sectionTitle}>History &mdash; what got you here, not just where you are</h2>
        {loading && <span className={`label ${s.spin}`}>reading chain…</span>}
      </div>

      <div className={s.sectionHead} style={{ marginTop: "16px" }}>
        <h3 className="label" style={{ fontSize: "12px" }}>Swaps made as a taker</h3>
        {data && (
          <span className="label">
            {data.swaps.available ? `${data.swaps.rows.length} in the last ~20,000 blocks` : data.swaps.reason}
          </span>
        )}
      </div>
      {data?.swaps.available && data.swaps.rows.length > 0 ? (
        <div className={s.tableWrap}>
          <table className={s.table}>
            <thead>
              <tr>
                <th>When</th>
                <th>Sold</th>
                <th>Bought</th>
                <th>Tx</th>
              </tr>
            </thead>
            <tbody>
              {data.swaps.rows.map((r) => (
                <tr key={r.txHash}>
                  <td className={`num ${s.dim}`}>{fmtTime(r.timestamp)}</td>
                  <td className="num">
                    {r.amountIn} <span className="hex">{short(r.tokenIn)}</span>
                  </td>
                  <td className="num">
                    {r.amountOut} <span className="hex">{short(r.tokenOut)}</span>
                  </td>
                  <td>
                    <span className="hex num">{short(r.txHash)}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        !loading && data?.swaps.available && (
          <p className={s.empty}>No swaps through this network&apos;s Wellhead in the recent window.</p>
        )
      )}

      <div className={s.sectionHead} style={{ marginTop: "24px" }}>
        <h3 className="label" style={{ fontSize: "12px" }}>Strategies shipped as a maker</h3>
        {data && <span className="label">{data.strategies.rows.length} &middot; source: {data.strategies.source}</span>}
      </div>
      {data && data.strategies.rows.length > 0 ? (
        <div className={s.tableWrap}>
          <table className={s.table}>
            <thead>
              <tr>
                <th>Strategy</th>
                <th>Shipped</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {data.strategies.rows.map((r) => (
                <tr key={r.strategyHash}>
                  <td className="hex num">{short(r.strategyHash)}</td>
                  <td className={`num ${s.dim}`}>{fmtTime(r.shippedAt)}</td>
                  <td>
                    <span className={`${s.badge} ${r.active ? s.badgeOk : s.badgeLoss}`}>
                      {r.active ? "active" : "docked"}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        !loading && <p className={s.empty}>No strategies shipped by this wallet found in this window.</p>
      )}
    </section>
  );
}

export default function Exposure({
  chainId,
  address,
  onGoToBase,
}: {
  chainId: NetworkId;
  address?: Address;
  onGoToBase?: () => void;
}) {
  const [data, setData] = useState<ExposureResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!address) {
      setData(null);
      setError(null);
      return;
    }

    let live = true;
    setLoading(true);
    setError(null);

    fetch(`/api/exposure?chain=${chainId}&maker=${address}`)
      .then(async (res) => {
        if (!live) return;
        const json = (await res.json()) as ExposureResponse;
        if (!res.ok) {
          setError(json.error ?? `request failed (${res.status})`);
        } else {
          setData(json);
        }
      })
      .catch((e) => {
        if (live) setError((e as Error).message);
      })
      .finally(() => {
        if (live) setLoading(false);
      });

    return () => {
      live = false;
    };
  }, [chainId, address]);

  // No section to fall silent into any more -- this is the whole tab, so a
  // disconnected wallet needs its own answer, not an empty page.
  if (!address) {
    return (
      <section className={s.exposure}>
        <div className={s.sectionHead}>
          <h2 className={s.sectionTitle}>Your exposure &mdash; claimed against held</h2>
          <span className="label">no wallet connected</span>
        </div>
        <div className={s.coverageEmpty}>
          <p>
            Connect a wallet to see your own coverage ratio: what you have claimed
            across every strategy you have shipped, against what your wallet
            actually holds.
          </p>
          <ConnectButton label="Connect wallet" chainStatus="none" showBalance={false} />
        </div>
      </section>
    );
  }

  if (error) {
    return (
      <>
        <section className={s.exposure}>
          <div className={s.sectionHead}>
            <h2 className={s.sectionTitle}>Your exposure &mdash; claimed against held</h2>
            <span className="label">{error}</span>
          </div>
          <p className={s.err}>{error}</p>
        </section>
        <PortfolioHistory chainId={chainId} address={address} />
      </>
    );
  }

  if (loading && !data) {
    return (
      <>
        <section className={s.exposure}>
          <div className={s.sectionHead}>
            <h2 className={s.sectionTitle}>Your exposure &mdash; claimed against held</h2>
            <span className="label">reading index...</span>
          </div>
        </section>
        <PortfolioHistory chainId={chainId} address={address} />
      </>
    );
  }

  if (data && !data.available) {
    return (
      <>
        <section className={s.exposure}>
          <div className={s.sectionHead}>
            <h2 className={s.sectionTitle}>Your exposure &mdash; claimed against held</h2>
            <span className="label">{data.reason ?? "no index for this network"}</span>
          </div>
          <div className={s.coverageEmpty}>
            <p>
              Totalling what one maker has promised across every strategy is the thing no
              contract can do, so this view needs an index. There is one on Base.
            </p>
            {onGoToBase && <button onClick={onGoToBase}>See it on Base</button>}
          </div>
        </section>
        <PortfolioHistory chainId={chainId} address={address} />
      </>
    );
  }

  if (data && data.positions.length === 0) {
    return (
      <>
        <section className={s.exposure}>
          <div className={s.sectionHead}>
            <h2 className={s.sectionTitle}>Your exposure &mdash; claimed against held</h2>
            <span className="label">0 active positions</span>
          </div>
          <p className={s.empty}>This wallet has no active Aqua positions on this network.</p>
        </section>
        <PortfolioHistory chainId={chainId} address={address} />
      </>
    );
  }

  if (!data) return null;

  return (
    <>
    <section className={s.exposure}>
      <div className={s.sectionHead}>
        <h2 className={s.sectionTitle}>Your exposure &mdash; claimed against held</h2>
        <span className="label">
          {data.fullyCoveredCount} of {data.totalPositions} fully covered
        </span>
      </div>
      <ExposureTable positions={data.positions} chainId={chainId} sources={data.sources} />
    </section>
    <PortfolioHistory chainId={chainId} address={address} />
    </>
  );
}
