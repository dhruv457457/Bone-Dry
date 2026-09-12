# Bone Dry — the dashboard, rebuilt (2026-09-12)

**For whoever owns `web/app/ui/app/*`, `Desk.tsx`, `app.module.css`** — that is the
session already holding those files, not Antigravity (contracts/subgraph) and not
Claude (landing page only). Nothing in here touches `Landing.tsx`,
`landing.module.css`, `Doodle.tsx`, `contracts/` or `subgraph/`.

This is a layout and information-architecture pass. The components mostly exist
and mostly work; what is wrong is **where they sit, how wide they are, and what
they claim.**

---

## 0. What is actually wrong — read this first

Observed in the running app, not guessed.

### 0.1 The page is 1,300px wide on a 1,900px screen

`app.module.css` hard-codes `max-width: 1300px` in three places — `.wrap:158`,
the header inner `:169`, and `.main:334`. On a normal laptop that leaves ~300px
of dead paper down each side while the maker book — a six-column table — is
squeezed into 620px and wraps.

This is the single most visible problem and the cheapest to fix.

### 0.2 The swap's headline number looks broken

```
YOU PAY      100 USDC
YOU RECEIVE  0.000004      ← WETH
+2461        bps better
```

100 USDC should be roughly 0.03 WETH. `0.000004` is four orders of magnitude out,
and `+2461 bps` (+24.6%) reads as invented. **The single largest number on the
screen is the one a judge will disbelieve first.** Whether this is thin Sepolia
liquidity, a decimals bug, or a real route, the UI must not present it without
saying which.

### 0.3 The receipt does not add up

```
Wallets filled            2 of 55 considered
Skipped — could not pay   17
```

2 + 17 = 19. The other **36 are unexplained**. A panel whose whole purpose is
honesty cannot leave two-thirds of its subject unaccounted for.

### 0.4 The maker book repeats makers and draws meaningless bars

`0x620b…f96b` appears three times with coverage 77%, 76% and 95%, each row showing
`promised 0 / deliverable 0`. Rows with nothing promised should not carry a
coverage bar at all — a full bar next to two zeroes is noise that reads as data.

### 0.5 The finding rail is a banner

The dark strip is the best sentence in the product, and it is built as a
full-width banner repeated on every tab, which is the one shape people are
trained to ignore. Its sparkline — one tick per position, sorted worst-first —
is genuinely informative and is currently squeezed into an 18px-tall sliver
where its shape cannot be read.

### 0.6 The chain switcher lets you into dead ends

`Shell.tsx:66-80` renders all three networks as equal segmented buttons. They are
not equal:

| Network | What it can do |
|---|---|
| Base Sepolia | everything — our Aqua, our hook, free tokens |
| Base | read-only evidence + hook deployed |
| Ethereum | **read-only. No hook, no lens, no wellhead** (`networks.ts:189-191`) |

Switching to Ethereum while on the Swap tab leaves you on a trade form that
cannot trade, with no explanation. The switcher is honest about the list and
silent about the consequence.

---

## 1. Hard rules

1. **Never `git add -A`.** Exact paths only.
2. Do not touch `Landing.tsx`, `landing.module.css`, `Doodle.tsx`, `contracts/`,
   `subgraph/`.
3. **Never fake data.** If a number cannot be computed, show the empty state and
   say why. This repo has deleted invented visualisations before — see the doc
   comment atop `DepthChart.tsx`.
4. **Null is not zero.** The subgraph now returns `backing` / `utilBps` as
   nullable specifically so "never measured" is distinguishable from "zero
   backing" — and 419 Ethereum pairs genuinely have zero backing. Render null as
   *unknown*, never as 0% and never as healthy.
5. **Never imply an Aqua commitment is binding.** `dock()` costs 4,452 gas and is
   instant (`PROOFS.md` P3).
6. Verification per item: `npx tsc --noEmit` clean **and** a screenshot of the
   changed surface at **1440px and 390px**, not a description.
7. Stop at every `--- CHECKPOINT ---`.
8. Commit per item, exact paths, trailer:
   `Co-Authored-By: Antigravity <noreply@google.com>`

---

## 2. Phase A — the shell: width, grid, density

**File:** `app/ui/app.module.css`

### 2.1 One container, fluid

Replace the three separate `max-width: 1300px` declarations with a single token so
they can never drift apart again:

```css
:root { --shell: min(100% - 52px, 1560px); }
.wrap, .headerInner, .main { width: var(--shell); margin-inline: auto; padding-inline: 0; }
```

1560 rather than unbounded: the maker book is a data table, and line lengths past
~1600px get hard to track across. Keep the 26px gutter as the `52px` subtraction.

### 2.2 A real two-column grid, not flex-wrap

`.cols` is `display: flex` with `.colNarrow { flex: 1 1 340px }` and
`.colWide { flex: 2 1 620px }` (`:335-337`), which means the split drifts with
content and the two columns can end up nearly equal.

```css
.cols { display: grid; grid-template-columns: minmax(330px, 380px) 1fr; gap: 24px; align-items: start; }
@media (max-width: 1080px) { .cols { grid-template-columns: 1fr; } }
```

The left rail is a **control column** and should be a fixed, calm width. The right
is the **evidence column** and should take everything else.

### 2.3 Density

The current surface is airy in a way that costs information. Tighten card padding
(`.cardPad: 22px` → `18px`), and let the maker book show ~12 rows before
paginating instead of 8. On a 1560px shell the table has room for it.

`--- CHECKPOINT A --- screenshots at 1440px and 390px.`

---

## 3. Phase B — the finding rail

**Do not delete it.** It is the thesis with a live number in it. But stop shipping
it as a banner.

**Move it into the left rail, at the top, as a tall panel** on Swap and Explore.
That does three things at once: it stops being banner-shaped, it frees the width
the header was stealing, and it finally gives the sparkline room to be a real
distribution — vertical, one row per position, worst at the top.

```
┌─ THE FINDING ──────────┐
│ 89                     │
│ of 162 live positions  │
│ on Base can't deliver  │
│ what they promised     │
│                        │
│ ▂▃▅▆▇█▇▆▅▃▂▁          │  ← coverage distribution, readable at last
│ 0%              100%   │
│                        │
│ [ See the 89 ]         │
│ read just now          │
└────────────────────────┘
```

On **Provide** and **Portfolio**, where the user's own position is the subject,
collapse it to a single line above the content. On **Lookup** drop it entirely —
the whole tab is already an evidence surface.

`--- CHECKPOINT B ---`

---

## 4. Phase C — chain switching

The fix is not a prettier switcher. It is that **the three networks are three
different products** and the UI should say so.

### 4.1 Label by purpose, not by name

```
TRY IT            LIVE EVIDENCE        AT SCALE
Base Sepolia      Base                 Ethereum · read-only
```

`networks.ts` already carries a `purpose` string per network — it is currently
only a `title` tooltip (`Shell.tsx:73`). Put it on screen.

### 4.2 Never strand the user on a dead tab

When the selected network cannot serve the current tab — `hook`, `lens` or
`wellhead` empty, per `networks.ts:189-191` — do not render a dead form. Replace
the tab body with a short explainer and a way out:

> **Ethereum is read-only here.** No Bone Dry contracts are deployed on Ethereum —
> this network is the measurement at full scale. Swapping lives on Base and Base
> Sepolia.
> `[ Switch to Base Sepolia ]  [ Explore Ethereum instead ]`

### 4.3 Switch the tab, not just the chain

If the user is on Swap and picks Ethereum, the honest move is to take them to
Explore on Ethereum rather than show them a broken Swap. Offer it; don't do it
silently.

`--- CHECKPOINT C ---`

---

## 5. Phase D — Swap

### 5.1 Fix or frame the headline number *(blocking)*

`0.000004 WETH` for 100 USDC must be diagnosed before anything else on this tab is
styled. Three possible causes and three different fixes:

- **A decimals bug** → fix it.
- **Genuinely thin depth** → then the number is true and the UI must say
  *"only 0.000004 WETH is deliverable across 2 wallets — the rest of the book
  cannot pay"*, which is our whole argument rather than an embarrassment.
- **Wrong pair or stale quote** → show the staleness.

Same for `+2461 bps`. If it is real, state what it is measured against
(`singleMakerAmountOut`, already in `RouteResponse`) directly beside it. An
unexplained +24.6% reads as marketing.

### 5.2 Make the receipt add up

```
55 considered
├─  2 filled
├─ 17 could not pay        ← the product working
└─ 36 wrong pair / no depth  ← currently invisible
```

Every wallet considered must land in exactly one bucket, and the buckets must sum.
`RouteResponse` already carries `makersSkipped`, `makersUnfillable` and `slices`.

### 5.3 Refusals are a save, not an error

Style skipped makers in the slate/neutral colour, never red-alarming, with the
reason from Phase 6b (`EncumbranceExceeded`, `EncumbranceInsufficient`,
`EncumbranceZeroBacking`, `QuoteUnusable`). Render the human name, never the raw
selector.

### 5.4 Wire `RouteInspector`

`lib/solvencyEngine.ts → hooks/useSolvencyRoute.ts → app/ui/RouteInspector.tsx` is
a complete chain that renders nowhere — `RouteInspector` has zero importers. It
already models `SOLVENT | CLAMPED | SKIPPED_GHOST | UNFILLABLE`. That is §5.2 and
§5.3 already built. Use it rather than writing it again.

`--- CHECKPOINT D ---`

---

## 6. Phase E — Provide (the most important tab)

This is where the project's actual product lives and it is currently the thinnest
surface. See `PLAN-ANTIGRAVITY-UI.md` §5 for the full spec; the short version:

1. **Your exposure** — promised across every live strategy, wallet, allowance,
   utilisation. From `/api/exposure`.
2. **Two parameters in words** — *"refuse once more than N% of my wallet is
   promised"*, *"quote this much worse at the limit"*.
3. **Sibling list pre-filled from the index.** Never make a maker type a 32-byte
   hash.
4. **The completeness warning** — *"you declared 3 siblings, you have 9 live;
   this will under-constrain"*. This is the sentence nothing on-chain can produce.
5. **Live curve preview** — at current utilisation, what a 1 WETH quote becomes,
   and where it would refuse.

A live example now exists on Base Sepolia to read rather than mock — see
`deployments/base-sepolia.json`: `boneDryRouter`, plus an `encumbranceStrategy`
with two real siblings, `maxUtilBps: 8000`, `widenBps: 500`.

**State the 6-sibling cap in the UI.** SwapVM caps instruction args at 255 bytes.
Do not silently truncate a longer list.

`--- CHECKPOINT E ---`

---

## 7. Phase F — Explore, Portfolio, Lookup

### Explore
Becomes the **evidence tab** and the default landing surface for a visitor with no
wallet. The maker book belongs here at full width, plus the refusal feed
(`/api/reliability`, currently written and unused — `lib/refusals.ts:48` says so
in a comment).

Fix the book itself: **group rows by maker**, not by strategy — `0x620b…f96b`
appearing three times is one maker with three strategies and should be one
expandable row. And **suppress the coverage bar when nothing is promised**; a full
bar beside two zeroes is noise.

### Portfolio
Your own fills, strategies shipped and docked, and — new — refusals *your*
strategies issued. "This position declined 4 fills it could not have paid" is a
better portfolio line than a balance.

### Lookup
Already good and already a real second Graph product via Subgraph MCP. Two jobs:
fold in the MCP discovery section from the orphaned `app/app/lookup/page.tsx`
(305 lines, nothing links to it), then delete that file.

`--- CHECKPOINT F ---`

---

## 8. Phase G — states, everywhere

The surface currently has good loading states and weak empty ones.

- **Empty states teach.** "No strategies here yet" is a dead end; "Nothing is live
  on Base Sepolia to total — ship one from Provide" is a door.
- **Unknown ≠ zero.** Rule 4. A never-measured maker must not render as healthy.
- **Staleness is visible.** `backingObservedAt` exists so the UI can say *"read 4
  minutes ago"*. Say it.
- **Errors name the network.** "Couldn't reach the index" is unactionable;
  "Ethereum's index is still syncing — Base is live" is not.

---

## 9. Do not do these

- Do not unify `desk.module.css` and `app.module.css`. That is a real refactor and
  out of scope; check which module a file imports before styling it.
- Do not delete the finding rail — move it.
- Do not delete `RouteInspector` / `useSolvencyRoute` / `solvencyEngine` — wire them.
- Do not render a coverage bar for a position that promised nothing.
- Do not show a trade form on a network with no hook deployed.
- Do not style a refusal as an error.
- Do not invent a number to fill a panel.

## 10. Open questions — answer, don't assume

1. **What is `0.000004 WETH` actually?** Diagnose before styling. If the route is
   genuinely that thin on Sepolia, say so in the UI and it becomes evidence.
2. Should Explore become the default tab for a visitor with no wallet connected,
   with Swap default once connected?
3. The maker book has six columns (promised, deliverable, shortfall, coverage,
   oracle, +address). At 380px of left rail and a 1560px shell it fits — but is
   `oracle` earning its column, or should it live in the expanded row?
4. Do Portfolio and Explore overlap enough to merge once the book moves to
   Explore?
