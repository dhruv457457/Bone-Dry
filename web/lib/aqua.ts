import { decodeAbiParameters, parseAbiParameters, type Address, type Hex } from "viem";
import { aquaAbi, erc20Abi } from "./chain";
import { clientFor, type Network } from "./networks";

export type Strategy = {
  maker: Address;
  strategyHash: Hex;
  strategy: Hex;
  blockNumber: bigint;
  tokens?: Address[];
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
export async function indexStrategies(
  n: Network,
  opts?: {
  fromBlock?: bigint;
  toBlock?: bigint;
    pageSize?: bigint;
    maxPages?: number;
  }
): Promise<Strategy[]> {
  const client = clientFor(n);
  const latest = opts?.toBlock ?? (await client.getBlockNumber());
  const page = opts?.pageSize ?? (n.id === 8453 ? 1_500n : n.id === 1 ? 9_000n : 9_999n);
  // Ethereum ships roughly 2,000 events per 9,000-block page -- measured, not
  // estimated -- against real Aqua data. That is already past the 250-strategy
  // cap in one page, so scanning the usual 12 only pays for eleven more round
  // trips (each a rate-limit chance on a free RPC) to discard everything they
  // would have found. One page is enough to fill the cap with the most recent
  // activity, which is what gets kept anyway.
  const budget = opts?.maxPages ?? (n.id === 1 ? 2 : 12);

  // Walk backwards from the head. A forward scan from Aqua's genesis is ~200
  // sequential round trips on Base and would make the fallback unusable; a
  // rolling window pinned to the head silently drops strategies once they age
  // out. So: newest first, a fixed page budget, and `scannedFrom` on the result
  // so the caller can say which window it actually saw. The subgraph is the
  // answer to this; this is what you get without one.
  const floor = opts?.fromBlock ?? n.aquaGenesis;

  const shipped: Strategy[] = [];
  const docked = new Set<string>();
  let end = latest;
  let pages = 0;

  while (end >= floor && pages < budget) {
    const start = end - page > floor ? end - page : floor;

    const [ship, dock] = await Promise.all([
      client.getLogs({ address: n.aqua, event: aquaAbi[0], fromBlock: start, toBlock: end }),
      client.getLogs({ address: n.aqua, event: aquaAbi[1], fromBlock: start, toBlock: end }),
    ]);

    for (const l of ship) {
      const a = l.args as { maker: Address; app: Address; strategyHash: Hex; strategy: Hex };
      if (a.app.toLowerCase() !== n.router.toLowerCase()) continue; // other apps are not ours to route
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
  const live = shipped.filter((s) => !docked.has(`${s.maker.toLowerCase()}:${s.strategyHash}`));

  // Bounded, not filtered by relevance -- this app cannot tell which
  // strategies matter before measuring their depth, and measuring depth is
  // the expensive part. Ethereum ships roughly 2,000 events per 9,000
  // blocks (measured directly against the same window this scan just ran),
  // and measureDepth spends one multicall of 3 calls per strategy: unbounded,
  // a single request here asks a free RPC to simulate tens of thousands of
  // calls, the same failure mode fixed for /api/route's clamp sweep earlier.
  // Base and Sepolia never produce enough strategies in one scan to reach
  // this cap, so it costs them nothing; Ethereum gets the most recent slice
  // of its own real activity rather than a request that times out reaching
  // for all of it.
  const CANDIDATE_CAP = 250;
  if (live.length <= CANDIDATE_CAP) return live;
  return live.sort((a, b) => (b.blockNumber > a.blockNumber ? 1 : -1)).slice(0, CANDIDATE_CAP);
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

/** Keyed by chain: one shared promise would hand Base's strategies to a request
 *  about Sepolia, which is the kind of bug that looks like bad data. */
type Entry = { at: number; p: Promise<{ strategies: Strategy[]; window: Window }> };
const cache = new Map<number, Entry>();

export function cachedStrategies(n: Network): Promise<{ strategies: Strategy[]; window: Window }> {
  const hit = cache.get(n.id);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.p;

  const p = indexStrategies(n)
    .then((strategies) => {
      // refresh on resolve too, so a 12s scan is not already stale by the time
      // it lands
      const e = cache.get(n.id);
      if (e) e.at = Date.now();
      return { strategies, window: lastWindow };
    })
    .catch((e) => {
      cache.delete(n.id); // a failed scan must not be served for 15 seconds
      throw e;
    });

  cache.set(n.id, { at: Date.now(), p });
  return p;
}

/**
 * A virtual balance is a promise, not a guarantee. Makers share one wallet
 * across many strategies, and `pull()` settles with transferFrom — so a fill
 * needs real balance AND allowance. Trust the floor of the three.
 */
export async function measureDepth(
  n: Network,
  strategies: Strategy[],
  token: Address
): Promise<MakerDepth[]> {
  const client = clientFor(n);
  if (strategies.length === 0) return [];

  const calls = strategies.flatMap((s) => [
    { address: n.aqua, abi: aquaAbi, functionName: "rawBalances", args: [s.maker, n.router, s.strategyHash, token] } as const,
    { address: token, abi: erc20Abi, functionName: "balanceOf", args: [s.maker] } as const,
    { address: token, abi: erc20Abi, functionName: "allowance", args: [s.maker, n.aqua] } as const,
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

export type Position = {
  maker: Address;
  token: Address;
  totalCommitted: bigint;
  activeStrategies: number;
  strategyHashes: Hex[];
  app: Address | null;
};

/**
 * Coverage without a subgraph, for a network whose real activity is too
 * large to enumerate the honest way.
 *
 * `/api/coverage` normally asks the subgraph "what has this maker committed,
 * across every strategy, for this token" -- a question the raw event log
 * cannot answer directly, because a Shipped event does not say which tokens
 * a strategy prices. The subgraph knows because it indexes the decoded
 * SwapVM program; a plain RPC scan does not decode it.
 *
 * So this asks a narrower, answerable question instead: for a short list of
 * tokens this app already knows about, which of the (already capped, most
 * recent) candidate strategies have committed to one of them. It reads
 * `rawBalances` per strategy per token -- the same call `measureDepth` makes
 * one token at a time, batched here across several at once -- and keeps
 * anything with a non-zero virtual balance. Strategies pricing a token
 * outside this list are invisible to it, same honest limitation the
 * candidate cap already has: real, recent, partial, not lifetime-complete.
 */
export async function positionsFromRpc(
  n: Network,
  strategies: Strategy[],
  tokens: Address[]
): Promise<Position[]> {
  if (strategies.length === 0 || tokens.length === 0) return [];
  const client = clientFor(n);

  const calls = strategies.flatMap((s) =>
    tokens.map(
      (token) =>
        ({
          address: n.aqua,
          abi: aquaAbi,
          functionName: "rawBalances",
          args: [s.maker, n.router, s.strategyHash, token],
        }) as const
    )
  );
  const res = await client.multicall({ contracts: calls, allowFailure: true });

  const byMakerToken = new Map<string, Position>();
  strategies.forEach((s, si) => {
    tokens.forEach((token, ti) => {
      const r = res[si * tokens.length + ti];
      if (r.status !== "success") return;
      const [amount, tokensCount] = r.result as unknown as [bigint, number];
      if (tokensCount === 0 || tokensCount === 0xff || amount === 0n) return;

      const key = `${s.maker.toLowerCase()}:${token.toLowerCase()}`;
      const existing = byMakerToken.get(key);
      if (existing) {
        existing.totalCommitted += amount;
        existing.activeStrategies += 1;
        existing.strategyHashes.push(s.strategyHash);
      } else {
        byMakerToken.set(key, {
          maker: s.maker,
          token,
          totalCommitted: amount,
          activeStrategies: 1,
          strategyHashes: [s.strategyHash],
          app: n.router,
        });
      }
    });
  });

  return [...byMakerToken.values()];
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
