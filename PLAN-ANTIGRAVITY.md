# Bone Dry — visual polish pass (for Antigravity)

The previous plan in this file (multi-token dashboard, ship-a-strategy form,
exposure views, multi-pair support) is done and merged. This is a new,
smaller plan: a visual polish pass on the dashboard, which now has real tab
navigation (Swap / Provide / Portfolio / Explore) but still looks more like
an engineering readout than a product next to Aave, Uniswap, or Morpho.

Read this whole file before writing anything. The tasks below are deliberately
narrow and mechanical — this codebase's visual language is small and already
coherent, and the risk on a pass like this is not "too little polish," it is
one enthusiastic global find-replace breaking a system that was previously
consistent. Do not generalize beyond what each task literally asks for.

---

## 0. Hard rules (same as always, read first)

1. **Never `git add -A` or `git add .`.** Stage exact paths only.
2. **Do not touch:** `web/app/ui/Landing.tsx`, `web/app/ui/landing.module.css`,
   `web/app/ui/Doodle.tsx`, `web/app/ui/useIsomorphicLayoutEffect.ts`,
   `web/app/page.tsx`. Owned by someone else, working in this repo in
   parallel.
3. **Ask before touching:** `web/app/layout.tsx`, `web/app/globals.css`,
   `web/app/ui/Motion.tsx`, `web/app/ui/Web3.tsx`. Post the diff, wait.
   (`globals.css` matters especially this round — see Task 2.)
4. **This is a visual-only pass.** No task below should change what data is
   fetched, what a route returns, or any on-chain interaction. If a task
   seems to require that, stop and report rather than doing it.
5. **Every task ends with a real verification step** — a screenshot or a
   description of what you saw when you clicked through it, not "should
   look right now."
6. **Commit after each task**, exact paths, with:
   ```
   Co-Authored-By: Antigravity <noreply@google.com>
   ```
7. **Unsure whether something is in scope? It is not.** Ask rather than
   generalize a task beyond its stated boundary — this file calls out the
   exact strings and files each task touches on purpose.

---

## 1. Orientation (do this before Task 1)

Read these, fully:

1. `web/app/globals.css` — the whole design system is here: colors as CSS
   variables (`--paper`, `--paper-sunk`, `--ink`, `--ink-soft`, `--ink-faint`,
   `--rule`, `--red`, `--slate`), a spacing unit (`--u: 4px`), two font
   stacks (`--mono` for data, `--serif` for prose/headings), and the base
   `.label` / `.num` classes almost everything else builds on.
2. `web/app/ui/desk.module.css` — skim the whole file once so you know what
   already exists (search before adding a new class; several of what you
   need may already be half-built, e.g. `.covPct`, `.dim`, `.loss`).
3. `web/app/ui/Desk.tsx` — specifically the `TabNav`, `Exposure` import,
   `MakerBook`, and `Coverage` functions.
4. `web/app/ui/Exposure.tsx` — the whole file, it is short.

One fact worth understanding before Task 1: `--paper-sunk` (`#f3f1e9`, a
slightly darker off-white than the page's `--paper`) already exists in
`globals.css` and is used in exactly two places in the whole app. It is the
elevation lever this design already has and almost never uses.

---

## Task 1 — Card elevation

**Goal:** the swap card (the primary action) should read as sitting above
the page; secondary panels (pool proof, maker book, ship form, exposure
table) should read as a distinct surface from the bare page background —
right now every one of these is just a 1px `var(--ink)` or `var(--rule)`
border against the same `var(--paper)` background as everything else, so
nothing has any weight relative to anything else.

### What to change

In `web/app/ui/desk.module.css`:

- `.swapCard` — add `background: var(--paper-sunk);`. Keep its existing
  border. This is the one card that gets the "elevated" treatment, because
  it is the one primary action on the page.
- `.proofCard`, `.book`, `.shipCard`, `.exposure` (in the sense of whatever
  wrapping element each of these sections uses — check the actual class
  names in the JSX, they may not be exactly these) — do **not** also make
  these `--paper-sunk`. Making every card the same elevated tone defeats the
  point; these stay on bare `--paper` with their existing border. The
  contrast between `.swapCard`'s tint and everything else's plain background
  *is* the hierarchy.
- Add a touch more breathing room to `.swapCard` specifically: increase its
  internal padding by roughly 20% over whatever it is now (check the
  current value; do not guess a number without reading it first).

Do not touch shadow (`box-shadow`) anywhere — this design system has no
shadows anywhere else, and introducing one card with a shadow while
everything else has none is a bigger inconsistency than the one you are
fixing. The elevation lever here is background tint only.

### Verification

1. Load `/app`, screenshot the Swap tab. The pay/receive card should read as
   a visually distinct surface from the pool-proof panel beside it, not the
   same white-on-white as before.
2. Confirm no other card picked up the tint by accident — Provide, Portfolio,
   and Explore tabs should look exactly as before except for spacing.
3. `npx tsc --noEmit` clean (this task shouldn't touch any `.tsx` file, but
   confirm nothing broke).

### Commit
```
git add web/app/ui/desk.module.css
git commit -m "Give the swap card a distinct surface from everything around it"
```

---

## Task 2 — Section headings, not shouting

**Goal:** every section heading on the dashboard is currently an `<h2>`
styled with the shared `.label` class — 10px uppercase mono, the same
treatment used for a table column header like "PROMISED" or a tiny meta
string like "idle". A genuine heading ("Ship a strategy — USDC / WETH",
"Your exposure — claimed against held") deserves to read as a heading, not
as the same visual weight as a table's column labels.

**This task touches exactly these seven headings and nothing else.** Do not
apply this change to `.label` globally — `.label` is used all over this app
for things that should stay small and mono (field labels like "You pay",
table headers, status meta rows), and changing it globally will visibly
break those. This task adds a *new*, separate class and applies it only at
these call sites:

- `web/app/ui/Desk.tsx`: the `<h2 className="label">` in `MakerBook`'s
  wrapping section ("Maker book — …"), in `Coverage` (two render branches,
  same text), in `Deployed` ("Deployed on …"), and in `ShipStrategy`
  ("Ship a strategy — …").
- `web/app/ui/Exposure.tsx`: all `<h2 className="label">` instances
  ("Your exposure — claimed against held").
- `web/app/app/lookup/page.tsx`: the `<h2 className="label">` ("Results —
  …"). Leave the `<h1 className="label">Check any wallet</h1>` on that same
  page alone — a page's own `<h1>` is a different call than a section's
  `<h2>` and is out of scope here.

### What to change

Add to `web/app/ui/desk.module.css`:
```css
/* A section heading, not a field label. Same family as the page's body
   text, not the mono/uppercase treatment everything data-shaped uses. */
.sectionTitle {
  font-family: var(--serif);
  font-size: 17px;
  font-weight: 400;
  letter-spacing: -0.01em;
  text-transform: none;
  color: var(--ink);
}
```

At each of the seven call sites above, change
`<h2 className="label">...</h2>` to `<h2 className={s.sectionTitle}>...</h2>`
(import `s` from `desk.module.css` — check whether `Exposure.tsx` and
`lookup/page.tsx` already import it as `s`, they should, since they reuse
`desk.module.css` classes already).

The sibling `<span className="label">...</span>` next to each of these
headings (the small meta text like "4 solvent of 6 live" or "no wallet
connected") stays exactly as it is — only the `<h2>` changes.

### Verification

1. Screenshot the Swap tab (maker book heading), Provide tab (ship-a-strategy
   heading), Portfolio tab (your-exposure heading), Explore tab (deployed
   heading), and `/app/lookup` after a search (results heading). All five
   should show a heading in the serif body font, not uppercase mono.
2. Confirm the small meta label beside each heading (the count/status text)
   is unchanged — still small mono uppercase.
3. Confirm nothing else on the page changed — table headers, field labels
   ("You pay"), and the tab nav itself should all still read exactly as
   before.
4. `npx tsc --noEmit` clean.

### Commit
```
git add web/app/ui/Desk.tsx web/app/ui/Exposure.tsx web/app/app/lookup/page.tsx web/app/ui/desk.module.css
git commit -m "Give section headings their own weight, separate from field labels"
```

---

## Task 3 — Coverage status as a badge, not a colored word

**Goal:** in the exposure table (used on both the Portfolio tab and the
public `/app/lookup` page — it's the same `ExposureTable` component in
`web/app/ui/Exposure.tsx`), the coverage column currently renders the plain
word "covered" or "shortfall" in green or red text. Real protocols mark
state like this as a small filled/outlined pill so it reads at a glance,
not by reading the word.

### What to change

In `web/app/ui/Exposure.tsx`, find:
```tsx
<span className={`num ${p.covered ? s.full : s.zero}`}>
  {p.covered ? "covered" : "shortfall"}
</span>
```

Replace with a badge. Add to `web/app/ui/desk.module.css`:
```css
.badge {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-family: var(--mono);
  font-size: 10px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  padding: 3px 8px;
  border: 1px solid currentColor;
}
.badge::before {
  content: "";
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
}
.badgeOk { color: var(--slate); }
.badgeLoss { color: var(--red); }
```

Change the JSX to:
```tsx
<span className={`${s.badge} ${p.covered ? s.badgeOk : s.badgeLoss}`}>
  {p.covered ? "covered" : "shortfall"}
</span>
```

Do not touch `s.full` / `s.zero` themselves — they are used elsewhere (check
with a grep across `web/app/ui/` before assuming otherwise) and this task
only changes this one call site's markup, not those shared classes.

### Verification

1. On `/app/lookup`, search an address with at least one covered and one
   under-covered position (any maker address from
   `deployments/base-sepolia.json` shipped strategies against should show
   real data — check a couple if the first one you try is fully covered or
   fully empty).
2. Screenshot the results table. Both states should show as a small
   dot-and-border pill, not plain colored text.
3. Confirm the same table on the Portfolio tab (a connected wallet with
   positions) shows the same treatment — it's the same component.
4. `npx tsc --noEmit` clean.

### Commit
```
git add web/app/ui/Exposure.tsx web/app/ui/desk.module.css
git commit -m "Show coverage state as a badge instead of a colored word"
```

---

## Task 4 — Two loading ellipses, gone

**Goal:** `web/app/ui/Desk.tsx` has exactly two spots that render a bare
`"..."` string while the maker book is loading — a text ellipsis reads as
unfinished, not as "working on it."

Find (grep for the literal string `"..."` in this file — there are exactly
two matches, both in or near the `MakerBook` section):
```tsx
{makers ? `${makers.solvent} solvent of ${makers.indexed} live` : "..."}
```
and
```tsx
if (!makers) return "...";
```

### What to change

Add to `web/app/ui/desk.module.css`:
```css
/* A quiet pulse instead of a static ellipsis -- still says "loading",
   without reading as if something stalled. */
.loadingDots {
  display: inline-block;
  animation: loadingPulse 1.4s ease-in-out infinite;
  color: var(--ink-faint);
}
@keyframes loadingPulse {
  0%, 100% { opacity: 0.35; }
  50% { opacity: 1; }
}
```

Replace each bare `"..."` with `<span className={s.loadingDots}>reading…</span>`
(note: real ellipsis character `…`, not three periods — check how the rest
of this file writes ellipses, e.g. search for `…` elsewhere in `Desk.tsx`
and match it). Confirm the surrounding code accepts a JSX element in that
position and not only a string — one of the two call sites returns a bare
string from a function (`return "...";`) and may need its return type or
call site adjusted if it currently assumes a plain string. If it does not
straightforwardly accept JSX there, report back rather than restructuring
the surrounding function.

Respect `prefers-reduced-motion`: check whether `globals.css` already has a
reduced-motion media query disabling animations globally (it does, for the
landing page's animations) and confirm this new `@keyframes` is also
covered by it rather than assuming — if the existing rule is scoped in a
way that would miss this one, say so rather than silently leaving motion-
sensitive users with a pulsing element.

### Verification

1. Reload `/app` on a fresh network switch (so the maker book briefly shows
   its loading state) and screenshot the pulse before data arrives.
2. Confirm it settles into the real count once data loads, same as before.
3. Confirm `prefers-reduced-motion: reduce` (test via your browser's dev
   tools or OS setting) shows a static state, not a pulse.
4. `npx tsc --noEmit` clean.

### Commit
```
git add web/app/ui/Desk.tsx web/app/ui/desk.module.css
git commit -m "Replace the bare loading ellipsis with a quiet pulse"
```

---

## What "done" means for this plan

Report back with, per task: which files changed, what you saw when you
verified it (screenshot description or exact behavior), and anything you
stopped on because a hard rule applied or a task's boundary was unclear.
If Task 4's JSX-return-type snag comes up, that is expected — report it
rather than guessing past it.

Do not do more than these four tasks without checking in first. This is a
deliberately small, contained pass — the previous plan already proved the
product works; this one is about whether it looks like it belongs next to
Aave and Uniswap, and that is a taste call worth a check-in before scope
grows.
