import { erc20Abi, lensAbi } from "@/lib/chain";
import { networkFrom, clientFor } from "@/lib/networks";
import { positionsFromGraph, indexStateOf } from "@/lib/graph";
import { cachedStrategies, positionsFromRpc } from "@/lib/aqua";
import { positionsFromIndex } from "@/lib/indexedDepth";
import { tokensForChain } from "@/lib/tokenList";
import { uintParam, BadInput } from "@/lib/validate";
import { j, fail, chainFailure } from "@/lib/json";

export const dynamic = "force-dynamic";

/**
 * GET /api/coverage?first=
 *
 * The number Aqua cannot produce.
 *
 * Balances are keyed [maker][app][strategyHash][token] and the mapping is not
 * enumerable, so nothing on-chain can total what one maker has promised across
 * every strategy they have live. The subgraph can. Set that against the wallet
 * balance and the allowance and you get a coverage ratio — the honest answer to
 * "if everyone tried to fill against this maker at once, could they?"
 *
 * On Base today the answer is sometimes no, and not marginally: a maker with
 * eight live strategies committing 12,694 DEGEN holds none of it.
 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const n = networkFrom(url.searchParams.get("chain"));
    const client = clientFor(n);
    const LENS = n.lens;
    const first = uintParam(url.searchParams.get("first"), 25, 10, "first");

    let positions = await positionsFromGraph(n, first);
    let source = "aquifer-subgraph";

    // No subgraph in our own schema indexes this network -- not "unavailable,"
    // genuinely never configured (n.graphUrl is empty by design; see
    // networks.ts). Ethereum's real activity is too large to enumerate the
    // honest way this app otherwise would, so the background index (or, if
    // it has never run, a live RPC scan) answers a narrower question
    // instead: coverage for a known, curated set of tokens among the most
    // recent strategies, rather than every position that exists. A
    // subgraph-configured network that is merely unreachable or still
    // syncing does NOT fall into this branch -- that stays a reported
    // unavailability, not a silent swap to a different, partial answer.
    let rpcFallbackFailed = false;
    if (positions === null && !n.graphUrl) {
      const knownTokens = tokensForChain(n.id).map((t) => t.address);
      const indexed = await positionsFromIndex(n, knownTokens);
      if (indexed !== null) {
        positions = indexed;
        source = "indexed-db";
      } else {
        // Free RPCs on a fresh scan occasionally answer with an error a
        // reader has no use for -- an archive-token upsell, a rate limit, raw
        // JSON-RPC internals with the endpoint URL in it. That belongs in a
        // server log, not in a label a user reads as this network's
        // permanent status. Caught here so it degrades to the same honest
        // "unavailable, here's why" shape every other index gap in this app
        // already uses, instead of leaking whichever RPC happened to answer.
        try {
          const { strategies } = await cachedStrategies(n);
          positions = await positionsFromRpc(n, strategies, knownTokens);
          source = "rpc-log-paging";
        } catch (e) {
          console.warn(`[coverage] rpc fallback failed for ${n.label}:`, (e as Error).message?.slice(0, 300));
          rpcFallbackFailed = true;
        }
      }
    }

    // Not an error: this network simply has no index, or its index is not caught
    // up. A 503 here put a red line in the console on every load and told the
    // reader nothing they could act on, and the client cannot decide this for
    // itself — GRAPH_URL is server-only, so in the browser it always looks unset.
    if (positions === null) {
      return j({
        source: "none",
        available: false,
        chain: { id: n.id, label: n.label, testnet: n.testnet },
        reason: rpcFallbackFailed
          ? `the RPC scan for ${n.label} hit a transient error -- try again`
          : `the ${n.label} index is unavailable or still catching up`,
        positions: 0,
        underCollateralised: 0,
        unknown: 0,
        onchainCrossCheck: null,
        rows: [],
      });
    }
    if (positions.length === 0)
      return j({ source, available: true, positions: 0, rows: [] });

    // Decimals come from the token, not from an assumption. Committing 12,694 of
    // an 18-decimal token and 12,694 of a 6-decimal one are the same integer and
    // wildly different amounts.
    const calls = positions.flatMap((p) => [
      { address: p.token, abi: erc20Abi, functionName: "balanceOf", args: [p.maker] } as const,
      { address: p.token, abi: erc20Abi, functionName: "allowance", args: [p.maker, n.aqua] } as const,
      { address: p.token, abi: erc20Abi, functionName: "decimals", args: [] } as const,
    ]);
    const res = await client.multicall({ contracts: calls, allowFailure: true });

    const rows = positions.map((p, i) => {
      const b = res[i * 3];
      const a = res[i * 3 + 1];
      const dec = res[i * 3 + 2];
      // A read that failed is not a balance of zero. Treating it as one would
      // report a solvent maker as backed by nothing — inventing the exact finding
      // this endpoint exists to report. Unknown rows say so and are excluded from
      // the under-collateralised count.
      const known = b.status === "success" && a.status === "success";
      const wallet = b.status === "success" ? (b.result as bigint) : 0n;
      const allowance = a.status === "success" ? (a.result as bigint) : 0n;
      const decimals = dec.status === "success" ? Number(dec.result) : 18;
      const backed = wallet < allowance ? wallet : allowance;

      return {
        known,
        maker: p.maker,
        token: p.token,
        app: p.app,
        strategyHashes: p.strategyHashes,
        decimals,
        activeStrategies: p.activeStrategies,
        committed: p.totalCommitted,
        wallet,
        allowance,
        /** what all of those strategies could actually deliver between them */
        backed,
        /** basis points of the promise the maker can honour; 10000 = fully covered */
        coverageBps:
          !known ? -1n : p.totalCommitted > 0n ? (backed * 10_000n) / p.totalCommitted : 0n,
        shortfall: p.totalCommitted > backed ? p.totalCommitted - backed : 0n,
      };
    });

    // Composability, demonstrated rather than asserted. Lens.coverage() computes
    // the same ratio on-chain, but it takes the strategy hashes as calldata — it
    // cannot find them, because the mapping is not enumerable. The index supplies
    // exactly the list the contract cannot produce, and the two answers are then
    // independent computations over the same facts. If they disagree, one of them
    // is wrong and this says so rather than hiding it.
    // ...but only if both sides are looking at the same block. The index and the
    // RPC can sit at different heights — trivially so against a fork of the chain
    // the index watches — and a maker who moved funds in between will make two
    // correct answers look like a bug. Skew is reported, not silently resolved.
    const chainBlock = await client.getBlockNumber();
    const head = indexStateOf(n).head;
    const skew = chainBlock > head ? chainBlock - head : head - chainBlock;

    let verified:
      | { maker: string; token: string; onchainBps: string; agrees: boolean | null }[]
      | null = null;
    if (LENS) {
      const checkable = rows.filter((r) => r.known && r.strategyHashes.length > 0 && r.app);
      if (checkable.length > 0) {
        const lensCalls = checkable.map((r) => ({
          address: LENS as `0x${string}`,
          abi: lensAbi,
          functionName: "coverage",
          args: [r.maker, r.app!, r.strategyHashes, r.token],
        }));
        const lensRes = await client.multicall({ contracts: lensCalls, allowFailure: true });
        verified = checkable.map((r, i) => {
          const ok = lensRes[i].status === "success";
          const bps = ok ? (lensRes[i].result as unknown as [bigint, bigint, bigint])[2] : -1n;
          // Lens caps at 10000; the API does not, so compare against the cap.
          const capped = r.coverageBps > 10_000n ? 10_000n : r.coverageBps;
          return {
            maker: r.maker,
            token: r.token,
            onchainBps: bps.toString(),
            // null = inconclusive: the two sides read different blocks
            agrees: !ok ? false : bps === capped ? true : skew > 0n ? null : false,
          };
        });
      }
    }

    const uncovered = rows.filter((r) => r.known && r.coverageBps < 10_000n);
    return j({
      source,
      available: true,
      chain: { id: n.id, label: n.label, testnet: n.testnet },
      note:
        "committed is summed across every live strategy for that maker and token, " +
        "which no contract can do: Aqua's balance mapping is not enumerable",
      positions: rows.length,
      underCollateralised: uncovered.length,
      /** rows whose on-chain balance could not be read, and so prove nothing */
      unknown: rows.filter((r) => !r.known).length,
      /** null when no Lens is deployed on this chain */
      onchainCrossCheck: verified
        ? {
            checked: verified.length,
            agreed: verified.filter((v) => v.agrees === true).length,
            disagreements: verified.filter((v) => v.agrees === false).length,
            inconclusive: verified.filter((v) => v.agrees === null).length,
            indexBlock: head,
            chainBlock,
            blockSkew: skew,
            rows: verified,
          }
        : null,
      rows: rows.sort((a, b) => (a.coverageBps === b.coverageBps ? 0 : a.coverageBps < b.coverageBps ? -1 : 1)),
    });
  } catch (e) {
    if (e instanceof BadInput) return fail(e.message, 400);
    if ((e as Error).message?.startsWith("unknown chain")) return fail((e as Error).message, 400);
    const unreachable = chainFailure(e);
    if (unreachable) return unreachable;
    return fail((e as Error).message, 500);
  }
}
