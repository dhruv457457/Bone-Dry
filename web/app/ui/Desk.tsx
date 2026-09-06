"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import s from "./desk.module.css";
import { units, compact, toRaw, short, pct } from "@/lib/format";
import { useAccount, useSwitchChain, useWriteContract, useSendTransaction } from "wagmi";
import { ConnectButton } from "@rainbow-me/rainbowkit";
/** A user closing the wallet popup is not an error worth shouting about. */
function describe(e: unknown): string {
  const err = e as { code?: number; shortMessage?: string; message?: string };
  if (err?.code === 4001 || /rejected|denied/i.test(err?.message ?? "")) return "cancelled in wallet";
  return err?.shortMessage ?? err?.message ?? "transaction failed";
}
import { wellheadAbi, erc20WriteAbi, erc20Abi } from "@/lib/chain";
import {
  publicClientFor,
  NETWORKS,
  DEFAULT_NETWORK,
  poolKey,
  sellingUsdcIsZeroForOne,
  tokensOf,
  type NetworkId,
  type Network,
} from "@/lib/networks";
import { keccak256, type Address, type Hex } from "viem";
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

  // wagmi owns the connection; RainbowKit owns the picker. `wrongChain` is still
  // ours to decide, because "wrong" means "not the network this page is showing".
  const { address, isConnected, chainId: walletChainId } = useAccount();
  const { switchChain } = useSwitchChain();
  // useWriteContract rather than a raw wallet client: with a chain chosen at
  // runtime the client's chain type resolves to never, and wagmi's own hook
  // takes chainId as an argument and stays typed.
  const { writeContractAsync } = useWriteContract();
  const wrongChain = isConnected && walletChainId !== undefined && walletChainId !== chainId;
  const [balance, setBalance] = useState<bigint | null>(null);
  const chainIdRef = useRef<NetworkId>(chainId);
  chainIdRef.current = chainId;
  const [txState, setTxState] = useState<{
    phase: "idle" | "approving" | "swapping" | "done";
    hash?: Hex;
    note?: string;
  }>({ phase: "idle" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const amountIn = useMemo(() => toRaw(input, tokenIn.decimals), [input, tokenIn.decimals]);

  /**
   * Drop everything the moment the chain changes.
   *
   * A route carries hookData: the exact strategies the hook will fill from. Left
   * on screen after a switch, the Swap button would hand the wallet calldata
   * addressed to the other chain's makers against a pool that does not exist
   * there. It would revert rather than lose money, but showing a live quote for
   * the wrong chain is not a state this should ever be in.
   */
  useEffect(() => {
    setRoute(null);
    setMakers(null);
    setPool(null);
    setBalance(null);
    setError(null);
    setTxState({ phase: "idle" });
  }, [chainId]);

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
    if (!address) {
      setBalance(null);
      return;
    }
    let live = true;
    publicClientFor(net)
      .readContract({
        address: tokenIn.address as Address,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [address],
      })
      .then((b) => live && setBalance(b as bigint))
      .catch(() => live && setBalance(null));
    return () => {
      live = false;
    };
  }, [address, tokenIn.address, txState.phase, chainId]);

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
        // The server says whether this network has an index; the client used to
        // decide from an env var it cannot see, and so reported "no subgraph" on
        // a chain that has one.
        if (c.error) setCoverageError(c.error);
        else if (c.available === false) setCoverageError(c.reason ?? "no index for this network");
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
    if (!route?.hookData || !address || !net.wellhead) return;
    const account = address;
    // The chain this transaction belongs to. Everything below is async, and the
    // switcher is one click away.
    const forChain = chainId;
    const stillHere = () => forChain === chainIdRef.current;
    const amount = BigInt(route.amountFilled);
    if (amount === 0n) return;

    const rpc = publicClientFor(net);
    const rpcForWallet = rpc;

    try {
      // A fork of Base reports Base's chain id, so `wallet_switchEthereumChain`
      // can move a wallet onto real Base while the app keeps reading the fork —
      // both claim 8453 and the mismatch is invisible. Ask the wallet itself
      // whether the router exists where it is looking.
      const deployed = await rpcForWallet.getBytecode({ address: net.wellhead as Address });
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

      const allowance = (await rpc.readContract({
        address: tokenIn.address as Address,
        abi: erc20Abi,
        functionName: "allowance",
        args: [account, net.wellhead as Address],
      })) as bigint;

      if (allowance < amount) {
        setTxState({ phase: "approving" });
        const approveHash = await writeContractAsync({
          chainId,
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
      const hash = await writeContractAsync({
        chainId,
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
      if (!stillHere()) return;
      setTxState({
        phase: "done",
        hash,
        note: receipt.status === "success" ? undefined : "reverted on chain",
      });
      void load();
    } catch (e) {
      if (stillHere()) setTxState({ phase: "idle", note: describe(e) });
    }
  }, [route, address, tokenIn.address, tokenIn.symbol, tokenIn.decimals, balance, load, net, chainId, writeContractAsync]);

  const usedMakers = new Set((route?.slices ?? []).map((x) => x.maker.toLowerCase()));
  const improvement = Number(route?.improvementBps ?? "0");

  return (
    <div className={s.shell}>
      <header className={s.masthead}>
        {/* Compact here, not a hero: the landing page already made the claim, and
            this fold belongs to the thing the visitor came to use. */}
        <div className={s.appNav}>
          <Link className={s.appMark} href="/">
            BONE<em>&middot;</em>DRY
          </Link>
          <NetworkSwitch chainId={chainId} onChange={setChainId} />
        </div>
        <hr className={s.mastRule} />
        <div className={`${s.mastMeta} label`}>
          <span>{net.label} &middot; chain {net.id}</span>
          <span>{hook ? <>Hook <span className="hex">{short(hook)}</span></> : "no hook deployed here"}</span>
          <span>Index {indexLabel(makers)}</span>
          <span className={s.spin}>{busy ? "reading chain" : "idle"}</span>
        </div>
      </header>

      {/* Swap first. The proof sits beside it rather than as a full-width band
          above: it is the reason to trust the number, not the headline. */}
      <div className={s.trade}>
        <section className={s.swapCard}>
          <div className={s.field}>
            <div className={s.fieldHead}>
              <span className="label">You pay</span>
              {balance !== null && (
                <button
                  className={s.maxBtn}
                  onClick={() => setInput(units(balance, tokenIn.decimals, 6).replace(/,/g, ""))}
                >
                  {units(balance, tokenIn.decimals, 4)} {tokenIn.symbol}
                </button>
              )}
            </div>
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

          <button
            className={s.flipBtn}
            onClick={() => setFlipped((f) => !f)}
            aria-label="Swap the direction"
          >
            &#8645;
          </button>

          <div className={s.field}>
            <span className="label">You receive</span>
            <div
              className={`${s.readout} ${route && route.amountOut !== "0" ? "" : s.readoutMuted}`}
            >
              {route ? units(route.amountOut, tokenOut.decimals, 6) : "--"}{" "}
              <span className={s.ticker}>{tokenOut.symbol}</span>
            </div>
            {route && improvement > 0 && (
              <p className={s.beat}>
                <b>+{improvement} bps</b> better than the deepest maker alone, by splitting
                across {route.makersUsed}
              </p>
            )}
          </div>

          <SwapAction
            route={route}
            busy={busy}
            tx={txState}
            balance={balance}
            decimals={tokenIn.decimals}
            wellhead={net.wellhead}
            chainLabel={net.label}
            address={address}
            wrongChain={wrongChain}
            onSwitch={() => switchChain({ chainId })}
            onSwap={executeSwap}
            onReload={load}
          />
        </section>

        <aside className={s.proofCard}>
          <PoolProof pool={pool} />
          <dl className={s.facts}>
            <div>
              <dt className="label">Filled from</dt>
              <dd className="num">
                {route?.makersUsed ?? 0} of {route?.makersConsidered ?? 0} wallets
              </dd>
            </div>
            <div>
              <dt className="label">Skipped, cannot pay</dt>
              <dd className="num">{route?.makersSkipped.length ?? 0}</dd>
            </div>
            <div>
              <dt className="label">Quote reverts</dt>
              <dd className="num">{route?.makersUnfillable?.length ?? 0}</dd>
            </div>
            {route && route.unfilled !== "0" && (
              <div>
                <dt className="label">Unfillable at this size</dt>
                <dd className={`num ${s.loss}`}>
                  {units(route.unfilled, tokenIn.decimals, 2)} {tokenIn.symbol}
                </dd>
              </div>
            )}
          </dl>
        </aside>
      </div>

      <section className={s.book}>
        <div className={s.sectionHead}>
          <h2 className="label">Maker book &mdash; {tokenOut.symbol}</h2>
          <span className="label">
            {makers ? `${makers.solvent} solvent of ${makers.indexed} live` : "..."}
          </span>
        </div>
        <MakerBook makers={makers} used={usedMakers} decimals={tokenOut.decimals} />
        <HookData route={route} />
      </section>

      <ShipStrategy
        net={net}
        tokenIn={tokenIn}
        tokenOut={tokenOut}
        address={address}
        wrongChain={wrongChain}
        onShipped={load}
      />

      <Coverage
        coverage={coverage}
        error={coverageError}
        onGoToBase={chainId === 84532 ? () => setChainId(8453) : undefined}
      />

      <Deployed net={net} />
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
  onGoToBase,
}: {
  coverage: CoverageResponse | null;
  error: string | null;
  onGoToBase?: () => void;
}) {
  // A dead end with an apology in it is worse than no section. This one names
  // the reason once and hands over the way out, because the view does exist —
  // just not on this network.
  if (error)
    return (
      <section className={s.coverage}>
        <div className={s.sectionHead}>
          <h2 className="label">Coverage &mdash; promised against held, per maker</h2>
          <span className="label">{error}</span>
        </div>
        <div className={s.coverageEmpty}>
          <p>
            Totalling what one maker has promised across every strategy is the thing no
            contract can do, so this view needs an index. There is one on Base.
          </p>
          {onGoToBase && (
            <button onClick={onGoToBase}>See it on Base</button>
          )}
        </div>
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

/* Every address, linked. A judge should be able to leave this page and confirm
   on a block explorer that the contracts exist and the pool is empty, rather
   than taking a screenshot's word for it. Aqua and the router are marked when
   they are ours, because on a testnet they are — 1inch have never deployed Aqua
   to one — and quietly implying otherwise would be the wrong kind of shortcut. */
function Deployed({ net }: { net: Network }) {
  const rows: [string, string, boolean][] = [
    ["Tap — the v4 hook", net.hook, false],
    ["Wellhead — the router your wallet calls", net.wellhead, false],
    ["Lens — the solvency read", net.lens, false],
    ["Aqua", net.aqua, net.aquaIsOurs],
    ["SwapVM router", net.router, net.aquaIsOurs],
    ["Uniswap v4 PoolManager", net.poolManager, false],
  ];
  return (
    <section className={s.deployed}>
      <div className={s.sectionHead}>
        <h2 className="label">Deployed on {net.label}</h2>
        <span className="label">verify every one of these</span>
      </div>
      <ul className={s.deployList}>
        {rows.map(([what, addr, ours]) =>
          addr ? (
            <li key={what}>
              <span className={s.deployWhat}>
                {what}
                {ours ? <span className={s.ours}>our deployment</span> : null}
              </span>
              <a
                className="num hex"
                href={`${net.explorer}/address/${addr}`}
                target="_blank"
                rel="noreferrer"
              >
                {short(addr)}
              </a>
            </li>
          ) : null
        )}
      </ul>
      {net.aquaIsOurs && (
        <p className={s.deployNote}>
          1inch have never deployed Aqua to a testnet, so Aqua and the SwapVM router
          here are ours — built unmodified from their sources, which their licence
          permits and their team confirmed. The router is tag <code>v1.0.2</code>:
          <code> main</code> has renumbered the opcodes and will not run the SDK&apos;s
          own programs.
        </p>
      )}
    </section>
  );
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
  route,
  busy,
  tx,
  balance,
  decimals,
  wellhead,
  chainLabel,
  address,
  wrongChain,
  onSwitch,
  onSwap,
  onReload,
}: {
  route: RouteResponse | null;
  busy: boolean;
  tx: { phase: string; hash?: string; note?: string };
  balance: bigint | null;
  decimals: number;
  wellhead: string;
  chainLabel: string;
  address?: string;
  wrongChain: boolean;
  onSwitch: () => void;
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
          Read-only on this network: no Wellhead router is deployed here. Everything
          above still reads the chain directly — switch to Base Sepolia to trade.
        </p>
      ) : !address ? (
        // RainbowKit's own button: it knows which wallets are installed, offers a
        // QR for mobile when a WalletConnect id is configured, and disconnects for
        // real rather than just forgetting the address.
        <ConnectButton label="Connect wallet" chainStatus="none" showBalance={false} />
      ) : wrongChain ? (
        <button onClick={onSwitch}>Switch to {chainLabel}</button>
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

      {address && (
        <span className={s.account}>
          <ConnectButton chainStatus="none" showBalance={false} accountStatus="address" />
        </span>
      )}

      {tx.phase === "done" && (
        <p className={s.note}>
          {tx.note ? `Swap ${tx.note}.` : "Filled, and the pool still holds nothing. "}
          <span className="hex num">{tx.hash ? short(tx.hash) : ""}</span>
        </p>
      )}
      {tx.note && tx.phase === "idle" && <p className={s.err}>{tx.note}</p>}
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
          {pool
            ? pool.initialized
              ? "Live pool. Zero before a swap, zero after one."
              : "Not initialized on this chain, so this zero proves nothing."
            : "Reading PoolManager storage…"}
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

/* The maker side of the desk.
   A maker claims an amount for each token and signs raw calldata from /api/strategy.
   Funds stay in the maker's wallet until filled, but Aqua records the claim
   immediately. Once confirmed, reloading the maker book picks up the new strategy. */
function ShipStrategy({
  net,
  tokenIn,
  tokenOut,
  address,
  wrongChain,
  onShipped,
}: {
  net: Network;
  tokenIn: Token;
  tokenOut: Token;
  address?: Address;
  wrongChain: boolean;
  onShipped: () => void;
}) {
  const [claimIn, setClaimIn] = useState("");
  const [claimOut, setClaimOut] = useState("");
  const [feeBps, setFeeBps] = useState("0");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shippedHash, setShippedHash] = useState<Hex | null>(null);

  const { sendTransactionAsync } = useSendTransaction();

  useEffect(() => {
    setShippedHash(null);
    setError(null);
    setBusy(false);
  }, [net.id]);

  const parsedIn = toRaw(claimIn, tokenIn.decimals);
  const parsedOut = toRaw(claimOut, tokenOut.decimals);
  const amountInvalid = parsedIn === 0n || parsedOut === 0n;

  const disabled = !address || wrongChain || amountInvalid || busy;

  const handleShip = async () => {
    if (disabled || !address) return;
    const forChain = net.id;
    setBusy(true);
    setError(null);
    setShippedHash(null);

    try {
      const res = await fetch("/api/strategy", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          maker: address,
          chainId: net.id,
          tokenIn: tokenIn.address,
          tokenOut: tokenOut.address,
          amountIn: parsedIn.toString(),
          amountOut: parsedOut.toString(),
          feeBps: feeBps ? Number(feeBps) : 0,
        }),
      });

      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `failed to assemble strategy (${res.status})`);
      }

      const built = (await res.json()) as {
        to: Address;
        data: Hex;
        strategy: Hex;
      };

      if (forChain !== net.id) return;

      const hash = await sendTransactionAsync({
        to: built.to,
        data: built.data,
      });

      const rpc = publicClientFor(net);
      const receipt = await rpc.waitForTransactionReceipt({ hash });

      if (forChain !== net.id) return;

      if (receipt.status !== "success") {
        throw new Error("reverted on chain");
      }

      const strategyHash = keccak256(built.strategy);
      setShippedHash(strategyHash);
      onShipped();
    } catch (e) {
      if (forChain === net.id) {
        setError(describe(e));
      }
    } finally {
      if (forChain === net.id) {
        setBusy(false);
      }
    }
  };

  return (
    <section className={s.ship}>
      <div className={s.sectionHead}>
        <h2 className="label">Ship a strategy &mdash; {tokenIn.symbol} / {tokenOut.symbol}</h2>
        <span className="label">become a maker</span>
      </div>
      <div className={s.shipCard}>
        <div className={s.field}>
          <div className={s.fieldHead}>
            <span className="label">Claim {tokenIn.symbol}</span>
          </div>
          <div className={s.amountRow}>
            <input
              value={claimIn}
              inputMode="decimal"
              onChange={(e) => setClaimIn(e.target.value)}
              aria-label={`Claim amount for ${tokenIn.symbol}`}
              placeholder="0.0"
            />
            <span className={s.ticker}>{tokenIn.symbol}</span>
          </div>
        </div>

        <div className={s.field}>
          <div className={s.fieldHead}>
            <span className="label">Claim {tokenOut.symbol}</span>
          </div>
          <div className={s.amountRow}>
            <input
              value={claimOut}
              inputMode="decimal"
              onChange={(e) => setClaimOut(e.target.value)}
              aria-label={`Claim amount for ${tokenOut.symbol}`}
              placeholder="0.0"
            />
            <span className={s.ticker}>{tokenOut.symbol}</span>
          </div>
        </div>

        <div className={s.field}>
          <div className={s.fieldHead}>
            <span className="label">Your fee (bps)</span>
          </div>
          <div className={s.amountRow}>
            <input
              value={feeBps}
              inputMode="numeric"
              onChange={(e) => setFeeBps(e.target.value)}
              aria-label="Fee in basis points"
              placeholder="0"
            />
            <span className={s.ticker}>bps</span>
          </div>
          <p className={s.shipCaption}>Spread you earn on every fill. 0 is fine to start.</p>
        </div>

        <div className={s.actions}>
          <button onClick={handleShip} disabled={disabled}>
            {busy
              ? "Shipping..."
              : !address
                ? "Connect wallet"
                : wrongChain
                  ? "Wrong network"
                  : amountInvalid
                    ? "Enter claim amounts"
                    : "Ship this strategy"}
          </button>
        </div>

        {shippedHash && (
          <div className={s.shipSuccess}>
            <p className={s.note}>
              Shipped. You are now a maker on this pair. Strategy hash:{" "}
              <span className="hex num">{short(shippedHash)}</span>
            </p>
          </div>
        )}

        {error && <p className={s.err}>{error}</p>}
      </div>
    </section>
  );
}

