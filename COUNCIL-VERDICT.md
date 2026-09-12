# Bone Dry — strategic verdict and the evidence behind it

Companion to [COMPETITIVE-PLAN.md](COMPETITIVE-PLAN.md) (the 23-repo teardown).
This file records **the measurement that changed the strategy**, the council that
argued it out, and the direction we settled on.

Measured 2026-09-12 against the live Neon index (`aqua_depth`), Ethereum mainnet.

---

## 1. The measurement

We had been arguing about a hypothesis — "makers overcommit" — without ever
counting it. We counted it.

### Does overcommitment exist?

```sql
SELECT maker, token, COUNT(DISTINCT strategy_hash)
FROM aqua_depth WHERE chain_id = 1 GROUP BY maker, token;
```

| | |
|---|---|
| Maker/token pairs backed by **more than one** strategy | **860** |
| …of those, **overcommitted** (promised > backing) | **600** (70%) |
| …of those, with **zero backing at all** | **419** (49%) |
| Most strategies on a single maker+token pair | **257** |

### How much advertised depth is real?

Per maker, `committed = Σ virtual across all their strategies`,
`backing = min(wallet balance, allowance)`, `deliverable = min(committed, backing)`.

| Token | Advertised | Deliverable | Phantom | Makers | Short |
|---|---:|---:|---:|---:|---:|
| WETH | 102,593 | **4** | 100% | 169 | 84 |
| USDC | 5,253,030 | 131,572 | 97.5% | 211 | 131 |
| USDT | 733,111 | 290,988 | 60.3% | 189 | 103 |
| WBTC | 1,419,169,229 | 0 | 100% | 95 | 57 |
| DAI | 288,313 | 228,976 | 20.6% | 41 | 19 |

### Caveats — read before putting these in a pitch

- **The WBTC figure is nonsense on purpose.** 1.4 billion WBTC exceeds the total
  supply of Bitcoin by ~68×. These are junk/spam strategies promising arbitrary
  numbers. That does not weaken the thesis — it *is* the thesis, since Aqua
  accepts them without complaint — but do not present 1.4B WBTC as a serious
  depth figure. Segment credible strategies from absurd ones before quoting.
- Source is our index, which is currently fed by **1inch's own Aqua API**. That
  is rhetorically useful (we are not disputing their data, only aggregating it)
  but it must be re-derived from our own subgraph before we claim the number as
  ours. See build step 2.
- `depth = min(virtual, wallet, allowance)` is a point-in-time read. Balances
  move. Any number we show must be pinned to a block.
- DAI at 20.6% shows the effect is not uniform. Good — a metric that said "100%
  phantom everywhere" would read as a broken measurement.

---

## 2. Why this changes the strategy

Every competitor checks solvency **per maker**: Solvent scores an agent,
Overdraft measures a wallet, Barker guards a position. Each check asks *"can this
maker pay this promise?"* and each answer is individually **yes**.

The 257 strategies on one wallet are each individually fine. They share one
balance. They cannot all be paid.

That is a **joint** property. It is invisible to every per-maker data model in the
field, and it is exactly what `MakerTokenPosition` in our subgraph already
models — aggregated across strategies **and across apps**, because our schema
keys on `app`. No competitor has a protocol-wide vantage point; they each see
their own book.

---

## 3. The council

**Contrarian** — "Your differentiator is a preposition." *Set*-level vs
*per*-maker is invisible to a judge with five minutes. You will be filed in the
"solvency tooling" bucket with three other projects and ranked fourth. Separately:
your index is fed by the API you claim to replace. Get out of the category.

**First Principles** — Aqua is not an AMM or an order book. It is a **registry of
uncollateralized promises**; `ship()` writes a number with nothing behind it.
Competitors treat insolvency as binary. But a promise backed by shared collateral
has a *probability* of delivery, and probability is priceable. The missing
primitive is not a filter. It is **credit**.

**Expansionist** — Our schema keys on `app`, so we see a maker's exposure across
*every* Aqua app, not just our router. We can observe that a maker is
simultaneously overcommitted in someone else's book and ours. That is a public
good — other apps and agents (via MCP) become consumers of the feed.

**Outsider** — Promises exceed reserves, first-come-first-served, no run
detection: **this is fractional-reserve banking.** Banking already built reserve
ratios, stress tests, ratings and run detection. Nobody has ported any of it to
Aqua. Also — the project is already named for what happens when reserves run out.

**Executor** — Everything gated on the count; run it first *(done, §1)*. Then:
snapshot → subgraph → reserve ratio → stress test → constrained router. Do not
fork SwapVM until the core lands (EIP-170 is a multi-day tarpit). Do not let the
demo depend on live mainnet state during judging — pin a block and replay.

### Clashes

| Question | Positions | Resolution |
|---|---|---|
| Router or public feed? | Expansionist wants a feed; Contrarian says a feed is not a product | **Both** — feed is the artifact, router is the proof |
| Price the risk or underwrite it? | First Principles wants an insurance market | **Killed.** Underwriting needs capital we do not have; a fake pool reads as theater |
| Is "credit" legible enough? | Outsider's banking frame is plainer | **Banking frame wins**, with §1's numbers as the concrete |

### Blind spots caught

1. **We had never counted.** The whole strategy was hypothesis until §1.
2. **Cross-*app* visibility** is structural to our schema and absent from every
   competitor's. It had not been named as an asset.
3. **`aqua_depth` already contains everything.** The reserve ratio is a `GROUP BY`.
   Most of this is a query, not a build.
4. **The name already tells the story.**

---

## 4. The verdict

> **Aqua is fractional-reserve market making. Bone Dry is the reserve ratio, the
> stress test, and the only router that trades on it.**

Three layers, each proving the next:

1. **Reserve ratio** — per maker, per token, across every strategy and every app:
   `backing / committed`. The number Aqua cannot produce and no competitor's
   schema can express.
2. **Stress test** — *"if 30% of advertised WETH depth were called in one block,
   who fails?"* A bank-run simulation against real state, with an ordering,
   because Aqua is literally first-fill-wins.
3. **The solvent router** — `Tap.sol`, routing under a **shared-budget
   constraint** rather than a per-maker filter.

### The constraint, stated once

Today we filter: *drop maker M if M is insolvent.*

Instead, solve: maximize fillable output **subject to**

```
for every maker M:   Σ (fills in this route against M)  ≤  min(wallet_M, allowance_M)
```

Two individually-solvent strategies from the same wallet can both pass a
per-maker filter and still collide. Only the constraint catches it.

### Sponsor removal test

- **Remove The Graph** → no cross-app aggregate → the constraint is unformulable
  → we degrade to exactly what everyone else does.
- **Remove Aqua** → every other venue custodies funds → uncollateralized promises
  do not exist → the phenomenon disappears.
- **Remove the Uniswap v4 hook** → no atomic multi-maker settlement → the solve
  cannot be enforced at execution time and is worthless.

None decorative. This is the answer to "are we using Uniswap properly."

---

## 5. What changes in the pitch

| | |
|---|---|
| **Before** | "A Uniswap v4 pool with no liquidity, filled from 1inch Aqua makers, that skips makers who can't deliver." |
| **After** | "1inch Aqua is fractional-reserve market making — 102,593 WETH advertised, 4 deliverable. We built the reserve ratio, the stress test, and the router that trades on them." |

The old verb was *skip* — defensive, and a subset of what Solvent and Overdraft
already do. The new claim is a measurement nobody else can take.
