# Bone Dry — the Swap tab, rearranged (2026-09-12)

**Scope: `web/app/ui/app/Swap.tsx`, `web/app/ui/RouteInspector.tsx`,
`web/app/ui/app/Explore.tsx`, `web/app/ui/app.module.css`.** No API changes, no
contract changes. This is an information-architecture pass: what belongs on this
page, what belongs elsewhere, and what is said twice.

---

## 0. Measured, not eyeballed

At 1440×900, live:

| element | w × h | y |
|---|---|---|
| page | 1425 × **1636** | — |
| left column | 380 × 1171 | 97 |
| right column | 969 × 1408 | 97 |
| Finding card | 380 × 110 | 97 |
| Swap card | 380 × **402** | 229 |
| Route receipt | 380 × **615** | 653 |
| Route & Solvency Breakdown | 969 × 271 | 97 |
| **The maker book** | 969 × **1113** | 392 |

The page is **1.8 screens tall**. One table is **68% of it**.

---

## 1. What is actually wrong

### 1.1 The maker book is about a book this trade did not use

`/api/makers` calls `strategiesFromGraph(n, n.router)` — the **evidence book,
always**. Since `77c989a` the router chooses between two books, and right now it
fills from the Bone Dry book. So the largest element on the page, 1,113 pixels of
it, is 55 rows of makers **that had nothing to do with the trade above them**.

The receipt says `ROUTED THROUGH Bone Dry book`. Eight hundred pixels lower, a
table headed "The maker book" lists 55 wallets from the other one. Nothing on
screen says they are different books. This is the most confusing thing on the
page and it is a correctness problem, not a layout one.

### 1.2 It also duplicates the Explore tab

| Swap's "maker book" | Explore's "Coverage per maker" |
|---|---|
| Maker · Promised · Deliverable · Shortfall · Coverage · Oracle | Maker · Token · Live · Committed · Actually backed · Coverage |

Same rows, same source, same question — "who is over-promising". Explore does it
better: every token, network totals beside it, a sort control, and a histogram.
Swap's copy is the same exhibit shrunk to one token and pasted under a trade.

We have two tabs showing the same table and neither says so.

### 1.3 The receipt and the breakdown are the same four numbers

Left column, "Route receipt":

```
Strategies considered        3
├─ Filled              1 wallet
├─ Skipped — could not pay   0
└─ Wrong pair / no depth     2
Unfilled at this size        0
```

Right column, "Route & Solvency Breakdown":

```
ALL (1)   FILLED (1)   SKIPPED SAVES (0)   1 of 1 wallets · 3 strategies considered
```

Identical content, 400px apart, in two columns, under two different headings. A
reader who notices has to work out whether they disagree.

### 1.4 The footnote is bigger than the action

Swap card: **402px**. Route receipt: **615px**. The thing you *do* is smaller
than the thing explaining what you did — and the receipt is only meaningful
*after* a quote, while the swap card is what the page is for.

### 1.5 The finding card pushes the action down

The dark card is the best sentence in the product, but at 110px on top of the
swap card it puts the Swap button around y=600 — below the fold on a laptop once
the header and rail are counted. It already appears as a one-line rail on every
other tab (`FindingLine`); only Swap carries the full card.

---

## 2. The decision

**Remove the maker book from Swap. Merge the receipt into the breakdown.**

Three panels become two, and each answers exactly one question:

| Panel | Question | Column |
|---|---|---|
| **Swap card** | What am I trading, and what do I get? | left |
| **Route & Solvency Breakdown** | Which makers filled it, from which book, and who refused? | right |

Everything cut has a home that already exists and does it better.

### 2.1 The maker book moves to Explore

Not deleted — **it is already there.** Explore's "Coverage per maker" is the same
table with more context. What Swap loses is a duplicate; what a judge loses is
nothing, because the tab next door has the fuller version.

Swap keeps a single line where the table was:

> **55 other wallets quote WETH on Base. 17 can't deliver what they promised.**
> See the evidence →

One sentence, one link, ~40px instead of 1,113. The number stays on the page; the
1,113-pixel exhibit stops being repeated.

**If the count must stay visible on Swap**, keep the "Short" and "No allowance"
filter counts as three figures in that line. Do not keep the rows.

### 2.2 The receipt folds into the breakdown's header

The receipt has three parts and they are not equal:

- **Duplicated** (counts tree) → delete, the breakdown's filter pills already say it
- **Unique and worth keeping** → `POOL LIQUIDITY 0 · BY DESIGN`, `ROUTED THROUGH
  <book> [opcode 35]`, the §2.1 disclosure, `Evidence book — no fill`, `Pool ID`
- **Better placed elsewhere** → nothing

So: the breakdown's card head gains a compact strip —

```
ROUTED THROUGH  Bone Dry book [opcode 35]   ·   POOL LIQUIDITY 0 · by design   ·   pool 0x33e4…12f1
Bone Dry book · 3 strategies, all published by us …          Evidence book — no fill
```

— and the left column loses 615px. The book disclosure lands **directly above the
table it describes**, which is where it belonged.

### 2.3 The finding becomes a line on Swap too

Use the existing `FindingLine`, as every other tab does. Saves ~70px and lifts the
Swap button above the fold. The full `FindingCard` stays on Explore, where the
histogram is the subject rather than an interruption.

### 2.4 Ratio

With the maker book gone the right column no longer needs 969px for a six-column
table; the breakdown's is six columns at ~820px minimum.

```css
.colsSwap { grid-template-columns: minmax(420px, 32%) 1fr; }
@media (max-width: 1080px) { .colsSwap { grid-template-columns: 1fr; } }
```

420px gives the swap card room for the pay/receive rows without the amount
wrapping — 380 is why `0.000011` sits tight against `WETH`. **Add `.colsSwap`;
do not re-tune `.colsBuild`**, which is Provide's and was fixed twice already.

### 2.5 Expected result

| | before | after |
|---|---|---|
| page height | 1636 | **~700** |
| panels | 4 | 2 |
| duplicated counts | 2 places | 1 |
| tables about the wrong book | 1 | 0 |
| Swap button y | ~600 | **~430** |

One screen, no scrolling to reach the action.

---

## 3. The alternative, and why not

**Keep the maker book and make it show the routed book.** Honest, and one line in
`/api/makers` to pass `route.app`.

Rejected as the primary move: it would show **three rows** — our own strategies —
and the 55-wallet evidence display, which is the strongest thing on the page,
would vanish from Swap without appearing anywhere new. It also leaves the page
at ~1,100px to show three rows.

**Worth doing anyway, as a smaller change:** `/api/makers` should still take an
app, because "The maker book" silently meaning "the evidence book" is a landmine
for whoever next reads this code. Do it when the table moves to Explore, where
being the evidence book is correct and can be said out loud.

---

## 4. Order of work

1. **`FindingLine` on Swap** — one-line change, immediate 70px, no risk.
2. **Fold the receipt into the breakdown head**; delete the duplicated counts
   tree. Biggest single win, −615px.
3. **Replace the maker book with the summary line + link to Explore.** −1,113px.
   Explore needs no change; verify its numbers match what the line claims.
4. **Add `.colsSwap`** at 420px.
5. **`/api/makers` takes an app**, and Explore says which book it is showing.

1–3 are the plan. 4 is polish. 5 is the debt the split left behind.

---

## 5. Do not

- **Do not** delete the maker-book component. It moves; Explore's version should
  absorb any column Swap's had that it lacks (Oracle deviation, notably).
- **Do not** drop `POOL LIQUIDITY 0 · by design`. A zero-liquidity pool is the
  mechanism, and it is the one number a Uniswap judge will look for.
- **Do not** drop the §2.1 book disclosure while moving it. It exists because a
  reader took "1 of 1 wallets" as opcode 35 filtering makers out.
- **Do not** re-tune `.colsBuild`, `.footerInner`, or `--shell`.
- **Do not** report this done from a diff. The acceptance is a 1440×900 screenshot
  showing the Swap button above the fold and no horizontal scroll at 390px.
