# Bone Dry — Phase 7: landing, dashboard, and every tab (2026-09-12)

Third workstream. `PLAN-ANTIGRAVITY-VM.md` (opcode 35) is done;
`PLAN-ANTIGRAVITY-EVENTS.md` (events + subgraph) is in progress. This one is
**`web/` only** — those two forbid touching it, and this one forbids touching
`contracts/`.

**Ownership warning:** another session has uncommitted work in `web/`
(`Desk.tsx`, `Exposure.tsx`, `RouteInspector.tsx`, `TokenIcon.tsx`,
`desk.module.css`, `types.ts` are all modified right now). **Do not start this
plan until that work is committed or explicitly handed over.** Two agents editing
`Desk.tsx` at once will lose work.

---

## 0. Why the landing page is now wrong

The pitch changed. The site still argues the old one.

`Landing.tsx:216` says **"A pool that holds nothing."** and `:225` says *"A
Uniswap v4 pool with zero TVL… **we check** they can actually pay before we route
to them."*

Two problems:

1. **"Zero TVL" invites the comparison we lose.** It frames us as a DEX, and any
   judge will note that 1inch's own aggregator has deeper liquidity. Zero TVL is a
   *mechanism*, not the argument.
2. **"We check" is no longer true, and the new truth is stronger.** We used to
   filter makers off-chain. Now the strategy refuses *itself*, on-chain, in
   1inch's VM, for any taker through any app whether Bone Dry is involved or not.
   "We check" undersells it into a trust-us claim.

The new argument, in the plainest words available — **this is the spine of every
copy change below**:

> On 1inch Aqua a maker never deposits anything. The money stays in their wallet;
> they just **promise** it. Nothing stops them promising the same money twice — or
> 257 times, which is the real record on Ethereum. It is writing cheques with
> nothing checking the balance.
>
> **Everyone else built a better price. We built a promise that can't bounce.**

`README.md` was rewritten around this already. Read it before writing any copy.

### What is already right — do not rewrite these

- `Landing.tsx:259` (the FINDING section) already says *"promising liquidity they
  did not hold"* and explains the non-enumerable mapping correctly. **Keep the
  structure**; only upgrade the numbers (§3.2).
- `Landing.tsx:298` — *"Your money never leaves your wallet."* Still exactly true
  and still the best line on the page.

---

## 1. Hard rules

1. **Never `git add -A` or `git add .`.** Exact paths only.
2. **Do not touch `contracts/` or `subgraph/`.**
3. **Do not unify the two CSS systems.** `Desk.tsx` imports `desk.module.css`;
   `app/ui/app/*` imports `app.module.css`. `PLAN-ANTIGRAVITY.md` §0 documents this
   split and says leave it — that is still correct. **Before styling anything,
   check which module that file actually imports.**
4. **Never fake data.** This repo has removed invented visualisations before (see
   the doc comment atop `app/ui/app/DepthChart.tsx`). If a number cannot be
   computed from real data, show the empty state — do not approximate.
5. **Never claim an Aqua commitment is binding.** `dock()` costs 4,452 gas and is
   instant ([PROOFS.md](PROOFS.md) P3). No UI string may imply otherwise.
6. **Null is not zero.** The subgraph work makes `backing`/`utilBps` nullable
   precisely so "never measured" is distinguishable from "zero backing" — and 419
   Ethereum pairs genuinely have zero backing. Render null as *unknown*, never as
   0% or as a healthy state.
7. Per-item verification: `npx tsc --noEmit` clean **and** a real screenshot from
   `npm run dev`, not a description.
8. **Stop at every `--- CHECKPOINT ---`.**
9. Commit per item, exact paths, trailer:
   `Co-Authored-By: Antigravity <noreply@google.com>`

---

## 2. Phase 7a — clear the dead code first

Do this before anything else; it removes files you would otherwise waste time
reading.

### 2.1 Delete

- **`app/app/lookup/page.tsx`** (305 lines). Orphaned — nothing links to
  `/app/lookup`, verified by grep. It duplicates the `lookup` tab
  (`app/ui/app/Lookup.tsx`, 205 lines).
  **Before deleting, move its Subgraph-MCP discovery section** (the
  `searchSubgraphsForTokens` block, `mcpTokenCard` / `mcpList` markup) into
  `app/ui/app/Lookup.tsx`. That feature is real, is a second independent Graph
  product, and only exists on the orphaned page.

### 2.2 Do **not** delete — wire up instead

There is a three-file chain that compiles, is excellent, and renders nowhere:

```
lib/solvencyEngine.ts  →  hooks/useSolvencyRoute.ts  →  app/ui/RouteInspector.tsx
                                                             ↑ imported by nothing
```

`solvencyEngine.ts` already models per-maker `SOLVENT | CLAMPED | SKIPPED_GHOST |
UNFILLABLE`, shielded volume and savings — exactly the swap-detail view we need.
It was built for the old off-chain filter and orphaned. §6 revives it.

Likewise `app/api/reliability/route.ts` has no caller, and `lib/refusals.ts:48`
says so in a comment. The subgraph work produces exactly this data. §7 wires it.

**Verification:** `npx tsc --noEmit` clean, `/app/lookup` returns 404, MCP
discovery still works inside the lookup tab.

`--- CHECKPOINT 7a ---`

---

## 3. Phase 7b — the landing page

**File:** `app/ui/Landing.tsx`, `app/ui/landing.module.css`

**Dhruv likes this page. Keep it.** The style, the scroll, the typography, the
animation, the four-section structure, the finding, the close — all stay. This is
a **headline swap plus one new section**, not a redesign. Anything not named below
is out of scope.

### 3.1 Do NOT touch the doodle — it is already correct

`Doodle.tsx` draws a strongman holding a rope taut between two cliffs labelled
**`PROMISED`** (`:387`) and **`DELIVERABLE`** (`:414`). On scroll the ground walks
away, the rope tightens, his arms stretch and then tear off at the shoulder. Its
own doc comment says *"He is holding the two halves of a promise together by main
strength and nothing else"* and *"the promise did not fail because he stopped
trying."*

**That is the new pitch, already drawn.** The gap he strains across is exactly the
102,593-vs-4 number. Do not redraw it, do not relabel it, do not touch the GSAP
timeline or the rope path constants — `ROPE` interpolates by matching command
order and is fragile.

The mismatch on this page is **not** the illustration. It is that the headline
above it argues about TVL while the drawing argues about a promise. Fixing the
headline is the whole job.

### 3.2 Hero headline and deck (`Landing.tsx:216-228`)

The h1 is two `claimLine` spans — keep that shape, two short lines.

- **h1:** must be about the **promise**, so it agrees with the drawing beneath it.
  *"A promise / that can't bounce."* is the working line. Propose alternatives if
  better, but it may not be about TVL, pools, or liquidity depth.
- **deck:** in plain words — makers never deposit, nothing stops the same money
  being promised twice, and this strategy refuses *itself* on-chain. **Do not use
  the words "we check."** That was true of the old off-chain filter and undersells
  the on-chain one into a trust-us claim.

### 3.3 The finding (`Landing.tsx:259-270`)

Structure is right. Replace the Base numbers with the stronger Ethereum ones:

> **102,593 WETH advertised. 4 deliverable.**

Supporting figures, all from [COUNCIL-VERDICT.md](COUNCIL-VERDICT.md) §1: 860
multi-strategy maker/token pairs, 600 overcommitted, 419 with zero backing, and one
wallet carrying **257 strategies on a single token**.

**Do not put WBTC on the page.** Its advertised figure exceeds the total supply of
bitcoin by ~68× — it is real junk data, it is evidence *for* the argument, but on a
landing page it reads as a broken metric. README's caveat explains the reasoning.

Keep DAI (20.6%) somewhere if it fits: a number that is not 100% is what makes the
100% ones credible.

### 3.4 Proof strip (`Landing.tsx:273` region)

The first figure is currently `0` (zero TVL). Replace with figures that prove the
new claim — `257` (strategies on one wallet), `4,452` (gas to revoke everything),
`54` (tests green on a mainnet fork) are all true and all more interesting than a
zero. Keep the strip's existing layout and animation.

### 3.5 NEW section — "what you can actually do here"

Insert **one new section between the proof strip (`:273`) and the close
(`:297`)**. Right now the page argues a problem and then asks for a click without
ever showing what the app does — a visitor has to take it on faith.

Two panels, matching the first two dashboard cards from §4 so the story is
continuous:

| Panel | Shows |
|---|---|
| **Swap** | a real quote breakdown — makers used, one clamped, one refused with its reason. The refusal is the interesting row; label it as a save, not an error. |
| **Provide** | the encumbrance builder in miniature — the two parameters in words, and the completeness warning (*"3 declared, 9 live"*). |

Rules:

- **Static or real, never faked.** A screenshot or a hard-coded *representative*
  example clearly marked as an example is fine. A fabricated number presented as
  live is not (rule 4).
- Match the page's existing type and palette. It must read as part of this
  landing page, not as an embedded app.
- Each panel links into its tab: `/app` → that card's destination.
- Do not add new GSAP timelines. Reuse the existing `data-fade` / `data-proof`
  scroll-in attributes already used by the sections around it.

### 3.6 Keep untouched

`:297` *"Your money never leaves your wallet."*, the CTA, and the CTA note. These
are the best lines on the page and the close is already correct.

`--- CHECKPOINT 7b --- screenshot the full scroll, top to bottom.`

---

## 4. Phase 7c — the dashboard entry

**Files:** `app/ui/Desk.tsx` (`:120` holds the default tab), `app/ui/app/Shell.tsx`
(`:11` holds `TABS`)

Today `/app` opens straight onto the swap tab. That is the wrong first impression:
a judge with no wallet lands on a trade form, and swap invites the liquidity
comparison we lose.

**Replace the cold-open with three choice cards.** No wallet required to
understand any of them, and each carries a live number so the cards *are* the
evidence, not just navigation:

| Card | Goes to | Live figure on the card |
|---|---|---|
| **See what's real** | `explore` | advertised vs deliverable for the selected token |
| **Make a promise that holds** | `provide` | how many live makers are overcommitted right now |
| **Swap against it** | `swap` | makers currently deliverable for this pair |

Rules:

- The card view is the default at `/app`. Choosing a card reveals the tab bar and
  the chosen tab; the tab bar stays available from then on.
- **A returning visitor should not be re-asked.** Persist the last choice in
  `localStorage`, wrapped in try/catch, and fall back to showing the cards.
- Numbers come from existing endpoints (`/api/coverage`, `/api/makers`). If one is
  unavailable, that card shows its empty state and stays clickable. **Never
  fabricate a figure to fill a card.**
- `portfolio` and `lookup` remain tabs, not cards.

`--- CHECKPOINT 7c --- screenshot cards + the state after choosing one.`

---

## 5. Phase 7d — Provide: the encumbrance builder

**File:** `app/ui/Desk.tsx:642` (`ShipStrategy`)

This is the hero of the whole project and it does not exist yet. Today Provide
ships a plain strategy.

Add, above the existing ship controls:

1. **Your exposure** — for the connected wallet and selected token: total promised
   across every live strategy, wallet balance, allowance, and utilisation. Source:
   `/api/exposure` (already used by the lookup tab).
2. **The two parameters**, with the consequence stated in words next to each:
   - `maxUtilBps` — *"refuse once more than N% of my wallet is already promised"*
   - `widenBps` — *"quote this much worse at full utilisation"*
3. **Sibling list, pre-filled from the index.** The maker must never type 32-byte
   hashes. Show count and let them inspect.
4. **The completeness warning** — the single most important element on the page:
   > *"You declared 3 siblings. You have 9 live. This strategy will
   > under-constrain."*
   Source: `siblingListComplete` / `missingSiblings` from the subgraph
   (`PLAN-ANTIGRAVITY-EVENTS.md` §5). **Until that lands, compute it client-side
   from `/api/exposure` and mark it clearly as a preview.**
5. **A live preview of the curve** — at current utilisation, what a 1 WETH quote
   becomes, and at what utilisation it would refuse.

**Hard constraint:** a maker with more than 6 siblings cannot be fully
constrained — SwapVM caps instruction args at 255 bytes, leaving (255 - 38)/32 = 6
sibling slots after accommodating the 32-byte declaredTotalEncumbrance. Say so plainly
in the UI. Do not silently truncate the list.

`--- CHECKPOINT 7d --- screenshot with a wallet that has ≥2 live strategies.`

---

## 6. Phase 7e — Swap: the transaction detail

**Files:** `app/ui/app/Swap.tsx`, and revive `app/ui/RouteInspector.tsx`

`RouteResponse` (`app/ui/types.ts:24`) already carries everything needed —
`slices[]`, `clamped[]`, `makersSkipped[]`, `makersUnfillable[]`,
`improvementBps`, `singleMakerAmountOut`. Nothing new is required from the API.

Three states, and all three must be visible:

**Before — the quote breakdown.** Render `RouteInspector` under the swap form:
one row per maker with its `SOLVENT / CLAMPED / SKIPPED_GHOST / UNFILLABLE` status
from `buildSolvencyWaterfall`. Show `improvementBps` against
`singleMakerAmountOut` — routing across makers is worth real basis points and we
currently never say so.

**During — pending.** Keep the maker list on screen with the pending tx hash. Do
not replace the breakdown with a spinner; the breakdown is the interesting part.

**After — the receipt.** Which makers actually filled, which were skipped, and
**why**, using the `reason` selector added in Phase 6b: `EncumbranceExceeded`,
`EncumbranceInsufficient`, `EncumbranceZeroBacking`, `QuoteUnusable`,
`EmptyRevertData`. Render the human name, never the raw selector.

A refused maker is **the product working**, not an error. Style it as a save —
*"skipped: would not have been able to pay"* — not as a failure.

`--- CHECKPOINT 7e --- screenshot all three states of one real swap.`

---

## 7. Phase 7f — formulas and the reliability feed

### 7.1 Show the maths

Every number on the surface should be able to show its own formula on demand — a
small "?" that reveals the expression and the live inputs. Four formulas:

```
depth      = min(virtual, wallet, allowance)
encumbered = Σ rawBalances(maker, app, sibling_i, tokenOut)
util       = encumbered / backing
haircut    = amountOut × widenBps × util / 1e8
free       = backing − encumbered
```

Plain HTML and CSS is fine. **Do not add a maths-rendering dependency** (KaTeX or
similar) for five expressions — two competitors did and it is not worth the weight.

This is a differentiator: it turns "trust our number" into "here is the arithmetic
and here are its inputs."

### 7.2 The reliability feed

Wire `app/api/reliability/route.ts`, which has no caller today, into the `explore`
tab: per maker, fills vs skips, and the refusal reasons behind them. Once the
subgraph lands, source it from `MakerRefusal` (deduped — the same refusal is
emitted twice by Tap's two placement loops, and the subgraph collapses it).

`--- CHECKPOINT 7f ---`

---

## 7g — Where every number comes from

Getting this wrong is how a UI says "solvent" and the transaction then reverts.
**The rule: anything that decides whether a transaction will succeed is read live
from chain at quote time. Anything historical or aggregate comes from an index.**

### Live from chain (RPC, every quote)

| Value | Why it cannot be cached |
|---|---|
| `router.quote(...)` | the number the user is about to trade on |
| maker `balanceOf` + `allowance` | backing moves every block; a stale read is a revert |
| `Aqua.rawBalances(maker, app, hash, token)` | virtual balance changes on every fill |
| connected wallet balance / allowance / chain id | obvious |
| PoolManager `slot0` / liquidity | proves the pool really holds nothing |
| gas price | §7h |

### From the subgraph (impossible to read on-chain)

| Value | Why |
|---|---|
| every live strategy a maker has | **Aqua's mapping is not enumerable** — this is the whole reason the index exists |
| `siblingListComplete`, `missingSiblings`, `liveSiblingCount` | needs all strategies at once |
| refusal history + reasons | **reverted transactions emit nothing** — only Tap's logs survive |
| `EncumbranceApplication` history | the haircut curve over time |
| decoded `maxUtilBps` / `widenBps` / `declaredSiblings` | decoded from `Shipped` program bytes |

### From Postgres (`/api/*`)

Cross-chain aggregates and anything on **Ethereum mainnet**, where no subgraph is
deployed — including the landing page's headline figures. **The subgraph is
Base-only** (`subgraph.yaml`, three `network: base` data sources). Do not assume a
subgraph field exists for an Ethereum maker; it does not.

### Never

Anything derivable client-side from data already fetched. Do not add a round trip
to compute a percentage.

---

## 7h — The gas panel (do this one; it is the best feature on the list)

A plain "estimated gas: $2.10" is table stakes. Ours can say something no other
project can, because we already compute the counterfactual.

`RouteResponse` (`app/ui/types.ts:24`) already carries `improvementBps`,
`singleMakerAmountOut`, `slices[]`, `makersSkipped[]` and `makersUnfillable[]`.
Combine those with a live gas price and `eth_estimateGas`:

**Panel 1 — is routing across makers worth it?**

> Routing across 4 makers costs **$1.40 more in gas** and earns you **$18.20 more
> output**. Net **+$16.80**.

More makers means a better price *and* more gas. Nobody in this field shows the
trade-off, and we are the only ones holding both halves of it.

**Panel 2 — what the refusals saved.**

> 3 makers were skipped. Filling against them would have reverted, costing you
> roughly **$0.90** in gas for nothing.

This converts the product's core behaviour from an invisible negative ("we
removed some makers") into a visible positive with a dollar figure on it.

Rules:

- Use a real gas estimate (`eth_estimateGas` on the actual calldata) and a real
  gas price. **Do not hard-code a gas figure** (rule 4).
- Price in USD via the existing `/api/price` route. If it is unavailable, show
  gas units and native token only — never a guessed dollar value.
- If `improvementBps` is zero or negative, say so plainly. A panel that only ever
  reports good news is not trustworthy.

---

## 7i — Make every number verifiable

The cheapest credibility win available, and it suits judging specifically.

Next to each headline figure, a small **"verify"** affordance that copies the exact
thing needed to check it independently:

- subgraph figures → the GraphQL query
- chain reads → the address + method, and a block explorer link
- index figures → the API URL that produced them

We are asking people to believe a measurement that contradicts what Aqua
advertises. Handing them the query is a stronger argument than any amount of
design. `CopyButton.tsx` already exists and is used in 7 places.

---

## 8. Do not do these

- Do not touch `contracts/`, `subgraph/`, or the GSAP setup.
- **Do not redraw, relabel or retime `Doodle.tsx`.** It already says PROMISED /
  DELIVERABLE and is the new pitch drawn; the `ROPE` path constants are fragile.
- Do not redesign the landing page. Headline, deck, proof figures and one new
  section only — everything else on it stays.
- Do not unify `desk.module.css` and `app.module.css`.
- Do not render a null `backing` / `utilBps` as `0` or as healthy.
- Do not write any string implying a commitment is binding or guaranteed.
- Do not put the WBTC figure on the landing page.
- Do not invent a number to fill a card or a chart.
- Do not add a maths-typesetting library.
- Do not start while another session has uncommitted `web/` work.

## 9. Open questions — answer, don't assume

1. Does the card view live at `/app` with tabs revealed after choosing, or at a
   separate route with tabs at `/app/<tab>`? Routing affects back-button
   behaviour — propose one and say why.
2. `Explore` and `Lookup` overlap: one browses makers, the other checks a pasted
   address. Should they merge into one tab now that a card handles discovery?
3. Until `siblingListComplete` ships from the subgraph, is the client-side
   approximation in §5.4 accurate enough to show — or should the warning be hidden
   rather than shown as a preview? Recommend one.
