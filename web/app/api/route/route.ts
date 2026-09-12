import { cachedStrategies, indexStrategies, measureDepth, mergeStrategies, type MakerDepth } from "@/lib/aqua";
import { dedupeByMaker, planLikeTap, filterFillable, encodeHookData, attachOracleDeviations } from "@/lib/router";
import { networkFrom, tokensOf, appsOf, type AquaApp } from "@/lib/networks";
import { allTokensFor } from "@/lib/pairs";
import { strategiesFromGraph, indexStateOf } from "@/lib/graph";
import { depthFromIndex } from "@/lib/indexedDepth";
import { addressParam, amountParam, distinct, BadInput } from "@/lib/validate";
import { j, fail, chainFailure } from "@/lib/json";

export const dynamic = "force-dynamic";

/**
 * GET /api/route?tokenIn=&tokenOut=&amountIn=
 *
 * The piece that cannot exist on-chain. Aqua stores no list of its makers, so the
 * candidate set has to be assembled off-chain and handed to the hook as calldata.
 * Returns the plan, a real quote for it from the router, and the encoded hookData.
 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const n = networkFrom(url.searchParams.get("chain"));
    const TOKENS = { ...tokensOf(n), ...allTokensFor(n.id) };
    const tokenIn = addressParam(url.searchParams.get("tokenIn"), n.usdc);
    const tokenOut = addressParam(url.searchParams.get("tokenOut"), n.weth);
    const amountIn = amountParam(url.searchParams.get("amountIn"), 100_000_000n);
    distinct(tokenIn, tokenOut);

    // Each Aqua app is its own book, and they cannot be merged.
    //
    // Aqua keys balances [maker][app][strategyHash][token] and pull() reads
    // msg.sender as the app (Aqua.sol:64), so a strategy shipped to one router
    // can only ever be filled by that router. A v4 pool binds exactly one hook
    // and Tap.router is immutable, so no single transaction can span two books.
    // We therefore plan each independently and return the best COMPLETE plan --
    // never a blend, which would not be executable.
    const books = appsOf(n);

    const planBook = async (book: AquaApp) => {
      const indexed = await depthFromIndex(n, tokenOut, book.app);
      let depths: MakerDepth[];
      let source: string;
      if (indexed !== null) {
        // The index is a candidate list, not a quote.
        //
        // Tap.sol:119 re-reads every candidate's depth live through
        // Lens.quotableDepth, and then either fills a maker whole or skips them —
        // a quote landing above `depth[i]` is a skip, never a clamp. So a plan
        // sized against indexed depth that has since fallen does not fill small;
        // every maker is skipped, `totalOut` reaches zero, and Tap.sol:176 throws
        // NoSolventMaker(). The taker pays gas to be refused by our own hook,
        // which is the single outcome this project promises never to produce.
        //
        // Measured on Base: one routed maker was indexed at 3,927,565,582,548 and
        // held 2,423,165,503,335 live — 38% less. The transaction reverted.
        depths = await measureDepth(n, indexed, tokenOut, book.app);
        source = "indexed-db + live depth recheck";
      } else {
        // The index for history, a short chain scan for the tail it has not reached.
        const fromGraph = await strategiesFromGraph(n, book.app);
        const rawStrategies =
          fromGraph ??
          (book.app.toLowerCase() === n.router.toLowerCase()
            ? (await cachedStrategies(n)).strategies
            : await indexStrategies(n, { app: book.app }));
        const strategies = rawStrategies.filter((s) => {
          if (!s.tokens || s.tokens.length === 0) return true;
          const toks = s.tokens.map((t) => t.toLowerCase());
          return toks.includes(tokenIn.toLowerCase()) && toks.includes(tokenOut.toLowerCase());
        });
        depths = await measureDepth(n, strategies, tokenOut, book.app);
        source = fromGraph ? "aquifer-subgraph" : n.graphUrl ? `rpc-log-paging (index ${indexStateOf(n).status})` : "rpc-log-paging";
      }

      // Having the token is not the same as being willing to part with it. Probe
      // each solvent maker once and drop the ones whose quote reverts, so their
      // share of the input is not thrown away on a fill that can never land.
      const { fillable, unfillable } = await filterFillable(n, depths, tokenIn, tokenOut, amountIn, book.app);

      // One candidate per maker: `depths` is per-strategy, and sibling strategies
      // of one maker all draw on the same wallet. This set is what ships in
      // hookData, so it is also the exact set Tap.sol sums its own totalDepth
      // over -- the two have to agree or every slice the hook computes is off.
      const candidates = dedupeByMaker(fillable);

      // Replay the hook rather than approximate it. Tap.sol re-derives every
      // slice on-chain from freshly-read depths and either fills a maker whole
      // or skips them; nothing it does resembles trimming a slice down.
      const plan = await planLikeTap(n, candidates, amountIn, tokenIn, tokenOut, book.app);
      return { book, source, depths, unfillable, candidates, plan };
    };

    const attempts = await Promise.all(books.map(planBook));

    // A book with no hook on this chain can be quoted but never filled, so it
    // cannot win -- routing to it would produce a plan with nowhere to send it.
    // It still appears in `alternatives`, because silently dropping a book is
    // how the second one went unnoticed in the first place.
    const fillableBooks = attempts.filter((a) => a.book.hook !== "");

    // Largest amountOut wins. Ties and all-zero fall to the first book, which is
    // the evidence book, so behaviour is unchanged whenever the second is empty.
    //
    // KNOWN WEAKNESS, deliberately left visible rather than papered over: this is
    // the standard exact-in definition of best execution, and it does not account
    // for a book that fills only part of the input. Measured on Base right now,
    // the Bone Dry book absorbs the whole 0.1 USDC at 17% of the oracle rate,
    // while the evidence book fills 97 units at 110% of it and leaves the rest
    // unsold. Maximising amountOut picks the first, which is right for a taker who
    // wants the input sold and wrong for one who would rather keep it.
    //
    // The response carries amountFilled and every alternative's amountOut, so the
    // surface can show the rate and let the taker choose. It must: routing someone
    // into a six-times-worse price without showing them the comparison is the kind
    // of silent decision this project exists to argue against.
    const best =
      fillableBooks.reduce<typeof attempts[number] | null>(
        (acc, a) => (acc === null || a.plan.amountOut > acc.plan.amountOut ? a : acc),
        null
      ) ?? attempts[0];

    const alternatives = attempts
      .filter((a) => a !== best)
      .map((a) => ({
        app: a.book.app,
        hook: a.book.hook || null,
        bookLabel: a.book.label,
        encumbranceAware: a.book.encumbranceAware,
        amountOut: a.plan.amountOut,
        makersUsed: a.plan.slices.length,
        makersConsidered: a.depths.length,
        fillable: a.book.hook !== "",
        reason: a.book.hook === "" ? "no hook on this chain can call this router" : undefined,
      }));

    const { source, depths, unfillable, candidates, plan, book } = best;
    const { slices, binding: clamped } = plan;

    if (slices.length === 0) {
      return j({
        source,
        app: book.app,
        hook: book.hook || null,
        bookLabel: book.label,
        encumbranceAware: book.encumbranceAware,
        alternatives,
        tokenIn: { ...TOKENS[tokenIn.toLowerCase()], address: tokenIn },
        tokenOut: { ...TOKENS[tokenOut.toLowerCase()], address: tokenOut },
        amountIn,
        // Same shape as the success branch: a consumer should not have to branch.
        amountFilled: 0n,
        unfilled: amountIn,
        slices: [],
        amountOut: 0n,
        singleMakerAmountOut: 0n,
        improvementBps: 0n,
        makersConsidered: depths.length,
        makersUsed: 0,
        makersSkipped: depths.filter((d) => !d.solvent).map((d) => d.maker),
        makersUnfillable: unfillable,
        clamped,
        hookData: null,
        reason:
          amountIn === 0n
            ? "nothing to swap"
            : "no solvent maker can deliver this token right now",
      });
    }

    // `plan.takeIn` is the number the wallet must send, and the replay already
    // proved the hook consumes all of it -- no re-derivation from the slices,
    // which would only reintroduce the rounding the replay just accounted for.
    const filled = plan.takeIn;

    // The comparison the split has to beat: the same input through the single
    // deepest maker alone. Run through the identical replay so the baseline is
    // subject to exactly the rules the split was, rather than a looser
    // approximation -- an earlier version cut corners here and reported
    // improvements over 10,000 bps because the baseline came out near zero.
    const single = await planLikeTap(n, candidates.slice(0, 1), filled, tokenIn, tokenOut, book.app);

    const improvementBps =
      single.amountOut > 0n ? ((plan.amountOut - single.amountOut) * 10_000n) / single.amountOut : 0n;

    return j({
      source,
      /** The Aqua app this plan fills from, and the v4 hook that can reach it.
       *  The taker must build its poolKey from THIS hook: a plan is only
       *  executable through the one router its strategies were shipped to. */
      app: book.app,
      hook: book.hook || null,
      bookLabel: book.label,
      encumbranceAware: book.encumbranceAware,
      /** The books that did not win, so a losing one is visible rather than erased. */
      alternatives,
      tokenIn: { ...TOKENS[tokenIn.toLowerCase()], address: tokenIn },
      tokenOut: { ...TOKENS[tokenOut.toLowerCase()], address: tokenOut },
      chain: { id: n.id, label: n.label, testnet: n.testnet },
      amountIn,
      /** what the route can actually absorb — below amountIn when depth ran out */
      amountFilled: filled,
      unfilled: amountIn - filled,
      makersConsidered: depths.length,
      makersUsed: slices.length,
      makersSkipped: depths.filter((d) => !d.solvent).map((d) => d.maker),
      /** solvent makers whose quote reverts — gated, wrong pair, or a program we cannot drive */
      makersUnfillable: unfillable,
      /** makers whose own ceiling held the whole fill below what was asked for */
      clamped,
      slices: await attachOracleDeviations(
        n,
        slices.map((s, i) => ({
          maker: s.maker,
          amountIn: s.amountIn,
          depth: s.depth,
          amountOut: plan.perMaker[i]?.amountOut ?? 0n,
        })),
        tokenIn,
        tokenOut,
        TOKENS[tokenIn.toLowerCase()]?.decimals ?? 18,
        TOKENS[tokenOut.toLowerCase()]?.decimals ?? 18
      ),
      amountOut: plan.amountOut,
      singleMakerAmountOut: single.amountOut,
      improvementBps,
      // Every candidate, not just the ones that drew a slice. Tap.sol sums its
      // own totalDepth across exactly what this blob carries, and that sum is
      // the denominator of every slice it computes -- ship a shorter list than
      // the plan was built on and the hook silently re-splits by different
      // weights than the quote assumed.
      hookData: encodeHookData(plan.candidates),
    });
  } catch (e) {
    if (e instanceof BadInput) return fail(e.message, 400);
    if ((e as Error).message?.startsWith("unknown chain")) return fail((e as Error).message, 400);
    const unreachable = chainFailure(e);
    if (unreachable) return unreachable;
    return fail((e as Error).message, 500);
  }
}
