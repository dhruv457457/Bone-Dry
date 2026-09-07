"use client";

import { useState, useCallback, useEffect, useMemo } from "react";
import Link from "next/link";
import s from "@/app/ui/desk.module.css";
import { ExposureTable, type ExposureResponse } from "@/app/ui/Exposure";
import { NETWORKS, DEFAULT_NETWORK, type NetworkId } from "@/lib/networks";
import { isAddress, getAddress } from "viem";
import { searchSubgraphsForTokens, type TokenDiscoveryResult } from "@/lib/subgraphMcp";

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
  const [mcpResults, setMcpResults] = useState<Record<string, TokenDiscoveryResult>>({});
  const [mcpLoading, setMcpLoading] = useState(false);

  // Unrecognised tokens are those displaying as a truncated hex symbol (e.g. 0x3681…)
  const unrecognisedTokens = useMemo(() => {
    if (!data?.available || !data.positions) return [];
    const seen = new Set<string>();
    for (const p of data.positions) {
      const isUnrecognised =
        p.symbol === `${p.token.slice(0, 6)}…` ||
        (p.symbol.startsWith("0x") && (p.symbol.includes("…") || p.symbol.length <= 8));
      if (isUnrecognised) {
        seen.add(p.token.toLowerCase());
      }
    }
    return Array.from(seen);
  }, [data]);

function formatFees(raw: string): string {
  try {
    const val = BigInt(raw);
    if (val === 0n) return "0 query fees";
    const oneGrt = 10n ** 18n;
    if (val >= oneGrt) {
      const whole = val / oneGrt;
      const rem = val % oneGrt;
      const dec = (Number(rem) / 1e18).toFixed(2).slice(2);
      return `${whole}.${dec} GRT query fees`;
    }
    const floatVal = Number(val) / 1e18;
    return `${floatVal.toFixed(4)} GRT query fees`;
  } catch {
    return `${raw} fees`;
  }
}

  useEffect(() => {
    if (unrecognisedTokens.length === 0) {
      setMcpResults({});
      setMcpLoading(false);
      return;
    }

    let active = true;
    setMcpLoading(true);

    searchSubgraphsForTokens(unrecognisedTokens, chainId)
      .then((results) => {
        if (!active) return;
        setMcpResults(results);
      })
      .catch((err) => {
        if (!active) return;
        console.error("Subgraph MCP query error:", err);
      })
      .finally(() => {
        if (active) setMcpLoading(false);
      });

    return () => {
      active = false;
    };
  }, [unrecognisedTokens, chainId]);

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
      setMcpResults({});
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
            <>
              <ExposureTable positions={data.positions} chainId={chainId} sources={data.sources} />

              {unrecognisedTokens.length > 0 && (
                <div className={s.mcpDiscoverySection}>
                  <div className={s.sectionHead}>
                    <h3 className="label">Cross-protocol discovery</h3>
                    <span className="label">Subgraph MCP</span>
                  </div>

                  <div className={s.mcpTokenList}>
                    {unrecognisedTokens.map((tokenAddr) => {
                      const res = mcpResults[tokenAddr];
                      const isLoading = mcpLoading && !res;
                      const deployments = res?.deployments ?? [];

                      return (
                        <div key={tokenAddr} className={s.mcpTokenCard}>
                          <div className={s.mcpTokenHead}>
                            <span className="label">Token address:</span>
                            <span className={`num ${s.mcpTokenAddr}`}>{tokenAddr}</span>
                          </div>

                          <p className={s.mcpPrompt}>Other subgraphs mentioning this address:</p>

                          {isLoading ? (
                            <p className={s.mcpEmpty}>Querying Subgraph MCP...</p>
                          ) : deployments.length === 0 ? (
                            <p className={s.mcpEmpty}>No other subgraphs found for this address</p>
                          ) : (
                            <ul className={s.mcpList}>
                              {deployments.map((d) => (
                                <li key={d.ipfsHash} className={s.mcpListItem}>
                                  <div className={s.mcpDeployMeta}>
                                    <span className={`num ${s.mcpDeployHash}`}>{d.ipfsHash}</span>
                                    {d.network ? (
                                      <span className={`label ${s.mcpNetworkTag}`}>{d.network}</span>
                                    ) : null}
                                  </div>
                                  <span className={`num ${s.mcpFees}`}>
                                    {formatFees(d.queryFeesAmount)}
                                  </span>
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </>
          )}
        </section>
      )}
    </div>
  );
}
