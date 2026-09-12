# Bone Dry — /app polish pass (fixes from live feedback, 2026-09-12)

Context for whoever reads this (Antigravity, or Dhruv reading it back): this
replaces the previous version of this file. That version was a 6-phase
roadmap (visual system, price charts, open token search, onboarding
defaults, leaderboard, Learn section) written when `/app` was much rougher.
Most of it already happened — `DepthChart.tsx` exists, maker-book pagination
exists, `TokenIcon` exists, the token search modal already does open
search. This file is a fresh, narrower punch-list: eight concrete issues
Dhruv found by using the live app just now, dictated in one long note. Work
through it in order; each item names exact files and lines already checked
against the current tree, not guesses.

**Read section 0 before touching anything.** It documents an architecture
split that is very likely the root cause of at least two of these bugs
(items 2 and 8), and you'll waste time patching symptoms if you don't
understand it first.

---

## 0. Load-bearing fact: this app has two parallel, half-merged CSS systems

`web/app/ui/Desk.tsx` (the page shell — Header, FindingRail, tab routing,
`ShipStrategy`/Provide) imports styles from **`web/app/ui/desk.module.css`**.

`web/app/ui/app/Swap.tsx`, `Shell.tsx`, `Portfolio.tsx`, `DepthChart.tsx`,
`bits.tsx` (the newer `/app` component set, under `app/ui/app/`) import
styles from **`web/app/ui/app.module.css`**, which scopes almost everything
under a `.root` class specifically to defend against `globals.css` bleeding
in (see the hover-fix comment near the top of that file).

`desk.module.css` has **no `.root` class at all** — nothing in it is scoped
the way `app.module.css` is. Two different class names can exist with the
same intent in each file (e.g. `app.module.css` has `.overlay`/`.sheet` for
a token-search sheet that no longer appears to be used; `desk.module.css`
separately defines `.modalBackdrop`/`.modalCard` for the modal that's
actually rendered today, `TokenSearchModal.tsx`). This is exactly the kind
of split that produces "it looked right in one place and broken in
another" bugs.

**Do not try to unify these two files in this pass** — that's a real
refactor, higher risk than anything below, and out of scope for a feedback
punch-list. But when you touch styling for any component, check which
module it actually imports (`import s from "./desk.module.css"` vs
`"../app.module.css"` vs `"../app/app.module.css"`) before assuming a class
exists — several items below depend on getting this right.

---

## 1. Hard rules (same as every prior plan in this repo)

1. **Never `git add -A` or `git add .`.** Exact paths only.
2. **Do not touch:** `web/app/ui/Landing.tsx`, `landing.module.css`,
   `Doodle.tsx`, `useIsomorphicLayoutEffect.ts`, `web/app/page.tsx`.
3. **Do not touch `contracts/` at all**, and do not broadcast any
   transaction from any script.
4. **Never fake data.** This codebase has repeatedly and deliberately
   removed fabricated visualizations (an invented bonding curve with fake
   timestamps was one; ship a strategy's depth chart was rebuilt once
   already this project specifically to stop implying a shape that wasn't
   real — see the doc comment at the top of
   `web/app/ui/app/DepthChart.tsx`). If a fix in this file would require
   showing a number or shape that isn't actually computed from real data,
   stop and ask instead of approximating it.
5. Every item below ends with its own verification. Do them per-item —
   `npx tsc --noEmit` clean, and a real screenshot of the changed UI in the
   actual running app (`npm run dev`), not a description of what it should
   look like.
6. Commit per item (not one giant commit), exact paths, trailer:
   `Co-Authored-By: Antigravity <noreply@google.com>`
7. **Unsure whether something is in scope, or whether a fix changes
   behavior beyond styling? Ask Dhruv directly** rather than guessing.

---

## 2. Maker book: cap at 8 rows per page, not 10

**File:** `web/app/ui/app/Swap.tsx`

Line 19:
```ts
const PAGE_SIZE = 10;
```
Change to:
```ts
const PAGE_SIZE = 8;
```
That's the entire change — pagination math (`bookPages`, `bookPageClamped`,
`pageRows` around lines 154–156) already derives from this constant, and
the Prev/Next pager already exists. Nothing else needs to move.

### Verification
Open Swap tab, a pair with >8 live makers (WETH/USDC on Base has 55+ today).
Screenshot showing 8 rows and a "page 1 of N" pager with N now one higher
than before.

---

## 3. Route Receipt card: my take, and what to do about it

**File:** `web/app/ui/app/Swap.tsx`, the section starting at line ~330
(`{/* ── route receipt ──... */}`), specifically the `.zeroRow`/`.zeroFig`
block around lines 364–378.

**Dhruv's complaint:** it "feels ugly," specifically calls out the giant
"0" TVL figure.

**My assessment:** the ugliness isn't the card's existence — a route
receipt showing exactly what the router did (wallets filled vs skipped vs
unfillable, pool ID, hook data) is genuinely useful and honest, keep that.
The actual problem is that **"Liquidity in the pool: 0" is rendered with
the same visual weight and size (`.zeroFig`, a large serif figure) as a
headline stat**, on a pool that is *supposed* to be at zero — that's the
whole "Bone Dry" thesis (liquidity lives in makers' wallets, not the pool).
To a first-time viewer a giant bare "0" reads as "something is broken,"
not "this is working as designed," even though the line right next to it
already says "zero is the mechanism, not a fault." The copy is doing the
explaining that the typography is actively fighting against.

**Fix:** de-emphasize the zero-TVL row instead of removing it.
- Shrink `.zeroFig` for this specific case, or replace the giant numeral
  with a small inline badge/pill (reuse the `s.pill`/`s.pillShort` pattern
  already used elsewhere in this same file for state tags) that just reads
  "0 — by design" or similar, next to the existing explanatory sentence,
  rather than a standalone hero number.
- Check `app.module.css` for `.zeroRow`/`.zeroFig` (search both
  `app.module.css` and `desk.module.css` — confirm which file actually
  defines these before editing, per section 0) and reduce `.zeroFig`'s
  `font-size` there, or add a new modifier class used only in this spot —
  don't shrink `.zeroFig` globally if anything else uses it (grep first).
- Leave the Pool ID / Wallets filled / Skipped / Unfillable / Unfilled rows
  and the raw hook data toggle exactly as they are — those are the useful,
  legible part of this card and nobody complained about them.

### Verification
Screenshot the Route Receipt card before and after, on a pair with a
genuinely empty pool (any Bone Dry pair). The "0" should read as a small,
calm status indicator, not a headline number.

---

## 4. Depth chart: my take, and what to do about it

**File:** `web/app/ui/app/DepthChart.tsx` (used from `web/app/ui/Desk.tsx`
in `ShipStrategy`, around the `02 · DEPTH AND RANGE` section).

**Dhruv's complaint:** "I can't see any pricing thing," "I don't see any
curves," references x·y=k / concentrated / other curve shapes, "I see no
price bound here."

**My assessment:** this chart is deliberately honest and I don't think it
should grow a curve it can't back up — see the doc comment at the top of
`DepthChart.tsx`, written for exactly this reason in the previous pass. A
constant-product strategy genuinely has flat, price-independent marginal
depth; drawing a bell curve for it would be the same kind of fabrication
this codebase has already ripped out once. **But the current flat-rect
rendering (lines ~203–210) is too subtle to read as "this is the shape of
depth," which is a legitimate part of the complaint** — a pale 5%-opacity
fill with one thin top line doesn't visually register as data at normal
screen brightness, so it reads as "no graph" even though it is one. Fix
the legibility, not the honesty:
- Raise the fill opacity of the CPMM flat band (line 208, currently
  `opacity={0.05}`) — try something in the `0.12–0.18` range and check it
  against both the light and any dark-mode rendering.
- Add a visible top-and-bottom border on the flat band, not just the
  current single top line, so it reads as a filled region with a clear
  boundary rather than a faint wash.
- Label the shape in-chart, not just in the badge above it — e.g. a small
  caption inside or under the SVG itself ("flat: this pricing model quotes
  the same depth at every price") so a first-time viewer doesn't have to
  infer the shape's meaning from the badge text alone.
- For the oracle spike (lines 211–224): the single vertical line is
  correct but thin (`strokeWidth={2.5}` on a 150px-tall viewBox) — thicken
  it slightly and consider a small radial highlight/halo around the dot at
  its tip so it doesn't get lost next to the flat CPMM case when a user
  toggles between the two pricing options and compares them.
- **Do not add: a bell curve, a concentrated-liquidity range shape, or any
  other curve type this app doesn't actually offer.** Bone Dry currently
  ships exactly two pricing models (constant-product, oracle-priced) — if
  and when a third (e.g. a real concentrated-liquidity range) is actually
  built, the chart should grow a third shape then, honestly reflecting it.
  Adding a decorative curve now, before that pricing model exists, would
  be the same mistake this file was written to avoid.
- The "no price bound here" complaint: this is correct and already stated
  in the caption below the chart ("neither pricing model enforces a price
  bound on chain") — the ±10%/±20%/Full range/Custom buttons above the
  chart are a *sizing reference*, not an enforced bound, and the copy
  already says so. If this is still confusing after the legibility fixes
  above, it's a copy problem, not a chart problem — flag it back to Dhruv
  rather than guessing at new copy.

### Verification
Screenshot both pricing modes (constant-product and oracle) with the
legibility changes applied, at the same zoom level as a first-time user
would see them (not zoomed into the SVG).

---

## 5. Provide tab: too many scroll-select-scroll-click round trips

**File:** `web/app/ui/Desk.tsx`, the `ShipStrategy` function (starts line
637) — sections `01 · Pricing mechanism`, `02 · Depth and range`,
`03 · Claim and fee`, and the publish button/summary card.

**Dhruv's complaint:** the flow today is scroll to see pricing options →
scroll to set range → scroll to enter claim/fee → scroll back up to hit
Publish. Too many round trips for one linear task.

**Dhruv's proposed idea:** move the black "Finding" banner (currently the
full-width bar at the top of every `/app` page,
`FindingRail` in `web/app/ui/app/Shell.tsx` line 95) into a **collapsed
vertical strip docked to the left edge**, that expands horizontally when
clicked.

**My assessment of that specific idea:** I'd push back on doing this as
described. The Finding banner is Bone Dry's core pitch (see the landing
page and README — "N of M live positions can't deliver what they
promised" is the entire reason this app exists) and it currently appears
identically on every tab, which is deliberate. Collapsing it to an edge
strip by default would bury the thing the app is supposed to lead with,
on every page, not just Provide — that's a bigger call than a UX tweak to
one tab, and I don't think it actually solves the scrolling problem, since
the banner is a fixed ~50-60px strip, not the reason Provide requires four
scrolls. **Don't implement the sidebar-Finding idea in this pass** —
flag it back to Dhruv as a separate, bigger decision (does he want the
Finding claim demoted on every page, not just Provide?) rather than
building it speculatively.

**What actually causes the scrolling, and the fix I'd make instead:**
Provide's three sections plus the publish summary are stacked vertically
as separate full-width cards, each with its own padding, and the "Publish"
action lives at the very bottom or in a separate summary card the user has
scrolled past. Two changes, scoped to `ShipStrategy` only:
1. **Make the claim/fee inputs and the Publish button co-resident on
   screen with whichever section is currently open**, by converting
   sections 01/02/03 into a compact stepper/accordion — one section open
   at a time (pricing → depth/range → claim & fee), each collapsing when
   the next is opened, instead of all three always fully expanded and
   stacked. This alone removes most of the scrolling, because the user is
   never looking at three full-height cards at once.
2. **Make the Publish button (and the live summary — "held in wallet /
   already promised / free to promise / this strategy claims") sticky**,
   pinned to the bottom (or side, on wide viewports) of the viewport once
   the user has scrolled past it once, so committing never requires
   scrolling back up. Check what renders that summary card today (search
   `ShipStrategy` for "Held in wallet" / "Already promised" / "PUBLISH
   ANYWAY" — it's the orange-bordered card in the screenshots) and give it
   `position: sticky` with an appropriate `top`/`bottom` offset inside its
   scroll container, or move it to a fixed side rail on desktop widths only
   (collapse back to inline on mobile).
- Keep all three sections' actual content and logic untouched — this is a
  layout/interaction change (accordion + sticky summary), not a rework of
  what pricing/range/claim controls exist or how `ShipStrategy`'s state
  works.

### Verification
Screenshot the new Provide flow at each step (pricing selected → range
selected → claim/fee entered → publish), and confirm on a normal laptop
viewport (not a huge monitor) that a user can go from landing on Provide to
clicking Publish with at most one scroll, not four.

---

## 6. Token images: these already exist — check why they didn't read as present

**Files:** `web/lib/tokenIcons.ts`, `web/app/ui/TokenIcon.tsx`.

Already wired and already used in `web/app/ui/app/Swap.tsx` (lines 266,
293 — the pay/receive token pills), `web/app/ui/Desk.tsx` (imported line
34), `web/app/ui/Exposure.tsx` (line 48), and `web/app/ui/
TokenSearchModal.tsx` (multiple rows in the picker list). This is not a
missing feature — before adding anything, find out why Dhruv didn't see
them:
- `iconUrl()` in `tokenIcons.ts` only has a Trust Wallet asset mapping for
  chain 8453/84532 (Base/Base Sepolia) — confirm which network Dhruv was
  on when he said this (the screenshots show Base). A 404 from Trust
  Wallet's repo for a given token is expected and `TokenIcon.tsx` is
  supposed to fall back gracefully — **open `TokenIcon.tsx` and confirm
  the fallback actually renders something visible** (an initials circle,
  a placeholder icon) rather than nothing, for a token with no Trust
  Wallet listing. If the fallback currently renders empty/blank, that's
  the real bug — fix the fallback to always show *something* (a colored
  circle with the token symbol's first letter is the usual pattern), not
  add a whole new icon system.
- Separately: the maker-book table (`Swap.tsx`, the table with columns
  Maker/Promised/Deliverable/Shortfall/Coverage/Oracle) shows maker
  *addresses*, not tokens, per row — there's no token to put an icon next
  to there, that's by design. If Dhruv meant he wants icons in that table
  specifically, that's a different ask (there'd need to be a token column
  first) — confirm with him rather than assuming.

### Verification
Screenshot the Swap tab's token pills and the token search modal's row
list on Base mainnet, showing real icons where Trust Wallet has them and a
visible (not blank) fallback where it doesn't.

---

## 7. Add a copy button on every address shown to the user

Confirmed: there is currently no clipboard/copy affordance anywhere in
`web/app/ui/app/Swap.tsx`, `Portfolio.tsx`, `Exposure.tsx`, or `Lookup.tsx`
— addresses are shown as plain shortened text (`shortAddr(...)`) with no
way to copy the full address without inspecting devtools.

**Do this:**
1. Add one new small component, e.g. `web/app/ui/CopyButton.tsx` — takes
   `value: string` (the full address) and renders a small inline icon
   button next to it. On click: `navigator.clipboard.writeText(value)`,
   with a brief visual confirmation (e.g. swap the icon for a checkmark
   for ~1.2s via local `useState`), wrapped in try/catch since clipboard
   access can be denied. Style it minimal/quiet — it should not compete
   visually with the address text itself.
2. Wire it in everywhere a full (not already-copyable) address is shown
   next to `shortAddr(...)`:
   - `web/app/ui/app/Swap.tsx` — maker book rows (`shortAddr(m.maker)`,
     around line 546), and the Route Receipt's Pool ID row (line ~380).
   - `web/app/ui/app/Portfolio.tsx` — wherever strategy/app addresses are
     shown in the "Live positions" table (`strategyHash`, `app` link).
   - `web/app/ui/Exposure.tsx` and `web/app/ui/Lookup.tsx` — any
     `shortAddr(...)` usage there.
3. Since `Swap.tsx`/`Portfolio.tsx` use `app.module.css` and
   `Exposure.tsx`/`Lookup.tsx` may use a different module (check per
   section 0), give `CopyButton` its own tiny inline styles (or its own
   minimal CSS module) rather than depending on a class from whichever
   module happens to be in scope at each call site — that keeps it
   portable across the split without needing to duplicate a class into
   both `app.module.css` and `desk.module.css`.

### Verification
Screenshot a maker-book row and the Portfolio live-positions table with
the copy button visible, and confirm a real click actually puts the full
`0x…` address on the clipboard (paste it somewhere to prove it, e.g. into
the search bar itself).

---

## 8. Restore the token-pair selector on the Provide tab (regression, confirmed)

**File:** `web/app/ui/Desk.tsx`.

Confirmed by reading the code: `TokenSearchModal` is already fully wired
for pair/token search (`handleSelectToken`, `handleSelectPair`,
`availablePairs`, `currentPair` — all exist, lines ~90–190), and the modal
itself is rendered once at the bottom of `Desk`'s JSX (line ~622). But the
`onPickToken` callback that actually *opens* it is only passed to `<Swap
.../>` (line 570: `onPickToken={(which) => { setSearchTarget(which);
setSearchModalOpen(true); }}`). `<ShipStrategy .../>` (line 581, the
Provide tab) receives `tokenIn`/`tokenOut` as plain values but has **no
prop and no button that opens the picker** — so today a user on Provide is
stuck on whatever pair Swap last had selected, with no way to change it
from Provide itself. This matches Dhruv's report exactly.

**Fix:**
1. In `Desk.tsx`, pass an `onPickToken` (or `onPickPair`, matching
   whatever makes sense for Provide's single-pair-at-a-time context — it
   likely wants `target: "pair"` specifically rather than tokenIn/tokenOut
   separately, since a strategy is shipped against one pair) prop down to
   `<ShipStrategy ...>` at line ~580, wired to the same
   `setSearchTarget`/`setSearchModalOpen` pattern already used for Swap.
2. In the `ShipStrategy` function (line 637 signature — add the new prop
   to both the destructure and the type block at lines 644–650), render a
   clickable pair display (e.g. "WETH / USDC ▾" as a button, styled
   consistently with however Swap's token pills look) near the top of the
   `01 · Pricing mechanism` section, calling the new callback on click.
3. Confirm `handleSelectPair`/`handleSelectToken` (lines 138–189) don't
   assume they're only ever called from the Swap context — read them
   fully before wiring Provide into the same path; if they need a small
   branch for `target === "pair"` opened from Provide vs from Swap, keep
   it minimal.

### Verification
Screenshot Provide tab showing the pair selector, click it, pick a
different real pair from the modal, and confirm Provide's pricing/depth/
claim sections all update to reflect the newly selected pair (not just the
label).

---

## 9. Token search modal renders with a broken/transparent backdrop

**Files:** `web/app/ui/TokenSearchModal.tsx`, `web/app/ui/desk.module.css`
(the modal's actual styles, `.modalBackdrop`/`.modalCard`, around line
1282 in that file).

**What the screenshot shows:** the modal opens with page content bleeding
through it at nearly full opacity — the maker book, the Route Receipt
section, and the header all still fully legible underneath/behind/beside
the search sheet, instead of the sheet appearing as a solid card over a
dimmed backdrop.

**What I checked, and what I didn't fully root-cause:** `.modalBackdrop`
itself is defined correctly (`position: fixed; inset: 0; background:
rgba(26,24,22,0.45); backdrop-filter: blur(4px); z-index: 999`) — on paper
that should render as a dimmed full-viewport backdrop. I could not
confirm from static reading alone why it isn't; the two most likely causes
that need to be checked live (`npm run dev`, devtools open) rather than
guessed at from source:
1. **A containing-block trap**: if any ancestor of where
   `TokenSearchModal` gets rendered in `Desk.tsx`'s tree has `transform`,
   `filter`, `perspective`, or `will-change: transform` set, `position:
   fixed` inside it stops being relative to the viewport and becomes
   relative to that ancestor instead — which would produce exactly this
   "the modal is contained/squashed inside part of the page" look. Check
   every ancestor between `Desk.tsx`'s root `<div className={s.root}>`
   (line 522) and where `<TokenSearchModal>` is rendered (line 622) for
   any of those properties, in both `desk.module.css` and any inline
   styles. Note `desk.module.css` has **no `.root` class defined at all**
   (confirmed by grep) — so whatever `s.root` resolves to on that outer
   div is currently a no-op class name; that's not itself the bug, but
   it's a sign this file's scoping hasn't been kept in sync with what's
   actually rendered, and worth a careful look at what *is* actually
   styling that outer container (global CSS from `globals.css`, most
   likely) while you're in there.
2. **z-index context isolation**: `app.module.css`'s sticky header
   (`.header`, `app.module.css` line ~160) sets `z-index: 50` on a
   `position: sticky` element — if the header (or another sticky/relative
   ancestor with its own stacking context) sits in front of the modal
   despite the modal's `z-index: 999`, that's a stacking-context bug, not
   a z-index-value bug — raising the number further won't fix it. Check
   with devtools' 3D/layers view or by inspecting computed stacking
   contexts.

**Do this:** reproduce the bug in the running dev server first (`npm run
dev`, open Swap, click a token pill), inspect the live DOM/computed styles
to find which of the two above (or something else) is actually happening,
then fix that root cause — don't patch it by e.g. raising `z-index`
further without understanding why the current value isn't already
winning, since that tends to just move the bug rather than fix it.

### Verification
Screenshot the token search modal open, showing a fully dimmed, blurred
backdrop with the page content behind it clearly non-interactive and
visually receded, and the modal card itself rendering as a solid,
unambiguous foreground panel.

---

## 10. Order of operations

Items 2, 6, 7 are small and independent — do those first, in any order.
Item 8 (restore pair selector) is a real regression fix and should happen
before item 5 (Provide flow restructure), since reflowing a page that's
about to get a new selector button added to it is wasted work done twice.
Item 9 (modal backdrop) is worth doing early too, since it's the kind of
bug that makes every other screenshot in this punch-list harder to verify
cleanly. Items 3 and 4 (Route Receipt, Depth chart) are self-contained
styling passes, do them whenever convenient. Item 5 (Provide flow) is the
largest single change here — do it last, after everything else in
`Desk.tsx`/`ShipStrategy` has already landed, so it isn't fighting merge
conflicts against smaller fixes to the same file.

When a new session picks this back up, read this file plus the git log
since it was last rewritten — same standard as every prior plan in this
repo: verify with real screenshots and real `tsc` output, ask when a call
is genuinely Dhruv's to make (items 3's zero-TVL badge wording and 5's
Finding-banner idea are flagged above specifically because they are), and
don't guess past that line.
