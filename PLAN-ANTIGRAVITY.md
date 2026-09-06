# Bone Dry — 2–3 day build plan (for Antigravity)

You are working on **Bone Dry**, a Uniswap v4 pool with zero liquidity that
fills swaps from 1inch Aqua maker wallets at trade time. This document is your
complete instruction set. Follow it in order. Do not skip the verification
step at the end of each task — a task is not done until it passes its own
checklist, not when the code merely looks right.

Read this whole file once before writing anything.

---

## 0. Hard rules (read first, apply to every task below)

1. **Never run `git add -A` or `git add .`.** Stage files by exact path only.
   This repo has another editor working in it in parallel; a wildcard add
   will scoop up someone else's in-progress work into your commit.
2. **Do not touch these files, ever, even to fix something in them:**
   - `web/app/ui/Landing.tsx`
   - `web/app/ui/landing.module.css`
   - `web/app/ui/Doodle.tsx`
   - `web/app/ui/useIsomorphicLayoutEffect.ts`
   - `web/app/page.tsx`
   These belong to the landing page, owned by someone else. If a task
   description below seems to require touching one of these, stop and flag
   it instead of proceeding.
3. **Ask before changing these shared files** — post the proposed diff and
   wait rather than committing it: `web/app/layout.tsx`, `web/app/globals.css`,
   `web/app/ui/Motion.tsx`, `web/app/ui/Web3.tsx`.
4. **Match the existing style exactly.** This codebase writes a short prose
   comment above every non-obvious block explaining *why*, not *what* — read
   three existing functions in the file you're editing before adding a
   fourth. Do not add comments that restate the code. Do not add JSDoc blocks
   this repo doesn't already use.
5. **Every task ends with a verification step.** Run it. Paste the actual
   output in your summary, not "should work now." If a verification step
   fails, fix it before moving to the next task — do not stack unverified
   work.
6. **Never invent contract addresses, ABIs, or API shapes.** Every address
   you need already exists in `web/lib/networks.ts` or
   `deployments/base-sepolia.json`. Every ABI fragment you need already
   exists somewhere in `web/app/ui/Desk.tsx` or `web/lib/*.ts` — grep for it
   before writing a new one.
7. **Commit after each numbered task**, not at the end of the day. Small,
   reviewable commits. Use this commit trailer on every commit:
   ```
   Co-Authored-By: Antigravity <noreply@google.com>
   ```
8. **If you are unsure whether something is in scope, it is not.** Stop and
   write the question at the top of your summary instead of guessing.

---

## 1. Orientation (do this before Task 1, ~15 min)

Read these files fully, in this order. Do not skim.

1. `web/lib/networks.ts` — every contract address and per-chain config lives
   here. `NETWORKS[84532]` is Base Sepolia, the network you will test against.
2. `web/app/ui/Desk.tsx` — the whole dashboard. It's ~900 lines; read all of
   it once so you know what already exists before you add to it.
3. `web/app/ui/desk.module.css` — every class Desk.tsx uses. New UI must use
   this file's existing tokens (`--ink`, `--paper`, `--rule`, `.label`,
   `.num` etc. — check `web/app/globals.css` for the token definitions) not
   new colors or fonts.
4. `web/app/api/strategy/route.ts` — the maker-flow server route, built and
   proven today. This is what Task 1 wires into the UI.
5. `web/lib/graph.ts` — `committedFromGraph` and `positionsFromGraph` are the
   two functions Task 3 and Task 4 are built on. Read their full bodies.
6. `web/app/api/coverage/route.ts` — the response shape
   (`available`/`reason`/`positions`/`underCollateralised`) that the whole
   app already uses for "is the index working" — reuse this pattern, don't
   invent a new one.

Confirm you understand: Aqua stores a maker's claim per `(maker, app,
strategyHash, token)`; there is no on-chain way to total one maker's
promises across strategies; only the subgraph (`positionsFromGraph`) can.
This fact is the reason the whole coverage/exposure UI exists — every task
below assumes you understand it.

---

## Task 1 — "Ship a strategy" form (day 1, do this first)

**Goal:** a connected wallet can become a maker from the dashboard: pick a
pair, claim an amount of each token, optionally set a fee, sign one
transaction, and see the resulting strategy appear.

### What to build

Add a new section to `web/app/ui/Desk.tsx`, placed **after** the `.book`
section (maker book / hook data) and **before** the closing of the main
return. Call the component `ShipStrategy`. It needs:

- Two amount inputs (claim for tokenIn, claim for tokenOut) — reuse the same
  input styling as the swap card's `.field`/`.amountRow` (read that JSX
  before writing this).
- A fee input in bps, optional, defaulting to 0. Label it "Your fee (bps)"
  with a one-line caption: "Spread you earn on every fill. 0 is fine to
  start."
- A "Ship this strategy" button. Disabled states, in this order of
  precedence: wallet not connected → wrong chain → either amount is zero or
  unparseable → busy (mid-transaction).
- On submit:
  1. `POST /api/strategy` with `{ maker: address, chainId, tokenIn: tokenIn.address, tokenOut: tokenOut.address, amountIn, amountOut, feeBps }` — amounts as decimal strings, converted to base units the same way `executeSwap` already does elsewhere in this file (grep for `parseUnits` in Desk.tsx and match it, don't reinvent the conversion).
  2. On success, take the returned `{ to, data }` and send it via
     `useSendTransaction` from wagmi (a new hook — `useWriteContract` is for
     ABI calls, this is raw calldata, so `useSendTransaction` is correct
     here; `to` and `data` map directly to its `sendTransaction` args).
  3. Wait for the receipt (`useWaitForTransactionReceipt`, same pattern
     `executeSwap` already uses for the swap tx — match it).
  4. On confirmed receipt, show the strategy hash (the route already returns
     enough info to compute or return it — check if `strategy/route.ts`
     returns a hash; if not, compute `keccak256(strategy)` client-side with
     viem, matching `tools/gen-strategy.cjs`'s approach) and a success
     message: "Shipped. You are now a maker on this pair."
  5. On error, reuse the existing `describe()` helper in Desk.tsx for the
     error message (cancelled in wallet / etc).
- State for this form is local to the new component — do not add it to the
  top-level `Desk` state unless it needs to trigger a refetch of `makers`
  (it should: after a successful ship, call the existing `load()` function
  so the maker book picks up the new strategy).

### CSS

Add new classes to `desk.module.css` following the file's existing naming
(`camelCase`, comment above any class whose purpose isn't obvious from its
neighbors). Do not modify unrelated existing classes.

### Verification (must pass before commit)

1. `cd web && npx tsc --noEmit` — zero new errors.
2. Start the dev server (`npm run dev` — check if one is already running on
   :3000 first with `curl -s localhost:3000 -o /dev/null -w '%{http_code}'`;
   if it answers, don't start a second one).
3. In a browser, connect a wallet on Base Sepolia, fill the form with a
   trivial claim (e.g. 1 USDC / 0.0003 WETH), submit, confirm in the wallet,
   and confirm the UI shows a success state after the receipt lands.
4. Refresh the page and confirm the maker book (`MakerBook` component) now
   lists the new maker/strategy.
5. Paste the transaction hash in your summary.

### Commit

```
git add web/app/ui/Desk.tsx web/app/ui/desk.module.css
git commit -m "Add the maker-side ship-a-strategy form to the dashboard"
```

---

## Task 2 — Fix anything Task 1's real usage surfaces

Before moving on, re-read `executeSwap` in Desk.tsx once more and check
whether your new form duplicates logic that should instead be a shared
helper (amount parsing, chain-mismatch guards, the `stillHere()` pattern
guarding against a chain switch mid-transaction). If you find duplication,
extract a small shared helper in the same file. Do not do this
speculatively — only if Task 1 actually created a duplicate.

Skip this task (say so in your summary) if there's nothing to extract.

---

## Task 3 — "Your exposure" (day 1 afternoon / day 2 morning)

**Goal:** a connected wallet that is also a maker can see their own coverage
ratio — total claimed vs. total held, across every strategy they've shipped
— using the subgraph, the same way `/api/coverage` already does for the
aggregate view.

### What to build

1. New route `web/app/api/exposure/route.ts`. Pattern it directly on
   `web/app/api/coverage/route.ts` — same `available`/`reason` shape when the
   subgraph isn't indexing this chain, same `chainFailure` error handling.
   Input: `?chain=&maker=0x...`. It should call `positionsFromGraph` (or, if
   that function is aggregate-only, read `committedFromGraph` per token the
   maker has positions in — check its signature first, don't guess) filtered
   to the one maker address, and return something like:
   ```ts
   {
     available: boolean,
     reason?: string,
     maker: Address,
     positions: Array<{ token: Address, symbol: string, claimed: string, held: string, covered: boolean }>,
     fullyCoveredCount: number,
     totalPositions: number,
   }
   ```
2. New component in Desk.tsx (or a new file `web/app/ui/Exposure.tsx` if it
   gets past ~80 lines — match how `MakerBook` and `HookData` are already
   split into their own concerns). Renders only when a wallet is connected.
   Fetches `/api/exposure?chain=&maker=` on mount and on chain/address
   change (mirror the `useEffect` dependency pattern already used for
   `coverage` in Desk.tsx).
3. If `available: false`, show the same kind of message the `Coverage`
   component already shows for an unindexed chain — reuse copy tone, don't
   invent new phrasing for the same fact.

### Verification

1. `npx tsc --noEmit` clean.
2. Query `/api/exposure?chain=84532&maker=<MAKER0 address from
   deployments/base-sepolia.json>` directly with curl and confirm the JSON
   shape matches what the component expects.
3. Connect a wallet holding a shipped strategy (or use the maker key from
   Task 1's test) and confirm the UI renders real numbers, not placeholders.
4. Paste the curl output in your summary.

### Commit

```
git add web/app/api/exposure/ web/app/ui/Desk.tsx web/app/ui/desk.module.css [Exposure.tsx if created]
git commit -m "Add a maker's own coverage view (Your exposure)"
```

---

## Task 4 — "Check any wallet" page (day 2)

**Goal:** a public page, no wallet connection required, where anyone pastes
an address and sees that address's Aqua coverage — the same computation as
Task 3, generalized to any maker, framed as a trust-checking tool rather
than a personal dashboard.

### What to build

1. New page `web/app/app/lookup/page.tsx` (confirm this doesn't collide with
   existing routing — check `web/app/app/` contents first). A simple form:
   address input, network selector (reuse the existing network-switch UI
   pattern from Desk.tsx if there is one, otherwise a plain `<select>` over
   `NETWORKS`), "Check" button.
2. Calls the **same** `/api/exposure` route from Task 3 — do not build a
   second backend route for the same computation. If Task 3's route needs a
   small generalization to serve this (e.g. it's currently too tied to "the
   connected wallet"), that's fine, adjust it — but there is still only one
   route.
3. Render the same position table Task 3 renders. If you factored a
   component out in Task 3, reuse it here directly rather than duplicating
   JSX.
4. Handle an address with zero positions distinctly from an unavailable
   index — "This address has no Aqua positions on this network" vs. "The
   index for this network isn't available."

### Verification

1. `npx tsc --noEmit` clean.
2. Visit `/app/lookup`, paste a known maker address (from
   `deployments/base-sepolia.json`), confirm real data renders.
3. Paste a random address with no positions, confirm the empty-state message
   is correct (not an error).
4. Confirm this page does not require a connected wallet at all — test it
   with the wallet disconnected.

### Commit

```
git add web/app/app/lookup/ [any shared component files]
git commit -m "Add a public wallet-lookup page for Aqua solvency"
```

---

## Task 5 — Multi-pair support (day 2 afternoon / day 3)

**Goal:** the dashboard can trade and ship strategies on more than one token
pair, not just USDC/WETH.

**Before writing any code**, verify this claim, which this plan is built on:
run `grep -nE "USDC|WETH|0x833589|0x4200" contracts/src/Tap.sol
contracts/src/Lens.sol` from the repo root. If this returns any hardcoded
token address, **stop and report it** — the plan below assumes it returns
nothing (i.e. both contracts already read currencies generically from the
`PoolKey` / function arguments). Do not proceed with this task on an
unverified assumption.

### What to build

1. In `web/lib/networks.ts`, currently `tokensOf(n)` and `poolKey(n)` assume
   a single hardcoded pair. Generalize: add a `PAIRS` config (either in
   `networks.ts` or a new `web/lib/pairs.ts`) — an array per network of
   `{ token0, token1, hook, poolId? }`. For now on Base Sepolia this can be a
   one-element array (the existing USDC/WETH pair) **plus a second pair you
   add with a new pool `initialize()` call** — check `contracts/script/Deploy.s.sol`
   for how the existing pool is initialized and whether it's parameterized
   by pair already, or needs a small change to accept one. If it needs a
   contract change, make the **smallest possible** change and say so
   explicitly in your summary — do not restructure the deploy script.
2. Add a pair selector to Desk.tsx, near the existing network switcher.
   Selecting a pair should behave exactly like a chain switch already does:
   clear all derived state (`route`, `makers`, `pool`, `balance`, `error`,
   `txState`) — reuse the existing `useEffect` keyed on `[chainId]` as a
   model, add `pairId` (or similar) to its dependency array.
3. Every place in Desk.tsx currently reading `net.usdc`/`net.weth` directly
   needs to instead read the selected pair's tokens. Grep for `net.usdc` and
   `net.weth` across `web/` and check each call site.
4. `/api/route`, `/api/makers`, `/api/coverage`, `/api/strategy` all
   currently default `tokenIn`/`tokenOut` to `n.usdc`/`n.weth`. These
   defaults are fine to keep (backward compatible), but confirm each route
   still accepts explicit `tokenIn`/`tokenOut` query params overriding the
   default — if any route hardcodes rather than accepting an override, that
   is a bug to fix as part of this task, not a separate one.

### Verification

1. `npx tsc --noEmit` clean.
2. Ship a strategy on the new pair via Task 1's form.
3. Get a live quote and execute a swap on the new pair via the existing swap
   flow.
4. Switch back to the original USDC/WETH pair and confirm nothing there
   regressed (run through one full swap on it).
5. Paste both transaction hashes.

### Commit

```
git add web/lib/networks.ts web/lib/pairs.ts web/app/ui/Desk.tsx web/app/ui/desk.module.css [contracts files only if genuinely needed, listed individually]
git commit -m "Support more than one token pair in the dashboard"
```

If the contracts need changes for this, commit contracts changes
**separately** from web changes, with their own message, and say plainly in
your summary that a redeploy is needed before this is live (do not attempt
the redeploy yourself — that's a human task).

---

## Task 6 — polish pass (day 3, whatever time remains)

Only after Tasks 1–4 are done and verified (Task 5 is a stretch goal, do it
only if time remains). In priority order:

1. Re-read every new user-facing string you wrote across Tasks 1–4. This
   project's voice is terse, numeric, no exclamation marks, no "Oops!" — cut
   anything that doesn't match. Compare against existing copy in `Desk.tsx`
   (the `Coverage` component's messages are a good reference).
2. Check every new loading/error/empty state actually renders (don't assume
   — trigger each one: disconnect wallet, use an address with no data, kill
   network access briefly).
3. Run `npx tsc --noEmit` one final time across the whole `web/` project.
4. Do **not** touch `README.md` or `FEEDBACK.md` — those are being handled
   separately.

---

## What "done" means for this whole plan

At the end, report back with:
- Which tasks completed, which were skipped and why.
- Every transaction hash / curl output collected during verification steps.
- Any place you stopped because a hard rule (Section 0) applied.
- A list of every file you touched, task by task (not just a final `git
  diff` — the per-task breakdown matters for review).

Do not summarize with "everything works." State what you tested and what
you did not test.
