# Bone Dry — the two books, and why a swap can never reach the new one (2026-09-12)

**Owner: whoever holds `web/lib/aqua.ts`, `web/lib/graph.ts`, `web/lib/indexedDepth.ts`,
`web/app/api/route/route.ts`, `web/app/ui/Desk.tsx`.** Contracts are already deployed and
correct; nothing here redeploys anything. `Provide.tsx` and `DepthChart.tsx` stay with
whoever is running PLAN-PROVIDE — this plan does not touch them.

Read §0 and §1 before proposing anything. §1 is an on-chain constraint, and every
design that ignores it is unimplementable.

---

## 0. The gap

Bone Dry has two liquidity books on Base and they cannot see each other.

| | app (SwapVM router) | hook | pool | active strategies | opcode 35 |
|---|---|---|---|---|---|
| **Evidence book** | `0x111111338c…` (1inch canonical) | `tapLegacy 0xeAdD3C76…` | `0x620f798e…` | **146** | ✗ — table stops at 34 |
| **Bone Dry book** | `boneDryRouter 0x74195573…` | `tap 0xaC7bCA41…` | `0x33e4c020…` | **3** | ✓ |

All of that was read live, not taken from a file:

```
tapLegacy  0xeAdD3C76…  router = 0x111111338c5091E8440b67B168bAe16a668AC0De   5849 bytes
tap (new)  0xaC7bCA41…  router = 0x74195573Fa9bC965667e03319F2C58567d4B96BE   6158 bytes
```

Both pools report `initialized: true` through `/api/pool`.

**The Swap tab uses `tapLegacy`** — `NEXT_PUBLIC_HOOK_ADDRESS` in `.env.local` is
`0xeAdD3C76…`, and `Tap.router` is `immutable` (`Tap.sol:42`), so that hook is welded to
1inch's router forever.

**The Provide tab now ships to `boneDryRouter`** — correctly, since commit `e284380`;
opcode 35 exists nowhere else.

So: **a strategy published on Provide can never be filled by a swap on Swap.** The
encumbrance instruction — the whole technical novelty, the thing the README leads with and
all three track submissions rest on — is not executed anywhere in the live product. It is
tested, deployed, verified on-chain, and unreachable.

A judge who publishes a strategy and then tries to trade against it finds this in ninety
seconds. That is the demo we are inviting them to run.

### 0.1 The route engine cannot even see the second book

`app` is filtered to `n.router` in five places:

```
app/api/route/route.ts:58   strategiesFromGraph(n, n.router)
lib/aqua.ts:88              if (a.app !== n.router) continue    // "other apps are not ours to route"
lib/aqua.ts:196             rawBalances(maker, n.router, hash, token)
lib/aqua.ts:265, :292       app: n.router
lib/indexedDepth.ts:104     app: n.router
```

`n.router` on Base is 1inch's. Encumbered strategies are therefore absent from the
candidate set, absent from depth measurement, and absent from the maker book. They are not
skipped with a reason — they do not exist as far as routing is concerned, which is the one
failure mode this project is supposed to make impossible.

### 0.2 One thing already works, and tells us the shape of the fix

`makerBook` (`lib/graph.ts:258`) returns `{ strategyHash, app, tokens }` and does **not**
filter by app. That is why the Lookup tab correctly shows our encumbered position
(`claimed 0.000036 WETH`) while the router pretends it isn't there.

The subgraph already indexes `app` per strategy (`graph.ts:33`,
`where: { active: true, app: $app }`). **No subgraph change is needed anywhere in this
plan.** The index is already right; the router's assumption is what is wrong.

---

## 1. Why this cannot be configured away

`Aqua.sol:63-64`:

```solidity
function pull(address maker, bytes32 strategyHash, address token, uint256 amount, address to) external {
    Balance storage balance = _balances[maker][msg.sender][strategyHash][token];
```

**The app is `msg.sender`.** A strategy shipped to 1inch's router can only be pulled by
1inch's router. `boneDryRouter` calling `pull` on those 146 strategies reads a balance of
zero and reverts.

Three consequences, all hard:

1. **Pointing everything at `boneDryRouter` does not work.** It would make the 146-maker
   evidence book unfillable. Those makers are not ours; we cannot re-ship them.
2. **One transaction cannot mix books.** A v4 pool has exactly one hook; a hook has exactly
   one immutable router; a router can only pull its own strategies. Three layers of
   one-to-one. There is no arrangement in which a single `Wellhead.swap` fills from both.
3. **Redeploying `Tap` does not help.** A third hook bound to a third router has the same
   problem. The partition is Aqua's data model, not our deployment.

Do not propose a merged book. It is not a difficult version of this task; it is a
different chain.

---

## 2. The decision

Three options. I recommend (B) and the rest of this plan assumes it.

**(A) Route only the evidence book. Delete the encumbrance surface from the demo.**
Honest and small. Throws away the one piece of novel contract work — opcode 35, the
subclassed opcode table, the six-sibling encoding — which is the strongest thing we have
for the 1inch track. Rejected.

**(B) Two books, one surface — recommended.**
The route API plans **per app** and returns the winning plan plus the hook to route it
through. Never mixes. The Swap tab builds its `poolKey` from the returned hook rather than
from a single env var. The maker book shows both, labelled, with the ones from the other
book marked as such rather than silently dropped.

Costs one extra planning pass; changes no contracts; makes opcode 35 reachable.

**(C) A visible book switcher.**
Same plumbing as (B) plus a segmented control. More honest still, but it asks a judge to
understand our deployment topology before they can trade. Keep it in reserve: if (B)'s
automatic choice ever looks arbitrary, promote the toggle. Do not build it first.

### 2.1 The thing (B) must not paper over

The Bone Dry book has **3 strategies, all ours, on one wallet**. Routing to it is a demo of
the mechanism, not a market. The UI must say that in words. We spent this entire project
proving that a number with nothing behind it is the disease; shipping "best execution across
2 books" over a book containing three of our own strategies would be us catching it.

Proposed copy, to be used verbatim rather than improvised:

> **Bone Dry book · 3 strategies, all published by us.** This is where opcode 35 runs. It
> is a demonstration of the constraint, not a market. The 146-maker book beside it is real
> third-party Aqua liquidity, and cannot carry our instruction.

---

## 3. Work plan

Sequential. `npx tsc --noEmit` clean at every phase boundary. Run the app and look at it —
a phase reported without a check that was actually run is not accepted.

### Phase 1 — make `app` a parameter, not a constant

Pure refactor. No behaviour change, and that is the point: land it, verify the app is
byte-for-byte unchanged, then build on it.

- `Network` gains `apps: { app: Address; hook: Address; label: string }[]`, derived from
  `router`/`hook` and `boneDryRouter`/`boneDryHook`. Add `boneDryHook` to `networks.ts`
  (Base `0xaC7bCA41EA8Fce76651684943Db2c38003c98088`, Base Sepolia from
  `deployments/base-sepolia.json`). Ethereum gets a single entry and no Bone Dry app.
- Thread `app` through `measureDepth`, `cachedStrategies`, `depthFromIndex`, and the
  `aqua.ts:88` filter. Default every call site to `n.router`.
- Delete the comment at `aqua.ts:88` (*"other apps are not ours to route"*) — it is now
  false, and a stale comment asserting the opposite of the code is worse than none.

**Check:** `/api/route` output is identical to a capture taken before the refactor — same
`amountFilled`, same slices, same `hookData`. Paste both.

### Phase 2 — plan every app, return the winner

- `route.ts` loops the `apps` array, runs the existing pipeline per app (index → **live
  depth recheck**, which `1a0a49a` added and which must run per app), and keeps the plan
  with the largest `amountOut`.
- Response gains `app`, `hook`, `bookLabel`, and `alternatives: [{ app, bookLabel,
  amountOut, makersUsed }]` so the losing book is visible rather than erased.
- Ties and both-zero: prefer the evidence book, so behaviour is unchanged when the Bone Dry
  book is empty.

**Check:** on Base, `/api/route` for USDC→WETH returns `bookLabel: "evidence"` and an
`alternatives` entry for the Bone Dry book. Paste the JSON.

### Phase 3 — let the swap reach the chosen hook

- `Desk.tsx` builds its `poolKey` from `route.hook`, not from `NEXT_PUBLIC_HOOK_ADDRESS`.
  `poolKeyFor` in `lib/pairs.ts` takes the hook as an argument.
- Guard: if `route.hook` names a pool that is not initialised, refuse before signing with a
  stated reason. We have just spent a day removing one silent pre-flight refusal
  (`00eeda4`); do not add another.
- `/api/pool` is already hook-parameterised. No change.

**Check — this is the acceptance test for the whole plan.** Publish a strategy from
Provide on Base Sepolia, then swap against it from Swap, and show the
`EncumbranceApplied` event in the receipt. That single transaction is the first time
opcode 35 has ever executed in the product. Paste the tx hash and the decoded event.

### Phase 4 — show both books

- Maker book gains a `book` column, or a segmented filter. Strategies from the book not
  being routed are listed and marked `other book — cannot be filled in this trade`, with a
  one-line explanation of why (Aqua keys balances by app).
- The §2.1 copy goes under the Bone Dry book wherever it appears.
- The route receipt names the book it filled from.

**Check:** screenshot at 1440×900 showing 146 and 3 partitioned and labelled.

### Phase 5 — the encumbrance surface earns its place

Only once Phase 3 passes. With opcode 35 reachable, the refusals become demonstrable
rather than theoretical: drive a maker past `maxUtilBps` and show `EncumbranceExceeded`
caught by `Tap.MakerSkipped` with its reason, in the route receipt.

That is the strongest single artefact this project can put in front of a 1inch judge: a
custom SwapVM opcode refusing a fill on mainnet, observed through our own hook, indexed by
our own subgraph, and rendered with the reason intact. It is currently unreachable, which
is the entire point of this document.

---

## 4. Acceptance

1. Pre/post-refactor `/api/route` captures identical (Phase 1).
2. `/api/route` names a book and lists the alternative (Phase 2).
3. **A swap fills a strategy published from Provide, emitting `EncumbranceApplied`** (Phase 3).
4. A pool that is not initialised refuses before signing, with the reason on screen (Phase 3).
5. Both books visible and labelled; neither silently dropped (Phase 4).
6. A refusal past `maxUtilBps` rendered with its reason (Phase 5).
7. `tsc` clean; no console errors on any tab.

---

## 5. Do not

- **Do not** propose merging the books. `Aqua.sol:64` keys on `msg.sender`. Re-read §1.
- **Do not** repoint `NEXT_PUBLIC_HOOK_ADDRESS` at the new hook as a shortcut. It makes the
  146-maker evidence book unfillable, which is the Base mainnet story and most of what the
  landing page claims.
- **Do not** redeploy `Tap`, `boneDryRouter`, or re-initialise a pool. Everything needed is
  already on chain and verified.
- **Do not** let the Bone Dry book be presented as market depth. Three strategies on one
  wallet, labelled as §2.1 requires.
- **Do not** skip the per-app live depth recheck from `1a0a49a`. Planning on indexed depth
  is what made every Base swap revert with `NoSolventMaker()`; doing it once per app is not
  optional just because there are now two loops.

---

## 6. Evidence log

Everything asserted above, and how it was established, so the next reader re-checks rather
than trusts.

| Claim | How |
|---|---|
| `tapLegacy.router` = 1inch canonical | `eth_call router()` on Base |
| `tap.router` = boneDryRouter | `eth_call router()` on Base |
| Both pools initialised | `/api/pool` with each hook |
| App uses `tapLegacy` | `NEXT_PUBLIC_HOOK_ADDRESS` in `web/.env.local` |
| `Tap.router` immutable | `contracts/src/Tap.sol:42` |
| Only the shipping app can pull | `contracts/lib/aqua/src/Aqua.sol:63-64` |
| Routing filters to `n.router` | five sites, listed in §0.1 |
| Subgraph indexes `app` | `web/lib/graph.ts:33` |
| `makerBook` does not filter by app | `web/lib/graph.ts:258` |
| 146 vs 3 active strategies | subgraph query, both apps, `active: true` |
