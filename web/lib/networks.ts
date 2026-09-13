import { createPublicClient, fallback, http, type Address, type PublicClient } from "viem";
import { base, baseSepolia, mainnet } from "viem/chains";

/**
 * Bone Dry runs on three networks that do different jobs, and the app should
 * not pretend they are the same thing.
 *
 * **Base mainnet** is the evidence with execution. 1inch's real Aqua, real
 * makers, the gap between what they have promised and what they hold -- and,
 * since the redeploy, a real router that actually fills from it.
 *
 * **Ethereum mainnet** is evidence only, at a different scale entirely: Aqua
 * is the exact same bytecode there (verified by comparing deployed code, not
 * assumed) as on Base, and real usage dwarfs it -- 113,000+ strategies shipped
 * against the same router address, next to Base's low hundreds. No Bone Dry
 * hook is deployed here and none is planned for this submission; this network
 * exists to answer "is the insolvency problem specific to Base, or general to
 * Aqua," which turns out to be the second one.
 *
 * **Base Sepolia** is the playground. Aqua has never been deployed to a
 * testnet, so this is our own deployment of it, and our own pool. Free
 * tokens, free gas, and anyone can actually swap.
 */
export type NetworkId = 8453 | 84532 | 1;

export type Network = {
  id: NetworkId;
  key: "base" | "base-sepolia" | "ethereum";
  label: string;
  /** One line explaining what this network is for, shown in the switcher. */
  purpose: string;
  testnet: boolean;
  explorer: string;
  rpc: string;
  /** Public endpoints rate-limit hard. One is a single point of failure. */
  rpcFallbacks: string[];
  aqua: Address;
  router: Address;
  /** Opcode-35 encumbrance-aware router. Only deployed on Base and Base Sepolia. */
  boneDryRouter?: Address;
  /** The v4 hook bound to `boneDryRouter`. `Tap.router` is immutable, so reaching
   *  opcode 35 means routing through this hook and its own pool — the `hook`
   *  field above is welded to 1inch's canonical router and cannot. */
  boneDryHook?: Address;
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
  /** Chainlink AggregatorV3-compatible feeds, keyed by the token address (
   *  lowercase) they price against USD. Empty object if none configured for
   *  this network. */
  oracleFeeds: Record<string, Address>;
};

const WETH_PREDEPLOY: Address = "0x4200000000000000000000000000000000000006";

export const BEACON_STRATEGY_ADDRESS: Address = "0x1cAD1eCa368940F91b43B25Db0e3E9B32B46fFe7"; // Base Sepolia only

export const NETWORKS: Record<NetworkId, Network> = {
  8453: {
    id: 8453,
    key: "base",
    label: "Base",
    purpose: "Real Aqua makers, and Bone Dry's own router, hooks and strategies beside them.",
    testnet: false,
    explorer: "https://basescan.org",
    // QuikNode's paid Build plan first -- verified live: correct chainId,
    // and (on Ethereum below) a 9000-block eth_getLogs that Alchemy's free
    // tier and the public drpc.org fallback were both failing on. Alchemy
    // kept as a fallback tier rather than removed: still a real, paid-enough
    // endpoint, and free redundancy costs nothing.
    rpc: process.env.QUICKNODE_BASE_RPC_URL ?? process.env.RPC_URL ?? "https://mainnet.base.org",
    rpcFallbacks: [
      ...(process.env.RPC_URL ? [process.env.RPC_URL] : []),
      "https://developer-access-mainnet.base.org",
      "https://base.gateway.tenderly.co",
      "https://base-rpc.publicnode.com",
      "https://base.llamarpc.com",
    ],
    aqua: "0x1111113ccf1426a8e30e2bff5e005d929bf6a90a",
    router: "0x111111338c5091E8440b67B168bAe16a668AC0De",
    boneDryRouter: "0x74195573Fa9bC965667e03319F2C58567d4B96BE",
    boneDryHook: "0xaC7bCA41EA8Fce76651684943Db2c38003c98088",
    poolManager: "0x498581fF718922c3f8e6A244956aF099B2652b2b",
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    weth: WETH_PREDEPLOY,
    // NEXT_PUBLIC_, not HOOK_ADDRESS: a plain server-only var here read fine
    // in the server-rendered HTML and as `undefined` in the client bundle
    // Next.js ships to the browser, which is a hydration mismatch on every
    // load, not an edge case -- the same reason wellhead below is public too.
    hook: (process.env.NEXT_PUBLIC_HOOK_ADDRESS ?? "") as Address | "",
    lens: (process.env.LENS_ADDRESS ?? "") as Address | "",
    wellhead: (process.env.NEXT_PUBLIC_WELLHEAD_ADDRESS ?? "") as Address | "",
    graphUrl:
      process.env.GRAPH_URL ??
      "https://api.studio.thegraph.com/query/1758723/aquifer/v0.0.3",
    aquaGenesis: 48_839_900n,
    aquaIsOurs: false,
    oracleFeeds: {
      "0x4200000000000000000000000000000000000006": "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70", // WETH, "ETH / USD"
      "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": "0x7e860098F58bBFC8648a4311b374B1D669a2bc6B", // USDC, "USDC / USD"
    },
  },
  84532: {
    id: 84532,
    key: "base-sepolia",
    label: "Base Sepolia",
    purpose: "Our own Aqua and pool. Free tokens — swap and make markets for nothing.",
    testnet: true,
    explorer: "https://sepolia.basescan.org",
    rpc: process.env.QUICKNODE_BASE_SEPOLIA_RPC_URL ?? process.env.SEPOLIA_RPC_URL ?? "https://sepolia.base.org",
    rpcFallbacks: [
      ...(process.env.SEPOLIA_RPC_URL ? [process.env.SEPOLIA_RPC_URL] : []),
      "https://base-sepolia-rpc.publicnode.com",
      "https://base-sepolia.gateway.tenderly.co",
    ],
    // 1inch have never deployed Aqua to a testnet. These are ours, built
    // unmodified from their sources; the router is tag v1.0.2, because main
    // renumbered the opcodes and will not run the SDK's own programs.
    aqua: "0x7a062f824FAbdf2360354Ad52B3752065150Da61",
    router: "0xD0a0A94711aa39EfcC3Ab2aF63ffa5BAD4E640a7",
    boneDryRouter: "0x75E8971831675A3eF0CAbc4fd441dA7aeB481146",
    // No boneDryHook here. The hook at 0xD5Bca5F5 looks like the obvious
    // candidate and is not: read on chain, its immutable `router` is
    // 0xD0a0A947… — the plain v1.0.2 router — so it cannot reach opcode 35.
    // Base Sepolia therefore has an opcode-35 *router* and no hook that can
    // call it; a second Tap bound to boneDryRouter has to be deployed before
    // any encumbered fill can be demonstrated on testnet. Base mainnet does
    // have one, at 0xaC7bCA41….
    poolManager: "0x05E73354cFDd6745C338b50BcFDfA3Aa6fA03408",
    usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    weth: WETH_PREDEPLOY,
    hook: "0xD5Bca5F5Df642E7cfDbA692FE8C3851c89238088",
    lens: "0xA3ce77230A06302e3De32A3816f46C293c9D291F",
    wellhead: "0x0A54ac0705Aeab8AB29F48899d2B347D7235a531",
    graphUrl: process.env.SEPOLIA_GRAPH_URL ?? "",
    aquaGenesis: 46_459_400n,
    aquaIsOurs: true,
    oracleFeeds: {
      "0x4200000000000000000000000000000000000006": "0x4aDC67696bA383F43DD60A9e78F2C97Fbbfc7cb1", // WETH, feed says "ETH / USD"
      "0x036cbd53842c5426634e7929541ec2318f3dcf7e": "0xd30e2101a97dcbAeBCBC04F14C3f624E67A35165", // USDC, feed says "USDC / USD"
    },
  },
  1: {
    id: 1,
    key: "ethereum",
    label: "Ethereum",
    purpose: "Real Aqua makers, at real scale. Read-only — no Bone Dry hook here.",
    testnet: false,
    explorer: "https://etherscan.io",
    // QuikNode's paid Build plan first -- this is the fix for the actual
    // bottleneck that was here: verified live that a plain 9000-block
    // eth_getLogs against this exact contract, the exact range Alchemy's
    // free tier and drpc.org were both failing/timing out on, answers
    // cleanly (and a 50k-block request comes back with an honest "limited
    // to a 10,000 range" JSON-RPC error rather than a timeout -- a real,
    // documented ceiling instead of a shared free node's mood).
    //
    // Alchemy demoted to first fallback rather than removed -- still a real
    // paid-enough endpoint for eth_call/multicall (no block-range cap
    // applies there), just never the right tool for the getLogs calls this
    // network's discovery scan is built on. drpc.org kept last: free, but a
    // real 10k-block getLogs ceiling and it did serve correctly most of the
    // time before QuikNode was available.
    //
    // publicnode and llamarpc are still deliberately absent -- found live
    // that viem's fallback does not distinguish "this transport is down"
    // from "this transport answered with an error": a transport that
    // responds at all, even with a JSON-RPC error, is treated as the final
    // answer, not a reason to try the next one. publicnode needs an archive
    // token for anything beyond a recent window and would swallow the
    // scan's own backward walk into older pages; eth.llamarpc.com failed
    // its TLS handshake outright on a live request. Both stay excluded.
    rpc:
      process.env.QUICKNODE_MAINNET_RPC_URL ??
      process.env.MAINNET_RPC_URL ??
      "https://eth.drpc.org",
    rpcFallbacks: [
      ...(process.env.MAINNET_RPC_URL ? [process.env.MAINNET_RPC_URL] : []),
      "https://eth.drpc.org",
    ],
    // Same address, same bytecode, on both chains -- confirmed by comparing
    // deployed code directly rather than assumed from the shared vanity
    // prefix. This is not a coincidence: 1inch deploy Aqua deterministically.
    aqua: "0x1111113ccf1426a8e30e2bff5e005d929bf6a90a",
    router: "0x111111338c5091E8440b67B168bAe16a668AC0De",
    // The canonical Uniswap v4 PoolManager, meaningless here since no hook of
    // ours reads it -- kept only so code that expects every Network to carry
    // one does not have to special-case this entry.
    poolManager: "0x000000000004444c5dc75cB358380D2e3dE08A90",
    usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    weth: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    // No hook, no lens, no wellhead: this submission does not deploy Bone Dry
    // to Ethereum. Every route that already handles Base's pre-deploy state
    // (empty hook, "not initialized" pool, read-only banner) handles this the
    // same way, for the same reason -- it is not a special case, it is the
    // same case twice.
    hook: "",
    lens: "",
    wellhead: "",
    // No subgraph in our own schema indexes Ethereum. A third-party one
    // exists and is real (verified: 113,162 strategies against this exact
    // router, live-queried), but its entities do not match ours
    // (App/Maker/Strategy/Fill, not Position/MakerTokenPosition), so plugging
    // its URL in here would silently return nothing from queries built for a
    // different schema rather than fail loudly. Left unset; this network
    // runs on rpc-log-paging, same fallback path Base used before it had an
    // index -- honestly labelled as such in the UI, same as Base's used to be.
    graphUrl: "",
    // A real floor, not the true one. Aqua's actual first strategy on
    // Ethereum predates this by a wide margin -- 113,162 shipped in total,
    // and a full RPC scan back to genesis is neither fast nor the point of a
    // read-only evidence panel. This is chosen to fit the default scan
    // budget (12 pages, see aqua.ts) without changing it: recent, real,
    // partial, and said so in the UI rather than presented as complete.
    aquaGenesis: 25_845_000n,
    aquaIsOurs: false,
    oracleFeeds: {
      "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2": "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419", // WETH, "ETH / USD"
      "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": "0x8fFfFfd4AfB6115b954Bd326cbe7B4BA576818f6", // USDC, "USDC / USD"
    },
  },
};

/** One Aqua "app" — a SwapVM router — and the v4 hook that can reach it.
 *
 *  Aqua keys balances `[maker][app][strategyHash][token]` and `pull()` reads
 *  `msg.sender` as the app, so a strategy shipped to one router can only ever be
 *  filled by that router. A v4 pool binds one hook and `Tap.router` is
 *  immutable, so each entry here is a separate, unmergeable book. Routing picks
 *  one; it can never span two. */
export type AquaApp = {
  app: Address;
  /** Absent when no hook on this chain can call this router — the book is then
   *  readable and quotable but not fillable. */
  hook: Address | "";
  label: string;
  /** Whether this router implements opcode 35. */
  encumbranceAware: boolean;
};

export function appsOf(n: Network): AquaApp[] {
  const out: AquaApp[] = [
    { app: n.router, hook: n.hook, label: "evidence", encumbranceAware: false },
  ];
  if (n.boneDryRouter) {
    out.push({
      app: n.boneDryRouter,
      hook: n.boneDryHook ?? "",
      label: "bone dry",
      encumbranceAware: true,
    });
  }
  return out;
}

export const DEFAULT_NETWORK: NetworkId = 8453;

/** Networks a user can switch to. Ethereum (read-only measurement) and Base
 *  Sepolia stay fully configured -- every API route still serves them -- but they
 *  are hidden from the switcher for the submission, where Base mainnet is the
 *  product. Add an id back here to re-enable one; nothing else needs to change. */
export const ENABLED_NETWORKS: NetworkId[] = [8453];

export function isEnabledNetwork(id: number): id is NetworkId {
  return (ENABLED_NETWORKS as number[]).includes(id);
}

export function isNetworkId(v: unknown): v is NetworkId {
  return v === 8453 || v === 84532 || v === 1;
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
  /**
   * Several endpoints, tried in order, each retried a couple of times.
   *
   * sepolia.base.org answers 429 under any real load, and with a single
   * transport that surfaces as a 500 on every read — the pool proof, the maker
   * book, all of it — for something that is nobody's bug and clears in a second.
   * A fallback list plus backoff turns a rate limit into a pause. A locally
   * configured RPC still goes first, because a fork is not optional when that is
   * what the app is pointed at.
   */
  // Ethereum's getLogs workhorse (drpc.org) is a shared free endpoint and the
  // only member of its fallback list per the comment above -- verified live
  // it can 408 on a single attempt under load and then answer fine on retry
  // moments later. There is no further transport to fall through to for this
  // chain, so the retry budget itself has to absorb that flakiness instead.
  const retryCount = n.id === 1 ? 4 : 2;
  const retryDelay = n.id === 1 ? 350 : 220;
  const made = createPublicClient({
    chain: n.id === 8453 ? base : n.id === 1 ? mainnet : baseSepolia,
    transport: fallback(
      [n.rpc, ...n.rpcFallbacks].map((url) =>
        http(url, { retryCount, retryDelay, timeout: 12_000 })
      ),
      { rank: false }
    ),
    batch: { multicall: { wait: 16 } },
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
