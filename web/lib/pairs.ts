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

