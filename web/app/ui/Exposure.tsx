"use client";

import { useEffect, useState } from "react";
import s from "./desk.module.css";
import { compact, short } from "@/lib/format";
import type { Address } from "viem";
import type { NetworkId } from "@/lib/networks";

export type ExposurePosition = {
  token: Address;
  symbol: string;
  decimals: number;
  claimed: string;
  held: string;
  backed?: string;
  covered: boolean;
};

export type ExposureResponse = {
  available: boolean;
  reason?: string;
  maker: Address;
  positions: ExposurePosition[];
  fullyCoveredCount: number;
  totalPositions: number;
  error?: string;
};

/* The table of a single maker's Aqua commitments against their actual wallet balance.
   Shared between the connected-wallet exposure card and the public lookup page. */
export function ExposureTable({ positions }: { positions: ExposurePosition[] }) {
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
                  <span className="num">{p.symbol}</span>{" "}
                  <span className={`num ${s.dim}`}>{short(p.token)}</span>
                </td>
                <td className={`num ${s.dim}`}>{compact(p.claimed, dec)}</td>
                <td className="num">{compact(p.held, dec)}</td>
                <td>
                  <span className={`num ${p.covered ? s.full : s.zero}`}>
                    {p.covered ? "covered" : "shortfall"}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/* A connected maker's own coverage ratio across every strategy they have shipped.
   Aqua cannot total this on-chain because the mapping is not enumerable; this view
   reads the index so a maker can verify whether their own book is solvent. */
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

  if (!address) return null;

  if (error) {
    return (
      <section className={s.exposure}>
        <div className={s.sectionHead}>
          <h2 className="label">Your exposure &mdash; claimed against held</h2>
          <span className="label">{error}</span>
        </div>
        <p className={s.err}>{error}</p>
      </section>
    );
  }

  if (loading && !data) {
    return (
      <section className={s.exposure}>
        <div className={s.sectionHead}>
          <h2 className="label">Your exposure &mdash; claimed against held</h2>
          <span className="label">reading index...</span>
        </div>
      </section>
    );
  }

  if (data && !data.available) {
    return (
      <section className={s.exposure}>
        <div className={s.sectionHead}>
          <h2 className="label">Your exposure &mdash; claimed against held</h2>
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
    );
  }

  if (data && data.positions.length === 0) {
    return (
      <section className={s.exposure}>
        <div className={s.sectionHead}>
          <h2 className="label">Your exposure &mdash; claimed against held</h2>
          <span className="label">0 active positions</span>
        </div>
        <p className={s.empty}>This wallet has no active Aqua positions on this network.</p>
      </section>
    );
  }

  if (!data) return null;

  return (
    <section className={s.exposure}>
      <div className={s.sectionHead}>
        <h2 className="label">Your exposure &mdash; claimed against held</h2>
        <span className="label">
          {data.fullyCoveredCount} of {data.totalPositions} fully covered
        </span>
      </div>
      <ExposureTable positions={data.positions} />
    </section>
  );
}
