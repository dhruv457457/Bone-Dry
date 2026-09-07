# Bone Dry — oracle-deviation checking (for Antigravity)

The tab-restructure and visual-polish passes are done and merged. This plan
adds one new thing: a second axis of trust alongside solvency. Bone Dry
already answers "can this maker actually pay?" (Lens, coverage). This adds
"is this maker's price actually fair?" — checked against a live Chainlink
feed, on every quote.

**Read Section 1 before anything else.** It corrects a mistake from earlier
research in this project (not yours — mine, from before this plan existed)
that assumed a swap-vm opcode called `Extruction` could be used for this.
It cannot, and the reasoning matters enough that you should understand it
rather than take it on faith.

---

## 0. Hard rules (same as every plan in this file, read first)

1. **Never `git add -A` or `git add .`.** Stage exact paths only.
2. **Do not touch:** `web/app/ui/Landing.tsx`, `web/app/ui/landing.module.css`,
   `web/app/ui/Doodle.tsx`, `web/app/ui/useIsomorphicLayoutEffect.ts`,
   `web/app/page.tsx`.
3. **Ask before touching:** `web/app/layout.tsx`, `web/app/globals.css`,
   `web/app/ui/Motion.tsx`, `web/app/ui/Web3.tsx`.
4. **Do not touch `contracts/src/Tap.sol`, its hook address, or anything in
   `contracts/script/Deploy.s.sol`'s hook-mining logic, under any
   circumstances in this plan.** Tap's address encodes its permission bits;
   changing what hooks it implements means re-mining a new address, which
   orphans every pool already initialized against the current one — both the
   USDC/WETH and WETH/MOCK pools on Sepolia, and whatever exists on mainnet
   by the time you read this. Nothing in this plan requires it — if a task
   below seems to need it, stop, you have misread the task.
5. **Every task ends with a real verification step.** Run it, paste the
   actual output.
6. **Commit after each task**, exact paths, with:
   ```
   Co-Authored-By: Antigravity <noreply@google.com>
   ```
7. **Unsure whether something is in scope? It is not.** Ask.

---

## 1. Why not `Extruction` — read this before Task 1

Aqua's SwapVM router has two lineages that matter here:

- **`v1.0.2`** — the tag Bone Dry's router is built from and deployed on
  both networks. 19 opcodes, no `Extruction`. This is also the exact opcode
  numbering `@1inch/swap-vm-sdk` (the package `tools/gen-strategy.cjs` and
  `web/app/api/strategy/route.ts` both use to build every strategy) targets.
- **`main`** — the current head of the same repo. Has since gained an
  `Extruction` opcode (confirmed: `main`'s `src/opcodes/AquaOpcodes.sol`
  imports `Extruction` from `../instructions/Extruction.sol`; `v1.0.2`'s
  does not). It has also **renumbered other opcodes** — this is the exact
  reason Bone Dry pins to `v1.0.2` in the first place; a router built from
  `main` does not understand the bytes the SDK emits, and every quote
  reverts.

Checked directly, not assumed: the installed `@1inch/swap-vm-sdk`'s
`AquaProgramBuilder` prototype has no `extruction` method at all —
```
node -e "console.log(Object.getOwnPropertyNames(require('@1inch/swap-vm-sdk').AquaProgramBuilder.prototype))"
```
lists `jump`, `salt`, `xycSwapXD`, `flatFeeAmountInXD`, and 15 others — no
`extruction`, no `customPricing`, nothing resembling it.

So: using `Extruction` would mean deploying a `main`-branch router, which
breaks every strategy the SDK builds — the maker-ship flow, the multi-pair
swap flow, everything already proven — on both networks. Not worth it for
this feature. **Do not deploy a different router version. Do not add an
`extruction` call anywhere.** This plan does not need the SwapVM at all.

## 2. Orientation

1. `web/lib/networks.ts` — the `Network` type and `NETWORKS` config. Task 1
   adds a new field here.
2. `web/lib/router.ts` — `quoteRoute` builds the `slices` array that ends up
   in `/api/route`'s response. Task 2 adds one field per slice here.
3. `web/app/ui/types.ts` — `RouteResponse`. Task 2 extends it.
4. `web/app/api/route/route.ts` — where the response is assembled.
5. `web/app/ui/Desk.tsx` — `SwapAction`/the trade row, where the deviation
   badge will render per maker slice used in a route.

---

## Task 1 — Chainlink feed config, verified addresses only

**Goal:** wire up real, checked Chainlink feed addresses per network. Do not
substitute any address you find elsewhere without checking it the same way
these were checked — an unverified feed address is worse than none, because
it fails silently (returns a stale or wrong price) rather than erroring.

### What to add

In `web/lib/networks.ts`, add to the `Network` type:
```ts
/** Chainlink AggregatorV3-compatible feeds, keyed by the token address (
 *  lowercase) they price against USD. Empty object if none configured for
 *  this network. */
oracleFeeds: Record<string, Address>;
```

And to each network's config in `NETWORKS`:

**Base Sepolia (84532)** — both verified live via `latestRoundData()` and
`description()` returning exactly the strings below:
```ts
oracleFeeds: {
  "0x4200000000000000000000000000000000000006": "0x4aDC67696bA383F43DD60A9e78F2C97Fbbfc7cb1", // WETH, feed says "ETH / USD"
  "0x036cbd53842c5426634e7929541ec2318f3dcf7e": "0xd30e2101a97dcbAeBCBC04F14C3f624E67A35165", // USDC, feed says "USDC / USD"
},
```

**Base mainnet (8453)** — same verification:
```ts
oracleFeeds: {
  "0x4200000000000000000000000000000000000006": "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70", // WETH, "ETH / USD"
  "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": "0x7e860098F58bBFC8648a4311b374B1D669a2bc6B", // USDC, "USDC / USD"
},
```

Note the token addresses as **keys must be lowercase** — match the existing
convention this codebase uses everywhere else for address-keyed lookups
(check `tokensOf` in this same file for the pattern).

`MOCK` (the Sepolia demo token from the WETH/MOCK pair) has no real feed —
leave it out of `oracleFeeds` entirely. A missing entry means "no oracle
configured for this token," which the rest of this plan must treat as a
normal, expected case, not an error.

### New file: `web/lib/oracle.ts`

```ts
import type { Address } from "viem";
import { publicClientFor, type Network } from "./networks";

const AGGREGATOR_V3_ABI = [
  {
    type: "function",
    name: "latestRoundData",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "roundId", type: "uint80" },
      { name: "answer", type: "int256" },
      { name: "startedAt", type: "uint256" },
      { name: "updatedAt", type: "uint256" },
      { name: "answeredInRound", type: "uint80" },
    ],
  },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
] as const;

// Chainlink can go quiet without erroring -- an old-but-successful read is
// the dangerous case, not a revert. Past this age, treat it as unavailable.
const MAX_STALENESS_SECONDS = 3600n;

export type OracleQuote = { priceUsdE18: bigint; updatedAt: bigint; stale: boolean };

/** A token's USD price from its configured Chainlink feed, normalized to
 *  18 decimals regardless of the feed's own decimals (Chainlink USD feeds
 *  are usually 8, but this must never assume that). Returns null if this
 *  network/token has no configured feed -- a normal case, not an error. */
export async function oraclePriceUsd(n: Network, token: Address): Promise<OracleQuote | null> {
  const feed = n.oracleFeeds[token.toLowerCase()];
  if (!feed) return null;

  const client = publicClientFor(n);
  const [decimals, round] = await Promise.all([
    client.readContract({ address: feed, abi: AGGREGATOR_V3_ABI, functionName: "decimals" }),
    client.readContract({ address: feed, abi: AGGREGATOR_V3_ABI, functionName: "latestRoundData" }),
  ]);
  const [, answer, , updatedAt] = round;
  if (answer <= 0n) return null; // a non-positive price is not a price

  const priceUsdE18 = (answer * 10n ** 18n) / 10n ** BigInt(decimals);
  const nowSeconds = BigInt(Math.floor(Date.now() / 1000));
  const stale = nowSeconds - updatedAt > MAX_STALENESS_SECONDS;
  return { priceUsdE18, updatedAt, stale };
}

/** How far a quoted implied price sits from the oracle's, in bps. Positive
 *  means the quote is above the oracle price, negative means below -- sign
 *  matters for reading whether a maker is over- or under-charging, so do
 *  not use an absolute value here; let the caller decide what to show. */
export function deviationBps(impliedUsdE18: bigint, oracleUsdE18: bigint): bigint {
  if (oracleUsdE18 === 0n) return 0n;
  return ((impliedUsdE18 - oracleUsdE18) * 10_000n) / oracleUsdE18;
}
```

The staleness threshold and the sign convention are deliberate — do not
"simplify" either without checking with me first, they're both there for a
reason stated in the comment next to them.

### Verification

1. `cd web && npx tsc --noEmit` clean.
2. Standalone smoke test — run this exact snippet with `node` (adjust the
   import to a compiled/transpiled path if needed, or write a quick
   `.mjs`/ts-node check) against Sepolia's WETH feed and confirm it prints a
   number near the live ETH price (a few thousand, not zero, not absurd):
   ```ts
   import { oraclePriceUsd } from "./web/lib/oracle";
   import { NETWORKS } from "./web/lib/networks";
   const q = await oraclePriceUsd(NETWORKS[84532], "0x4200000000000000000000000000000000000006");
   console.log(q);
   ```
3. Paste the actual printed value in your report.

### Commit
```
git add web/lib/networks.ts web/lib/oracle.ts
git commit -m "Add verified Chainlink feed config and an oracle price reader"
```

---

## Task 2 — Attach deviation to every quoted slice

**Goal:** `/api/route`'s response already lists which makers filled how much
of a swap (`slices`). Each slice gets an `oracleDeviationBps` field — how far
that maker's implied price sits from the live oracle price, when both
tokens in the pair have a configured feed. `null` when either token has no
feed (most of the time on Sepolia's WETH/MOCK pair, since MOCK has none —
this must render as "no oracle for this pair," never as "0% deviation",
which would be a lie about a pair with no oracle at all).

### What to change

In `web/lib/router.ts`, find where `quoteRoute` builds each slice's
`{ maker, amountIn, depth, amountOut }` object (grep for `depth:` in this
file if the shape isn't obvious at a glance). For each slice, once you have
`tokenIn`, `tokenOut`, and the slice's own `amountIn`/`amountOut`:

1. Call `oraclePriceUsd(n, tokenIn)` and `oraclePriceUsd(n, tokenOut)` (both,
   not just one — the deviation is a ratio between two prices, one leg alone
   tells you nothing).
2. If either is `null` or `.stale`, the slice's `oracleDeviationBps` is
   `null`.
3. Otherwise: compute the slice's own implied price (how much `tokenOut`'s
   USD value the maker delivered per unit of `tokenIn`'s USD value — this is
   **not** the same as either token's own oracle price; it is a ratio
   computed from the actual quoted amounts, normalized by each token's own
   decimals before comparing). Compare that implied ratio against the ratio
   of the two oracle prices, via `deviationBps` from `oracle.ts`.

Do this calculation carefully — decimals matter twice here (once per token)
and getting it wrong produces a confidently-wrong number, which is worse
than showing nothing. If you are not fully certain the decimal normalization
is right, write out the arithmetic in a comment showing a worked example
with real numbers (e.g. "1 WETH (18 dec) for 2500 USDC (6 dec) at oracle
$2500/$1 implies 0 bps deviation, here's why") rather than shipping it
unverified.

In `web/app/ui/types.ts`, extend `RouteResponse["slices"]`'s item type with
`oracleDeviationBps: string | null;` (as a string, matching how every other
bigint-shaped field in this response is already serialized — check `j()` in
`web/lib/json.ts` for why).

### Verification

1. `npx tsc --noEmit` clean.
2. `curl` `/api/route?chain=84532&amountIn=100000000` (the default USDC/WETH
   pair, both tokens have feeds) and confirm every slice in the response now
   has a real (non-null) `oracleDeviationBps`, and that the number is small
   (low double digits of bps, not thousands — Aqua's XYC curve at this
   trade size should track the oracle closely for a well-backed maker).
3. `curl` the WETH/MOCK pair's route and confirm every slice's
   `oracleDeviationBps` is `null` (MOCK has no feed) — this is the case most
   likely to be gotten wrong (e.g. by defaulting to `0` instead of `null`),
   check it explicitly.
4. Paste both curl outputs.

### Commit
```
git add web/lib/router.ts web/app/ui/types.ts
git commit -m "Compute each maker slice's deviation from the live oracle price"
```

---

## Task 3 — Show it

**Goal:** the swap card's "better than the deepest maker alone" line already
tells a taker something about the fill. Add one more fact next to the maker
book: how each maker's price compares to the oracle.

### What to change

In `web/ui/Desk.tsx`'s `MakerBook` (or wherever the per-slice/per-maker rows
already render — read the current maker book table before adding a column,
this plan does not know its exact current shape after the last two passes),
add one more column or inline badge, only for rows that are part of the
current route's `slices` (i.e. makers actually used in the current quote —
`oracleDeviationBps` does not exist for a maker not in the route). Reuse the
`.badge`/`.badgeOk`/`.badgeLoss` classes from the visual-polish pass (check
`desk.module.css`, they should already exist) rather than inventing new
ones: within some small threshold (propose 25 bps — say why in a comment if
you pick a different number) is `.badgeOk`, outside it is `.badgeLoss`. A
`null` value (no oracle for this pair) renders as plain text like "no
oracle for this pair", not a badge of either color — a badge implies a
checked, known state, and this is neither.

### Verification

1. Screenshot the Swap tab on the default USDC/WETH pair after a quote
   loads — every maker row used in the fill should show a deviation badge.
2. Screenshot the WETH/MOCK pair — should show "no oracle for this pair" (or
   your exact chosen copy), not a badge, not a 0%.
3. `npx tsc --noEmit` clean.

### Commit
```
git add web/app/ui/Desk.tsx web/app/ui/desk.module.css
git commit -m "Show each maker's price against the live oracle in the maker book"
```

---

## Task 4 (stretch, only if Tasks 1-3 are done and verified) — an on-chain view

Everything above is off-chain: our server reads Chainlink and does the math.
That is honest and sufficient for the demo, but "trust our server's math" is
weaker than "call a contract and check yourself." If time remains:

Write `contracts/src/Beacon.sol` — a small, standalone, **immutable**,
**stateless** contract. Two pure/view functions only:
- a view function taking a Chainlink feed address, returning its price
  normalized to 18 decimals (same normalization as `oracle.ts`'s
  `oraclePriceUsd`, kept consistent on purpose — write a comment cross-
  referencing that file)
- a pure function taking two normalized prices and returning the deviation
  in bps (same formula as `deviationBps` in `oracle.ts`)

This contract does **not** touch Aqua, the SwapVM router, Tap, Wellhead, or
any existing deployment. It is deployed once, standalone, with a plain
`forge create` (no CREATE2 mining — it is not a hook, it has no permission
bits to encode). Deploy it to Base Sepolia only for now; do not deploy to
mainnet without checking in first.

### Verification

1. `forge build` clean.
2. Deploy to Sepolia, then call both functions directly with `cast call`
   against the same feed addresses from Task 1, and confirm the numbers
   match what `oracle.ts` computed for the same feed at roughly the same
   time (prices will drift slightly between two separate reads a few
   seconds apart — that is expected, not a bug; a large mismatch is).
3. Paste the deployed address and both `cast call` outputs.

### Commit
```
git add contracts/src/Beacon.sol
git commit -m "Add a standalone on-chain oracle-deviation check"
```
State clearly in your report that this contract is not wired into anything
else yet — whether and how to wire it into `Lens` or expose it in the UI as
"verified on-chain" is a decision for next, not part of this task.

---

## What "done" means

Report per task: files changed, the actual verification output (numbers,
not "looks right"), and anything you stopped on. If Task 2's decimal
arithmetic gives you any doubt, say so explicitly rather than shipping a
number you are not sure of — a wrong "0.3% deviation" reads as more
dangerous than an honest "not sure, flagging this."
