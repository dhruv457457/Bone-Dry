"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import s from "./app.module.css";
import { units, toRaw, short } from "@/lib/format";
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
import type { MakersResponse, RouteResponse, PoolResponse, CoverageResponse, AppsResponse, ExposureResponse } from "./types";
import { TokenIcon } from "./TokenIcon";
import { CopyButton } from "./CopyButton";
import { DepthChart, type RangePreset } from "./app/DepthChart";
import { Header, FindingLine, ReadOnlyExplainer, WrongChain, Footer, TABS, type Tab } from "./app/Shell";
import { Swap } from "./app/Swap";
import { Explore } from "./app/Explore";
import { Portfolio } from "./app/Portfolio";
import { Lookup } from "./app/Lookup";
import { TokenSearchModal } from "./TokenSearchModal";
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
  const [chainId, setChainId] = useState<NetworkId>(() => {
    if (typeof window !== "undefined") {
      const c = new URLSearchParams(window.location.search).get("chain");
      if (c === "8453") return 8453;
      if (c === "84532") return 84532;
      if (c === "1") return 1;
    }
    return DEFAULT_NETWORK;
  });
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
    else if (c === "1") setChainId(1);

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
  const [tab, setTab] = useState<Tab>("swap");

  useEffect(() => {
    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      const t = params.get("tab");
      if (TABS.includes(t as Tab)) setTab(t as Tab);
      const a = params.get("address");
      if (a) setDeepAddress(a);
    }
  }, []);

  const [deepAddress, setDeepAddress] = useState<string | undefined>();
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
  // The finding, not the swap, is the headline. Used to be pinned to Base
  // mainnet unconditionally -- true once, when Base was the only network with
  // real (not our own seeded) Aqua data, so testing on Sepolia should not
  // silently swap the headline for a claim about our own test makers. Now
  // that Ethereum is a second real network, pinning stayed wrong the other
  // direction: a viewer on Ethereum saw a label that said "Ethereum" next to
  // a number that was quietly still Base's. Follows the selected network
  // whenever it carries real data (aquaIsOurs === false); still falls back
  // to Base specifically for Sepolia, whose makers are ours.
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
    if (!net.hook || !net.wellhead) {
      setBusy(false);
      setRoute(null);
      setMakers(null);
      setPool(null);
      return;
    }
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
  }, [tokenIn.address, tokenOut.address, amountIn, pKey, chainId, net.hook, net.wellhead]);

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

  // Fetched at the same depth as the finding above it. At first=12 the rail
  // could announce 145 short positions and the Evidence tab it links to would
  // then list twelve — the headline and its own proof disagreeing on screen. It is also the slowest call: a multicall per position.
  // A failure here used to be swallowed, so the panel simply never appeared and
  // nothing said why — say why instead.
  useEffect(() => {
    let live = true;
    setCoverage(null);
    setCoverageError(null);
    getJson<CoverageResponse>(`/api/coverage?chain=${chainId}&first=200`, 60_000)
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
    const findingChain = net.aquaIsOurs ? 8453 : net.id;
    getJson<CoverageResponse>(`/api/coverage?chain=${findingChain}&first=200`, 60_000)
      .then((c) => {
        if (live && c.available !== false && !c.error) setFinding(c);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [net.id, net.aquaIsOurs]);

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

  const stamp = busy ? "reading…" : "read just now";

  return (
    <div className={s.root}>
      <Header
        tab={tab}
        onTab={setTab}
        chainId={chainId}
        onChain={setChainId}
        busy={busy}
        wallet={<ConnectButton chainStatus="none" showBalance={false} accountStatus="address" />}
      />

      {wrongChain ? (
        <WrongChain netName={net.label} onFix={() => switchChain({ chainId })} />
      ) : null}

      <main className={s.main}>
        {tab === "swap" && (
          !net.hook || !net.wellhead ? (
            <ReadOnlyExplainer
              netName={net.label}
              tabName="swap"
              onSwitchChain={setChainId}
              onExplore={() => setTab("explore")}
            />
          ) : (
            <Swap
              finding={finding}
              chainId={chainId}
              net={net}
              tokenIn={tokenIn}
              tokenOut={tokenOut}
              input={input}
              onInput={setInput}
              balance={balance}
              route={route}
              makers={makers}
              pool={pool}
              busy={busy}
              error={error}
              connected={isConnected}
              wrongChain={wrongChain}
              txPhase={txState.phase}
              txHash={txState.hash}
              txNote={txState.note}
              received={txState.received}
              onSwap={executeSwap}
              onFlip={() => setFlipped((f) => !f)}
              onPickToken={(which) => {
                setSearchTarget(which);
                setSearchModalOpen(true);
              }}
              onExplore={() => setTab("explore")}
              onLookup={() => setTab("lookup")}
              quoteStamp={stamp}
            />
          )
        )}

        {tab === "provide" && (
          !net.hook ? (
            <ReadOnlyExplainer
              netName={net.label}
              tabName="provide"
              onSwitchChain={setChainId}
              onExplore={() => setTab("explore")}
            />
          ) : (
            <>
              <FindingLine
                finding={finding}
                chainLabel={net.aquaIsOurs ? NETWORKS[8453].label : net.label}
                onEvidence={() => setTab("explore")}
                stamp={stamp}
              />
              <ShipStrategy
                net={net}
                tokenIn={tokenIn}
                tokenOut={tokenOut}
                address={address}
                wrongChain={wrongChain}
                onShipped={load}
                onPickPair={() => {
                  setSearchTarget("pair");
                  setSearchModalOpen(true);
                }}
              />
            </>
          )
        )}

        {tab === "portfolio" && (
          <>
            <FindingLine
              finding={finding}
              chainLabel={net.aquaIsOurs ? NETWORKS[8453].label : net.label}
              onEvidence={() => setTab("explore")}
              stamp={stamp}
            />
            <Portfolio
              chainId={chainId}
              net={net}
              address={address}
              onProvide={() => setTab("provide")}
              onExplore={() => setTab("explore")}
              onLookup={() => setTab("lookup")}
              connectButton={<ConnectButton chainStatus="none" showBalance={false} />}
            />
          </>
        )}

        {tab === "explore" && (
          <Explore
            coverage={coverage}
            coverageError={coverageError}
            apps={appsData}
            appsError={appsError}
            net={net}
            onLookup={() => setTab("lookup")}
            onRetry={() => setChainId(chainId)}
          />
        )}

        {tab === "lookup" && (
          <Lookup chainId={chainId} netName={net.label} initial={deepAddress} />
        )}
      </main>

      <Footer net={net} stamp={stamp} />

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

function ShipStrategy({
  net,
  tokenIn,
  tokenOut,
  address,
  wrongChain,
  onShipped,
  onPickPair,
}: {
  net: Network;
  tokenIn: Token;
  tokenOut: Token;
  address?: Address;
  wrongChain: boolean;
  onShipped: () => void;
  onPickPair?: () => void;
}) {
  const [openStep, setOpenStep] = useState<1 | 2 | 3>(1);
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

  /**
   * What this wallet has already promised, and what it actually holds.
   *
   * This is the panel the whole screen is built around: Aqua will accept an
   * over-promise without complaint, so the only place anyone is told is here,
   * before they sign. Read from the same endpoint Lookup uses, so a maker
   * checking themselves and a stranger checking them see the same figures.
   */
  const [exposure, setExposure] = useState<ExposureResponse | null>(null);
  useEffect(() => {
    if (!address) {
      setExposure(null);
      return;
    }
    let live = true;
    fetch(`/api/exposure?chain=${net.id}&maker=${address}`)
      .then((r) => r.json())
      .then((d: ExposureResponse) => live && !d.error && d.available !== false && setExposure(d))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [address, net.id, shippedHash]);

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

  // Held, already promised, and what is therefore free to promise — all in the
  // token being claimed. `capacity` floors at zero: a wallet already short does
  // not have negative room to promise into, it has none.
  const pos = exposure?.positions.find(
    (x) => x.token.toLowerCase() === tokenIn.address.toLowerCase()
  );
  const held = pos ? BigInt(pos.held) : null;
  const alreadyPromised = pos ? BigInt(pos.claimed) : 0n;
  const capacity = held === null ? null : held > alreadyPromised ? held - alreadyPromised : 0n;
  const thisClaim = (() => {
    try {
      return BigInt(toRaw(claimIn || "0", tokenIn.decimals));
    } catch {
      return 0n;
    }
  })();
  const coverPct =
    capacity === null || thisClaim === 0n
      ? 100
      : Math.min(100, Number((capacity * 10000n) / thisClaim) / 100);
  const covered = coverPct >= 100;
  const shortBy = capacity !== null && thisClaim > capacity ? thisClaim - capacity : 0n;

  return (
    <div className={s.in}>
      <div style={{ marginBottom: 20, display: "flex", justifyContent: "space-between", alignItems: "flex-end", flexWrap: "wrap", gap: 16 }}>
        <div>
          <h1 className={`${s.display} ${s.h1}`}>Ship a strategy</h1>
          <p style={{ margin: 0, color: "var(--ink2)", maxWidth: "60ch", fontSize: 15 }}>
            Aqua lets you promise the same tokens twice. This is where you&apos;d see it.
          </p>
        </div>
        {onPickPair && (
          <button
            type="button"
            className={s.ticker}
            onClick={onPickPair}
            style={{ cursor: "pointer", padding: "5px 14px 5px 8px" }}
            title="Change trading pair"
          >
            <div style={{ display: "flex", alignItems: "center", marginRight: 2 }}>
              <TokenIcon chainId={net.id} address={tokenIn.address as Address} symbol={tokenIn.symbol} size={20} />
              <span style={{ marginLeft: -4 }}>
                <TokenIcon chainId={net.id} address={tokenOut.address as Address} symbol={tokenOut.symbol} size={20} />
              </span>
            </div>
            <span style={{ fontWeight: 600 }}>{tokenIn.symbol} / {tokenOut.symbol}</span>
            <span style={{ fontSize: 10, color: "var(--ink3)", marginLeft: 4 }}>▾</span>
          </button>
        )}
      </div>

      <div className={s.cols}>
        <div className={s.stack} style={{ flex: "2 1 480px", minWidth: 0 }}>
          {/* ── 01 · Pricing mechanism ── */}
          <section className={`${s.card} ${s.cardPad}`}>
            <button
              type="button"
              onClick={() => setOpenStep(1)}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                width: "100%",
                background: "transparent",
                border: "none",
                padding: 0,
                cursor: "pointer",
                textAlign: "left",
                marginBottom: openStep === 1 ? 14 : 0,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <span className={s.label} style={{ margin: 0 }}>
                  01 · Pricing mechanism
                </span>
                {openStep !== 1 && (
                  <span className={s.pill} style={{ fontSize: 11 }}>
                    {pricing === "oracle" ? "Chainlink-priced" : "Constant product"}
                  </span>
                )}
              </div>
              <span style={{ fontSize: 12, color: "var(--ink3)" }}>
                {openStep === 1 ? "▲" : "▼"}
              </span>
            </button>

            {openStep === 1 && (
              <>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12, paddingBottom: 10, borderBottom: "1px solid var(--line)" }}>
                  <span style={{ fontSize: 13, color: "var(--ink2)" }}>Target pair:</span>
                  {onPickPair && (
                    <button
                      type="button"
                      className={s.ticker}
                      onClick={onPickPair}
                      style={{ cursor: "pointer", padding: "3px 10px 3px 6px", fontSize: 11.5 }}
                      title="Change trading pair"
                    >
                      <div style={{ display: "flex", alignItems: "center", marginRight: 2 }}>
                        <TokenIcon chainId={net.id} address={tokenIn.address as Address} symbol={tokenIn.symbol} size={16} />
                        <span style={{ marginLeft: -4 }}>
                          <TokenIcon chainId={net.id} address={tokenOut.address as Address} symbol={tokenOut.symbol} size={16} />
                        </span>
                      </div>
                      <span>{tokenIn.symbol} / {tokenOut.symbol}</span>
                      <span style={{ fontSize: 9, color: "var(--ink3)", marginLeft: 3 }}>▾</span>
                    </button>
                  )}
                </div>

                <div className={s.modelGrid} role="radiogroup" aria-label="Pricing model">
                  <button
                    type="button"
                    role="radio"
                    aria-checked={pricing === "xyc"}
                    className={`${s.model} ${pricing === "xyc" ? s.modelOn : ""}`}
                    onClick={() => setPricing("xyc")}
                  >
                    <span className={s.modelName}>Constant product</span>
                    <span className={s.modelDesc}>
                      A curve. Price moves with every fill, no external input, always quotable.
                    </span>
                    <span className={s.modelNote}>available on every network</span>
                  </button>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={pricing === "oracle"}
                    disabled={!isBeaconEligible}
                    className={`${s.model} ${pricing === "oracle" ? s.modelOn : ""} ${!isBeaconEligible ? s.modelOff : ""}`}
                    onClick={() => {
                      if (isBeaconEligible) setPricing("oracle");
                    }}
                  >
                    <span className={s.modelName}>Chainlink-priced</span>
                    <span className={s.modelDesc}>
                      Quotes off the oracle answer minus a fixed spread. No curve, no impact — and it
                      stops quoting when the feed goes stale.
                    </span>
                    <span
                      className={s.modelNote}
                      style={!isBeaconEligible ? { color: "var(--tan)" } : undefined}
                    >
                      {isBeaconEligible ? "available here" : "WETH/USDC on Base Sepolia only"}
                    </span>
                  </button>
                </div>

                <div style={{ marginTop: 16, display: "flex", justifyContent: "flex-end" }}>
                  <button
                    type="button"
                    className={`${s.btn} ${s.btnSolid}`}
                    onClick={() => setOpenStep(2)}
                  >
                    Next: Depth &amp; range →
                  </button>
                </div>
              </>
            )}
          </section>

          {/* ── 02 · Depth and range ── */}
          <section className={`${s.card} ${s.cardPad}`}>
            <button
              type="button"
              onClick={() => setOpenStep(2)}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                width: "100%",
                background: "transparent",
                border: "none",
                padding: 0,
                cursor: "pointer",
                textAlign: "left",
                marginBottom: openStep === 2 ? 14 : 0,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <span className={s.label} style={{ margin: 0 }}>
                  02 · Depth and range
                </span>
                {openStep !== 2 && (
                  <span className={s.pill} style={{ fontSize: 11 }}>
                    {rangePreset === "full" ? "Full range" : rangePreset === "custom" ? "Custom" : `±${rangePreset}%`}
                    {spotPrice ? ` · $${spotPrice.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : ""}
                  </span>
                )}
              </div>
              <span style={{ fontSize: 12, color: "var(--ink3)" }}>
                {openStep === 2 ? "▲" : "▼"}
              </span>
            </button>

            {openStep === 2 && (
              <>
                <DepthChart
                  chainId={net.id}
                  tokenIn={tokenIn}
                  tokenOut={tokenOut}
                  pricing={pricing}
                  preset={rangePreset}
                  spreadBps={beaconSpreadBps}
                  onSelectPreset={handleSelectPreset}
                  onSpotPrice={setSpotPrice}
                />
                <p style={{ margin: "14px 0 0", fontSize: 13, color: "var(--ink3)", maxWidth: "78ch" }}>
                  The curve is the depth <em>your</em> strategy offers at each price, computed from your
                  claim. Chainlink returns one answer, not a series, so no historical price line is drawn.
                </p>
                <div style={{ marginTop: 16, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <button
                    type="button"
                    className={s.btn}
                    onClick={() => setOpenStep(1)}
                  >
                    ← Back: Pricing
                  </button>
                  <button
                    type="button"
                    className={`${s.btn} ${s.btnSolid}`}
                    onClick={() => setOpenStep(3)}
                  >
                    Next: Claim &amp; fee →
                  </button>
                </div>
              </>
            )}
          </section>

          {/* ── 03 · Claim and fee ── */}
          <section className={`${s.card} ${s.cardPad}`}>
            <button
              type="button"
              onClick={() => setOpenStep(3)}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                width: "100%",
                background: "transparent",
                border: "none",
                padding: 0,
                cursor: "pointer",
                textAlign: "left",
                marginBottom: openStep === 3 ? 14 : 0,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <span className={s.label} style={{ margin: 0 }}>
                  03 · Claim and fee
                </span>
                {openStep !== 3 && (
                  <span className={s.pill} style={{ fontSize: 11 }}>
                    {claimIn || "0"} {tokenIn.symbol} / {claimOut || "0"} {tokenOut.symbol}
                    {pricing === "oracle" ? (beaconSpreadBps !== null ? ` · ${beaconSpreadBps} bps spread` : "") : ` · ${feeBps || "0"} bps fee`}
                  </span>
                )}
              </div>
              <span style={{ fontSize: 12, color: "var(--ink3)" }}>
                {openStep === 3 ? "▲" : "▼"}
              </span>
            </button>

            {openStep === 3 && (
              <>
                <div className={s.claimGrid}>
                  <div className={`${s.claimBox} ${covered ? "" : s.claimBoxWarn}`}>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6, gap: 8 }}>
                      <span className={s.label} style={{ fontSize: 9.5, letterSpacing: ".11em" }}>
                        Claim {tokenIn.symbol}
                      </span>
                      <span className={s.mono} style={{ fontSize: 10.5, color: "var(--ink3)" }}>
                        held {held === null ? "—" : units(held, tokenIn.decimals, 2)}
                      </span>
                    </div>
                    <input
                      className={s.claimIn}
                      value={claimIn}
                      inputMode="decimal"
                      onChange={(e) => {
                        setClaimIn(e.target.value);
                        setRangePreset("custom");
                      }}
                      aria-label={`Claim amount for ${tokenIn.symbol}`}
                      placeholder="0.0"
                    />
                  </div>

                  <div className={s.claimBox}>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6, gap: 8 }}>
                      <span className={s.label} style={{ fontSize: 9.5, letterSpacing: ".11em" }}>
                        Claim {tokenOut.symbol}
                      </span>
                    </div>
                    <input
                      className={s.claimIn}
                      value={claimOut}
                      inputMode="decimal"
                      onChange={(e) => {
                        setClaimOut(e.target.value);
                        setRangePreset("custom");
                      }}
                      aria-label={`Claim amount for ${tokenOut.symbol}`}
                      placeholder="0.0"
                    />
                  </div>

                  <div className={s.claimBox}>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6, gap: 8 }}>
                      <span className={s.label} style={{ fontSize: 9.5, letterSpacing: ".11em" }}>
                        Your fee
                      </span>
                      <span className={s.mono} style={{ fontSize: 10.5, color: "var(--ink3)" }}>
                        {pricing === "oracle" ? "bps · fixed" : "bps"}
                      </span>
                    </div>
                    {pricing === "oracle" ? (
                      <span className={s.claimIn} style={{ display: "block", color: "var(--ink3)" }}>
                        {beaconSpreadBps === null ? "…" : beaconSpreadBps}
                      </span>
                    ) : (
                      <input
                        className={s.claimIn}
                        value={feeBps}
                        inputMode="numeric"
                        onChange={(e) => setFeeBps(e.target.value)}
                        aria-label="Fee in basis points"
                        placeholder="0"
                      />
                    )}
                  </div>
                </div>
                <p style={{ margin: "12px 0 0", fontSize: 13, color: "var(--ink3)" }}>
                  {pricing === "oracle"
                    ? beaconSpreadBps === null
                      ? "Reading the deployed contract's fixed spread…"
                      : `BeaconStrategy charges a fixed ${(beaconSpreadBps / 100).toFixed(2)}% spread, read live from the contract — not configurable here.`
                    : "Spread you earn on every fill. 0 is fine to start."}
                </p>
                <div style={{ marginTop: 16, display: "flex", justifyContent: "flex-start" }}>
                  <button
                    type="button"
                    className={s.btn}
                    onClick={() => setOpenStep(2)}
                  >
                    ← Back: Depth &amp; range
                  </button>
                </div>
              </>
            )}
          </section>
        </div>

        <aside
          style={{
            flex: "1 1 320px",
            minWidth: 0,
            display: "flex",
            flexDirection: "column",
            gap: 14,
            position: "sticky",
            top: 84,
            alignSelf: "flex-start",
          }}
        >
          <section className={`${s.coverCard} ${covered ? "" : s.coverCardWarn}`}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
              <span className={s.pulseDot}>
                <span style={{ background: covered ? "var(--ink)" : "var(--short)" }} />
                <span style={{ background: covered ? "var(--ink)" : "var(--short)" }} />
              </span>
              <p className={s.label} style={{ margin: 0, letterSpacing: ".14em" }}>
                If you publish this
              </p>
            </div>

            {!address ? (
              <p style={{ margin: 0, fontSize: 14.5, color: "var(--ink2)" }}>
                Connect a wallet and this becomes a live check against what you actually hold.
              </p>
            ) : held === null ? (
              <p style={{ margin: 0, fontSize: 14.5, color: "var(--ink2)" }}>
                Reading what you hold and what you have already promised…
              </p>
            ) : (
              <>
                <p
                  className={`${s.coverFig} ${s.roll}`}
                  style={{ color: covered ? "var(--ink)" : "var(--short)" }}
                >
                  {Math.round(coverPct)}%
                </p>
                <p style={{ margin: "0 0 16px", fontSize: 14.5, color: "var(--ink2)", textWrap: "pretty" }}>
                  {covered
                    ? "Every promise you have out, including this one, is covered by tokens you actually hold."
                    : `Publishing this leaves you ${units(shortBy, tokenIn.decimals, 2)} ${tokenIn.symbol} short. Aqua will accept it. Bone Dry will list you.`}
                </p>
                <div className={s.bar} style={{ height: 8, marginBottom: 14, width: "100%" }}>
                  <span
                    className={s.barFill}
                    style={{ width: `${coverPct}%`, background: covered ? "var(--ink)" : "var(--short)" }}
                  />
                </div>
                {[
                  { label: "Held in wallet", value: units(held, tokenIn.decimals, 2), warn: false },
                  {
                    label: "Already promised",
                    value: units(alreadyPromised, tokenIn.decimals, 2),
                    warn: false,
                  },
                  {
                    label: "Free to promise",
                    value: units(capacity ?? 0n, tokenIn.decimals, 2),
                    warn: false,
                  },
                  { label: "This strategy claims", value: claimIn || "0", warn: !covered },
                ].map((c) => (
                  <div className={s.kv} key={c.label} style={{ fontSize: 13.5 }}>
                    <span style={{ color: "var(--ink3)" }}>{c.label}</span>
                    <span
                      className={s.mono}
                      style={{ fontSize: 12, color: c.warn ? "var(--short)" : "var(--ink)" }}
                    >
                      {c.value}
                    </span>
                  </div>
                ))}
              </>
            )}
            <p style={{ margin: "14px 0 0", fontSize: 13, color: "var(--ink3)" }}>
              Aqua accepts an over-promise without complaint. This is Bone Dry&apos;s own check, run
              against you before you sign.
            </p>
          </section>

          <button
            className={`${s.btnBlock} ${!covered && address ? s.btnBlockShort : ""}`}
            style={{ marginTop: 0 }}
            onClick={handleShip}
            disabled={disabled}
          >
            {busy
              ? "Shipping…"
              : !address
                ? "Connect wallet to publish"
                : wrongChain
                  ? "Switch network to publish"
                  : amountInvalid
                    ? "Enter claim amounts"
                    : covered
                      ? "Publish strategy"
                      : "Publish anyway — over-promised"}
          </button>

          {shippedHash ? (
            <p style={{ margin: 0, fontSize: 13.5, color: "var(--ink2)", display: "inline-flex", alignItems: "center" }}>
              <span>Shipped. You are now a maker on this pair — strategy{" "}</span>
              <span className={s.mono} style={{ fontSize: 12, margin: "0 4px" }}>
                {short(shippedHash)}
              </span>
              <CopyButton value={shippedHash} title="Copy strategy hash" />
            </p>
          ) : null}
          {error ? (
            <p className={s.mono} style={{ margin: 0, fontSize: 11.5, color: "var(--short)" }}>
              {error}
            </p>
          ) : null}
          <p style={{ margin: 0, fontSize: 13, color: "var(--ink3)" }}>
            {net.testnet
              ? `${net.label} — faucet tokens are free, contracts are identical.`
              : `Live on ${net.label}. One signature; indexed within two seconds.`}
          </p>
        </aside>
      </div>
    </div>
  );
}
