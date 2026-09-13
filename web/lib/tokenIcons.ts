import { getAddress, type Address } from "viem";
import { LOCAL_TOKEN_ICONS } from "./tokenIconManifest";

/**
 * Trust Wallet's public asset repo, keyed by checksummed address, per chain.
 * No auth, no rate limit issues we have hit in testing. A 404 here is
 * expected and normal for any token without a listing (MOCK, always) --
 * TokenIcon below must render its fallback on that, not a broken image.
 *
 * Ethereum was missing from this map, so every Ethereum token rendered as a
 * letter even though Trust Wallet lists all of them.
 */
const TRUST_WALLET_CHAIN = { 1: "ethereum", 8453: "base", 84532: "base" } as const; // Sepolia has no separate TW listing; same-chain fallback is fine, most Sepolia addresses will 404 anyway and fall back cleanly

const tw = (chain: string, address: string) =>
  `https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/${chain}/assets/${address}/logo.png`;

/**
 * Tokens Trust Wallet does not list on the chain we read them from, each
 * checked to 404 there, pointed at the same asset's listing elsewhere. The key
 * is chainId:lowercased address, so a lookalike contract never borrows a logo.
 */
const OVERRIDES: Record<string, string> = {
  // USDbC is Coinbase's bridged USDC on Base; it carries the USDC mark.
  "8453:0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca": tw("ethereum", "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"),
  // EURC: Circle's euro stablecoin, listed on Ethereum only.
  "8453:0x60a3e35cc302bfa44cb288bc5a4f316fdb1adb42": tw("ethereum", "0x1aBaEA1f7C830bD89Acc67eC4af516284b1bC33c"),
  // cbBTC: listed by neither Trust Wallet chain; CoinGecko's image for this exact contract.
  "8453:0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf": "https://coin-images.coingecko.com/coins/images/40143/small/cbbtc.webp",
  // Circle's testnet USDC is the same asset's mark, not a different token's.
  "84532:0x036cbd53842c5426634e7929541ec2318f3dcf7e": tw("ethereum", "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"),
};

export function iconUrl(chainId: number, address: Address): string | null {
  // Local copy first: raw.githubusercontent.com is blocked on some networks, and a
  // logo that depends on a third-party host is a logo that sometimes is not there.
  const local = LOCAL_TOKEN_ICONS[`${chainId}:${address.toLowerCase()}`];
  if (local) return local;
  const override = OVERRIDES[`${chainId}:${address.toLowerCase()}`];
  if (override) return override;
  const chain = TRUST_WALLET_CHAIN[chainId as keyof typeof TRUST_WALLET_CHAIN];
  if (!chain) return null;
  try {
    return tw(chain, getAddress(address));
  } catch {
    return null;
  }
}
