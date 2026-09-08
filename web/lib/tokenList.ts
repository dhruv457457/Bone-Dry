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
  return chainId === 8453 ? BASE_TOKENS : SEPOLIA_TOKENS;
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
