import { getAddress, type Address } from "viem";

/**
 * Trust Wallet's public asset repo, keyed by checksummed address, per chain.
 * No auth, no rate limit issues we have hit in testing. A 404 here is
 * expected and normal for any token without a listing (MOCK, always) --
 * TokenIcon below must render its fallback on that, not a broken image.
 */
const TRUST_WALLET_CHAIN = { 8453: "base", 84532: "base" } as const; // Sepolia has no separate TW listing; same-chain fallback is fine, most Sepolia addresses will 404 anyway and fall back cleanly

export function iconUrl(chainId: number, address: Address): string | null {
  const chain = TRUST_WALLET_CHAIN[chainId as keyof typeof TRUST_WALLET_CHAIN];
  if (!chain) return null;
  try {
    const checksummed = getAddress(address);
    return `https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/${chain}/assets/${checksummed}/logo.png`;
  } catch {
    return null;
  }
}
