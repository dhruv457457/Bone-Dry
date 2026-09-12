"use client";

import { useEffect, useRef, useState } from "react";
import { iconUrl } from "@/lib/tokenIcons";
import type { Address } from "viem";

/**
 * A token's logo, or a plain letter-in-circle if it doesn't have one (every
 * Sepolia demo token, MOCK included, and any real token the CDN 404s on).
 * The fallback is not a placeholder to feel bad about -- a real dashboard
 * showing a generated circle for an unlisted token is normal and honest;
 * showing the wrong logo, or no visual at all, are the two actually wrong
 * options here.
 */
export function TokenIcon({
  chainId,
  address,
  symbol,
  size = 20,
}: {
  chainId: number;
  address: Address;
  symbol: string;
  size?: number;
}) {
  const [failed, setFailed] = useState(false);
  const url = iconUrl(chainId, address);
  const imgRef = useRef<HTMLImageElement>(null);

  useEffect(() => {
    setFailed(false);
  }, [url]);

  // A repeat 404 (any Sepolia token, most of the time -- Trust Wallet only
  // lists mainnet addresses) is served from the browser's HTTP cache, which
  // can resolve as failed before React finishes hydrating and wires up
  // onError below. The browser never refires `error` for an element whose
  // load already settled, so that race silently strands a broken <img>
  // with no fallback. Checking the element directly on mount catches
  // exactly that case, without replacing onError -- onError still covers a
  // slow failure that settles after this effect has already run once.
  useEffect(() => {
    if (imgRef.current?.complete && imgRef.current.naturalWidth === 0) {
      setFailed(true);
    }
  }, [url]);

  if (!url || failed) {
    const letter = (symbol || "?").slice(0, 1).toUpperCase();
    return (
      <span
        aria-hidden
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: size,
          height: size,
          borderRadius: "50%",
          background: "var(--ink, #1b1b1a)",
          color: "var(--paper, #fbfaf6)",
          fontSize: Math.max(9, size * 0.45),
          fontWeight: 600,
          fontFamily: "var(--mono)",
          flexShrink: 0,
          boxShadow: "inset 0 0 0 1px rgba(255, 255, 255, 0.15)",
        }}
      >
        {letter}
      </span>
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element -- external CDN, not a local asset
    <img
      ref={imgRef}
      src={url}
      alt=""
      aria-hidden
      width={size}
      height={size}
      style={{ borderRadius: "50%", flexShrink: 0 }}
      onError={() => setFailed(true)}
    />
  );
}
