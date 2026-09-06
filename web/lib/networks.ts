import { createPublicClient, http, type Address, type PublicClient } from "viem";
import { base, baseSepolia } from "viem/chains";

/**
 * Bone Dry runs on two networks that do different jobs, and the app should not
 * pretend they are the same thing.
 *
 * **Base mainnet** is the evidence. 1inch's real Aqua, real makers, and the gap
 * between what they have promised and what they hold. Read-only — nobody spends
 * anything to look at it — and impossible to reproduce on a testnet, because it
 * is other people's behaviour.
 *
 * **Base Sepolia** is the playground. Aqua has never been deployed to a testnet,
 * so this is our own deployment of it, and our own pool. Free tokens, free gas,
 * and anyone can actually swap.
 */
export type NetworkId = 8453 | 84532;

export type Network = {
  id: NetworkId;
  key: "base" | "base-sepolia";
  label: string;
  /** One line explaining what this network is for, shown in the switcher. */
  purpose: string;
  testnet: boolean;
  explorer: string;
  rpc: string;
  aqua: Address;
  router: Address;
  poolManager: Address;
  usdc: Address;
  weth: Address;
  hook: Address | "";
  lens: Address | "";
  wellhead: Address | "";
  graphUrl: string;
  /** The block Aqua was deployed on THIS chain. Nothing was shipped before it,
   *  and a mainnet block number is above a testnet's head, so a shared constant
   *  silently scans an empty range and reports no makers at all. */
  aquaGenesis: bigint;
  /** Where the strategies came from, so the UI can be honest about provenance. */
  aquaIsOurs: boolean;
};

const WETH_PREDEPLOY: Address = "0x4200000000000000000000000000000000000006";

export const NETWORKS: Record<NetworkId, Network> = {
  8453: {
    id: 8453,
    key: "base",
    label: "Base",
    purpose: "Real Aqua makers. Read-only — this is the evidence, not a sandbox.",
    testnet: false,
    explorer: "https://basescan.org",
    rpc: process.env.RPC_URL ?? "https://mainnet.base.org",
    aqua: "0x1111113ccf1426a8e30e2bff5e005d929bf6a90a",
    router: "0x111111338c5091E8440b67B168bAe16a668AC0De",
    poolManager: "0x498581fF718922c3f8e6A244956aF099B2652b2b",
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    weth: WETH_PREDEPLOY,
    hook: (process.env.HOOK_ADDRESS ?? "") as Address | "",
    lens: (process.env.LENS_ADDRESS ?? "") as Address | "",
    wellhead: (process.env.NEXT_PUBLIC_WELLHEAD_ADDRESS ?? "") as Address | "",
    graphUrl: process.env.GRAPH_URL ?? "",
    aquaGenesis: 48_839_900n,
    aquaIsOurs: false,
  },
  84532: {
    id: 84532,
    key: "base-sepolia",
    label: "Base Sepolia",
    purpose: "Our own Aqua and pool. Free tokens — swap and make markets for nothing.",
    testnet: true,
    explorer: "https://sepolia.basescan.org",
    rpc: process.env.SEPOLIA_RPC_URL ?? "https://sepolia.base.org",
    // 1inch have never deployed Aqua to a testnet. These are ours, built
    // unmodified from their sources; the router is tag v1.0.2, because main
    // renumbered the opcodes and will not run the SDK's own programs.
    aqua: "0x7a062f824FAbdf2360354Ad52B3752065150Da61",
    router: "0xD0a0A94711aa39EfcC3Ab2aF63ffa5BAD4E640a7",
    poolManager: "0x05E73354cFDd6745C338b50BcFDfA3Aa6fA03408",
    usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    weth: WETH_PREDEPLOY,
    hook: "0xD5Bca5F5Df642E7cfDbA692FE8C3851c89238088",
    lens: "0xA3ce77230A06302e3De32A3816f46C293c9D291F",
    wellhead: "0x0A54ac0705Aeab8AB29F48899d2B347D7235a531",
    graphUrl: process.env.SEPOLIA_GRAPH_URL ?? "",
    aquaGenesis: 46_459_400n,
    aquaIsOurs: true,
  },
};

export const DEFAULT_NETWORK: NetworkId = 84532;

export function isNetworkId(v: unknown): v is NetworkId {
  return v === 8453 || v === 84532;
}

/** Parse a `?chain=` parameter. Unknown values are a 400, not a silent default:
 *  quoting the wrong chain is worse than refusing to quote. */
export function networkFrom(value: string | null): Network {
  if (value === null || value === "") return NETWORKS[DEFAULT_NETWORK];
  const id = Number(value);
  if (!isNetworkId(id)) throw new Error(`unknown chain: ${value}`);
  return NETWORKS[id];
}

const clients = new Map<NetworkId, PublicClient>();

export function clientFor(n: Network): PublicClient {
  const cached = clients.get(n.id);
  if (cached) return cached;
  const made = createPublicClient({
    chain: n.id === 8453 ? base : baseSepolia,
    transport: http(n.rpc),
  }) as PublicClient;
  clients.set(n.id, made);
  return made;
}

/**
 * The pool key, sorted.
 *
 * A PoolKey is a hash preimage, so the currency order is not cosmetic — and it
 * INVERTS between these two chains. WETH `0x4200..` sorts below mainnet USDC
 * `0x8335..`, but above Circle's Sepolia USDC `0x036C..`. Hardcoding the order
 * gets a pool key rejected on one chain, and — quieter and worse — inverts
 * `zeroForOne`, so a fixed direction sells the wrong token.
 */
export function poolKey(n: Network) {
  const [currency0, currency1] =
    n.weth.toLowerCase() < n.usdc.toLowerCase() ? [n.weth, n.usdc] : [n.usdc, n.weth];
  return { currency0, currency1, fee: 0, tickSpacing: 60, hooks: n.hook as Address } as const;
}

/** True when selling USDC means zeroForOne on this chain. */
export function sellingUsdcIsZeroForOne(n: Network): boolean {
  return n.usdc.toLowerCase() < n.weth.toLowerCase();
}

/** A read client for the browser. Same shape as the server's, kept separate so
 *  a server-only RPC override never leaks into a bundle. */
export function publicClientFor(n: Network): PublicClient {
  return clientFor(n);
}

export function tokensOf(n: Network) {
  return {
    [n.usdc.toLowerCase()]: { address: n.usdc, symbol: "USDC", decimals: 6 },
    [n.weth.toLowerCase()]: { address: n.weth, symbol: "WETH", decimals: 18 },
  } as Record<string, { address: Address; symbol: string; decimals: number }>;
}
