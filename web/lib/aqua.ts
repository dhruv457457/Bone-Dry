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
    /** Which Aqua app (SwapVM router) to scan. Defaults to n.router. */
    app?: Address;
  }
): Promise<Strategy[]> {
  const client = clientFor(n);
  const app = opts?.app ?? n.router;
  const latest = opts?.toBlock ?? (await client.getBlockNumber());
  const page = opts?.pageSize ?? (n.id === 8453 ? 1_500n : n.id === 1 ? 9_000n : 9_999n);
  // This used to stop at 2 pages on Ethereum, on the theory that Ethereum's
  // higher event density fills the CANDIDATE_CAP from recent activity alone.
  // Measured directly and found wrong: genesis to head is currently only
  // ~13 pages of real history, not an unbounded backlog, and a 2-page scan
  // was seeing under 4% of it -- missing the densest pages entirely
  // (900-1,300 ships each, vs ~150-250 in the most recent ones).
  //
  // (A first version of this comment also claimed Ethereum's registry had
  // never had a single Docked event. That was wrong -- an artifact of a
  // verification script using an incorrect 2-field Docked ABI that silently
  // matched zero real events, not a real property of the chain. The
  // background indexer's first full backfill, using the correct 3-field ABI
  // below, found 6,534 of 7,006 ever-shipped strategies already docked. The
  // page-budget fix above is unaffected by the correction: it was justified
  // by the page-density measurement, not the docked-event claim.)
  //
  // budget is set generously above the current span so the `start === floor`
  // break below does the real work of stopping the scan, not an arbitrary
  // page count guessing at how far back "recent" should mean.
  const budget = opts?.maxPages ?? (n.id === 1 ? 20 : 12);

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
      // Filtered to the app being scanned. Aqua keys balances by app and
      // pull() reads msg.sender, so a strategy shipped to another router can
      // never be filled through this one -- they are separate books, not a
      // superset. Defaults to n.router so existing callers are unchanged.
      if (a.app.toLowerCase() !== app.toLowerCase()) continue;
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
  // strategies matter before measuring their depth (rawBalances is keyed per
  // token and not enumerable), and measuring depth is the expensive part:
  // one multicall of 3 calls per candidate.
  //
  // 250 was too tight, found live: a direct probe against a real pair found
  // 29 solvent candidates for one token scattered across the full
  // genesis-to-head span -- only 5 of them within the first 250 by recency,
  // 19 within 2,500. (That probe's candidate set was built from raw Shipped
  // events without cross-checking Docked ones -- it did not know the true
  // live population was ~472, not ~7,000. That did not make the solvent
  // count wrong: `virtual` above already reads 0 for anything Aqua's own
  // contract state marks docked, via the 0xff sentinel, independent of this
  // app's own event bookkeeping. It only means the 7,000-candidate multicall
  // that probe ran, and the "30-45s" cost that motivated capping at 2,500
  // instead of going uncapped, was checking ~15x more candidates than
  // actually existed.) 2,500 stays as the cap regardless -- comfortably
  // above the real ~472 live strategies, so nothing is actually being
  // truncated today, and it is headroom for the population to grow. Base
  // and Sepolia still never reach even the old 250 cap in one scan, so this
  // costs them nothing.
  const CANDIDATE_CAP = n.id === 1 ? 2_500 : 250;
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
// Ethereum's scan now walks the full genesis-to-head range (20 pages, not 2)
// to actually cover the real population instead of the most recent slice --
// slower per scan, so a 15s TTL would mean almost every request re-pays for
// it. A longer window here trades a little staleness (new strategies show up
// up to a minute late) for not re-running a ~13-page scan on every keystroke.
const TTL_MS_ETHEREUM = 60_000;

/** Keyed by chain: one shared promise would hand Base's strategies to a request
 *  about Sepolia, which is the kind of bug that looks like bad data. */
type Entry = { at: number; p: Promise<{ strategies: Strategy[]; window: Window }> };
const cache = new Map<number, Entry>();

export function cachedStrategies(n: Network): Promise<{ strategies: Strategy[]; window: Window }> {
  const ttl = n.id === 1 ? TTL_MS_ETHEREUM : TTL_MS;
  const hit = cache.get(n.id);
  if (hit && Date.now() - hit.at < ttl) return hit.p;

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
  token: Address,
  app: Address = n.router
): Promise<MakerDepth[]> {
  const client = clientFor(n);
  if (strategies.length === 0) return [];

  const calls = strategies.flatMap((s) => [
    { address: n.aqua, abi: aquaAbi, functionName: "rawBalances", args: [s.maker, app, s.strategyHash, token] } as const,
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
