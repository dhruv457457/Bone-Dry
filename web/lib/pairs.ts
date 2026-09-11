import type { Address } from "viem";
import { NETWORKS, type Network, type NetworkId } from "./networks";

export type PairToken = {
  address: Address;
  symbol: string;
  decimals: number;
};

export type PairConfig = {
  id: string;
  label: string;
  token0: PairToken;
  token1: PairToken;
  fee: number;
  tickSpacing: number;
  hook?: Address | "";
  poolId?: string;
};

/**
 * Supported pairs per network.
 * Each pool is uniquely identified by (currency0, currency1, fee, tickSpacing, hooks).
 */
export const PAIRS: Record<NetworkId, PairConfig[]> = {
  1: [
    {
      id: "usdc-weth",
      label: "USDC / WETH",
      token0: { address: NETWORKS[1].usdc, symbol: "USDC", decimals: 6 },
      token1: { address: NETWORKS[1].weth, symbol: "WETH", decimals: 18 },
      // No hook here (see networks.ts) -- kept so the pool-key math that
      // every pair already runs through does not need an Ethereum special
      // case. A pool key with an empty hooks address is exactly what Base
      // showed before its own hook was deployed, handled the same way.
      fee: 0,
      tickSpacing: 60,
      hook: NETWORKS[1].hook,
    },
  ],
  8453: [
    {
      id: "usdc-weth",
      label: "USDC / WETH",
      token0: {
        address: NETWORKS[8453].usdc,
        symbol: "USDC",
        decimals: 6,
      },
      token1: {
        address: NETWORKS[8453].weth,
        symbol: "WETH",
        decimals: 18,
      },
      fee: 0,
      tickSpacing: 60,
      hook: NETWORKS[8453].hook,
    },
    {
      id: "cbeth-weth",
      label: "cbETH / WETH",
      token0: {
        address: "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22",
        symbol: "cbETH",
        decimals: 18,
      },
      token1: {
        address: NETWORKS[8453].weth,
        symbol: "WETH",
        decimals: 18,
      },
      fee: 0,
      tickSpacing: 60,
      hook: NETWORKS[8453].hook,
    },
    {
      id: "aero-weth",
      label: "AERO / WETH",
      token0: {
        address: "0x940181a94A35A4569E4529A3CDfB74e38FD98631",
        symbol: "AERO",
        decimals: 18,
      },
      token1: {
        address: NETWORKS[8453].weth,
        symbol: "WETH",
        decimals: 18,
      },
      fee: 0,
      tickSpacing: 60,
      hook: NETWORKS[8453].hook,
    },
    {
      id: "degen-weth",
      label: "DEGEN / WETH",
      token0: {
        address: "0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed",
        symbol: "DEGEN",
        decimals: 18,
      },
      token1: {
        address: NETWORKS[8453].weth,
        symbol: "WETH",
        decimals: 18,
      },
      fee: 0,
      tickSpacing: 60,
      hook: NETWORKS[8453].hook,
    },
    {
      id: "brett-weth",
      label: "BRETT / WETH",
      token0: {
        address: "0x532f27101965dd16442E59d40670FaF5eBB142E4",
        symbol: "BRETT",
        decimals: 18,
      },
      token1: {
        address: NETWORKS[8453].weth,
        symbol: "WETH",
        decimals: 18,
      },
      fee: 0,
      tickSpacing: 60,
      hook: NETWORKS[8453].hook,
    },
    {
      id: "virtual-weth",
      label: "VIRTUAL / WETH",
      token0: {
        address: "0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b",
        symbol: "VIRTUAL",
        decimals: 18,
      },
      token1: {
        address: NETWORKS[8453].weth,
        symbol: "WETH",
        decimals: 18,
      },
      fee: 0,
      tickSpacing: 60,
      hook: NETWORKS[8453].hook,
    },
  ],
  84532: [
    {
      id: "usdc-weth",
      label: "USDC / WETH",
      token0: {
        address: NETWORKS[84532].usdc,
        symbol: "USDC",
        decimals: 6,
      },
      token1: {
        address: NETWORKS[84532].weth,
        symbol: "WETH",
        decimals: 18,
      },
      fee: 0,
      tickSpacing: 60,
      hook: NETWORKS[84532].hook,
      poolId: "0xc7801a6812962faaf660df0532e3006cd171fcf69ecd21538aabf4bb9f5271bc",
    },
    {
      id: "weth-mock",
      label: "WETH / MOCK",
      token0: {
        address: "0x4200000000000000000000000000000000000006",
        symbol: "WETH",
        decimals: 18,
      },
      token1: {
        address: "0xB3809889554aF826268F48a2B0E5F681c3500403",
        symbol: "MOCK",
        decimals: 8,
      },
      fee: 0,
      tickSpacing: 60,
      hook: "0xD5Bca5F5Df642E7cfDbA692FE8C3851c89238088",
      poolId: "0x9c1e01a4303132e6e6f19fcc80dd10351612d54f3c3128c7c4751b25ba6981c6",
    },
  ],
};

export function pairsFor(chainId: NetworkId): PairConfig[] {
  return PAIRS[chainId] ?? [];
}

export function defaultPairFor(chainId: NetworkId): PairConfig {
  return pairsFor(chainId)[0];
}

/**
 * Returns canonical sorted PoolKey for any pair on a given network.
 * Currency order is determined by address value (currency0 < currency1).
 */
export function poolKeyFor(pair: PairConfig, net: Network) {
  const t0 = pair.token0.address.toLowerCase();
  const t1 = pair.token1.address.toLowerCase();
  const [currency0, currency1] =
    t0 < t1 ? [pair.token0.address, pair.token1.address] : [pair.token1.address, pair.token0.address];
  const hooks = (pair.hook || net.hook || "") as Address;
  return {
    currency0,
    currency1,
    fee: pair.fee,
    tickSpacing: pair.tickSpacing,
    hooks,
  } as const;
}

/**
 * Returns true if selling tokenIn corresponds to zeroForOne in the v4 pool.
 * In v4, zeroForOne means selling currency0 for currency1.
 */
export function isZeroForOne(tokenInAddress: Address, pair: PairConfig): boolean {
  const t0 = pair.token0.address.toLowerCase();
  const t1 = pair.token1.address.toLowerCase();
  const currency0 = t0 < t1 ? t0 : t1;
  return tokenInAddress.toLowerCase() === currency0;
}

export function allTokensFor(chainId: NetworkId): Record<string, PairToken> {
  const map: Record<string, PairToken> = {};
  for (const pair of pairsFor(chainId)) {
    map[pair.token0.address.toLowerCase()] = pair.token0;
    map[pair.token1.address.toLowerCase()] = pair.token1;
  }
  return map;
}

/**
 * Dynamically construct a valid PairConfig for any arbitrary pair of tokens.
 */
export function createPairConfig(
  token0: PairToken,
  token1: PairToken,
  net: Network
): PairConfig {
  const id = `${token0.symbol.toLowerCase()}-${token1.symbol.toLowerCase()}`;
  const label = `${token0.symbol} / ${token1.symbol}`;
  return {
    id,
    label,
    token0,
    token1,
    fee: 0,
    tickSpacing: 60,
    hook: net.hook,
  };
}


