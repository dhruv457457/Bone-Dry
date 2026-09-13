import { decodeAbiParameters, parseAbiParameters, type Address, type Hex } from "viem";
import { aquaAbi, erc20Abi } from "./chain";
import { NETWORKS, clientFor, appsOf, type Network, type NetworkId } from "./networks";
import { findEncumbranceInProgram } from "./encumbrance";
import { refusalReasonName } from "./refusals";
import { tokensForChain } from "./tokenList";
import { sql } from "./db";

/**
 * One maker's whole book, on every chain we read, in one shape.
 *
 * Provide and Portfolio both need the same answer -- what this wallet has
 * promised, what actually backs it, and whether each opcode-35 strategy would
 * refuse right now -- and two components computing it separately is how they
 * come to disagree. So it is computed once, here.
 *
 * Sources, per chain, and they are not the same kind of evidence:
 *  - Base: the Aquifer subgraph lists the strategies (with their bytes, so the
 *    opcode-35 parameters are decoded, not guessed) and carries this maker's
 *    fills and refusals. Every claim is then re-read live with rawBalances.
 *  - Ethereum: no subgraph of ours indexes it. The Postgres index of 1inch's
 *    Aqua API lists the strategies; claims, balances and allowances are read
 *    live. It covers 1inch's router only -- nothing of ours is deployed there.
 *
 * Combined totals add a token across chains only when the symbol AND decimals
 * match. That treats WETH on Base and WETH on Ethereum as one inventory, which is
 * a claim about the maker (they will bridge to settle), not about the chain: the
 * UI says so.
 */

export type BookSide = { token: Address; symbol: string; decimals: number; claim: string };

export type BookActivity = {
  kind: "fill" | "applied" | "refusal";
  txHash: Hex;
  blockNumber: number;
  timestamp: number;
  detail: string;
};

export type BookStrategy = {
  chainId: NetworkId;
  strategyHash: Hex;
  app: Address;
  book: string;
  shippedTx: Hex | null;
  sides: BookSide[];
  opcode35: null | {
    declared: string;
    maxUtilBps: number;
    widenBps: number;
    siblings: number;
    /** declared / min(balance, allowance) of the encumbered token, now. null when backing is 0. */
    utilBps: number | null;
    refusesNow: boolean;
    token: Address;
    symbol: string;
    decimals: number;
  };
  activity: BookActivity[];
};

export type BookToken = {
  token: Address;
  symbol: string;
  decimals: number;
  promised: string;
  held: string;
  allowance: string;
  backing: string;
};

export type BookChain = {
  chainId: NetworkId;
  label: string;
  available: boolean;
  reason?: string;
  source: "subgraph" | "index" | "none";
  strategies: BookStrategy[];
  tokens: BookToken[];
};

export type CombinedToken = {
  symbol: string;
  decimals: number;
  promised: string;
  backing: string;
  chains: NetworkId[];
};

export type MakerBook = { maker: Address; chains: BookChain[]; combined: CombinedToken[] };

export const BOOK_CHAINS: NetworkId[] = [8453, 1];

const STRATEGY_QUERY = /* GraphQL */ `
  query Book($maker: String!) {
    strategies(first: 200, where: { maker: $maker, active: true }) {
      strategyHash
      app
      tokens
      strategy
      shippedTx
    }
    makerRefusals(first: 100, where: { maker: $maker }, orderBy: blockNumber, orderDirection: desc) {
      strategyHash
      reason
      wanted
      blockNumber
      timestamp
      txHash
    }
    encumbranceApplications(first: 100, where: { maker: $maker }, orderBy: blockNumber, orderDirection: desc) {
      strategy { strategyHash }
      utilBps
      adjustedFrom
      adjustedTo
      blockNumber
      timestamp
      txHash
    }
  }
`;

type GqlBook = {
  strategies: { strategyHash: Hex; app: Address; tokens: Hex[]; strategy: Hex; shippedTx: Hex }[];
  makerRefusals: { strategyHash: Hex | null; reason: Hex; wanted: string; blockNumber: string; timestamp: string; txHash: Hex }[];
  encumbranceApplications: {
    strategy: { strategyHash: Hex } | null;
    utilBps: number;
    adjustedFrom: string;
    adjustedTo: string;
    blockNumber: string;
    timestamp: string;
    txHash: Hex;
  }[];
};

async function gql<T>(n: Network, query: string, variables: Record<string, unknown>): Promise<T | null> {
  if (!n.graphUrl) return null;
  try {
    const r = await fetch(n.graphUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, variables }),
      cache: "no-store",
    });
    if (!r.ok) return null;
    const body = (await r.json()) as { data?: T; errors?: unknown };
    return body.errors ? null : (body.data ?? null);
  } catch {
    return null;
  }
}

function bookLabel(n: Network, app: string): string {
  const hit = appsOf(n).find((a) => a.app.toLowerCase() === app.toLowerCase());
  if (!hit) return "other app";
  return hit.encumbranceAware ? "Bone Dry" : "1inch";
}

function decodeOpcode35(strategy: Hex) {
  try {
    const [order] = decodeAbiParameters(parseAbiParameters("(address maker, uint256 traits, bytes data)"), strategy);
    const found = findEncumbranceInProgram(order.data);
    return found ? found.args : null;
  } catch {
    return null;
  }
}

type Raw = { strategyHash: Hex; app: Address; tokens: Address[]; strategy: Hex | null; shippedTx: Hex | null };

/** Live claims, balances and allowances for a list of strategies, then the opcode-35 verdict. */
async function readLive(n: Network, maker: Address, raws: Raw[], activity: Map<string, BookActivity[]>) {
  const client = clientFor(n);
  const known = new Map(tokensForChain(n.id).map((t) => [t.address.toLowerCase(), t]));
  const tokenList = [...new Set(raws.flatMap((r) => r.tokens.map((t) => t.toLowerCase())))] as Address[];

  const ctxCalls = tokenList.flatMap((t) => [
    { address: t, abi: erc20Abi, functionName: "balanceOf", args: [maker] } as const,
    { address: t, abi: erc20Abi, functionName: "allowance", args: [maker, n.aqua] } as const,
    { address: t, abi: erc20Abi, functionName: "decimals", args: [] } as const,
  ]);
  const claimCalls = raws.flatMap((r) =>
    r.tokens.map(
      (t) => ({ address: n.aqua, abi: aquaAbi, functionName: "rawBalances", args: [maker, r.app, r.strategyHash, t] }) as const
    )
  );
  const [ctxRes, claimRes] = await Promise.all([
    ctxCalls.length ? client.multicall({ contracts: ctxCalls, allowFailure: true }) : Promise.resolve([]),
    claimCalls.length ? client.multicall({ contracts: claimCalls, allowFailure: true }) : Promise.resolve([]),
  ]);

  const ctx = new Map<string, { held: bigint; allowance: bigint; decimals: number; symbol: string }>();
  tokenList.forEach((t, i) => {
    const ok = (k: number) => ctxRes[i * 3 + k]?.status === "success";
    const meta = known.get(t);
    ctx.set(t, {
      held: ok(0) ? (ctxRes[i * 3].result as bigint) : 0n,
      allowance: ok(1) ? (ctxRes[i * 3 + 1].result as bigint) : 0n,
      decimals: meta?.decimals ?? (ok(2) ? Number(ctxRes[i * 3 + 2].result) : 18),
      symbol: meta?.symbol ?? `${t.slice(0, 6)}…`,
    });
  });
  const backingOf = (t: string) => {
    const c = ctx.get(t.toLowerCase());
    if (!c) return 0n;
    return c.held < c.allowance ? c.held : c.allowance;
  };

  const promised = new Map<string, bigint>();
  let k = 0;
  const strategies: BookStrategy[] = [];
  for (const r of raws) {
    const sides: BookSide[] = [];
    let docked = false;
    for (const t of r.tokens) {
      const res = claimRes[k++];
      const [bal, count] = res?.status === "success" ? (res.result as readonly [bigint, number]) : [0n, 0];
      if (count === 0xff) docked = true;
      const c = ctx.get(t.toLowerCase())!;
      sides.push({ token: t, symbol: c.symbol, decimals: c.decimals, claim: bal.toString() });
    }
    // The index can lag a dock by a refresh; the chain cannot.
    if (docked) continue;
    for (const sd of sides) promised.set(sd.token.toLowerCase(), (promised.get(sd.token.toLowerCase()) ?? 0n) + BigInt(sd.claim));

    let opcode35: BookStrategy["opcode35"] = null;
    const args = r.strategy ? decodeOpcode35(r.strategy) : null;
    if (args) {
      // Opcode 35 checks one declared number against the backing of whichever token
      // a fill pays out, and a maker sizes that number in one token's units. Against
      // the other token's backing it is meaningless (23e12 wei of WETH read against
      // 0.23 USDC is "10 million percent"), so the side it was sized for is the one
      // where it reads smallest, and that is the verdict reported.
      let pick = sides[0];
      let pickUtil = Number.MAX_SAFE_INTEGER;
      for (const sd of sides) {
        const b = backingOf(sd.token);
        const u = b === 0n ? Number.MAX_SAFE_INTEGER : Number((BigInt(args.declaredTotalEncumbrance) * 10_000n) / b);
        if (u <= pickUtil) {
          pickUtil = u;
          pick = sd;
        }
      }
      const backing = backingOf(pick.token);
      const utilBps = backing === 0n ? null : Number((BigInt(args.declaredTotalEncumbrance) * 10_000n) / backing);
      opcode35 = {
        declared: BigInt(args.declaredTotalEncumbrance).toString(),
        maxUtilBps: Number(args.maxUtilBps),
        widenBps: Number(args.widenBps),
        siblings: args.siblingHashes.length,
        utilBps,
        refusesNow: utilBps === null || utilBps >= Number(args.maxUtilBps),
        token: pick.token,
        symbol: pick.symbol,
        decimals: pick.decimals,
      };
    }

    strategies.push({
      chainId: n.id,
      strategyHash: r.strategyHash,
      app: r.app,
      book: bookLabel(n, r.app),
      shippedTx: r.shippedTx,
      sides,
      opcode35,
      activity: activity.get(r.strategyHash.toLowerCase()) ?? [],
    });
  }

  const tokens: BookToken[] = tokenList.map((t) => {
    const c = ctx.get(t)!;
    return {
      token: t,
      symbol: c.symbol,
      decimals: c.decimals,
      promised: (promised.get(t) ?? 0n).toString(),
      held: c.held.toString(),
      allowance: c.allowance.toString(),
      backing: backingOf(t).toString(),
    };
  });

  return { strategies, tokens };
}

async function baseChain(n: Network, maker: Address): Promise<BookChain> {
  const data = await gql<GqlBook>(n, STRATEGY_QUERY, { maker: maker.toLowerCase() });
  if (!data) {
    return { chainId: n.id, label: n.label, available: false, reason: "the index did not answer", source: "none", strategies: [], tokens: [] };
  }
  const activity = new Map<string, BookActivity[]>();
  const push = (h: string | null | undefined, a: BookActivity) => {
    if (!h) return;
    const key = h.toLowerCase();
    activity.set(key, [...(activity.get(key) ?? []), a]);
  };
  for (const r of data.makerRefusals) {
    push(r.strategyHash, {
      kind: "refusal",
      txHash: r.txHash,
      blockNumber: Number(r.blockNumber),
      timestamp: Number(r.timestamp),
      detail: refusalReasonName(r.reason),
    });
  }
  for (const a of data.encumbranceApplications) {
    const from = BigInt(a.adjustedFrom);
    const cut = from === 0n ? 0 : Number(((from - BigInt(a.adjustedTo)) * 1_000_000n) / from) / 100;
    push(a.strategy?.strategyHash, {
      kind: "applied",
      txHash: a.txHash,
      blockNumber: Number(a.blockNumber),
      timestamp: Number(a.timestamp),
      detail: `filled at ${(a.utilBps / 100).toFixed(2)}% util · ${cut.toFixed(2)} bps haircut`,
    });
  }
  for (const list of activity.values()) list.sort((x, y) => y.blockNumber - x.blockNumber);

  const raws: Raw[] = data.strategies.map((st) => ({
    strategyHash: st.strategyHash,
    app: st.app,
    tokens: st.tokens.map((t) => t.toLowerCase() as Address),
    strategy: st.strategy,
    shippedTx: st.shippedTx,
  }));
  const live = await readLive(n, maker, raws, activity);
  return { chainId: n.id, label: n.label, available: true, source: "subgraph", ...live };
}

async function indexedChain(n: Network, maker: Address): Promise<BookChain> {
  const db = sql();
  if (!db) {
    return { chainId: n.id, label: n.label, available: false, reason: "no index configured", source: "none", strategies: [], tokens: [] };
  }
  const rows = await db<{ strategy_hash: string; strategy_bytes: string; tokens: string[] | null }[]>`
    select s.strategy_hash, s.strategy_bytes,
           array_remove(array_agg(distinct d.token), null) as tokens
      from aqua_strategies s
      left join aqua_depth d
        on d.chain_id = s.chain_id and d.maker = s.maker and d.strategy_hash = s.strategy_hash
     where s.chain_id = ${n.id} and lower(s.maker) = ${maker.toLowerCase()} and not s.docked
     group by s.strategy_hash, s.strategy_bytes
     limit 200
  `;
  const indexed: Raw[] = rows
    .filter((r) => (r.tokens ?? []).length > 0)
    .map((r) => ({
      strategyHash: r.strategy_hash as Hex,
      app: n.router,
      tokens: (r.tokens ?? []).map((t) => t.toLowerCase() as Address),
      strategy: (r.strategy_bytes.startsWith("0x") ? r.strategy_bytes : `0x${r.strategy_bytes}`) as Hex,
      shippedTx: null,
    }));
  const raws = [...indexed, ...(await boneDryShipped(n, maker))];
  const live = await readLive(n, maker, raws, new Map());
  // A maker with no strategies still has a wallet on this chain; report what it holds
  // of the tokens it trades elsewhere, so an empty chain reads as "nothing promised",
  // not as "unknown".
  if (live.tokens.length === 0) {
    const client = clientFor(n);
    const base = [
      { token: n.weth, symbol: "WETH", decimals: 18 },
      { token: n.usdc, symbol: "USDC", decimals: 6 },
    ];
    const res = await client.multicall({
      allowFailure: true,
      contracts: base.flatMap((t) => [
        { address: t.token, abi: erc20Abi, functionName: "balanceOf", args: [maker] } as const,
        { address: t.token, abi: erc20Abi, functionName: "allowance", args: [maker, n.aqua] } as const,
      ]),
    });
    live.tokens = base.map((t, i) => {
      const held = res[i * 2]?.status === "success" ? (res[i * 2].result as bigint) : 0n;
      const allowance = res[i * 2 + 1]?.status === "success" ? (res[i * 2 + 1].result as bigint) : 0n;
      return {
        token: t.token,
        symbol: t.symbol,
        decimals: t.decimals,
        promised: "0",
        held: held.toString(),
        allowance: allowance.toString(),
        backing: (held < allowance ? held : allowance).toString(),
      };
    });
  }
  return { chainId: n.id, label: n.label, available: true, source: "index", ...live };
}

/**
 * This maker's strategies on BoneDryRouter, where no index of ours exists: Aqua's
 * Shipped logs from the router's deploy block, filtered to this maker and app.
 * Shipped carries no token list, so both sides of the chain's USDC/WETH pair are
 * read and readLive drops a strategy whose claims show it docked. Sides the
 * strategy never shipped read tokensCount 0 and are removed here.
 */
async function boneDryShipped(n: Network, maker: Address): Promise<Raw[]> {
  if (!n.boneDryRouter || n.boneDryGenesis === undefined) return [];
  const client = clientFor(n);
  const head = await client.getBlockNumber();
  const shipped = aquaAbi.find((x) => x.type === "event" && x.name === "Shipped");
  if (!shipped || shipped.type !== "event") return [];
  const out: Raw[] = [];
  const STEP = 9_000n;
  for (let from = n.boneDryGenesis; from <= head; from += STEP + 1n) {
    const to = from + STEP > head ? head : from + STEP;
    const logs = await client.getLogs({ address: n.aqua, event: shipped, fromBlock: from, toBlock: to });
    for (const l of logs) {
      const a = l.args as { maker?: Address; app?: Address; strategyHash?: Hex; strategy?: Hex };
      if (a.maker?.toLowerCase() !== maker.toLowerCase()) continue;
      if (a.app?.toLowerCase() !== n.boneDryRouter.toLowerCase()) continue;
      if (!a.strategyHash) continue;
      out.push({
        strategyHash: a.strategyHash,
        app: n.boneDryRouter,
        tokens: [n.usdc.toLowerCase() as Address, n.weth.toLowerCase() as Address],
        strategy: a.strategy ?? null,
        shippedTx: l.transactionHash,
      });
    }
  }
  if (out.length === 0) return out;
  // Keep only the sides each strategy actually shipped (tokensCount != 0).
  const res = await client.multicall({
    allowFailure: true,
    contracts: out.flatMap((r) =>
      r.tokens.map((t) => ({ address: n.aqua, abi: aquaAbi, functionName: "rawBalances", args: [maker, r.app, r.strategyHash, t] }) as const)
    ),
  });
  let k = 0;
  return out
    .map((r) => {
      const tokens = r.tokens.filter(() => {
        const x = res[k++];
        return x?.status === "success" && (x.result as readonly [bigint, number])[1] !== 0;
      });
      return { ...r, tokens };
    })
    .filter((r) => r.tokens.length > 0);
}

export async function makerBookAcrossChains(maker: Address): Promise<MakerBook> {
  const chains = await Promise.all(
    BOOK_CHAINS.map(async (id): Promise<BookChain> => {
      const n = NETWORKS[id];
      try {
        return n.graphUrl ? await baseChain(n, maker) : await indexedChain(n, maker);
      } catch (e) {
        return {
          chainId: id,
          label: n.label,
          available: false,
          reason: (e as Error).message?.slice(0, 120) ?? "read failed",
          source: "none",
          strategies: [],
          tokens: [],
        };
      }
    })
  );

  const combined = new Map<string, CombinedToken>();
  for (const c of chains) {
    for (const t of c.tokens) {
      const key = `${t.symbol}:${t.decimals}`;
      const cur = combined.get(key) ?? { symbol: t.symbol, decimals: t.decimals, promised: "0", backing: "0", chains: [] };
      cur.promised = (BigInt(cur.promised) + BigInt(t.promised)).toString();
      cur.backing = (BigInt(cur.backing) + BigInt(t.backing)).toString();
      if (!cur.chains.includes(c.chainId)) cur.chains.push(c.chainId);
      combined.set(key, cur);
    }
  }
  return { maker, chains, combined: [...combined.values()] };
}
