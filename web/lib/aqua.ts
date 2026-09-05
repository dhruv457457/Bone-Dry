import { decodeAbiParameters, parseAbiParameters, type Address, type Hex } from "viem";
import { client, AQUA, ROUTER, aquaAbi, erc20Abi } from "./chain";

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
}): Promise<Strategy[]> {
  const latest = opts?.toBlock ?? (await client.getBlockNumber());
  const from = opts?.fromBlock ?? (latest > 50_000n ? latest - 50_000n : 0n);
  const page = opts?.pageSize ?? 9_999n;

  const shipped: Strategy[] = [];
  const docked = new Set<string>();

  for (let start = from; start <= latest; start += page + 1n) {
    const end = start + page > latest ? latest : start + page;

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
  }

  return shipped.filter((s) => !docked.has(`${s.maker.toLowerCase()}:${s.strategyHash}`));
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
