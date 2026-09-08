"use client";

import { useEffect, useState, useRef, useMemo } from "react";
import type { Address } from "viem";
import type { NetworkId } from "@/lib/networks";
import type { PairConfig, PairToken } from "@/lib/pairs";
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
  onSelectToken: (token: SearchableToken) => void;
  onSelectPair?: (pair: PairConfig) => void;
  availablePairs?: PairConfig[];
  currentPairId?: string;
  target?: "tokenIn" | "tokenOut" | "pair";
};

type Category = "all" | "curated" | "defi" | "meme";

export function TokenSearchModal({
  isOpen,
  onClose,
  chainId,
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

  const filteredTokens = useMemo(() => {
    let list = knownTokens;
    if (category !== "all") {
      list = list.filter((t) => t.category === category);
    }
    const q = query.trim().toLowerCase();
    if (!q) return list;
    return list.filter(
      (t) =>
        t.symbol.toLowerCase().includes(q) ||
        t.name.toLowerCase().includes(q) ||
        t.address.toLowerCase() === q
    );
  }, [knownTokens, category, query]);

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

        {/* Quick pair pills when viewing pair picker and query is empty */}
        {target === "pair" && !query && availablePairs.length > 0 && (
          <div className={s.quickPairsSec}>
            <div className={`label ${s.secLabel}`}>Popular pairs</div>
            <div className={s.quickPairsGrid}>
              {availablePairs.map((p) => {
                const isActive = p.id === currentPairId;
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
                filteredTokens.map((t) => (
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
                      </div>
                    </div>
                  </div>
                ))
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
