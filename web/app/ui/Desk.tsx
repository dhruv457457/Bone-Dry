"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import s from "./desk.module.css";
import { units, compact, toRaw, short, pct } from "@/lib/format";
import { useWallet, walletClient, describe } from "./useWallet";
import { wellheadAbi, erc20WriteAbi, erc20Abi } from "@/lib/chain";
import {
  publicClientFor,
  NETWORKS,
  DEFAULT_NETWORK,
  poolKey,
  sellingUsdcIsZeroForOne,
  tokensOf,
  type NetworkId,
} from "@/lib/networks";
import type { Address, Hex } from "viem";
import type { MakersResponse, RouteResponse, PoolResponse, CoverageResponse } from "./types";

type Token = { address: string; symbol: string; decimals: number };

/** A hung RPC is worse than a refused one: nothing rejects, so the page sits on
 *  "reading chain" forever with no way back. Every request gets a deadline, and
 *  a 500 that returns an HTML error page must not surface as a JSON parse error. */
const TIMEOUT_MS = 30_000;

async function getJson<T>(url: string, timeout = TIMEOUT_MS): Promise<T> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    const text = await res.text();
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(`${url.split("?")[0]} returned ${res.status} (not JSON)`);
    }
  } catch (e) {
    if ((e as Error).name === "AbortError") {
      throw new Error(`${url.split("?")[0]} timed out after ${timeout / 1000}s`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

export default function Desk() {
  const [chainId, setChainId] = useState<NetworkId>(DEFAULT_NETWORK);
  const net = NETWORKS[chainId];
  const hook = net.hook;

  // Token metadata is per chain: Circle deploys a different USDC on Sepolia, at
  // a lower address than WETH, which also inverts the pool's currency order.
  const tokens = useMemo(() => {
    const t = tokensOf(net);
    return {
      usdc: t[net.usdc.toLowerCase()] as Token,
      weth: t[net.weth.toLowerCase()] as Token,
    };
  }, [net]);

  const [flipped, setFlipped] = useState(false);
  const tokenIn = flipped ? tokens.weth : tokens.usdc;
  const tokenOut = flipped ? tokens.usdc : tokens.weth;

  const [input, setInput] = useState("100");
  const [route, setRoute] = useState<RouteResponse | null>(null);
  const [makers, setMakers] = useState<MakersResponse | null>(null);
  const [pool, setPool] = useState<PoolResponse | null>(null);
  const [coverage, setCoverage] = useState<CoverageResponse | null>(null);
  const [coverageError, setCoverageError] = useState<string | null>(null);

  const wallet = useWallet();
  const [balance, setBalance] = useState<bigint | null>(null);
  const [txState, setTxState] = useState<{
    phase: "idle" | "approving" | "swapping" | "done";
    hash?: Hex;
    note?: string;
  }>({ phase: "idle" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const amountIn = useMemo(() => toRaw(input, tokenIn.decimals), [input, tokenIn.decimals]);

  // One in-flight generation. A slow request that resolves after a newer one
  // must not overwrite fresher state — the classic async race in a quote box.
  const gen = useRef(0);

  const load = useCallback(async () => {
    const mine = ++gen.current;
    setBusy(true);
    setError(null);
    try {
      const q = `chain=${chainId}&tokenIn=${tokenIn.address}&tokenOut=${tokenOut.address}&amountIn=${amountIn}`;
      const [r, m, p] = await Promise.all([
        getJson<RouteResponse>(`/api/route?${q}`),
        getJson<MakersResponse>(`/api/makers?chain=${chainId}&token=${tokenOut.address}`),
        getJson<PoolResponse>(`/api/pool?chain=${chainId}${hook ? `&hook=${hook}` : ""}`),
      ]);
      if (mine !== gen.current) return;
      const bad = r.error ?? m.error ?? p.error;
      if (bad) setError(bad);
      setRoute(r.error ? null : r);
      setMakers(m.error ? null : m);
      setPool(p.error ? null : p);
    } catch (e) {
      if (mine === gen.current) setError((e as Error).message);
    } finally {
      if (mine === gen.current) setBusy(false);
    }
  }, [tokenIn.address, tokenOut.address, amountIn, hook, chainId]);

  useEffect(() => {
    const t = setTimeout(load, 250); // debounce keystrokes
    return () => clearTimeout(t);
  }, [load]);

  // What the connected wallet actually holds of the token being sold. Without
  // this the app happily quotes a swap the wallet cannot pay for, the approval
  // succeeds, and the swap reverts on a bare ERC-20 error.
  useEffect(() => {
    if (!wallet.address) {
      setBalance(null);
      return;
    }
    let live = true;
    publicClientFor(net)
      .readContract({
        address: tokenIn.address as Address,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [wallet.address],
      })
      .then((b) => live && setBalance(b as bigint))
      .catch(() => live && setBalance(null));
    return () => {
      live = false;
    };
  }, [wallet.address, tokenIn.address, txState.phase, chainId]);

  // Coverage does not depend on the swap inputs, so it is fetched once instead
  // of on every keystroke. It is also the slowest call: a multicall per position.
  // A failure here used to be swallowed, so the panel simply never appeared and
  // nothing said why — say why instead.
  useEffect(() => {
    let live = true;
    setCoverage(null);
    setCoverageError(null);
    getJson<CoverageResponse>(`/api/coverage?chain=${chainId}&first=12`, 60_000)
      .then((c) => {
        if (!live) return;
        if (c.error) setCoverageError(c.error);
        else setCoverage(c);
      })
      .catch((e) => live && setCoverageError((e as Error).message));
    return () => {
      live = false;
    };
  }, [chainId]);

  /**
   * Approve if needed, then swap. The hookData is the candidate set the router
   * API assembled -- the hook cannot discover makers on its own, because Aqua's
   * balance mapping is not enumerable.
   *
   * minOut is the quote less 1%. A quote is a reading of state any maker can
   * change before the transaction lands, so the floor is the swapper's only real
   * protection; sending 0 would make the demo smooth and the product unsafe.
   */
  const executeSwap = useCallback(async () => {
    if (!route?.hookData || !wallet.address || !net.wellhead) return;
    const wc = walletClient();
    const account = wallet.address;
    const amount = BigInt(route.amountFilled);
    if (amount === 0n) return;

    try {
      // A fork of Base reports Base's chain id, so `wallet_switchEthereumChain`
      // can move a wallet onto real Base while the app keeps reading the fork —
      // both claim 8453 and the mismatch is invisible. Ask the wallet itself
      // whether the router exists where it is looking.
      const deployed = (await window.ethereum!.request({
        method: "eth_getCode",
        params: [net.wellhead, "latest"],
      })) as string;
      if (!deployed || deployed === "0x") {
        setTxState({
          phase: "idle",
          note:
            "Your wallet is on a different network than this app is reading — no router at " +
            `${net.wellhead.slice(0, 8)}… there. Point the wallet at the same RPC.`,
        });
        return;
      }

      if (balance !== null && balance < amount) {
        setTxState({
          phase: "idle",
          note: `Not enough ${tokenIn.symbol}: this wallet holds ${units(
            balance,
            tokenIn.decimals,
            4
          )}.`,
        });
        return;
      }

      const rpc = publicClientFor(net);
      const allowance = (await rpc.readContract({
        address: tokenIn.address as Address,
        abi: erc20Abi,
        functionName: "allowance",
        args: [account, net.wellhead as Address],
      })) as bigint;

      if (allowance < amount) {
        setTxState({ phase: "approving" });
        const approveHash = await wc.writeContract({
          account,
          address: tokenIn.address as Address,
          abi: erc20WriteAbi,
          functionName: "approve",
          args: [net.wellhead as Address, (1n << 256n) - 1n],
        });
        await rpc.waitForTransactionReceipt({ hash: approveHash });
      }

      const quoted = BigInt(route.amountOut);
      const minOut = (quoted * 99n) / 100n;

      // Derived, never assumed: the currency order inverts between the chains,
      // so a fixed direction sells the wrong token on one of them.
      const sellingUsdc = tokenIn.address.toLowerCase() === net.usdc.toLowerCase();
      const zeroForOne = sellingUsdc
        ? sellingUsdcIsZeroForOne(net)
        : !sellingUsdcIsZeroForOne(net);

      setTxState({ phase: "swapping" });
      const hash = await wc.writeContract({
        account,
        address: net.wellhead as Address,
        abi: wellheadAbi,
        functionName: "swap",
        args: [
          poolKey(net),
          zeroForOne,
          amount,
          minOut,
          route.hookData as Hex,
        ],
      });
      const receipt = await rpc.waitForTransactionReceipt({ hash });
      setTxState({
        phase: "done",
        hash,
        note: receipt.status === "success" ? undefined : "reverted on chain",
      });
      void load();
    } catch (e) {
      setTxState({ phase: "idle", note: describe(e) });
    }
  }, [route, wallet.address, tokenIn.address, tokenIn.symbol, tokenIn.decimals, balance, load, net]);

  const usedMakers = new Set((route?.slices ?? []).map((x) => x.maker.toLowerCase()));
  const improvement = Number(route?.improvementBps ?? "0");

  return (
    <div className={s.shell}>
      <header className={s.masthead}>
        <h1 className={s.wordmark}>
          BONE<em>&middot;</em>DRY
        </h1>
        <p className={s.deck}>
          A Uniswap v4 pool that holds nothing. Every fill is drawn from 1inch Aqua maker
          wallets at the moment of the swap.
        </p>
        <NetworkSwitch chainId={chainId} onChange={setChainId} />
        <hr className={s.mastRule} />
        <div className={`${s.mastMeta} label`}>
          <span>{net.label} &middot; chain {net.id}</span>
          <span>{hook ? <>Hook <span className="hex">{short(hook)}</span></> : "no hook deployed here"}</span>
          <span>Index {indexLabel(makers)}</span>
          <span className={s.spin}>{busy ? "reading chain" : "idle"}</span>
        </div>
      </header>

      <PoolProof pool={pool} />

      <div className={s.cols}>
        <section className={s.left}>
          <div className={s.sectionHead}>
            <h2 className="label">Swap</h2>
            <span className="label">
              {route?.makersUsed ?? 0} of {route?.makersConsidered ?? 0} makers
            </span>
          </div>

          <div className={s.field}>
            <span className="label">
              You pay
              {balance !== null && (
                <span className={s.balance}>
                  {" "}
                  &middot; wallet holds {units(balance, tokenIn.decimals, 4)}
                </span>
              )}
            </span>
            <div className={s.amountRow}>
              <input
                value={input}
                inputMode="decimal"
                onChange={(e) => setInput(e.target.value)}
                aria-label={`Amount of ${tokenIn.symbol} to sell`}
              />
              <span className={s.ticker}>{tokenIn.symbol}</span>
            </div>
          </div>

          <div className={s.flip}>
            <button className={s.flipBtn} onClick={() => setFlipped((f) => !f)}>
              flip direction
            </button>
          </div>

          <div className={s.field}>
            <span className="label">You receive</span>
            <div
              className={`${s.readout} ${route && route.amountOut !== "0" ? "" : s.readoutMuted}`}
            >
              {route ? units(route.amountOut, tokenOut.decimals, 6) : "--"}{" "}
              <span className={s.ticker}>{tokenOut.symbol}</span>
            </div>
          </div>

          <ul className={s.stats}>
            <li>
              <span className="label">Deepest maker alone</span>
              <span className="num">
                {route ? units(route.singleMakerAmountOut, tokenOut.decimals, 6) : "--"}
              </span>
            </li>
            <li>
              <span className="label">Split routing gains</span>
              <span className={`num ${improvement >= 0 ? s.gain : s.loss}`}>
                {route ? `${improvement >= 0 ? "+" : ""}${improvement} bps` : "--"}
              </span>
            </li>
            <li>
              <span className="label">Skipped as insolvent</span>
              <span className="num">{route?.makersSkipped.length ?? 0}</span>
            </li>
            <li>
              <span className="label">Quote reverts (gated)</span>
              <span className="num">{route?.makersUnfillable?.length ?? 0}</span>
            </li>
            <li>
              <span className="label">Cut back to real depth</span>
              <span className={`num ${route?.clamped?.length ? s.loss : ""}`}>
                {route?.clamped?.length ?? 0}
              </span>
            </li>
            {route && route.unfilled !== "0" && (
              <li>
                <span className="label">Unfillable at this size</span>
                <span className={`num ${s.loss}`}>
                  {units(route.unfilled, tokenIn.decimals, 2)} {tokenIn.symbol}
                </span>
              </li>
            )}
            <li>
              <span className="label">Pool liquidity consumed</span>
              <span className="num">0</span>
            </li>
          </ul>

          <SwapAction
            wallet={wallet}
            route={route}
            busy={busy}
            balance={balance}
            decimals={tokenIn.decimals}
            wellhead={net.wellhead}
            tx={txState}
            onSwap={executeSwap}
            onReload={load}
          />

          {route?.reason && <p className={s.err}>{route.reason}</p>}
          {error && <p className={s.err}>{error}</p>}
        </section>

        <section className={s.right}>
          <div className={s.sectionHead}>
            <h2 className="label">Maker book &mdash; {tokenOut.symbol}</h2>
            <span className="label">
              {makers ? `${makers.solvent} solvent of ${makers.indexed} live` : "..."}
            </span>
          </div>
          <MakerBook makers={makers} used={usedMakers} decimals={tokenOut.decimals} />
          <HookData route={route} />
        </section>
      </div>

      <Coverage coverage={coverage} error={coverageError} />
    </div>
  );
}

/* The number Aqua cannot produce.
   Balances are keyed [maker][app][strategyHash][token] and the mapping is not
   enumerable, so nothing on-chain can total what one maker promised across all
   of their strategies. The index can. Next to the wallet balance, that is a
   coverage ratio -- and on Base most of the largest positions fail it. */
function Coverage({
  coverage,
  error,
}: {
  coverage: CoverageResponse | null;
  error: string | null;
}) {
  if (error)
    return (
      <section className={s.coverage}>
        <div className={s.sectionHead}>
          <h2 className="label">Coverage &mdash; promised against held, per maker</h2>
        </div>
        <p className={s.empty}>
          Unavailable: {error}. This view is computed from the Aquifer subgraph, which
          is the only thing that can total a maker&apos;s commitments across strategies.
        </p>
      </section>
    );
  if (!coverage || coverage.rows.length === 0) return null;
  const worst = coverage.rows.find((r) => r.known) ?? coverage.rows[0];

  return (
    <section className={s.coverage}>
      <div className={s.sectionHead}>
        <h2 className="label">Coverage &mdash; promised against held, per maker</h2>
        <span className="label">
          {coverage.underCollateralised} of {coverage.positions} under-collateralised
        </span>
      </div>

      <p className={s.coverageLede}>
        Aqua keys balances by maker, app, strategy and token, and the mapping is not
        enumerable &mdash; so no contract can add up what one maker has promised across
        every strategy they have live. The subgraph can. Set that total against the
        wallet and the allowance and the promise becomes checkable. Right now the
        largest position on Base belongs to a maker running{" "}
        <strong>
          {worst.activeStrategies} live strategies backed by {worst.wallet === "0" ? "nothing" : "less than they owe"}
        </strong>
        .
      </p>

      <CrossCheck check={coverage.onchainCrossCheck} />

      <div className={s.tableWrap}>
        <table className={s.table}>
          <thead>
            <tr>
              <th>Maker</th>
              <th>Token</th>
              <th>Live strategies</th>
              <th>Committed</th>
              <th>Actually backed</th>
              <th>Coverage</th>
            </tr>
          </thead>
          <tbody>
            {coverage.rows.map((r) => {
              const bps = Number(r.coverageBps);
              const pctOf = r.known ? Math.min(100, bps / 100) : 0;
              return (
                <tr key={`${r.maker}-${r.token}`}>
                  <td className="num">{short(r.maker)}</td>
                  <td className={`num ${s.dim}`}>{short(r.token)}</td>
                  <td className="num">{r.activeStrategies}</td>
                  <td className={`num ${s.dim}`}>{compact(r.committed, r.decimals)}</td>
                  <td className="num">{compact(r.backed, r.decimals)}</td>
                  <td>
                    <span
                      className={`num ${s.covPct} ${!r.known ? s.dim : bps === 0 ? s.zero : bps >= 10000 ? s.full : ""}`}
                    >
                      {r.known ? `${(bps / 100).toFixed(1)}%` : "unread"}
                    </span>
                    <span className={s.covBar} aria-hidden>
                      <span className={s.covFill} style={{ width: `${pctOf}%` }} />
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** What is answering, and if it is the fallback, how far the index still has to
 *  go. A subgraph mid-sync answers every query truthfully and uselessly, so the
 *  distinction belongs on screen rather than buried in a JSON field. */
function indexLabel(makers: MakersResponse | null): string {
  if (!makers) return "...";
  if (!makers.index) return "rpc log paging";
  if (makers.index.ready) return "aquifer subgraph";
  if (makers.index.state === "syncing") {
    const behind = Number(makers.index.behind).toLocaleString();
    return `rpc fallback — index ${behind} blocks behind`;
  }
  return `rpc fallback — index ${makers.index.state}`;
}

/* Two networks, two jobs — said plainly rather than left as a chain id.
   Mainnet is other people's real Aqua and cannot be transacted against here;
   Sepolia is our own deployment, where anyone can swap for nothing. */
function NetworkSwitch({
  chainId,
  onChange,
}: {
  chainId: NetworkId;
  onChange: (id: NetworkId) => void;
}) {
  const net = NETWORKS[chainId];
  return (
    <div className={s.netRow}>
      <div className={s.netTabs} role="tablist" aria-label="Network">
        {([84532, 8453] as NetworkId[]).map((id) => (
          <button
            key={id}
            role="tab"
            aria-selected={id === chainId}
            className={`${s.netTab} ${id === chainId ? s.netTabOn : ""}`}
            onClick={() => onChange(id)}
          >
            {NETWORKS[id].label}
            {NETWORKS[id].testnet ? <span className={s.netFree}>free</span> : null}
          </button>
        ))}
      </div>
      <p className={s.netPurpose}>{net.purpose}</p>
    </div>
  );
}

/* Everything a swapper needs to act, and nothing they do not.
   The states worth distinguishing are: no wallet extension at all, a wallet on
   the wrong chain, a route with nothing to fill, and a router that was never
   deployed on this chain -- each of which is a different thing to do next. */
function SwapAction({
  wallet,
  route,
  busy,
  tx,
  balance,
  decimals,
  wellhead,
  onSwap,
  onReload,
}: {
  wallet: ReturnType<typeof useWallet>;
  route: RouteResponse | null;
  busy: boolean;
  tx: { phase: string; hash?: string; note?: string };
  balance: bigint | null;
  decimals: number;
  wellhead: string;
  onSwap: () => void;
  onReload: () => void;
}) {
  const nothingToFill = !route?.hookData || route.amountFilled === "0";
  const short_ =
    balance !== null && route !== null && balance < BigInt(route.amountFilled || "0");
  const pending = tx.phase === "approving" || tx.phase === "swapping";

  return (
    <div className={s.actions}>
      {!wellhead ? (
        <p className={s.note}>
          Read-only: no Wellhead router is configured for this chain. Deploy one with{" "}
          <code>script/Deploy.s.sol</code> and set{" "}
          <code>NEXT_PUBLIC_WELLHEAD_ADDRESS</code>.
        </p>
      ) : !wallet.available ? (
        <p className={s.note}>
          No wallet found in this browser. The quote, the maker book and the coverage
          view all read the chain directly and work without one.
        </p>
      ) : !wallet.address ? (
        <button onClick={wallet.connect} disabled={wallet.connecting}>
          {wallet.connecting ? "Check your wallet..." : "Connect wallet"}
        </button>
      ) : wallet.wrongChain ? (
        <button onClick={wallet.switchChain}>Switch to Base</button>
      ) : (
        <button onClick={onSwap} disabled={pending || busy || nothingToFill || short_}>
          {tx.phase === "approving"
            ? "Approving..."
            : tx.phase === "swapping"
              ? "Swapping..."
              : nothingToFill
                ? "Nothing to fill"
                : short_
                  ? "Not enough to swap"
                  : "Swap"}
        </button>
      )}

      <button className={s.secondary} onClick={onReload} disabled={busy}>
        {busy ? "Reading..." : "Re-quote"}
      </button>

      {wallet.address && (
        <span className={`label ${s.account}`}>
          <span className="hex">{short(wallet.address)}</span>
        </span>
      )}

      {tx.phase === "done" && (
        <p className={s.note}>
          {tx.note ? `Swap ${tx.note}.` : "Filled, and the pool still holds nothing. "}
          <span className="hex num">{tx.hash ? short(tx.hash) : ""}</span>
        </p>
      )}
      {tx.note && tx.phase === "idle" && <p className={s.err}>{tx.note}</p>}
      {wallet.error && <p className={s.err}>{wallet.error}</p>}
    </div>
  );
}

/* The proof: the whole thesis in one number, read straight out of PoolManager
   storage via extsload. Not an indexer, not an event -- the slot itself. */
function PoolProof({ pool }: { pool: PoolResponse | null }) {
  // Only a live pool's zero means anything. Colour encodes that distinction:
  // slate for a proven-empty live pool, red for anything else.
  const proven = pool?.boneDry === true;
  return (
    <div className={s.proof}>
      <div>
        <span className="label">
          Pool liquidity, read from PoolManager storage
          {pool && !pool.initialized ? " — pool not initialized" : ""}
        </span>
        <div className={`${s.proofFig} ${proven ? s.proofDry : s.proofWet}`}>
          {pool ? pool.liquidity : "--"}
        </div>
        <p className={s.proofNote}>
          {pool?.note ??
            "Reading slot 6 of the PoolManager for this pool id. A Bone Dry pool never holds a position, so this figure is zero before a swap and zero after one."}
        </p>
      </div>
      <div className={s.proofSide}>
        <span className="label">Pool id</span>
        <span className="num">{pool ? short(pool.poolId) : "--"}</span>
        <span className="label" style={{ marginTop: 8 }}>
          Initialized
        </span>
        <span className="num">{pool ? (pool.initialized ? "yes" : "not yet") : "--"}</span>
      </div>
    </div>
  );
}

/* The book: five columns because five numbers disagree. `virtual` is what the
   maker promised Aqua; `depth` is what a fill can actually take. The bar shows
   the gap directly rather than making the reader subtract. */
function MakerBook({
  makers,
  used,
  decimals,
}: {
  makers: MakersResponse | null;
  used: Set<string>;
  decimals: number;
}) {
  if (!makers) return <p className={s.empty}>Indexing Aqua registry events...</p>;
  if (makers.makers.length === 0)
    return (
      <p className={s.empty}>
        No live strategy is shipped to this router yet. Aqua&apos;s balance mapping is not
        enumerable, so an empty book means the registry has no matching Shipped event &mdash; not
        that the read failed.
      </p>
    );

  // A single maker can have dozens of strategies live, most of them holding
  // nothing for this token. Listing every one buries the two rows that matter,
  // so dormant strategies are counted rather than enumerated.
  const live = makers.makers.filter((m) => m.virtual !== "0" || m.depth !== "0");
  // Sorted by deliverable depth already, so the head of the list is the part a
  // router would ever touch. The tail is real but it is not a reading.
  const SHOWN = 8;
  const rows = (live.length > 0 ? live : makers.makers.slice(0, 1)).slice(0, SHOWN);
  const hidden = makers.makers.length - rows.length;
  const max = rows.reduce((a, m) => (BigInt(m.virtual) > a ? BigInt(m.virtual) : a), 1n);

  return (
    <div className={s.tableWrap}>
    <table className={s.table}>
      <thead>
        <tr>
          <th>Maker</th>
          <th>Promised</th>
          <th>Wallet</th>
          <th>Allowance</th>
          <th>Deliverable</th>
          <th>Shortfall</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((m) => {
          const isUsed = used.has(m.maker.toLowerCase());
          return (
            <tr key={`${m.maker}-${m.strategyHash}`} className={isUsed ? s.used : undefined}>
              <td>
                <span className="num">{short(m.maker)}</span>
                <span className={s.bar} aria-hidden>
                  <span className={s.barFill} style={{ width: `${pct(m.virtual, max)}%` }}>
                    <span
                      className={s.barReal}
                      style={{ width: `${pct(m.depth, m.virtual === "0" ? "1" : m.virtual)}%` }}
                    />
                    <span className={s.barGap} style={{ flex: 1 }} />
                  </span>
                </span>
              </td>
              <td className={`num ${s.dim}`}>{compact(m.virtual, decimals)}</td>
              <td className={`num ${s.dim}`}>{compact(m.wallet, decimals)}</td>
              <td className={`num ${s.dim}`}>{compact(m.allowance, decimals)}</td>
              <td className="num">{compact(m.depth, decimals)}</td>
              <td className={`num ${m.shortfall !== "0" ? s.loss : s.dim}`}>
                {m.shortfall === "0" ? "--" : compact(m.shortfall, decimals)}
              </td>
            </tr>
          );
        })}
      </tbody>
      {hidden > 0 && (
        <tfoot>
          <tr>
            <td colSpan={6} className={`label ${s.dormant}`}>
              + {hidden} more live {hidden === 1 ? "strategy" : "strategies"}, none with more{" "}
              {makers.token.symbol} to give than these
            </td>
          </tr>
        </tfoot>
      )}
    </table>
    </div>
  );
}

/* The index feeding a contract, checked both ways.
   Lens.coverage() computes this same ratio on-chain but takes the strategy
   hashes as calldata -- it cannot enumerate them. The subgraph supplies exactly
   the list the contract cannot produce, so the two are independent computations
   over the same facts. When they read different blocks, that is stated rather
   than resolved: a maker who moved funds in between makes two correct answers
   look like a bug. */
function CrossCheck({ check }: { check: CoverageResponse["onchainCrossCheck"] }) {
  if (!check) return null;
  const skew = Number(check.blockSkew);
  return (
    <p className={s.crossCheck}>
      <span className="label">Cross-checked on-chain</span>{" "}
      <span className="num">
        {check.agreed}/{check.checked} agree with Lens.coverage()
      </span>
      {check.disagreements > 0 && (
        <span className={`num ${s.loss}`}> &middot; {check.disagreements} disagree</span>
      )}
      {check.inconclusive > 0 && (
        <span className={`num ${s.dim}`}>
          {" "}
          &middot; {check.inconclusive} inconclusive, index is {skew.toLocaleString()} blocks
          ahead of this RPC
        </span>
      )}
    </p>
  );
}

/* The calldata: shown, not hidden. This blob is the part of the system that
   cannot live on-chain, and a judge should be able to see and decode it. */
function HookData({ route }: { route: RouteResponse | null }) {
  if (!route?.hookData) return null;
  const bytes = (route.hookData.length - 2) / 2;
  return (
    <div className={s.blob}>
      <div className={s.sectionHead} style={{ border: 0, margin: 0, paddingBottom: 0 }}>
        <h2 className="label">hookData handed to Tap.beforeSwap</h2>
        <span className="label">
          {bytes} bytes &middot; {route.slices.length} strategies
        </span>
      </div>
      <div className={s.blobBody}>{route.hookData}</div>
    </div>
  );
}
