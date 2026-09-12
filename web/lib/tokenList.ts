import type { Address } from "viem";
import type { NetworkId } from "./networks";
import type { PairToken } from "./pairs";

export type SearchableToken = PairToken & {
  name: string;
  verified: boolean;
  source: "curated" | "token-api" | "rpc";
  holders?: number;
  category?: "curated" | "defi" | "meme" | "imported";
};

export const BASE_TOKENS: SearchableToken[] = [
  {
    address: "0x4200000000000000000000000000000000000006",
    symbol: "WETH",
    name: "Wrapped Ether",
    decimals: 18,
    verified: true,
    source: "curated",
    category: "curated",
  },
  {
    address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    symbol: "USDC",
    name: "USD Coin",
    decimals: 6,
    verified: true,
    source: "curated",
    category: "curated",
  },
  {
    // Base's other stablecoin. USDbC is the Coinbase-bridged coin that shipped
    // with the chain; USDC above is Circle's native issuance. They are separate
    // contracts whose symbols differ by one letter, and a wallet holding one
    // while the app quotes the other reads a correct "0" as a broken app.
    // Listing it is the difference between an honest zero and an unexplained one.
    address: "0xd9aaEc86B65D86f6A7B5B1b0c42FFA531710b6CA",
    symbol: "USDbC",
    name: "USD Base Coin (bridged)",
    decimals: 6,
    verified: true,
    source: "curated",
    category: "curated",
  },
  {
    address: "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22",
    symbol: "cbETH",
    name: "Coinbase Wrapped Staked ETH",
    decimals: 18,
    verified: true,
    source: "curated",
    category: "defi",
  },
  {
    address: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb",
    symbol: "DAI",
    name: "Dai Stablecoin",
    decimals: 18,
    verified: true,
    source: "curated",
    category: "curated",
  },
  {
    // Real depth on Base as of writing: 13 distinct makers, 33 active
    // strategies -- more than every curated token here except USDC and WETH.
    // The most requested missing token turned out to be one of the
    // best-backed ones; it was just never added to this list.
    address: "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2",
    symbol: "USDT",
    name: "Tether USD",
    decimals: 6,
    verified: true,
    source: "curated",
    category: "curated",
  },
  {
    address: "0x820C137fa70C8691f0e44Dc420a5e53c168921Dc",
    symbol: "USDS",
    name: "USDS Stablecoin",
    decimals: 18,
    verified: true,
    source: "curated",
    category: "curated",
  },
  {
    // 7 distinct makers, 15 active strategies -- also genuinely backed,
    // not added on the strength of the ticker alone.
    address: "0x60a3E35Cc302bfA44Cb288Bc5a4F316FdB1adb42",
    symbol: "EURC",
    name: "Euro Coin",
    decimals: 6,
    verified: true,
    source: "curated",
    category: "curated",
  },
  {
    address: "0x940181a94A35A4569E4529A3CDfB74e38FD98631",
    symbol: "AERO",
    name: "Aerodrome Finance",
    decimals: 18,
    verified: true,
    source: "curated",
    category: "defi",
  },
  {
    address: "0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed",
    symbol: "DEGEN",
    name: "Degen",
    decimals: 18,
    verified: true,
    source: "curated",
    category: "meme",
  },
  {
    address: "0x532f27101965dd16442E59d40670FaF5eBB142E4",
    symbol: "BRETT",
    name: "Brett",
    decimals: 18,
    verified: true,
    source: "curated",
    category: "meme",
  },
  {
    address: "0xAC1Bd2486aAf3B5C0fc3Fd868558b082a531B2B4",
    symbol: "TOSHI",
    name: "Toshi",
    decimals: 18,
    verified: true,
    source: "curated",
    category: "meme",
  },
  {
    address: "0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b",
    symbol: "VIRTUAL",
    name: "Virtual Protocol",
    decimals: 18,
    verified: true,
    source: "curated",
    category: "defi",
  },
  {
    address: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf",
    symbol: "cbBTC",
    name: "Coinbase Wrapped BTC",
    decimals: 8,
    verified: true,
    source: "curated",
    category: "curated",
  },
];

export const ETHEREUM_TOKENS: SearchableToken[] = [
  {
    address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    symbol: "WETH",
    name: "Wrapped Ether",
    decimals: 18,
    verified: true,
    source: "curated",
    category: "curated",
  },
  {
    address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    symbol: "USDC",
    name: "USD Coin",
    decimals: 6,
    verified: true,
    source: "curated",
    category: "curated",
  },
  {
    address: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
    symbol: "USDT",
    name: "Tether USD",
    decimals: 6,
    verified: true,
    source: "curated",
    category: "curated",
  },
  {
    address: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
    symbol: "DAI",
    name: "Dai Stablecoin",
    decimals: 18,
    verified: true,
    source: "curated",
    category: "curated",
  },
  {
    address: "0xdC035D45d973E3EC169d2276DDab16f1e407384F",
    symbol: "USDS",
    name: "USDS Stablecoin",
    decimals: 18,
    verified: true,
    source: "curated",
    category: "curated",
  },
];

export const SEPOLIA_TOKENS: SearchableToken[] = [
  {
    address: "0x4200000000000000000000000000000000000006",
    symbol: "WETH",
    name: "Wrapped Ether",
    decimals: 18,
    verified: true,
    source: "curated",
    category: "curated",
  },
  {
    address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    symbol: "USDC",
    name: "Circle Testnet USDC",
    decimals: 6,
    verified: true,
    source: "curated",
    category: "curated",
  },
  {
    address: "0xB3809889554aF826268F48a2B0E5F681c3500403",
    symbol: "MOCK",
    name: "Mock ERC20",
    decimals: 8,
    verified: true,
    source: "curated",
    category: "curated",
  },
];

export function tokensForChain(chainId: NetworkId): SearchableToken[] {
  if (chainId === 8453) return BASE_TOKENS;
  if (chainId === 1) return ETHEREUM_TOKENS;
  return SEPOLIA_TOKENS;
}

export function searchKnownTokens(
  chainId: NetworkId,
  query: string
): SearchableToken[] {
  const q = query.trim().toLowerCase();
  const pool = tokensForChain(chainId);
  if (!q) return pool;

  return pool.filter(
    (t) =>
      t.symbol.toLowerCase().includes(q) ||
      t.name.toLowerCase().includes(q) ||
      t.address.toLowerCase() === q
  );
}
