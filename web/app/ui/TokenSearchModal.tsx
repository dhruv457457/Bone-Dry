"use client";

import { useEffect, useState, useRef, useMemo } from "react";
import type { Address } from "viem";
import type { Network, NetworkId } from "@/lib/networks";
import { createPairConfig, type PairConfig, type PairToken } from "@/lib/pairs";
import {
  tokensForChain,
  type SearchableToken,
} from "@/lib/tokenList";
import { TokenIcon } from "./TokenIcon";
import { short } from "@/lib/format";
import s from "./desk.module.css";

type TokenSearchModalProps = {
  isOpen: boolean;
  onClose: () => void;
  chainId: NetworkId;
  net: Network;
  onSelectToken: (token: SearchableToken) => void;
  onSelectPair?: (pair: PairConfig) => void;
  availablePairs?: PairConfig[];
  currentPairId?: string;
  target?: "tokenIn" | "tokenOut" | "pair";
};

type Category = "all" | "curated" | "defi" | "meme";

type LiquidPair = { tokenA: Address; tokenB: Address; distinctMakers: number; activeStrategies: number };
type LiquidToken = { token: Address; distinctMakers: number; activeStrategies: number };

export function TokenSearchModal({
  isOpen,
  onClose,
  chainId,
  net,
  onSelectToken,
  onSelectPair,
  availablePairs = [],
  currentPairId,
  target = "pair",
}: TokenSearchModalProps) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<Category>("all");
  const [lookupLoading, setLookupLoading] = useState(false);
  const [lookupToken, setLookupToken] = useState<SearchableToken | null>(null);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [liquidPairs, setLiquidPairs] = useState<LiquidPair[] | null>(null);
  const [liquidTokens, setLiquidTokens] = useState<LiquidToken[] | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus search input when modal opens
  useEffect(() => {
    if (isOpen) {
      setQuery("");
      setLookupToken(null);
      setLookupError(null);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [isOpen]);

  // Which pairs and tokens actually have a maker behind them, right now --
  // not the static 3-pair list, which was hand-picked once and never
  // checked against real depth. Fetched once per open; this data changes on
  // the order of minutes, not keystrokes, so it isn't refetched per query.
  useEffect(() => {
    if (!isOpen) return;
    let active = true;
    fetch(`/api/liquid-pairs?chain=${chainId}`)
      .then((r) => r.json())
      .then((json: { available: boolean; pairs?: LiquidPair[]; tokens?: LiquidToken[] }) => {
        if (!active) return;
        setLiquidPairs(json.available ? json.pairs ?? [] : []);
        setLiquidTokens(json.available ? json.tokens ?? [] : []);
      })
      .catch(() => {
        if (active) {
          setLiquidPairs([]);
          setLiquidTokens([]);
        }
      });
    return () => {
      active = false;
    };
  }, [isOpen, chainId]);

  const liquidityByToken = useMemo(() => {
    const m = new Map<string, LiquidToken>();
    for (const t of liquidTokens ?? []) m.set(t.token.toLowerCase(), t);
    return m;
  }, [liquidTokens]);

  // Handle Escape key to close
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose]);

  // Check if query is an Ethereum address
  const isAddressQuery = useMemo(() => {
    const trimmed = query.trim();
    return trimmed.startsWith("0x") && trimmed.length === 42;
  }, [query]);

  // Remote lookup for arbitrary contract addresses via /api/tokens
  useEffect(() => {
    if (!isAddressQuery) {
      setLookupToken(null);
      setLookupError(null);
      setLookupLoading(false);
      return;
    }

    let active = true;
    setLookupLoading(true);
    setLookupError(null);

    fetch(`/api/tokens?chain=${chainId}&address=${query.trim()}`)
      .then((res) => {
        if (!res.ok) throw new Error("Contract lookup failed");
        return res.json();
      })
      .then((json) => {
        if (!active) return;
        if (json.found && json.token) {
          setLookupToken(json.token);
        } else {
          setLookupError("No valid ERC-20 contract found at this address");
        }
      })
      .catch((err) => {
        if (!active) return;
        setLookupError((err as Error).message);
      })
      .finally(() => {
        if (active) setLookupLoading(false);
      });

    return () => {
      active = false;
    };
  }, [isAddressQuery, query, chainId]);

  // Filter local known tokens
  const knownTokens = useMemo(() => tokensForChain(chainId), [chainId]);

  const knownByAddress = useMemo(() => {
    const m = new Map<string, SearchableToken>();
    for (const t of knownTokens) m.set(t.address.toLowerCase(), t);
    return m;
  }, [knownTokens]);

  // Real pairs, ranked by real depth -- replaces the old static "popular
  // pairs" list, which was three hand-picked pairs never checked against
  // actual maker coverage (one of them, cbETH/WETH, turned out to have just
  // 2 makers). Only pairs where both sides resolve to a symbol this app
  // recognises are shown here; an unresolved pair would need two more
  // lookups just to render a label, and the search box already covers
  // "find any token by address" for that case.
  const realPairs = useMemo(() => {
    if (!liquidPairs) return [];
    const built: PairConfig[] = [];
    for (const p of liquidPairs) {
      const a = knownByAddress.get(p.tokenA.toLowerCase());
      const b = knownByAddress.get(p.tokenB.toLowerCase());
      if (!a || !b) continue;
      built.push(createPairConfig(a, b, net));
      if (built.length >= 6) break;
    }
    return built;
  }, [liquidPairs, knownByAddress, net]);

  const filteredTokens = useMemo(() => {
    let list = knownTokens;
    if (category !== "all") {
      list = list.filter((t) => t.category === category);
    }
    const q = query.trim().toLowerCase();
    if (q) {
      list = list.filter(
        (t) =>
          t.symbol.toLowerCase().includes(q) ||
          t.name.toLowerCase().includes(q) ||
          t.address.toLowerCase() === q
      );
    }
    // Real makers behind a token, not just curation, decides ordering here --
    // a "curated" token nobody backs is exactly the trap this list used to
    // set (see cbETH: on the masthead's quick pairs, backed by 2 makers).
    // Only reorders once liquidity data has actually loaded; before that,
    // the list keeps its original order rather than flash-reordering.
    if (!liquidityByToken.size) return list;
    return [...list].sort((a, b) => {
      const la = liquidityByToken.get(a.address.toLowerCase())?.distinctMakers ?? 0;
      const lb = liquidityByToken.get(b.address.toLowerCase())?.distinctMakers ?? 0;
      return lb - la;
    });
  }, [knownTokens, category, query, liquidityByToken]);

  if (!isOpen) return null;

  const title =
    target === "tokenIn"
      ? "Select pay token"
      : target === "tokenOut"
      ? "Select receive token"
      : "Select token or pair";

  return (
    <div className={s.modalBackdrop} onClick={onClose}>
      <div
        className={s.modalCard}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className={s.modalHead}>
          <div className={s.modalTitleWrap}>
            <h3 className={s.modalTitle}>{title}</h3>
            <span className="label">Chain {chainId}</span>
          </div>
          <button
            type="button"
            className={s.modalCloseBtn}
            onClick={onClose}
            aria-label="Close"
          >
            &times;
          </button>
        </div>

        <div className={s.searchBarWrap}>
          <input
            ref={inputRef}
            className={s.searchInput}
            type="text"
            placeholder="Search name, symbol, or paste 0x address…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {query && (
            <button
              type="button"
              className={s.searchClearBtn}
              onClick={() => setQuery("")}
            >
              &times;
            </button>
          )}
        </div>

        {/* Quick pair pills when viewing pair picker and query is empty.
            Prefer real, ranked pairs from liquid-pairs; fall back to the
            static list only while that data is loading or unavailable
            (e.g. a network with no subgraph configured), so this section
            never goes blank. */}
        {target === "pair" && !query && (realPairs.length > 0 || availablePairs.length > 0) && (
          <div className={s.quickPairsSec}>
            <div className={`label ${s.secLabel}`}>
              {realPairs.length > 0 ? "Backed by real makers, ranked" : "Popular pairs"}
            </div>
            <div className={s.quickPairsGrid}>
              {(realPairs.length > 0 ? realPairs : availablePairs).map((p) => {
                const isActive = p.id === currentPairId;
                const real = liquidPairs?.find(
                  (lp) =>
                    (lp.tokenA.toLowerCase() === p.token0.address.toLowerCase() &&
                      lp.tokenB.toLowerCase() === p.token1.address.toLowerCase()) ||
                    (lp.tokenA.toLowerCase() === p.token1.address.toLowerCase() &&
                      lp.tokenB.toLowerCase() === p.token0.address.toLowerCase())
                );
                return (
                  <button
                    key={p.id}
                    type="button"
                    className={`${s.quickPairBtn} ${isActive ? s.quickPairActive : ""}`}
                    onClick={() => {
                      if (onSelectPair) onSelectPair(p);
                      onClose();
                    }}
                  >
                    <div className={s.quickPairIcons}>
                      <TokenIcon
                        chainId={chainId}
                        address={p.token0.address as Address}
                        symbol={p.token0.symbol}
                        size={16}
                      />
                      <TokenIcon
                        chainId={chainId}
                        address={p.token1.address as Address}
                        symbol={p.token1.symbol}
                        size={16}
                      />
                    </div>
                    <span>{p.label}</span>
                    {real && (
                      <span className={`label ${s.dim}`}>
                        {real.distinctMakers} maker{real.distinctMakers === 1 ? "" : "s"}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Filter categories */}
        {!isAddressQuery && (
          <div className={s.categoryTabs}>
            {(["all", "curated", "defi", "meme"] as Category[]).map((cat) => (
              <button
                key={cat}
                type="button"
                className={`${s.categoryTab} ${category === cat ? s.categoryTabActive : ""}`}
                onClick={() => setCategory(cat)}
              >
                {cat}
              </button>
            ))}
          </div>
        )}

        {/* Token List or Dynamic Lookup Result */}
        <div className={s.tokenListContainer}>
          {isAddressQuery ? (
            <div className={s.addressLookupResult}>
              <div className={`label ${s.secLabel}`}>Contract Address Lookup</div>
              {lookupLoading && (
                <div className={s.lookupStatus}>
                  <span className={s.spin}>reading contract & metadata…</span>
                </div>
              )}
              {lookupError && (
                <div className={s.lookupErrorBox}>
                  <span>{lookupError}</span>
                </div>
              )}
              {lookupToken && (
                <div
                  className={s.tokenRow}
                  onClick={() => {
                    onSelectToken(lookupToken);
                    onClose();
                  }}
                  role="button"
                  tabIndex={0}
                >
                  <TokenIcon
                    chainId={chainId}
                    address={lookupToken.address as Address}
                    symbol={lookupToken.symbol}
                    size={28}
                  />
                  <div className={s.tokenInfo}>
                    <div className={s.tokenMainLine}>
                      <span className={s.tokenSymbol}>{lookupToken.symbol}</span>
                      <span className={s.tokenName}>{lookupToken.name}</span>
                    </div>
                    <div className={s.tokenSubLine}>
                      <span className="hex">{short(lookupToken.address)}</span>
                      <span className={`label ${s.trustBadgeWarning}`}>
                        Unverified &middot; {lookupToken.source === "token-api" ? "The Graph Token API" : "RPC on-chain"}
                      </span>
                    </div>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className={s.tokenList}>
              {filteredTokens.length === 0 ? (
                <div className={s.emptyTokensMsg}>
                  <p>No tokens matched &ldquo;{query}&rdquo;</p>
                  <p className="label">Paste a full contract address (0x…) to look up any token on-chain.</p>
                </div>
              ) : (
                filteredTokens.map((t) => {
                  const liquidity = liquidityByToken.get(t.address.toLowerCase());
                  return (
                    <div
                      key={t.address}
                      className={s.tokenRow}
                      onClick={() => {
                        onSelectToken(t);
                        onClose();
                      }}
                      role="button"
                      tabIndex={0}
                    >
                      <TokenIcon
                        chainId={chainId}
                        address={t.address as Address}
                        symbol={t.symbol}
                        size={28}
                      />
                      <div className={s.tokenInfo}>
                        <div className={s.tokenMainLine}>
                          <span className={s.tokenSymbol}>{t.symbol}</span>
                          <span className={s.tokenName}>{t.name}</span>
                        </div>
                        <div className={s.tokenSubLine}>
                          <span className="hex">{short(t.address)}</span>
                          {t.verified ? (
                            <span className={`label ${s.trustBadgeVerified}`}>Curated</span>
                          ) : (
                            <span className={`label ${s.trustBadgeWarning}`}>Unverified</span>
                          )}
                          {liquidTokens !== null && (
                            <span
                              className={`label ${liquidity ? s.trustBadgeVerified : s.dim}`}
                              title={
                                liquidity
                                  ? `${liquidity.distinctMakers} maker${liquidity.distinctMakers === 1 ? "" : "s"} currently shipping a strategy for this token`
                                  : "No maker currently has a live strategy for this token -- a swap will likely find nothing to fill from"
                              }
                            >
                              {liquidity
                                ? `${liquidity.distinctMakers} maker${liquidity.distinctMakers === 1 ? "" : "s"}`
                                : "No live makers"}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          )}
        </div>

        <div className={s.modalFoot}>
          <p className="label">
            Tokens discovered via open search are unvetted ERC-20 contracts read directly from chain or The Graph Token API.
          </p>
        </div>
      </div>
    </div>
  );
}
