# Bone Dry — Next Phase: become a real Aqua front-end, not a demo of one

Context for whoever reads this (Antigravity, or Dhruv reading it back): the
previous Claude session that wrote this is ending (weekly limit). This is a
multi-day roadmap, not a single sprint — six phases, meant to be worked
through over the next 2-3 days without a session actively steering each
step. Each phase has its own verification section; treat those as gates,
not suggestions. Commit per phase, not per file, so there's a clean
checkpoint to roll back to if a phase goes sideways.

**The framing, stated plainly:** 1inch's own track says "build an Aqua
app." Their own Aqua app (app.1inch.io — Aqua tab) is good: real charts,
a leaderboard, a Learn section, open token search across any pair, and an
onboarding flow that gets a new user swapping or providing liquidity in a
few clicks. Ours, right now, is a working, honest, real-data product — the
Lens/coverage/solvency-checking work this whole project is built on is
real and 1inch's own app doesn't have it — but it looks and feels
unfinished next to theirs. The goal of this phase is not to copy their
product; it's to reach their production bar on breadth and polish, on top
of the thing we already have that they don't: proof a maker's promises
are actually backed.

If this phase succeeds, a judge (or any real user) should be able to land
on this app, see real market pairs beyond WETH/USDC/MOCK, watch a real
price chart, understand the solvency angle from the Learn section, and
come away thinking "this is a legitimate Aqua front-end, and it does one
thing 1inch's own app doesn't."

---

## 0. What research turned up (read before building anything)

Fetched from `1inch.com/aqua/learn` directly — this is what their own app
teaches a new user, and what "good" looks like for this track:

- **Aqua's own framing**: "a shared liquidity layer for self-custodial
  liquidity provision." One wallet balance backs multiple positions
  simultaneously — this is exactly the "not enumerable, claims can exceed
  reality" property this whole project is already built around. We
  understand this primitive better than most Aqua apps will, because we
  built a solvency checker for it.
- **Position shapes**: "Straight" (concentrated in a price range) and
  "Curved" (for pegged/parity assets, e.g. stablecoin pairs) — two
  distinct range-chart visualizations, not one generic chart.
- **Per-position setup**: price range (lower/upper bound), swap fee
  (auto/preset/custom), and backing amount — configured against a live
  price chart with range-preset buttons (±10%, ±20%, full range, custom).
- **"Coverage"**: their own term for "how much of a position's quote its
  current wallet backing supports" — this is functionally the same
  concept our own Lens/coverage work already measures, just without the
  enforcement/verification layer we built. Worth naming this connection
  explicitly somewhere in the UI or Learn content: we're not doing
  something unrelated to Aqua's own vocabulary, we're the missing half of
  it.
- **Fee model**: fees accrue directly to the position holder, not pooled —
  explicitly designed to prevent JIT fee-sniping.
- **Onboarding flow**: connect wallet → pick pair + shape → configure range
  on a live chart → set fee → set backing amount → "Ship" (their own verb
  too — signs and publishes in one step).
- **Leaderboard**: ranks liquidity providers by volume/liquidity/fees/APY,
  filterable by time window, with a network-share breakdown and a live
  recent-swaps feed.
- **Learn section**: risk disclaimers stated plainly (smart-contract risk,
  impermanent loss, market risk), video walkthroughs, an Aave-looping
  guide for advanced users.
- **Token breadth**: their pair picker searches an open token list (name,
  symbol, or pasted address) across categories (Top/Trending/Gainers/
  New/Most viewed) with live price/volume data — this is not something
  special to Aqua, it's their existing 1inch token/price API surface
  applied to the pair picker. We already integrate two real Graph
  products (Token API, Subgraph MCP) for balance/discovery data — Phase C
  below is about reusing that muscle for price/market data, not building
  something unrelated from scratch.

---

## 1. Hard rules (same spirit as every plan before this one, one change)

1. **Never `git add -A` or `git add .`.** Exact paths only.
2. **Do not touch:** `web/app/ui/Landing.tsx`, `landing.module.css`,
   `Doodle.tsx`, `useIsomorphicLayoutEffect.ts`, `web/app/page.tsx`. The
   landing page's spare, editorial look is a deliberate choice and stays
   exactly as it is — this phase is about the `/app` product surface, not
   the landing page. Do not let "make it look more like a real product"
   bleed into "make the landing page busier."
3. **Ask before touching:** `web/app/layout.tsx`, `globals.css`,
   `Motion.tsx`, `Web3.tsx`.
4. **Do not touch `contracts/` at all**, and do not broadcast any
   transaction from any script.
5. **The one rule that changes this phase**: `globals.css`'s comment
   ("Radius 0, no shadows, no gradients") was a deliberate constraint for
   the swap-card era of this app. It's now actively working against the
   goal — 1inch's own app (and every serious DeFi app) uses depth, color,
   and motion to communicate state. This phase explicitly supersedes that
   rule for `/app` pages (not the landing page, see rule 2). Don't remove
   the comment without asking, but treat "flat, colorless, no shadows" as
   no longer binding for anything under `web/app/app/` and `web/app/ui/
   Desk.tsx` and its siblings.
6. **Every phase ends with real verification** — screenshots of the
   actual running app, real API responses, `npx tsc --noEmit` clean. The
   standard set by every previous plan in this repo does not relax just
   because the session steering it changed.
7. Commit per phase (not per file), exact paths, trailer:
   `Co-Authored-By: Antigravity <noreply@google.com>`
8. **Unsure whether something is in scope? It is not — ask Dhruv directly**
   rather than guessing, especially for anything touching money amounts,
   real API keys, or contract addresses.
9. **Never fake data.** If a chart has no real data source yet, show an
   honest empty/loading state, the same standard every other feature in
   this codebase already holds itself to. A fabricated-looking price
   chart is worse than no chart.

---

## 2. Phase A — Visual system overhaul (do this first, everything else builds on it)

**Goal:** `/app` (Swap, Provide, Portfolio, Explore, Lookup) reads like a
real trading product, not a document. This is foundational — building
charts and a leaderboard on top of the current flat card system will just
mean redoing their styling later.

### What to do

1. Read `web/app/globals.css` and `web/app/ui/desk.module.css` in full
   first — understand the existing token system (`--paper`, `--ink`,
   `--red`, `--mono`, `--serif`, etc.) before changing it. Extend it,
   don't replace it wholesale; the mono/serif typographic identity is
   good and should survive this pass.
2. Introduce real depth and hierarchy for `/app` surfaces: shadows,
   subtle gradients where they communicate state (e.g. a covered/backed
   position vs a shortfall), spacing that breathes, and a richer color
   role beyond `--ink`/`--red` for things like APY, volume, and coverage
   badges — 1inch's app leans on a blue/purple accent system against dark
   surfaces; ours doesn't have to copy that palette, but it should have
   an equivalently confident one, consistent with the mono/serif identity
   already established.
3. Dark mode / dark surface option for `/app` (their dashboard defaults
   dark) is worth strongly considering, but confirm with Dhruv before
   committing to it as the default — it's a big visual identity decision,
   not a styling tweak.
4. Every existing real-data element (coverage badges, the Finding hero,
   ExposureTable, the maker book) keeps working exactly as before — this
   phase is styling, not a rebuild of the data layer.

### Verification

1. `npx tsc --noEmit` clean.
2. Before/after screenshots of Swap, Provide, Portfolio, and Explore tabs.
3. Confirm the landing page (`/`) is pixel-identical to before — screenshot it too, as proof nothing leaked.

### Commit

```
git add web/app/globals.css web/app/ui/desk.module.css [other touched ui files]
git commit -m "Give /app a real visual system instead of the flat card look"
```

---

## 3. Phase B — Real price charts, both range shapes

**Goal:** a maker configuring a Ship-a-strategy position sees a real price
history chart, not just number inputs, and can pick a price range against
it the way Aqua's own "Straight" and "Curved" position types do.

### What to do

1. Pick a charting library via the CDN-free path this repo already uses
   (`npm install`, not a CDN script) — a lightweight one (`lightweight-charts`
   or `recharts`) is enough; this doesn't need TradingView-grade
   complexity. Confirm the choice with Dhruv before installing if unsure —
   a new dependency is worth a quick check-in.
2. Real price data: reuse what's already proven working this session —
   the Chainlink feeds already wired for WETH/USDC (`web/lib/oracle.ts`,
   `web/lib/networks.ts`'s `oracleFeeds`) give a live spot price; for
   historical series, check whether Chainlink's `latestRoundData`/round
   history is enough, or whether Token API/a public price-history
   endpoint is needed. **Do not fabricate a plausible-looking historical
   line** — if no real historical source is wired yet, show a live
   spot-price point and an honest "historical view coming" state rather
   than a fake curve.
3. In `ShipStrategy` (`web/app/ui/Desk.tsx`), add the chart above the
   existing claim inputs, with range-preset buttons (±10%, ±20%, full
   range, custom) that visually mark the selected range on the chart —
   this is presentation on top of the existing claim/pricing logic, not a
   new pricing model. It does not need to functionally change what gets
   shipped yet (that's a bigger follow-up); it needs to make the existing
   flow feel like a real position-builder.
4. Distinguish "Straight" vs "Curved" visually if/when both are
   meaningfully different in this app (today: XYC is curve-shaped,
   BeaconStrategy is a flat oracle line) — the chart treatment should
   honestly reflect which pricing model is selected, not use one generic
   chart for both.

### Verification

1. `npx tsc --noEmit` clean.
2. Screenshot the chart rendering real Chainlink-sourced data, with the
   actual current price marked.
3. Screenshot the range-preset buttons changing the marked range.
4. State plainly whether the chart is showing real historical data or an
   honest "spot only" state — do not let this be ambiguous in the report.

### Commit

```
git add web/app/ui/Desk.tsx web/app/ui/desk.module.css web/package.json web/package-lock.json [chart component files]
git commit -m "Add a real price chart with range presets to Ship a strategy"
```

---

## 4. Phase C — Open pair/token search, not a hardcoded list

**Goal:** a user can search any real token (name, symbol, or pasted
address) the way Aqua's own pair picker does, instead of being limited to
the small hardcoded set this app ships with today.

### What to do

1. Find where the current pair/token list is hardcoded (`web/lib/
   pairs.ts`, `web/lib/networks.ts`'s token tables, wherever `TOKENS` is
   built) and understand its current shape before touching it.
2. Build a search-driven token picker: an input searching by name/symbol/
   address, backed by a real token-list/price source — the Token API
   integration already live in this app (`web/lib/tokenApi.ts`) is the
   natural first place to check for a token-search or metadata endpoint;
   if it doesn't cover this, ask before reaching for a third data source.
3. Categories (Top/Trending/Gainers/New) are a nice-to-have, not
   required for this pass — a working real search across a real token
   universe matters far more than matching every filter tab Aqua's UI has.
4. **The trust boundary**: any token found via open search is, by
   definition, one this app has never independently verified. Every
   existing honesty pattern in this app (the TokenIcon fallback, the
   "unrecognised token" treatment in ExposureTable, the Subgraph MCP
   discovery panel) already assumes this — extend that pattern to the new
   picker rather than inventing a new one. A found-via-search token
   should look and behave exactly like an "unrecognised" token does
   elsewhere in this app until proven otherwise.

### Verification

1. `npx tsc --noEmit` clean.
2. Search for and select a real token this app has never had hardcoded
   before (something outside WETH/USDC/MOCK) — screenshot it working.
3. Confirm existing hardcoded pairs (WETH/USDC, WETH/MOCK) still work
   unchanged.

### Commit

```
git add web/lib/[touched files] web/app/ui/[touched files]
git commit -m "Let a user search any real token instead of a hardcoded pair list"
```

---

## 5. Phase D — Onboarding: land ready to act, on mainnet

**Goal:** today `DEFAULT_NETWORK` is Base Sepolia (`web/lib/networks.ts`)
— a new visitor lands on the free-tokens testnet, not on the "this is the
evidence" mainnet. Aqua's own onboarding gets a user to a swap or a
position in a few clicks; ours should too, and it should default to
showing the real thing first.

### What to do

1. **This needs a product decision from Dhruv before touching code**:
   should the default network flip to Base mainnet (8453)? The whole
   landing page's pitch ("real maker positions, read-only, this is the
   evidence") argues for it — but mainnet has real funds and the current
   Sepolia default exists specifically so a first-time visitor can try
   swapping/shipping with free tokens without any risk. Don't just flip
   `DEFAULT_NETWORK` unilaterally; propose the change, lay out the
   tradeoff exactly as stated here, and get an explicit yes first.
2. Regardless of the network-default decision, tighten the first-open
   experience: land directly on a populated Swap tab (a real pair, real
   depth already loaded) rather than an empty form waiting for input —
   check what `Desk.tsx`'s initial state does today and see how much of
   this is already true vs. needs work.
3. If mainnet becomes the default per the decision in step 1, the
   Provide tab's oracle-priced (BeaconStrategy) option needs an honest
   "not deployed on this network yet" state for mainnet, matching the
   pattern already built for Sepolia-only in Phase 2 of the prior plan —
   BeaconStrategy is Sepolia-only right now; don't let a mainnet default
   silently break that gating.

### Verification

1. Explicit written confirmation from Dhruv on the network-default
   decision, pasted into the report, before any default-network code
   change ships.
2. `npx tsc --noEmit` clean.
3. Screenshot the actual first-open state after the change.

### Commit

```
git add web/lib/networks.ts web/app/ui/Desk.tsx
git commit -m "Tighten first-open onboarding [+ flip default network to Base mainnet, if approved]"
```

---

## 6. Phase E — Leaderboard

**Goal:** a real ranking of makers on this app's own router, by a real
metric — not a copy of Aqua's cross-chain leaderboard (we don't have
their volume), but an honest equivalent scoped to what this app actually
indexes.

### What to do

1. The data already exists: `/api/apps`, `/api/coverage`, the `aquifer`
   subgraph's Maker/Strategy entities. This is a new view over data this
   app already has, not a new data source.
2. Rank real makers on our router by a real, defensible metric — total
   committed value, coverage ratio, active strategy count, whatever the
   subgraph can actually answer cleanly. State the ranking metric plainly
   in the UI (Aqua's own leaderboard is explicit about what it's sorting
   by — "Volume, 1M" as a visible, changeable control).
3. This is a genuinely good opportunity to make the solvency-checking
   story *more* visible, not less: consider a coverage-ratio column or
   sort option that plain volume-based leaderboards (including Aqua's
   own) don't have. That's the actual differentiator this project has
   over the platform it's building on top of — the leaderboard is a good
   place to say so without being asked.
4. Where does this live? A new tab, or a section on Explore — Dhruv's
   call if genuinely ambiguous, otherwise use your own judgment and note
   the reasoning in the report.

### Verification

1. `npx tsc --noEmit` clean.
2. Screenshot the leaderboard with real maker data, sorted.
3. Paste the actual API response(s) it's built from.

### Commit

```
git add web/app/api/[new route] web/app/ui/[touched files]
git commit -m "Add a real maker leaderboard scoped to this app's own router"
```

---

## 7. Phase F — Learn section

**Goal:** a short, honest explainer section — what Aqua is, what "shared
liquidity" and "coverage" mean, and specifically what this app adds that
Aqua's own app doesn't (the solvency check). This is a content task more
than an engineering one.

### What to do

1. A new page or section (`web/app/app/learn/page.tsx` or similar) —
   short, plain-language, matching this app's existing voice (see how
   `README.md` and the landing page copy already talk: precise, a little
   dry, no hype-speak).
2. Cover, at minimum: what Aqua's shared-liquidity model is (one wallet
   backs many positions — the reason claims can outrun reality), what
   "coverage" means in Aqua's own vocabulary and in this app's, and why
   Aqua's own balance mapping can't answer the solvency question on its
   own (the `rawBalances` non-enumerability point this whole project is
   built on — already written up clearly in `subgraph/STANDARD.md` and
   the README, reuse that framing rather than rewriting it from scratch).
3. Risk disclaimers, stated as plainly as Aqua's own ("smart-contract
   risk, impermanent loss and market risk remain") — this app's Lens
   reduces one specific risk (undisclosed insolvency), it does not
   eliminate the others, and pretending otherwise would undercut the
   project's own credibility.
4. Do not write marketing copy dressed as education. If a sentence reads
   like it's trying to sell rather than explain, cut it.

### Verification

1. `npx tsc --noEmit` clean.
2. Screenshot the finished page.
3. A quick self-check: would a judge reading only this page understand
   both what Aqua is AND what Bone Dry specifically adds to it? If not,
   it's not done.

### Commit

```
git add web/app/app/learn/
git commit -m "Add a Learn section explaining Aqua's shared-liquidity model and what Bone Dry adds"
```

---

## 8. Order of operations, and what "done" means for this file

Do the phases in order — A before B (chart styling depends on the visual
system), C and D can run in parallel with each other once A is done, E
and F are lowest-risk and can slot in whenever there's a natural pause.

This file is a roadmap for 2-3 days without active session-by-session
steering, not a rigid script — if a phase turns out to need a decision
only Dhruv can make (Phase D explicitly does), stop and ask rather than
guessing and shipping something that has to be unwound later. Every
previous plan in this repo has held to "verify, don't assert, ask when
unsure" as the actual standard this project is judged by internally, not
just an instruction to a coding agent — that doesn't change because the
session writing the plan changed.

When a new Claude session picks this back up, it should be able to read
this file plus the git log since `PLAN-ANTIGRAVITY.md` was last rewritten
and understand exactly what happened and what's left — keep commit
messages as detailed as every one before them in this repo's history, not
shorter because there's no one actively reviewing each one in real time.
