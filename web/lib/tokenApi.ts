import type { Address } from "viem";
import type { Network } from "./networks";

/**
 * The Graph's Token API (hosted by Pinax).
 *
 * Endpoint: https://api.pinax.network/v1/evm/balances
 * Requires Bearer JWT from The Graph Market / Pinax.
 */
const PINAX_API_URL = "https://api.pinax.network/v1/evm/balances";

// Pinax network slugs per EVM chain ID
const PINAX_NETWORKS: Record<number, string> = {
  8453: "base",
  // Base Sepolia (84532) is not indexed by Pinax Token API (mainnets only)
};

type PinaxBalanceItem = {
  address: string;
  contract: string;
  amount: string;
  value?: number;
  decimals?: number;
  symbol?: string;
};

type PinaxBalancesResponse = {
  data: PinaxBalanceItem[];
};

/**
 * Fetch token balances for a wallet via The Graph's Token API.
 *
 * Returns null if:
 * - TOKEN_API_KEY environment variable is unset or empty
 * - Network is unsupported by Token API (e.g. Base Sepolia)
 * - The remote request times out, throws, or returns non-200
 *
 * A return value of null indicates "source unavailable", signalling the caller
 * to fall back to RPC. An empty map indicates "wallet holds 0 tokens".
 */
export async function tokenBalances(
  n: Network,
  holder: Address
): Promise<Map<string, bigint> | null> {
  const apiKey = process.env.TOKEN_API_KEY?.trim();
  if (!apiKey) return null;

  const networkSlug = PINAX_NETWORKS[n.id];
  if (!networkSlug) return null;

  try {
    const url = `${PINAX_API_URL}?network=${networkSlug}&address=${holder}&limit=1000`;
    const authHeader = apiKey.startsWith("Bearer ") ? apiKey : `Bearer ${apiKey}`;

    const res = await fetch(url, {
      headers: {
        Authorization: authHeader,
        "X-Api-Key": apiKey.replace(/^Bearer\s+/i, ""),
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) return null;

    const json = (await res.json()) as PinaxBalancesResponse;
    if (!Array.isArray(json?.data)) return null;

    const balances = new Map<string, bigint>();
    for (const item of json.data) {
      if (item.contract && item.amount != null) {
        try {
          balances.set(item.contract.toLowerCase(), BigInt(item.amount));
        } catch {
          // ignore parse errors on corrupted amounts
        }
      }
    }

    return balances;
  } catch {
    return null;
  }
}
