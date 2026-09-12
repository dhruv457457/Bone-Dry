# Bone Dry — build order

What to actually do, in sequence. Decision and evidence live in
[COUNCIL-VERDICT.md](COUNCIL-VERDICT.md); competitor teardown in
[COMPETITIVE-PLAN.md](COMPETITIVE-PLAN.md).

Each step is gated on the one before it. Nothing here is speculative — steps 1–4
are mostly queries over data we already hold.

---

## Step 1 — Freeze the evidence *(do first, ~1 hour)*

The numbers in COUNCIL-VERDICT §1 are the entire pitch and they **will drift or
vanish** before judging. Balances move; strategies dock.

- New table `aqua_snapshot` — same shape as `aqua_depth` plus `snapshot_id`,
  `taken_at`, `block_number`.
- Pin a mainnet block number at snapshot time so every figure is quotable as
  "as of block N."
- Segment credible strategies from junk (the 1.4-billion-WBTC problem). A simple
  sanity bound per token — reject a commitment exceeding, say, total supply — and
  report both figures: "all promises" and "credible promises."
- Re-run the §1 queries against the frozen snapshot and commit the output as a
  markdown table, so the pitch never depends on a live query succeeding.

**Why first:** everything downstream quotes these numbers, and a demo that
recomputes them live during judging is a demo that can fail during judging.

---

## Step 2 — Own the data: deploy the subgraph to Ethereum mainnet *(hours)*

Today `lib/indexer.ts` pages `api.1inch.dev/aqua/v1.0/strategies/opened`. Ten of
23 competitors run their own subgraph; we are the only solvency project that does
not own its data, and it costs us the Graph track.

- Copy `subgraph/subgraph.yaml` → `subgraph.mainnet.yaml`; change
  `network: base` → `network: mainnet`; set `startBlock` from `aquaGenesis`
  (`web/lib/networks.ts:207`).
- Addresses are **identical across both chains** — no ABI or mapping changes:
  - `aqua: 0x1111113ccf1426a8e30e2bff5e005d929bf6a90a` (`networks.ts:81`, `:176`)
  - `router: 0x111111338c5091E8440b67B168bAe16a668AC0De` (`networks.ts:82`, `:177`)
- Deploy; set `graphUrl` for chain 1 (`networks.ts:200`, currently `""`).
- Rewrite `lib/indexer.ts` to read the subgraph instead of the 1inch API.
  Keep Postgres as the fast serving layer — subgraph is the *source*, Neon is the
  *cache*. Two-tier, and nobody else has it.
- `AQUA_API_KEY` then stops mattering (it is still unset in Vercel and the cron
  has been failing on it — this makes that moot).

**Gate:** re-run step 1's queries against subgraph-derived data and confirm the
numbers agree with the API-derived ones. If they disagree, that disagreement is
the bug report.

---

## Step 3 — The reserve ratio *(half day)*

The metric. Per maker, per token, across **every strategy and every app**:

```
committed = Σ virtual_amount across all live strategies
backing   = min(wallet_balance, allowance)
reserve   = backing / committed        -- 1.0 = fully backed, 0.0 = pure phantom
```

- Add it to the subgraph as a first-class entity (extend `MakerTokenPosition`
  with `backing`, `reserveRatioBps`) so it is queryable by anyone, not just us.
- Expose `GET /api/reserve?chain=&token=` returning the per-maker table plus the
  token-level rollup (advertised / deliverable / phantom %).
- UI: a token page that says, in one line, *"102,593 WETH advertised. 4
  deliverable."*

This is the layer that makes us a measurement project rather than a filter.

---

## Step 4 — The stress test *(half day)*

The screen that wins the room. *"If 30% of advertised WETH depth were called in
one block, who fails?"*

- Slider: 0–100% of advertised depth called.
- Because Aqua is **first-fill-wins**, the simulation needs an ordering. Order
  makers by reserve ratio, or by strategy age, and show the cut line: everyone
  above it is paid, everyone below it reverts.
- Output: number of makers that fail, volume that reverts, and *which specific
  strategies collide with each other*.

This is a bank-run simulation on real mainnet state. No competitor's data model
can produce it.

---

## Step 5 — The constrained router *(the interesting part, ~1 day)*

Replace the per-maker filter in `lib/solvencyEngine.ts` with a solve.

Maximize fillable output subject to, for every maker M:

```
Σ (fills in this route against M)  ≤  min(wallet_M, allowance_M)
```

- Small flow/knapsack problem; milliseconds at our scale.
- It is **impossible without the index** — a maker's total exposure cannot be
  derived from any single strategy, from Aqua itself, or from a single 1inch API
  item. That is the Graph track argument in one sentence.
- `Tap.sol` enforces it at execution: atomic multi-maker settlement is what makes
  the solve binding rather than advisory.

---

## Step 6 — The split-screen demo *(half day)*

Same block, same real makers, side by side:

- **Left** — the naive route a per-maker solvency checker builds. Simulate it.
  It reverts. Show the revert reason.
- **Right** — Bone Dry's constrained route. Fills.
- **Below** — the collision panel: this wallet, these N strategies, this reserve
  ratio, here is the pair that collides.

Nobody else can build the left-hand side and explain *why* it fails, because
nobody else has the number.

**Record it against a pinned block from step 1.** Do not let judging depend on
live mainnet.

---

## Step 7 — Credibility pass *(hours)*

Cheap items that competitors have and we do not.

- **Tests.** We have none. Field has `vitest` in 7 repos, `matchstick-as` in 4.
  Minimum: matchstick tests on the subgraph mappings (Graph judges look) and
  vitest on the solver from step 5.
- **MCP server.** `lib/subgraphMcp.ts` exists, half-built. Seven competitors ship
  `@modelcontextprotocol/sdk`. Expose `makerReserve`, `tokenDepth`,
  `stressTest` so an agent can ask "is this maker good for 100k USDC." This is
  the whole field's AI story and it is one file for us.
- **Self-chaining keeper.** Replace `*/30 * * * *` in
  `.github/workflows/refresh-index.yml` with Solvent's pattern — 8 passes 60s
  apart, then `gh workflow run` to re-trigger, cron as backstop only, plus a
  `concurrency` group. ~60s freshness for free, 15× better than today. Twenty
  minutes of work.
- **Removal-test paragraph** in the README (COUNCIL-VERDICT §4), which settles
  the "are we really using Uniswap" question at zero cost.

---

## Step 8 — Optional: the solvency floor as a real opcode *(1 day, only if 1–6 land)*

Our skip rule lives in TypeScript. Solvent's `SolvencyFloor` refuses **inside the
VM**, so a maker cannot quote what it cannot pay. Four competitors forked the
router and added opcodes; we use `IExtruction`, the plug-in seam 1inch ships for
you.

Fork `swap-vm` at `release/1.0.2` (per Discord — **not** `main`), strip unused
opcodes for the EIP-170 bytecode limit, add ours.

**Do not start this until step 6 is done.** It is the highest-risk item here and
the demo does not depend on it.

---

## Sequence summary

| Step | What | Effort | Blocking? |
|---|---|---|---|
| 1 | Freeze the evidence | 1 hr | **yes — everything quotes it** |
| 2 | Mainnet subgraph, drop the 1inch API | hours | yes — step 3 needs it |
| 3 | Reserve ratio | half day | yes — step 4 needs it |
| 4 | Stress test | half day | no |
| 5 | Constrained router | 1 day | no |
| 6 | Split-screen demo | half day | no |
| 7 | Tests, MCP, keeper, README | hours | no |
| 8 | Opcode fork | 1 day | no — do last or not at all |
