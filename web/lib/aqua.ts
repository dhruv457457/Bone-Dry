import { decodeAbiParameters, parseAbiParameters, type Address, type Hex } from "viem";
import { client, AQUA, ROUTER, aquaAbi, erc20Abi } from "./chain";

/** Block Aqua was deployed on Base. Nothing was shipped before it. */
export const AQUA_GENESIS = 48_839_900n;

export type Strategy = {
  maker: Address;
  strategyHash: Hex;
  strategy: Hex;
  blockNumber: bigint;
};

export type MakerDepth = Strategy & {
  /** what the strategy claims it can pay out */
  virtual: bigint;
  /** what the maker's wallet actually holds */
  wallet: bigint;
  /** what the maker has let Aqua move */
  allowance: bigint;
  /** min of the three — the only number a router may trust */
  depth: bigint;
  solvent: boolean;
};

/**
 * Aqua's balance mapping is NOT enumerable. There is no on-chain way to ask
 * "who are the makers?" — 1inch say so themselves and recommend building a
 * reference indexer over the registry events. This is that indexer.
 *
 * Public RPCs cap eth_getLogs at 10k blocks, so we page.
 */
export async function indexStrategies(opts?: {
  fromBlock?: bigint;
  toBlock?: bigint;
  pageSize?: bigint;
  maxPages?: number;
}): Promise<Strategy[]> {
  const latest = opts?.toBlock ?? (await client.getBlockNumber());
  const page = opts?.pageSize ?? 9_999n;
  const budget = opts?.maxPages ?? 12;

  // Walk backwards from the head. A forward scan from Aqua's genesis is ~200
  // sequential round trips on Base and would make the fallback unusable; a
  // rolling window pinned to the head silently drops strategies once they age
  // out. So: newest first, a fixed page budget, and `scannedFrom` on the result
  // so the caller can say which window it actually saw. The subgraph is the
  // answer to this; this is what you get without one.
  const floor = opts?.fromBlock ?? AQUA_GENESIS;

  const shipped: Strategy[] = [];
  const docked = new Set<string>();
  let end = latest;
  let pages = 0;

  while (end >= floor && pages < budget) {
    const start = end - page > floor ? end - page : floor;

    const [ship, dock] = await Promise.all([
      client.getLogs({ address: AQUA, event: aquaAbi[0], fromBlock: start, toBlock: end }),
      client.getLogs({ address: AQUA, event: aquaAbi[1], fromBlock: start, toBlock: end }),
    ]);

    for (const l of ship) {
      const a = l.args as { maker: Address; app: Address; strategyHash: Hex; strategy: Hex };
      if (a.app.toLowerCase() !== ROUTER.toLowerCase()) continue; // other apps are not ours to route
      shipped.push({
        maker: a.maker,
        strategyHash: a.strategyHash,
        strategy: a.strategy,
        blockNumber: l.blockNumber!,
      });
    }
    for (const l of dock) {
      const a = l.args as { maker: Address; strategyHash: Hex };
      docked.add(`${a.maker.toLowerCase()}:${a.strategyHash}`);
    }

    if (start === floor) break;
    end = start - 1n;
    pages++;
  }

  lastWindow = { fromBlock: end, toBlock: latest };
  return shipped.filter((s) => !docked.has(`${s.maker.toLowerCase()}:${s.strategyHash}`));
}

/** The window the last RPC scan covered. Meaningless once a subgraph is
 *  configured, which is the point. */
export type Window = { fromBlock: bigint; toBlock: bigint };
let lastWindow: Window = { fromBlock: 0n, toBlock: 0n };

/**
 * One scan, shared. Paging logs backwards over Base takes ~12s, and both
 * /api/makers and /api/route need the same answer — without this the page fires
 * two identical scans on every keystroke. Concurrent callers await the same
 * promise rather than starting a second scan, so `window` always describes the
 * strategies returned alongside it.
 */
const TTL_MS = 15_000;
let inflight: Promise<{ strategies: Strategy[]; window: Window }> | null = null;
let cachedAt = 0;

export function cachedStrategies(): Promise<{ strategies: Strategy[]; window: Window }> {
  if (inflight && Date.now() - cachedAt < TTL_MS) return inflight;
  cachedAt = Date.now(); // set on start so concurrent callers dedupe...
  inflight = indexStrategies()
    .then((strategies) => {
      cachedAt = Date.now(); // ...and again on resolve, so a 12s scan is not
      return { strategies, window: lastWindow }; // stale 12s into its own TTL
    })
    .catch((e) => {
      inflight = null; // a failed scan must not be served for the next 15 seconds
      throw e;
    });
  return inflight;
}

/**
 * A virtual balance is a promise, not a guarantee. Makers share one wallet
 * across many strategies, and `pull()` settles with transferFrom — so a fill
 * needs real balance AND allowance. Trust the floor of the three.
 */
export async function measureDepth(strategies: Strategy[], token: Address): Promise<MakerDepth[]> {
  if (strategies.length === 0) return [];

  const calls = strategies.flatMap((s) => [
    { address: AQUA, abi: aquaAbi, functionName: "rawBalances", args: [s.maker, ROUTER, s.strategyHash, token] } as const,
    { address: token, abi: erc20Abi, functionName: "balanceOf", args: [s.maker] } as const,
    { address: token, abi: erc20Abi, functionName: "allowance", args: [s.maker, AQUA] } as const,
  ]);

  const res = await client.multicall({ contracts: calls, allowFailure: true });

  return strategies.map((s, i) => {
    const raw = res[i * 3];
    const bal = res[i * 3 + 1];
    const allw = res[i * 3 + 2];

    let virtual = 0n;
    if (raw.status === "success") {
      const [amount, tokensCount] = raw.result as unknown as [bigint, number];
      // tokensCount 0 = never shipped, 0xff = docked
      virtual = tokensCount === 0 || tokensCount === 0xff ? 0n : amount;
    }
    const wallet = bal.status === "success" ? (bal.result as bigint) : 0n;
    const allowance = allw.status === "success" ? (allw.result as bigint) : 0n;

    const depth = [virtual, wallet, allowance].reduce((a, b) => (b < a ? b : a));
    return { ...s, virtual, wallet, allowance, depth, solvent: depth > 0n };
  });
}

/** The maker address is baked into the Order, so we can verify what we indexed. */
export function makerFromStrategy(strategy: Hex): Address {
  const [order] = decodeAbiParameters(
    parseAbiParameters("(address maker, uint256 traits, bytes data)"),
    strategy
  );
  return (order as { maker: Address }).maker;
}

/**
 * The index, plus whatever the chain has that the index has not.
 *
 * A subgraph is authoritative about history and always slightly behind the
 * present: it is fresh to within 300 blocks at best, and a strategy shipped in
 * the last minute is invisible to it. Choosing one source or the other trades a
 * complete history for a current one. Merging keeps both — the index supplies
 * depth of history, a short backward RPC scan supplies the tail, and dedupe on
 * (maker, strategyHash) makes the overlap free.
 *
 * It also makes the app work against a fork of the chain the index watches,
 * which is what a reviewer running this locally actually has.
 */
export function mergeStrategies(indexed: Strategy[], tail: Strategy[]): Strategy[] {
  const seen = new Set(indexed.map((s) => `${s.maker.toLowerCase()}:${s.strategyHash}`));
  const merged = indexed.slice();
  for (const s of tail) {
    const k = `${s.maker.toLowerCase()}:${s.strategyHash}`;
    if (seen.has(k)) continue;
    seen.add(k);
    merged.push(s);
  }
  return merged;
}
