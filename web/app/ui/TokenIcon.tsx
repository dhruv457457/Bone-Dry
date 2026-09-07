"use client";

import { useState } from "react";
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

  if (!url || failed) {
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
          background: "var(--ink)",
          color: "var(--paper)",
          fontSize: size * 0.42,
          fontFamily: "var(--mono)",
          flexShrink: 0,
        }}
      >
        {symbol.slice(0, 1).toUpperCase()}
      </span>
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element -- external CDN, not a local asset
    <img
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
