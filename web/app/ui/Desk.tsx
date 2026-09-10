"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import s from "./desk.module.css";
import Exposure from "./Exposure";
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
  type NetworkId,
  type Network,
} from "@/lib/networks";
import {
  pairsFor,
  defaultPairFor,
  poolKeyFor,
  isZeroForOne,
  createPairConfig,
  type PairConfig,
  type PairToken,
} from "@/lib/pairs";
import { keccak256, type Address, type Hex } from "viem";
import type { MakersResponse, RouteResponse, PoolResponse, CoverageResponse, AppsResponse } from "./types";
import { TokenIcon } from "./TokenIcon";
import { PriceChart, type RangePreset } from "./PriceChart";
import { TokenSearchModal } from "./TokenSearchModal";
import { RouteInspector } from "./RouteInspector";
import type { SearchableToken } from "@/lib/tokenList";

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

  const [customPairs, setCustomPairs] = useState<PairConfig[]>([]);
  const basePairs = useMemo(() => pairsFor(chainId), [chainId]);
  const availablePairs = useMemo(() => {
    const list = [...basePairs];
    for (const cp of customPairs) {
      if (!list.some((p) => p.id === cp.id)) {
        list.push(cp);
      }
    }
    return list;
  }, [basePairs, customPairs]);

  const [pairId, setPairId] = useState<string>(() => defaultPairFor(DEFAULT_NETWORK).id);
  const [searchModalOpen, setSearchModalOpen] = useState(false);
  const [searchTarget, setSearchTarget] = useState<"tokenIn" | "tokenOut" | "pair">("pair");

  useEffect(() => {
    setCustomPairs([]);
    const defaultPair = defaultPairFor(chainId);
    setPairId(defaultPair ? defaultPair.id : "usdc-weth");
  }, [chainId]);

  useEffect(() => {
    const search = new URLSearchParams(window.location.search);
    const c = search.get("chain");
    if (c === "8453") setChainId(8453);
    else if (c === "84532") setChainId(84532);

    const p = search.get("pair");
    if (p && pairsFor(chainId).some((pair) => pair.id === p)) {
      setPairId(p);
    }
  }, [chainId]);

  const currentPair = useMemo(() => {
    return availablePairs.find((p) => p.id === pairId) ?? availablePairs[0] ?? defaultPairFor(chainId);
  }, [availablePairs, pairId, chainId]);

  // Four jobs, four views. Everything below used to be one long scroll --
  // swap, become a maker, check your own exposure, and browse anyone else's --
  // stacked on top of each other regardless of which one a visitor came for.
  const [tab, setTab] = useState<"swap" | "provide" | "portfolio" | "explore">("swap");

  useEffect(() => {
    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      const t = params.get("tab");
      if (t === "provide" || t === "portfolio" || t === "explore" || t === "swap") {
        setTab(t);
      }
    }
  }, []);

  const [flipped, setFlipped] = useState(false);
  const tokenIn = flipped ? currentPair.token1 : currentPair.token0;
  const tokenOut = flipped ? currentPair.token0 : currentPair.token1;

  const handleSelectToken = useCallback(
    (token: SearchableToken) => {
      const selectedAsPairToken: PairToken = {
        address: token.address as Address,
        symbol: token.symbol,
        decimals: token.decimals,
      };

      if (searchTarget === "tokenIn") {
        if (selectedAsPairToken.address.toLowerCase() === tokenOut.address.toLowerCase()) {
          setFlipped((f) => !f);
          return;
        }
        const newPair = createPairConfig(selectedAsPairToken, tokenOut, net);
        setCustomPairs((prev) => [newPair, ...prev]);
        setPairId(newPair.id);
        setFlipped(false);
      } else if (searchTarget === "tokenOut") {
        if (selectedAsPairToken.address.toLowerCase() === tokenIn.address.toLowerCase()) {
          setFlipped((f) => !f);
          return;
        }
        const newPair = createPairConfig(tokenIn, selectedAsPairToken, net);
        setCustomPairs((prev) => [newPair, ...prev]);
        setPairId(newPair.id);
        setFlipped(false);
      } else {
        const isWeth = token.symbol.toUpperCase() === "WETH";
        const counterpartAddress = isWeth ? net.usdc : net.weth;
        const counterpartSymbol = isWeth ? "USDC" : "WETH";
        const counterpartDecimals = isWeth ? 6 : 18;
        const counterpartToken: PairToken = {
          address: counterpartAddress,
          symbol: counterpartSymbol,
          decimals: counterpartDecimals,
        };
        const newPair = createPairConfig(selectedAsPairToken, counterpartToken, net);
        setCustomPairs((prev) => [newPair, ...prev]);
        setPairId(newPair.id);
        setFlipped(false);
      }
    },
    [searchTarget, tokenIn, tokenOut, net]
  );

  const handleSelectPair = useCallback(
    (pair: PairConfig) => {
      if (!availablePairs.some((p) => p.id === pair.id)) {
        setCustomPairs((prev) => [pair, ...prev]);
      }
      setPairId(pair.id);
      setFlipped(false);
    },
    [availablePairs]
  );
  const pKey = useMemo(() => poolKeyFor(currentPair, net), [currentPair, net]);

  const [input, setInput] = useState("100");
  const [route, setRoute] = useState<RouteResponse | null>(null);
  const [makers, setMakers] = useState<MakersResponse | null>(null);
  const [pool, setPool] = useState<PoolResponse | null>(null);
  const [coverage, setCoverage] = useState<CoverageResponse | null>(null);
  const [coverageError, setCoverageError] = useState<string | null>(null);
  // The finding, not the swap, is the headline -- so it is fetched once,
  // always against Base mainnet, independent of whichever network the swap
  // UI is currently pointed at. Testing on Sepolia should not hide the real
  // number; the problem this project answers is a Base mainnet fact.
  const [finding, setFinding] = useState<CoverageResponse | null>(null);
  const [appsData, setAppsData] = useState<AppsResponse | null>(null);
  const [appsError, setAppsError] = useState<string | null>(null);

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
    /** measured from the wallet's own balances either side of the fill --
     *  what the swap paid out, as opposed to what the quote predicted */
    received?: bigint;
  }>({ phase: "idle" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const amountIn = useMemo(() => toRaw(input, tokenIn.decimals), [input, tokenIn.decimals]);

  /**
   * Drop everything the moment the chain or pair changes.
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
    setInput(currentPair.id === "weth-mock" ? "0.001" : "100");
  }, [chainId, currentPair.id]);

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
        getJson<PoolResponse>(
          `/api/pool?chain=${chainId}&currency0=${pKey.currency0}&currency1=${pKey.currency1}&fee=${pKey.fee}&tickSpacing=${pKey.tickSpacing}${pKey.hooks ? `&hook=${pKey.hooks}` : ""}`
        ),
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
  }, [tokenIn.address, tokenOut.address, amountIn, pKey, chainId]);

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

  useEffect(() => {
    let live = true;
    getJson<CoverageResponse>(`/api/coverage?chain=8453&first=200`, 60_000)
      .then((c) => {
        if (live && c.available !== false && !c.error) setFinding(c);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    let live = true;
    setAppsData(null);
    setAppsError(null);
    getJson<AppsResponse>(`/api/apps?chain=${chainId}`, 30_000)
      .then((res) => {
        if (!live) return;
        if (res.error) setAppsError(res.error);
        else if (res.available === false) setAppsError(res.reason ?? "no index for this network");
        else setAppsData(res);
      })
      .catch((e) => live && setAppsError((e as Error).message));
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

      // Derived, never assumed: currency order is determined by token address,
      // so zeroForOne depends on whether tokenIn is currency0.
      const zeroForOne = isZeroForOne(tokenIn.address as Address, currentPair);

      setTxState({ phase: "swapping" });

      // What the wallet held of the token being bought, immediately before the
      // fill. The difference after settlement is what this swap ACTUALLY paid
      // out, which is the only number worth showing once a trade is done -- the
      // quote above it was a prediction, and a prediction is not a receipt.
      const outBefore = (await rpc
        .readContract({
          address: tokenOut.address as Address,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [account],
        })
        .catch(() => null)) as bigint | null;

      const hash = await writeContractAsync({
        chainId,
        account,
        address: net.wellhead as Address,
        abi: wellheadAbi,
        functionName: "swap",
        args: [
          pKey,
          zeroForOne,
          amount,
          minOut,
          route.hookData as Hex,
        ],
      });
      const receipt = await rpc.waitForTransactionReceipt({ hash });
      if (!stillHere()) return;

      // Re-read both balances pinned to the block this landed in. Without the
      // pin these go out over a fallback transport that can answer from a node
      // a block behind the one that returned the receipt, and the panel sits
      // there showing pre-trade numbers under a confirmed transaction.
      const at = { blockNumber: receipt.blockNumber };
      const [spentAfter, gainedAfter] = await Promise.all([
        rpc
          .readContract({
            address: tokenIn.address as Address,
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [account],
            ...at,
          })
          .catch(() => null) as Promise<bigint | null>,
        rpc
          .readContract({
            address: tokenOut.address as Address,
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [account],
            ...at,
          })
          .catch(() => null) as Promise<bigint | null>,
      ]);

      if (!stillHere()) return;
      if (spentAfter !== null) setBalance(spentAfter);
      setTxState({
        phase: "done",
        hash,
        note: receipt.status === "success" ? undefined : "reverted on chain",
        received:
          receipt.status === "success" && outBefore !== null && gainedAfter !== null
            ? gainedAfter - outBefore
            : undefined,
      });
      void load();
    } catch (e) {
      if (stillHere()) setTxState({ phase: "idle", note: describe(e) });
    }
  }, [route, address, tokenIn.address, tokenIn.symbol, tokenIn.decimals, currentPair, pKey, balance, load, net, chainId, writeContractAsync]);

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
          <div className={s.navControls}>
            <PairSwitch
              pairs={availablePairs}
              pairId={currentPair.id}
              currentPair={currentPair}
              onChange={setPairId}
              onOpenSearch={() => {
                setSearchTarget("pair");
                setSearchModalOpen(true);
              }}
            />
            <NetworkSwitch chainId={chainId} onChange={setChainId} />
          </div>
        </div>
        <hr className={s.mastRule} />
        <div className={`${s.mastMeta} label`}>
          <span>{net.label} &middot; chain {net.id}</span>
          <span>{hook ? <>Hook <span className="hex">{short(hook)}</span></> : "no hook deployed here"}</span>
          <span>Index {indexLabel(makers)}</span>
          <span className={s.spin}>{busy ? "reading chain" : "idle"}</span>
        </div>
      </header>

      <TabNav tab={tab} onChange={setTab} />

      {tab === "swap" && (
      <>
      <Finding coverage={finding} onSeeExplore={() => setTab("explore")} />
      {/* The swap is the proof the finding above is answerable, not the
          headline itself -- that reversal is the point of this page now. */}
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
              <button
                type="button"
                className={s.tickerBtn}
                onClick={() => {
                  setSearchTarget("tokenIn");
                  setSearchModalOpen(true);
                }}
                aria-label={`Select token to pay (currently ${tokenIn.symbol})`}
              >
                <TokenIcon chainId={chainId} address={tokenIn.address as Address} symbol={tokenIn.symbol} size={16} />
                <span className={s.tickerLabel}>{tokenIn.symbol}</span>
                <span className={s.tickerChevron}>▾</span>
              </button>
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
              <button
                type="button"
                className={s.tickerBtn}
                onClick={() => {
                  setSearchTarget("tokenOut");
                  setSearchModalOpen(true);
                }}
                aria-label={`Select token to receive (currently ${tokenOut.symbol})`}
              >
                <TokenIcon chainId={chainId} address={tokenOut.address as Address} symbol={tokenOut.symbol} size={16} />
                <span className={s.tickerLabel}>{tokenOut.symbol}</span>
                <span className={s.tickerChevron}>▾</span>
              </button>
            </div>
            {route && improvement > 0 && (
              <p className={s.beat}>
                <b>+{improvement} bps</b> better than any single maker alone, by splitting
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
            outDecimals={tokenOut.decimals}
            outSymbol={tokenOut.symbol}
            explorer={net.explorer}
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
              <dt className="label">Unfillable quote</dt>
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

      <RouteInspector route={route} tokenIn={tokenIn} tokenOut={tokenOut} net={net} />

      <section className={s.book}>
        <div className={s.sectionHead}>
          <h2 className={s.sectionTitle}>
            Maker book &mdash;{" "}
            <span className={s.tokenCell}>
              <TokenIcon chainId={chainId} address={tokenOut.address as Address} symbol={tokenOut.symbol} size={16} />
              {tokenOut.symbol}
            </span>
          </h2>
          <span className="label">
            {makers ? `${makers.solvent} solvent of ${makers.indexed} live` : <span className={s.loadingDots}>reading…</span>}
          </span>
        </div>
        <MakerBook makers={makers} used={usedMakers} decimals={tokenOut.decimals} slices={route?.slices} />
      </section>

      {/* Real, and not the first thing anyone should have to look at. Collapsed
          by default -- <details> costs no JS and needs no state of its own. */}
      <HookDataDisclosure route={route} />
      </>
      )}

      {tab === "provide" && (
        <ShipStrategy
          net={net}
          tokenIn={tokenIn}
          tokenOut={tokenOut}
          address={address}
          wrongChain={wrongChain}
          onShipped={load}
        />
      )}

      {tab === "portfolio" && (
        <Exposure
          chainId={chainId}
          address={address}
          onGoToBase={chainId === 84532 ? () => setChainId(8453) : undefined}
        />
      )}

      {tab === "explore" && (
        <>
          <Coverage
            coverage={coverage}
            error={coverageError}
            onGoToBase={chainId === 84532 ? () => setChainId(8453) : undefined}
          />
          <AcrossAqua
            data={appsData}
            error={appsError}
            onGoToBase={chainId === 84532 ? () => setChainId(8453) : undefined}
          />
          <section className={s.exploreLink}>
            <p>
              Checking a wallet that has never touched this dashboard? The lookup
              page takes any address, on either network, no connection required.
            </p>
            <Link href="/app/lookup" className={s.exploreLinkBtn}>
              Check any wallet &rarr;
            </Link>
          </section>
          <Deployed net={net} />
        </>
      )}

      <TokenSearchModal
        isOpen={searchModalOpen}
        onClose={() => setSearchModalOpen(false)}
        chainId={chainId}
        net={net}
        target={searchTarget}
        availablePairs={availablePairs}
        currentPairId={currentPair.id}
        onSelectToken={handleSelectToken}
        onSelectPair={handleSelectPair}
      />
    </div>
  );
}

/* Counts up from 0 once, on mount or whenever the target changes -- not a
   general-purpose spring, just enough motion to make a number that only
   ever renders once feel like it was measured just now rather than typed
   into the JSX. Skips straight to the target under reduced motion. */
function useCountUp(target: number, ms = 900) {
  const [value, setValue] = useState(0);
  const reduced = useRef(
    typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
  useEffect(() => {
    if (reduced.current) {
      setValue(target);
      return;
    }
    let raf: number;
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / ms);
      // easeOutCubic -- fast start, settles rather than snapping.
      const eased = 1 - Math.pow(1 - t, 3);
      setValue(Math.round(target * eased));
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, ms]);
  return value;
}

/* The headline, not the swap card beside it. This is the whole pitch in one
   sentence and one live number: most of what Aqua thinks it has is not
   there. The swap below is the proof that this dashboard routes around it --
   evidence for the claim made here, not the other way around. */
function Finding({
  coverage,
  onSeeExplore,
}: {
  coverage: CoverageResponse | null;
  onSeeExplore: () => void;
}) {
  const bad = useCountUp(coverage?.underCollateralised ?? 0);
  if (!coverage) return null;
  return (
    <section className={s.finding}>
      <p className={s.findingFig}>
        <span className={s.findingBad}>{bad}</span>
        <span className={s.findingOf}> of {coverage.positions}</span>
      </p>
      <p className={s.findingClaim}>
        real maker positions on Base can&apos;t deliver what they promised, right
        now.
      </p>
      <p className={s.findingSub}>
        Aqua has no way to check this on-chain -- the balance mapping isn&apos;t
        enumerable, 1inch say so themselves. This is the index that can, and
        the swap below only fills from makers who actually pass it.{" "}
        <button className={s.findingLink} onClick={onSeeExplore}>
          See the full breakdown &rarr;
        </button>
      </p>
    </section>
  );
}

/* The four jobs this dashboard does, as four places rather than one scroll.
   Same tab visual language as the network/pair switchers above it, so the
   page reads as one system rather than three different widgets bolted
   together. */
function TabNav({
  tab,
  onChange,
}: {
  tab: "swap" | "provide" | "portfolio" | "explore";
  onChange: (t: "swap" | "provide" | "portfolio" | "explore") => void;
}) {
  const items: { id: typeof tab; label: string }[] = [
    { id: "swap", label: "Swap" },
    { id: "provide", label: "Provide" },
    { id: "portfolio", label: "Portfolio" },
    { id: "explore", label: "Explore" },
  ];
  return (
    <div className={s.pageTabs} role="tablist" aria-label="Section">
      {items.map((it) => (
        <button
          key={it.id}
          role="tab"
          aria-selected={it.id === tab}
          className={`${s.pageTab} ${it.id === tab ? s.pageTabOn : ""}`}
          onClick={() => onChange(it.id)}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}

/* HookData, unwrapped only on request. It is the realest proof on this page --
   the exact bytes Tap.beforeSwap acts on -- and also the least useful thing to
   put in front of someone deciding whether to swap. */
function HookDataDisclosure({ route }: { route: RouteResponse | null }) {
  if (!route?.hookData) return null;
  const bytes = (route.hookData.length - 2) / 2;
  return (
    <details className={s.disclosure}>
      <summary className="label">
        Technical proof &mdash; hookData handed to Tap.beforeSwap ({bytes} bytes,{" "}
        {route.slices.length} {route.slices.length === 1 ? "strategy" : "strategies"})
      </summary>
      <div className={s.blobBody}>{route.hookData}</div>
    </details>
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
          <h2 className={s.sectionTitle}>Coverage &mdash; promised against held, per maker</h2>
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
        <h2 className={s.sectionTitle}>Coverage &mdash; promised against held, per maker</h2>
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

function AcrossAqua({
  data,
  error,
  onGoToBase,
}: {
  data: AppsResponse | null;
  error: string | null;
  onGoToBase?: () => void;
}) {
  if (error)
    return (
      <section className={s.acrossAqua}>
        <div className={s.sectionHead}>
          <h2 className={s.sectionTitle}>Across Aqua &mdash; every app this index sees, not just ours</h2>
          <span className="label">{error}</span>
        </div>
        <div className={s.coverageEmpty}>
          <p>
            Aqua&apos;s registry is shared across any protocol that ships strategies to it.
            Indexing across apps requires the subgraph on Base.
          </p>
          {onGoToBase && (
            <button onClick={onGoToBase}>See it on Base</button>
          )}
        </div>
      </section>
    );

  if (!data) return null;

  const totalStrategies = data.apps.reduce((sum, a) => sum + a.activeStrategies, 0);

  return (
    <section className={s.acrossAqua}>
      <div className={s.sectionHead}>
        <h2 className={s.sectionTitle}>Across Aqua &mdash; every app this index sees, not just ours</h2>
        <span className="label">
          {data.apps.length} {data.apps.length === 1 ? "app" : "apps"}, {totalStrategies} live {totalStrategies === 1 ? "strategy" : "strategies"} total
        </span>
      </div>

      <p className={s.coverageLede}>
        Our subgraph listens to Aqua&apos;s contract events rather than filtering to Bone Dry&apos;s
        router &mdash; so it indexes every consumer on the network. Here is every app currently
        shipping live strategies under that same standardized schema.
      </p>

      <div className={s.tableWrap}>
        <table className={s.table}>
          <thead>
            <tr>
              <th>App</th>
              <th>Status</th>
              <th>Live strategies</th>
              <th>Distinct makers</th>
            </tr>
          </thead>
          <tbody>
            {data.apps.map((a) => (
              <tr key={a.app}>
                <td>
                  <span className="num" title={a.app}>{short(a.app)}</span>
                </td>
                <td>
                  {a.isOurs ? (
                    <span className={`${s.badge} ${s.badgeOk}`}>this app</span>
                  ) : (
                    <span className={s.dim}>--</span>
                  )}
                </td>
                <td className="num">{a.activeStrategies}</td>
                <td className="num">{a.distinctMakers}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** What is answering, and if it is the fallback, how far the index still has to
 *  go. A subgraph mid-sync answers every query truthfully and uselessly, so the
 *  distinction belongs on screen rather than buried in a JSON field. */
function indexLabel(makers: MakersResponse | null): ReactNode {
  if (!makers) return <span className={s.loadingDots}>reading…</span>;
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
        <h2 className={s.sectionTitle}>Deployed on {net.label}</h2>
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
        {([8453, 84532] as NetworkId[]).map((id) => (
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

/* Multiple pairs when available on this network.
   Selecting a pair clears derived state and switches the trading desk's currencies. */
function PairSwitch({
  pairs,
  pairId,
  currentPair,
  onChange,
  onOpenSearch,
}: {
  pairs: PairConfig[];
  pairId: string;
  currentPair: PairConfig;
  onChange: (id: string) => void;
  onOpenSearch: () => void;
}) {
  const displayedPairs = pairs.slice(0, 3);
  if (!displayedPairs.some((p) => p.id === currentPair.id)) {
    displayedPairs.push(currentPair);
  }

  return (
    <div className={s.pairRow}>
      <div className={s.netTabs} role="tablist" aria-label="Trading pair">
        {displayedPairs.map((p) => (
          <button
            key={p.id}
            role="tab"
            aria-selected={p.id === pairId}
            className={`${s.netTab} ${p.id === pairId ? s.netTabOn : ""}`}
            onClick={() => onChange(p.id)}
          >
            {p.label}
          </button>
        ))}
        <button
          type="button"
          className={s.searchPairBtn}
          onClick={onOpenSearch}
          title="Search all tokens or paste address"
        >
          <span>🔍</span>
          <span>Find pair</span>
        </button>
      </div>
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
  outDecimals,
  outSymbol,
  explorer,
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
  tx: { phase: string; hash?: string; note?: string; received?: bigint };
  balance: bigint | null;
  decimals: number;
  outDecimals: number;
  outSymbol: string;
  explorer: string;
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
          {tx.note
            ? `Swap ${tx.note}. `
            : tx.received !== undefined
              ? `Filled. ${units(tx.received, outDecimals, 6)} ${outSymbol} received, and the pool still holds nothing. `
              : "Filled, and the pool still holds nothing. "}
          {tx.hash && explorer ? (
            <a href={`${explorer}/tx/${tx.hash}`} target="_blank" rel="noopener noreferrer" className="hex num">
              {short(tx.hash)}
            </a>
          ) : (
            <span className="hex num">{tx.hash ? short(tx.hash) : ""}</span>
          )}
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
        <span className={`label ${s.proofSubLabel}`}>
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
  slices,
}: {
  makers: MakersResponse | null;
  used: Set<string>;
  decimals: number;
  slices?: RouteResponse["slices"];
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
          <th>vs Oracle</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((m) => {
          const isUsed = used.has(m.maker.toLowerCase());
          const slice = isUsed
            ? (slices?.find(
                (s) => s.maker.toLowerCase() === m.maker.toLowerCase() && s.depth === m.depth
              ) ??
              slices?.find(
                (s) => s.maker.toLowerCase() === m.maker.toLowerCase()
              ))
            : undefined;

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
                    <span className={s.barGap} />
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
              <td>
                {slice ? (
                  slice.oracleDeviationBps === null ? (
                    <span className={s.noOracle}>no oracle for this pair</span>
                  ) : (
                    (() => {
                      const bps = BigInt(slice.oracleDeviationBps);
                      // 25 bps threshold: Aqua constant-product curves within 25 bps of live oracle
                      // track par closely; outside 25 bps indicates higher slippage or wider spread.
                      const isOk = bps >= -25n && bps <= 25n;
                      return (
                        <span className={`${s.badge} ${isOk ? s.badgeOk : s.badgeLoss}`}>
                          {bps > 0n ? `+${bps}` : `${bps}`} bps
                        </span>
                      );
                    })()
                  )
                ) : (
                  <span className={`num ${s.dim}`}>--</span>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
      {hidden > 0 && (
        <tfoot>
          <tr>
            <td colSpan={7} className={`label ${s.dormant}`}>
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
  const [pricing, setPricing] = useState<"xyc" | "oracle">("xyc");
  const [rangePreset, setRangePreset] = useState<RangePreset>("10");
  const [spotPrice, setSpotPrice] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shippedHash, setShippedHash] = useState<Hex | null>(null);
  const [beaconSpreadBps, setBeaconSpreadBps] = useState<number | null>(null);

  const { sendTransactionAsync } = useSendTransaction();

  const isBeaconEligible =
    net.id === 84532 &&
    ((tokenIn.address.toLowerCase() === net.weth.toLowerCase() && tokenOut.address.toLowerCase() === net.usdc.toLowerCase()) ||
     (tokenIn.address.toLowerCase() === net.usdc.toLowerCase() && tokenOut.address.toLowerCase() === net.weth.toLowerCase()));

  useEffect(() => {
    setShippedHash(null);
    setError(null);
    setBusy(false);
    setPricing("xyc");
  }, [net.id]);

  useEffect(() => {
    if (!isBeaconEligible && pricing === "oracle") {
      setPricing("xyc");
    }
  }, [isBeaconEligible, pricing]);

  // BeaconStrategy's spread is immutable, set once at deploy -- so read it
  // from the contract rather than keep a second copy of the number typed
  // into this component, which a redeploy would silently make wrong.
  useEffect(() => {
    if (!isBeaconEligible) return;
    let active = true;
    fetch(`/api/beacon-spread?chain=${net.id}`)
      .then((r) => r.json())
      .then((json: { available: boolean; spreadBps?: number }) => {
        if (active) setBeaconSpreadBps(json.available ? json.spreadBps ?? null : null);
      })
      .catch(() => {
        if (active) setBeaconSpreadBps(null);
      });
    return () => {
      active = false;
    };
  }, [isBeaconEligible, net.id]);

  const calcClaimOut = useCallback(
    (inStr: string, _preset: RangePreset, spot: number | null) => {
      if (!spot || spot <= 0) return;
      const numIn = parseFloat(inStr);
      if (isNaN(numIn) || numIn <= 0) return;

      const isWethIn = tokenIn.symbol.toUpperCase() === "WETH";
      const isWethOut = tokenOut.symbol.toUpperCase() === "WETH";

      if (isWethIn) {
        // Selling WETH for USD
        const out = numIn * spot;
        setClaimOut(out.toFixed(2));
      } else if (isWethOut) {
        // Selling USD for WETH
        const out = numIn / spot;
        setClaimOut(out.toFixed(4));
      } else {
        const out = numIn * spot;
        setClaimOut(out.toFixed(tokenOut.decimals <= 6 ? 2 : 4));
      }
    },
    [tokenIn.symbol, tokenOut.symbol, tokenOut.decimals]
  );

  const handleSelectPreset = useCallback(
    (p: RangePreset) => {
      setRangePreset(p);
      if (!spotPrice || spotPrice <= 0) return;

      let currentIn = claimIn;
      if (!currentIn || parseFloat(currentIn) <= 0 || isNaN(parseFloat(currentIn))) {
        const isWethIn = tokenIn.symbol.toUpperCase() === "WETH";
        currentIn = isWethIn ? "0.5" : "1000";
        setClaimIn(currentIn);
      }
      calcClaimOut(currentIn, p, spotPrice);
    },
    [claimIn, spotPrice, tokenIn.symbol, calcClaimOut]
  );

  // Auto-populate sensible defaults when live spot price resolves
  useEffect(() => {
    if (spotPrice && spotPrice > 0 && !claimIn && !claimOut) {
      const isWethIn = tokenIn.symbol.toUpperCase() === "WETH";
      const isWethOut = tokenOut.symbol.toUpperCase() === "WETH";
      const initialIn = isWethIn ? "0.5" : "1000";
      setClaimIn(initialIn);
      const initialOut = isWethIn
        ? (0.5 * spotPrice).toFixed(2)
        : isWethOut
        ? (1000 / spotPrice).toFixed(4)
        : "1000";
      setClaimOut(initialOut);
    }
  }, [spotPrice, tokenIn.symbol, tokenOut.symbol, claimIn, claimOut]);

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
          feeBps: pricing === "oracle" ? 0 : (feeBps ? Number(feeBps) : 0),
          pricing,
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
        <h2 className={s.sectionTitle}>Ship a strategy &mdash; {tokenIn.symbol} / {tokenOut.symbol}</h2>
        <span className="label">become a maker</span>
      </div>
      <div className={s.shipCard}>
        <div className={s.field}>
          <div className={s.fieldHead}>
            <span className="label">Pricing model</span>
          </div>
          <div className={s.pricingRow}>
            <div className={s.pricingTabs} role="radiogroup" aria-label="Pricing model">
              <button
                type="button"
                role="radio"
                aria-checked={pricing === "xyc"}
                className={`${s.pricingTab} ${pricing === "xyc" ? s.pricingTabOn : ""}`}
                onClick={() => setPricing("xyc")}
              >
                Constant-product curve
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={pricing === "oracle"}
                disabled={!isBeaconEligible}
                className={`${s.pricingTab} ${pricing === "oracle" ? s.pricingTabOn : ""} ${!isBeaconEligible ? s.pricingTabDisabled : ""}`}
                onClick={() => {
                  if (isBeaconEligible) setPricing("oracle");
                }}
              >
                Oracle (Chainlink, via Beacon)
              </button>
            </div>
          </div>
          {!isBeaconEligible ? (
            <p className={s.shipCaption}>
              Only available for WETH/USDC on Base Sepolia right now
            </p>
          ) : (
            <p className={s.shipCaption}>
              {pricing === "oracle"
                ? "BeaconStrategy: prices off Chainlink oracle mid minus fixed spread via SwapVM opcode 0x20 (Extruction)."
                : "Standard SwapVM XYC invariant curve."}
            </p>
          )}
        </div>

        <PriceChart
          chainId={net.id}
          tokenIn={tokenIn}
          tokenOut={tokenOut}
          pricing={pricing}
          preset={rangePreset}
          onSelectPreset={handleSelectPreset}
          onSpotPrice={setSpotPrice}
        />

        <div className={s.field}>
          <div className={s.fieldHead}>
            <span className="label">Claim {tokenIn.symbol}</span>
          </div>
          <div className={s.amountRow}>
            <input
              value={claimIn}
              inputMode="decimal"
              onChange={(e) => {
                // Typing in either claim field is a deliberate override of
                // whatever a preset last filled in -- so, symmetrically with
                // "you receive" below, it drops to "custom" and only touches
                // the field being edited. Auto-recalculating the other field
                // here too would mean the two inputs behave differently
                // depending on which one the user happens to type into first.
                setClaimIn(e.target.value);
                setRangePreset("custom");
              }}
              aria-label={`Claim amount for ${tokenIn.symbol}`}
              placeholder="0.0"
            />
            <span className={s.ticker}>
              <TokenIcon chainId={net.id} address={tokenIn.address as Address} symbol={tokenIn.symbol} size={16} />
              {tokenIn.symbol}
            </span>
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
              onChange={(e) => {
                setClaimOut(e.target.value);
                setRangePreset("custom");
              }}
              aria-label={`Claim amount for ${tokenOut.symbol}`}
              placeholder="0.0"
            />
            <span className={s.ticker}>
              <TokenIcon chainId={net.id} address={tokenOut.address as Address} symbol={tokenOut.symbol} size={16} />
              {tokenOut.symbol}
            </span>
          </div>
        </div>

        {pricing === "oracle" ? (
          <div className={s.field}>
            <div className={s.fieldHead}>
              <span className="label">Your fee (spread)</span>
            </div>
            <div className={s.amountRow}>
              <input
                value={beaconSpreadBps === null ? "…" : String(beaconSpreadBps)}
                disabled
                readOnly
                aria-label="Fee in basis points"
                className={s.inputDisabled}
              />
              <span className={s.ticker}>bps (fixed)</span>
            </div>
            <p className={s.shipCaption}>
              {beaconSpreadBps === null
                ? "Reading the deployed contract's fixed spread…"
                : `BeaconStrategy charges a fixed ${(beaconSpreadBps / 100).toFixed(2)}% spread, read live from the contract — not configurable here`}
            </p>
          </div>
        ) : (
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
        )}

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

