"use client";

import { useState, useCallback } from "react";
import Link from "next/link";
import s from "@/app/ui/desk.module.css";
import { ExposureTable, type ExposureResponse } from "@/app/ui/Exposure";
import { NETWORKS, DEFAULT_NETWORK, type NetworkId } from "@/lib/networks";
import { isAddress, getAddress } from "viem";

/* A public verification tool for Aqua maker solvency.
   Aqua's balance mapping is not enumerable, so no contract can verify what a maker
   has promised across all their strategies. Anyone can paste an address here to check
   whether a maker's promises are backed by real wallet balance and allowance. */
export default function LookupPage() {
  const [chainId, setChainId] = useState<NetworkId>(DEFAULT_NETWORK);
  const [inputAddress, setInputAddress] = useState("");
  const [queriedAddress, setQueriedAddress] = useState<string | null>(null);
  const [data, setData] = useState<ExposureResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const net = NETWORKS[chainId];

  const handleCheck = useCallback(
    async (addrToCheck?: string, targetChainId?: NetworkId) => {
      const raw = (addrToCheck ?? inputAddress).trim();
      const activeChain = targetChainId ?? chainId;
      if (!raw) return;

      if (!isAddress(raw, { strict: false })) {
        setError("not a valid address");
        setData(null);
        setQueriedAddress(null);
        return;
      }

      const addr = getAddress(raw);
      setBusy(true);
      setError(null);
      setQueriedAddress(addr);

      try {
        const res = await fetch(`/api/exposure?chain=${activeChain}&maker=${addr}`);
        const json = (await res.json()) as ExposureResponse;
        if (!res.ok) {
          setError(json.error ?? `query failed (${res.status})`);
          setData(null);
        } else {
          setData(json);
        }
      } catch (e) {
        setError((e as Error).message);
        setData(null);
      } finally {
        setBusy(false);
      }
    },
    [inputAddress, chainId]
  );

  const handleNetworkChange = (newChainId: NetworkId) => {
    setChainId(newChainId);
    if (queriedAddress) {
      void handleCheck(queriedAddress, newChainId);
    } else {
      setData(null);
      setError(null);
    }
  };

  const valid = isAddress(inputAddress.trim(), { strict: false });

  return (
    <div className={s.shell}>
      <header className={s.masthead}>
        <div className={s.appNav}>
          <Link className={s.appMark} href="/app">
            BONE<em>&middot;</em>DRY
          </Link>
          <div className={s.netRow}>
            <div className={s.netTabs} role="tablist" aria-label="Network">
              {([84532, 8453] as NetworkId[]).map((id) => (
                <button
                  key={id}
                  role="tab"
                  aria-selected={id === chainId}
                  className={`${s.netTab} ${id === chainId ? s.netTabOn : ""}`}
                  onClick={() => handleNetworkChange(id)}
                >
                  {NETWORKS[id].label}
                  {NETWORKS[id].testnet ? <span className={s.netFree}>free</span> : null}
                </button>
              ))}
            </div>
            <p className={s.netPurpose}>{net.purpose}</p>
          </div>
        </div>
        <hr className={s.mastRule} />
        <div className={`${s.mastMeta} label`}>
          <span>Trust verification</span>
          <span>Aqua maker solvency check</span>
          <Link href="/app" className={s.backLink}>
            &larr; Back to swap desk
          </Link>
        </div>
      </header>

      <section className={s.lookupSection}>
        <div className={s.sectionHead}>
          <h1 className="label">Check any wallet</h1>
          <span className="label">verify promised vs held</span>
        </div>

        <p className={s.lookupLede}>
          Aqua stores claims per strategy and does not enumerate balances. Paste any
          maker address to total what they have promised across all strategies on this
          network and verify if their promises are backed.
        </p>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void handleCheck();
          }}
          className={s.field}
        >
          <div className={s.fieldHead}>
            <label htmlFor="maker-address" className="label">
              Maker wallet address
            </label>
          </div>
          <div className={s.amountRow}>
            <input
              id="maker-address"
              className={s.addressInput}
              value={inputAddress}
              onChange={(e) => setInputAddress(e.target.value)}
              placeholder="0x..."
              spellCheck={false}
              autoComplete="off"
            />
          </div>

          <div className={`${s.actions} ${s.lookupActions}`}>
            <button type="submit" disabled={!valid || busy}>
              {busy ? "Checking..." : "Check"}
            </button>
          </div>
        </form>

        {error && <p className={s.err}>{error}</p>}
      </section>

      {data && (
        <section className={s.lookupResults}>
          <div className={s.sectionHead}>
            <h2 className={s.sectionTitle}>Results &mdash; {data.maker}</h2>
            <span className="label">
              {data.available
                ? `${data.fullyCoveredCount} of ${data.totalPositions} fully covered`
                : "index unavailable"}
            </span>
          </div>

          {!data.available ? (
            <div className={s.coverageEmpty}>
              <p>
                The index for this network isn&apos;t available.{" "}
                {data.reason ? `(${data.reason})` : ""}
              </p>
              {chainId === 84532 && (
                <button onClick={() => handleNetworkChange(8453)}>
                  Check on Base mainnet
                </button>
              )}
            </div>
          ) : data.positions.length === 0 ? (
            <p className={s.empty}>
              This address has no Aqua positions on this network.
            </p>
          ) : (
            <ExposureTable positions={data.positions} />
          )}
        </section>
      )}
    </div>
  );
}
