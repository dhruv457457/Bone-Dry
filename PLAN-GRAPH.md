# Bone Dry — the index indexes everything except what makes us different (2026-09-12)

**Owner: whoever holds `subgraph/` and `web/lib/refusals.ts`.** No contract changes; every
event named here is already deployed and emitting. This is a manifest-and-wiring plan.

Read §0 first. The headline is not that the subgraph is bad — it is healthy and synced.
It is that **the two entities that make this a Graph submission rather than a generic Aqua
indexer have no path to being written, and neither does the RPC fallback behind them.**

This also corrects `PLAN-TWO-BOOKS.md` §0.2, where I wrote *"No subgraph change is needed
anywhere in this plan."* That was wrong. It was true of the `app` field on `Strategy`,
which is indexed correctly; it is false of everything in §0.2 and §0.3 below.

---

## 0. What is actually wrong

### 0.0 What works — establish this first

The deployed Base subgraph is genuinely healthy:

```
Strategy (active)      163
Fill                  ≥1000  (page limit)
MakerTokenPosition     358
head block        51,220,498
hasIndexingErrors      false
```

Four Aqua events (`Shipped`, `Docked`, `Pulled`, `Pushed`) and `Swapped` are indexed, and
`Strategy.app` is indexed per strategy — which is why `makerBook` can see strategies on
both routers. None of that needs touching.

The problem is everything on top of it.

### 0.1 The deployed subgraph is an older build than the repo

Introspecting the live endpoint returns exactly these root fields:

```
protocol, protocols, maker, makers, strategy, strategies,
commitment, commitments, makerTokenPosition, makerTokenPositions, fill, fills
```

`schema.graphql` declares **eight** entities. The deployed one serves **six**.
`MakerRefusal` and `EncumbranceApplication` are not absent-but-empty — the fields do not
exist, and a query naming them fails outright:

```
Type `Query` has no field `makerRefusals`
Type `Query` has no field `encumbranceApplications`
```

A redeploy is necessary. It is not sufficient, because of the next two.

### 0.2 The `Tap` data source is a template nobody instantiates

Both `subgraph.yaml` and `subgraph.mainnet.yaml` declare `Tap` under `templates:`. A
template only begins indexing when a mapping calls `TapTemplate.create(address)`.

```
$ grep -rn "Tap.create\|TapTemplate" subgraph/src/*.ts
(no matches)
```

Nothing creates it. `handleMakerSkipped` in `src/tap.ts` is unreachable code,
`MakerRefusal` is never written, and `Maker.skipsAsMaker` / `Protocol.skips` never
increment. It indexes nothing, forever, and reports no error while doing it — the exact
failure the comment at `subgraph.yaml:70-84` warns about for a *different* reason, having
been fixed in the wrong direction.

The comment says mainnet's hook "does not exist there yet." That is now out of date: both
Base hooks are deployed and carry bytecode (`tapLegacy 0xeAdD3C76…`, 5,849 bytes;
`tap 0xaC7bCA41…`, 6,158 bytes). `Tap` can and should be a plain `dataSources` entry with
a real address and `startBlock`, not a template.

### 0.3 `EncumbranceApplied` is watched on a router that cannot emit it

`subgraph.yaml` attaches the `SwapVM` data source — including
`handleEncumbranceApplied` — to:

```yaml
address: "0x111111338c5091E8440b67B168bAe16a668AC0De"   # 1inch canonical router
```

Opcode 35 exists only on `boneDryRouter 0x74195573Fa9bC965667e03319F2C58567d4B96BE`
(`BoneDryOpcodes` subclasses `AquaOpcodes` and appends index 35). 1inch's router's opcode
table stops at 34 and can never emit `EncumbranceApplied`.

So the handler is dead for the same root reason as `PLAN-TWO-BOOKS`: the product was split
across two routers and the off-chain half was only ever pointed at one of them.

### 0.4 The on-chain fallback filters an event signature that does not exist

`web/lib/refusals.ts` exists precisely so refusals survive a lagging index. It filters on:

```ts
parseAbiItem("event MakerSkipped(address indexed maker, uint256 wanted)")
```

`Tap.sol:56` emits:

```solidity
event MakerSkipped(
    address indexed maker, bytes32 indexed strategyHash, address indexed token,
    uint256 wanted, bytes4 reason
);
```

Different signature, therefore different `topic0`:

```
web/lib/refusals.ts filters : 0xabb600620bdc343dcfdb23bd124b0460d1b7425cf22e19f8c7d92f677d3c742d
Tap.sol actually emits      : 0xe4993c16be3560fa7c0ee16526c5d0683a9296a0e12503241e7435e050b4c78a
```

`getLogs` matches nothing and returns `[]` — indistinguishable from "this maker has never
refused anyone." The `reason` selector, which is the single most valuable byte this
project produces, is not even in the shape being requested.

### 0.5 What this adds up to

**There are three independent paths to refusal data and all three are severed.** Every
"Audit / Refusal Reason" string rendered in the app today — `EncumbranceZeroBacking: 0
deliverable depth — skipped atomically` and the rest — is computed client-side in
`web/lib/solvencyEngine.ts:138`. It is a *prediction of what the chain would do*, which is
legitimate and is how the quote works, but it is not what the UI implies and not what the
README claims.

The project's distinguishing sentence is that a refusal is observable. `Tap.sol` was
written to make it so — a reverted transaction emits nothing, so catching the revert and
re-emitting the selector is the only way to observe one. That machinery is deployed and
correct. Nothing reads it.

For The Graph track specifically: strip `MakerRefusal` and `EncumbranceApplication` and
what remains is Shipped/Docked/Pulled/Pushed/Swapped — the same index any of the other ten
subgraph projects in `COMPETITIVE-PLAN.md` would build in an afternoon. Those two entities
*are* the submission.

---

## 1. Work plan

Sequential. Each phase ends with a query against a deployed endpoint whose output is
pasted. `graph build` must succeed; a passing build is not evidence of indexing.

### Phase 1 — make `Tap` a real data source

- Promote `Tap` from `templates:` to `dataSources:` in `subgraph.yaml`, address
  `0xeAdD3C76bB9f3D8Aa26fA9F793A893e2aBa24088`, `network: base`, `startBlock` = the hook's
  deployment block (find it; do not guess, and do not use the Aqua genesis — it wastes
  hours of sync).
- Add a **second** `Tap` data source for `0xaC7bCA41EA8Fce76651684943Db2c38003c98088`, the
  opcode-35 hook. Both emit `MakerSkipped`; both belong in the index.
- Delete the stale comment block at `subgraph.yaml:70-84`. It describes a world where
  mainnet has no hook. Mainnet has two.
- `subgraph.mainnet.yaml`: Ethereum has no Bone Dry hook (`networks.ts` — *"No hook, no
  lens, no wellhead"*). **Delete the `Tap` template there** rather than leaving a
  never-instantiated block that reads as coverage.

**Check:** deploy, then `{ makerRefusals(first:5){ maker strategyHash token wanted reason } }`
returns rows, or returns `[]` with a stated reason why (e.g. no skip has occurred since
`startBlock` — then force one on Base Sepolia and show it).

### Phase 2 — point `EncumbranceApplied` at the router that emits it

- Add a data source for `boneDryRouter 0x74195573Fa9bC965667e03319F2C58567d4B96BE`
  carrying `handleEncumbranceApplied`, `startBlock` = its deployment block
  (tx `0xd034eb62…`, `deployments/base.json`).
- Keep the existing 1inch-router data source for `Swapped`. Both routers produce fills;
  only ours produces encumbrance.
- Make sure `EncumbranceApplication` records which router it came from, for the same reason
  `Strategy.app` exists.

**Check:** `{ encumbranceApplications(first:5){ maker util haircut refused } }`. If the set
is empty because no encumbered fill has landed yet, say so — and note that
`PLAN-TWO-BOOKS` Phase 3 is what makes the first one possible. **These two plans are
joined here.** Until a swap can reach the opcode-35 hook, this entity is correctly empty,
and that is a product gap, not an indexing one.

### Phase 3 — fix the fallback

- Correct the ABI item in `web/lib/refusals.ts` to the five-parameter signature, and decode
  `reason` (a `bytes4` revert selector) into a name via the same table `Tap.sol` uses.
- An empty result must be distinguishable from a failed read. Return
  `{ rows, available }`, not a bare array — a silent `[]` from a broken filter is what hid
  this for so long.
- Cross-check one maker against the subgraph and the RPC path and assert they agree.

**Check:** the same maker, both paths, same count. Paste both.

### Phase 4 — make the refusal ledger visible

Only after 1–3. With real refusals indexed, the Swap receipt's "Audit / Refusal Reason"
column should distinguish **predicted** (solvency engine, pre-trade) from **observed**
(`MakerRefusal`, post-trade), and a maker page should show their refusal history with
decoded reasons.

That distinction is worth more than any additional chart on this project. Every competitor
can predict. Only we emit the refusal and read it back.

---

## 2. Acceptance

1. Deployed endpoint's introspection lists `makerRefusals` and `encumbranceApplications`.
2. `_meta.hasIndexingErrors == false` after redeploy, head within a few blocks of chain tip.
3. `makerRefusals` returns rows with a decoded `reason`, or a stated reason for being empty.
4. Both `Tap` hooks indexed; a refusal from each distinguishable by source.
5. Subgraph and RPC refusal counts agree for one maker.
6. Ethereum manifest carries no never-instantiated template.
7. `Strategy`/`Fill`/`MakerTokenPosition` counts unchanged after redeploy — this plan adds
   coverage, it does not disturb what works.

---

## 3. Do not

- **Do not** redeploy pointing `startBlock` at the Aqua genesis (`48839900`) for the hook
  data sources. It is tens of thousands of blocks of nothing and will not finish in time.
- **Do not** leave a `templates:` block that nothing calls `create()` on. That is the exact
  bug in §0.2 and it is invisible — no error, no warning, no rows.
- **Do not** report `MakerRefusal` as working because `graph build` passed or because the
  handler exists. Three separate mechanisms here compile perfectly and index nothing.
- **Do not** present solvency-engine strings as on-chain refusals. They are a prediction;
  the whole point of `Tap.MakerSkipped` is that the observed one is different evidence.

---

## 4. Evidence log

| Claim | How established |
|---|---|
| Deployed schema has 6 of 8 entities | GraphQL introspection of the live endpoint |
| 163 strategies / ≥1000 fills / 358 positions / no errors | live query incl. `_meta` |
| `Tap` template never instantiated | `grep -rn "Tap.create\|TapTemplate" subgraph/src/` → no matches |
| `EncumbranceApplied` watched on 1inch's router | `subgraph.yaml` SwapVM `source.address` |
| Only boneDryRouter can emit it | `BoneDryOpcodes` appends index 35; upstream stops at 34 |
| Both Base hooks deployed | `eth_getBytecode` — 5,849 and 6,158 bytes |
| Fallback filters the wrong topic0 | keccak of both signatures, §0.4 |
| Refusal strings are client-computed | `web/lib/solvencyEngine.ts:138` |
