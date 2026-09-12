# Bone Dry — competitive teardown and build plan

What 23 competitor repos actually ship, read from their file trees, `package.json`s,
subgraph manifests, keeper services and Solidity — not their READMEs. Then what we
change, in priority order.

---

## 1. The finding that matters most

**We are the only solvency project that does not own its own data.**

| Project | Where "who committed what" comes from | 1inch API dependency |
|---|---|---|
| Overdraft | Own subgraph, `Pushed`/`Pulled` → `Commitment.committed` | none |
| Solvent | Own subgraph, `MakerBook{committed, backing, utilisationBps}` | none |
| Glasshouse | Own subgraph + `scripts/keeper.ts` | none |
| Riptide | Own subgraph + `services/vol-indexer` | none |
| Keel, Tremor, Helico, Aqua0, Horizon | Own subgraph | none |
| **Bone Dry (today)** | **`GET api.1inch.dev/aqua/v1.0/strategies/opened`** | **total** |

We *have* the better schema already. `subgraph/schema.graphql` has
`MakerTokenPosition{totalCommitted, activeStrategies}` — the cross-strategy
aggregate. Overdraft only has per-strategy `Commitment`; Solvent computes the
same aggregate as `MakerBook` and calls it "the number Aqua cannot produce."
We wrote that entity first and then stopped calling it.

The reason was real: our subgraph is `network: base` only, and Ethereum mainnet
had no index, so `lib/indexer.ts` reaches for 1inch's API to cover chain 1.

**But Aqua and SwapVM are at the same addresses on Ethereum and Base:**

```
aqua:   0x1111113ccf1426a8e30e2bff5e005d929bf6a90a   # networks.ts:81 and :176
router: 0x111111338c5091E8440b67B168bAe16a668AC0De   # networks.ts:82 and :177
```

So the mainnet manifest is the Base manifest with `network: mainnet` and a new
`startBlock`. Same ABIs, same handlers, zero new mapping code. This is the single
highest-value change available to us and it is measured in hours, not days.

### Why this is not just a purity argument

1inch's own mentor said in Discord: *"If you need some functionality that isn't
covered here, you'll most likely need to build your own indexer."* Calling the
documented endpoint is the path they expect people who did **not** build anything
to take. Every serious competitor built the indexer. A judge comparing
`indexer.ts` (a paginated `fetch` loop) against Solvent's `subgraph/src/aqua.ts`
plus an on-chain attestor sees one project that did the work.

It also costs us the entire Graph track. We are entered in it. Today our Graph
surface on the chain we demo hardest is a subgraph nothing queries.

---

## 2. Custom SwapVM code — where we actually sit

Everyone shipped custom VM logic. The split that matters is **Extruction vs.
forked router**.

| Project | Mechanism | What it does |
|---|---|---|
| Solvent | opcodes in a forked `SolventRouter` | `SolvencyFloor` (0x22), `SolvencySkew`, `ReputationGate` (0x21), `ReputationPriceAdjuster` (0xb3) — four |
| Glasshouse | opcode 0x2e in `GlasshouseRouter` | sealed-bid Vickrey auction, Base mainnet |
| Bebecita | instruction 0x92 `UnwindPricedBalances` | reads a Uniswap v4 LP position to size the quote |
| Subfloor | whole forked `contracts/src/SwapVM.sol` + `instructions/` | signed price floor, Halmos-proved |
| Keel | `KeelInstructions` + `libs/AvellanedaStoikov.sol` | reservation pricing, mirrored as a v4 hook |
| Riptide | `RiptideOpcodes`, `RiptideSwapOpcodes`, `RiptideDutchHandlers` | LVR internalisation |
| Helico | `swapvm/HelicoAquaOpcodes.sol` + own router | yield cover |
| **Bone Dry** | **`IExtruction` + `BeaconStrategy`** | Chainlink-priced quote |

An Extruction is the plug-in seam 1inch ships for you. A forked router with a new
opcode is what Tanner called "encouraged." We are on the easier side of that line,
alone among the top tier. Four of these teams put the solvency/pricing rule *inside
the VM*; ours lives in TypeScript in `lib/solvencyEngine.ts`.

**The gap to close:** our skip rule is off-chain. Solvent's `SolvencyFloor` refuses
*in the VM*, so the maker cannot quote what it cannot pay. Ours filters before we
build the route. If a maker goes insolvent between our read and the fill, Solvent
reverts-safe at the opcode; we rely on `Tap.sol` catching it. That is a real
robustness argument a judge can poke, and it is the argument for moving the floor
on-chain.

---

## 3. Services, keepers and cron — the technique worth stealing

Our GitHub Action runs `*/30 * * * *`. Solvent's runs **every ~60 seconds on the
same free tier**, via a self-chaining trick:

```yaml
# .github/workflows/attest.yml  (Aman035/solvent)
- name: Sync maker books into SolventBook (8x, ~every 60s)
  run: |
    for i in 1 2 3 4 5 6 7 8; do
      if pnpm attest:books; then ok=$((ok+1)); fi
      [ "$i" != "8" ] && sleep 60
    done
    [ "$ok" -gt 0 ]
- name: Chain the next run
  if: success()                       # a failed run must NOT spawn another
  run: gh workflow run attest.yml --repo ${{ github.repository }}
```

One run does eight passes a minute apart, then re-triggers itself. The 15-minute
`schedule:` is only a backstop if the chain breaks. `concurrency: {group, cancel-in-progress: false}`
stops overlap. This is ~15× our freshness for free, and it directly answers the
"15-minute cron delay" weakness we had been holding against Solvent — they fixed it
and we did not notice.

Other service patterns in the field:

| Project | Service | Purpose |
|---|---|---|
| Solvent | `services/attestor` + `contracts/SolventRecorder.sol` | writes scores **on-chain**, not just to a DB |
| Barker | `keeper/` (viem, `policy.ts` + `indexer.ts` side by side) | rebalances v4 positions; keeps a chain-read view *and* an event-sourced view deliberately, "if they ever disagree, that disagreement is the bug report" |
| Riptide | `services/vol-indexer` | EWMA realised-vol feed with a `/health` endpoint |
| Subfloor | `.github/workflows/fuzz-cron.yml` | scheduled fuzzing, not data |
| Horizon | `src/worker.ts` + Prisma migrations | the only Postgres-with-migrations setup besides ours |
| Overdraft | `indexer/substreams` (Rust) **and** a subgraph | two indexing paths; substreams is the Graph-track flex |

**Storage split across the field:** 10 of 23 run a subgraph (on-chain-derived,
off-chain-served). Only **3** run a real database — Horizon (Prisma/Postgres),
Mandate (Drizzle + Supabase), and us (Neon). Solvent is the only one putting
derived state **back on-chain** via an attestor contract. Nobody else has a
Postgres index of Aqua. That part of our stack is genuinely unusual; it is the
*source* feeding it that is the problem.

---

## 4. Dependency audit — what the field builds with

95 `package.json` files across 23 repos.

**Near-universal:** `viem` (21), `react`+`react-dom` (16), `zod` (12), `tsx` (12),
`next` (11), `wagmi` (11), `@tanstack/react-query` (11), `tailwindcss` (10).
We match all of these.

**Where we differ, and whether it matters:**

| Dependency | Repos | Have it? | Verdict |
|---|---|---|---|
| `@graphprotocol/graph-cli` + `graph-ts` | 10 | yes, unused at runtime | **fix — see §6.1** |
| `matchstick-as` (subgraph unit tests) | 4 | no | **add — cheap Graph-track credibility** |
| `@modelcontextprotocol/sdk` | **7** | partial (`subgraphMcp.ts`) | **finish it — see §6.4** |
| `lucide-react` | 10 | no | optional |
| `motion` / `framer-motion` | 9 | no (we use `gsap` + `lenis`) | ours is rarer, keep |
| `@reown/appkit` | 3 | no (RainbowKit) | no change |
| `@privy-io/react-auth` | 3 | no | no change |
| `@1inch/aqua-sdk` | 8 | yes | parity |
| `@1inch/swap-vm-sdk` | 6 | yes | parity |
| `vitest` | 7 | **no tests at all** | **add — see §6.5** |
| `@playwright/test` | 5 | no | optional |
| `ogl` (WebGL) | 2 (Keel, Subfloor) | no | Keel also runs `gsap`+`katex` — closest visual peer |
| `recharts` / `three` | Tremor | no | Tremor renders a vol surface in 3D |
| `katex` (render the actual math) | 2 | no | **worth it if we publish the solvency formula** |

**AI/agent stack — smaller than feared.** Only Helico ships a real LLM product
(`ai` + `@ai-sdk/react`). Horizon has `@anthropic-ai/sdk`. Everyone else's "AI" is
`@modelcontextprotocol/sdk` — an **MCP server exposing their subgraph to an agent**,
not an agent of their own. Seven teams did that. Nobody is running LangChain or
LangGraph. So the realistic AI play is not "add a chatbot", it is "expose Bone Dry's
solvency index as an MCP server," which is one file and puts us level with the
7-project majority pattern.

---

## 5. Positioning — what's already taken, and the one gap

You asked specifically about LP positioning. Three teams work this ground:

- **Bebecita** — maker inventory lives in a Uniswap v4 LP position; instruction
  0x92 reads the position on-chain to size the quote; the fill unwinds exactly
  what settlement needs, same tx. Sepolia, 19 fills, verified.
- **Barker** — `BarkerV4Positions` + `BarkerDynamicFeeHook` + a keeper that
  rebalances; explicitly yield-backed, with `YieldBackedSolvencyGuard.sol`.
- **Aqua0** — v4 adapter + vault registry, cross-chain non-USD stables.

**Bebecita and Barker have both already built "LP position backs the Aqua quote."**
Barker's `YieldBackedSolvencyGuard.sol` is uncomfortably close to our thesis with a
yield wrapper on top. Going further into LP positioning is entering a crowded lane
late.

### The genuinely unclaimed gap

Nobody indexes **overcommitment across makers as a system-level number**.

Everyone checks solvency *per maker* — Solvent scores an agent, Overdraft measures
a wallet, Barker guards a position. `Aqua.ship()` performs no aggregate check, so
one wallet legitimately backs N strategies across M apps. The question nobody
answers is: **for this token, what is the total advertised depth, what is the total
real backing, and which subset of makers would collide if they were all filled in
the same block?**

That is a *joint* property. It needs exactly what our subgraph already models
(`MakerTokenPosition`) and what per-maker checkers structurally cannot see. It is
also the honest version of Bone Dry's existing pitch — "we skip makers who can't
deliver" becomes "we compute which makers can't *all* deliver, and route around the
collision."

---

## 6. The build plan

### 6.1 — Deploy the subgraph to Ethereum mainnet, cut the 1inch API *(highest value)*

Copy `subgraph/subgraph.yaml` → `subgraph.mainnet.yaml`, change `network: base` →
`network: mainnet`, set `startBlock` to Aqua's mainnet genesis (`aquaGenesis`,
`networks.ts:207`). Addresses and ABIs are identical. Deploy, set `graphUrl` for
chain 1 (`networks.ts:200`, currently `""`), and rewrite `lib/indexer.ts` to read
the subgraph instead of `api.1inch.dev`.

Keep Postgres. The subgraph becomes the *source*; Neon stays the fast serving
layer. That is a defensible two-tier design and nobody else has it.

Then delete `AQUA_API_KEY` from the story entirely. *(Note: it is still not set in
Vercel — the cron has been 500ing. This change makes that moot.)*

### 6.2 — Move the solvency floor into the VM

Add a real instruction that refuses when
`min(virtual, wallet, allowance) < floor`, instead of filtering in
`lib/solvencyEngine.ts`. Fork `swap-vm` at `release/1.0.2` (per Discord — not
`main`), strip unused opcodes for EIP-170, add ours. This moves us from the
Extruction tier to the tier Solvent/Glasshouse/Subfloor are in, and it closes the
"what if a maker goes insolvent between your read and the fill" hole.

### 6.3 — Self-chaining keeper

Replace `*/30 * * * *` in `.github/workflows/refresh-index.yml` with Solvent's
8-pass + `gh workflow run` chain and a `concurrency` group. ~60s freshness, same
cost. Twenty minutes of work.

### 6.4 — Finish the MCP server

`lib/subgraphMcp.ts` exists. Seven competitors ship `@modelcontextprotocol/sdk`.
Expose the solvency index as MCP tools (`makerCoverage`, `tokenDepth`,
`collisionSet`) so an agent can ask "is this maker good for 100k USDC." This is the
whole field's AI story and it is one file for us.

### 6.5 — Tests

We have none. Field has `vitest` in 7 repos, `matchstick-as` in 4, Playwright in 5,
Halmos in Subfloor, invariant suites in Solvent and Glasshouse. Minimum:
`matchstick` tests for the subgraph mappings (Graph track judges look) and `vitest`
on `solvencyEngine.ts`.

### 6.6 — Pitch: keep Uniswap, borrow Bebecita's framing

You asked whether to drop Uniswap. **Don't.** But the discomfort is legitimate and
Bebecita solved the exact rhetorical problem with a section called *"The removal
test, both ways"*:

> **Take the Uniswap API out** and there is no calldata to place in either hook
> slice… There is no degraded mode.
> **Take the custom SwapVM instruction out** and Aqua quotes against the virtual
> balance…

Apply that test to us honestly. `Tap.sol` *is* a v4 hook with zero pool liquidity —
remove it and there is no pool to swap through, so it passes. Write that paragraph
in the README and the doubt disappears. Dropping the track forfeits a prize we
already qualify for; the fix is making the dependency legible, not removing it.

### 6.7 — Reframe to the collision thesis (§5)

Positioning change, not a rewrite. Same contracts, same index, one new query over
`MakerTokenPosition` and one new UI panel. It moves us off the crowded
"per-maker solvency" ground that Solvent, Overdraft and Barker all occupy, onto
ground the schema we already wrote is uniquely shaped for.

---

## 7. Priority

| # | Item | Effort | Why |
|---|---|---|---|
| 1 | §6.1 mainnet subgraph, drop 1inch API | hours | uniqueness + Graph track + kills the broken cron |
| 2 | §6.6 removal-test paragraph | 30 min | settles the Uniswap question at zero cost |
| 3 | §6.3 self-chaining keeper | 20 min | 15× freshness, free |
| 4 | §6.7 collision reframe | half day | the one unclaimed gap |
| 5 | §6.2 solvency floor as an opcode | 1 day | moves us into the top contract tier |
| 6 | §6.4 MCP server | hours | matches the field's AI pattern |
| 7 | §6.5 tests | hours | table stakes we are missing |

Items 1–4 are the ones that change the outcome.

---

## Appendix — repos read

Trees, `package.json`s and selected sources pulled for: solvent, overdraft, helico,
aqua-mux, subfloor, Glasshouse, keel, ghost-protocol, mandate, riptide,
barker-alm-engine, aqua0-ethglobal, Percolate, batas, SwipeFI, horizon,
tremor, aqua-propAMM, bebecita, pool-party-v2-frontend, RouteCO2.

Not reachable: `pintoolx/pintool-aqua` (empty/private),
`codeForEatingEverything/1_mol` (single file), `zubidubi` (no public repo found).
