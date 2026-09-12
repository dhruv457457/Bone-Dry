# Bone Dry — Phase 6: events and indexing for the frontend (2026-09-12)

Follows `PLAN-ANTIGRAVITY-VM.md`, which is complete through Checkpoint 5 (opcode 35
built, 15 fork tests green). This phase makes the position **visible** — everything
the VM now decides is currently invisible to the UI.

Same house rules, same checkpoint discipline. **Read section 0 first** — two
constraints determine the whole design, and getting either wrong means building
something that silently produces no data.

---

## 0. The two constraints

### 0.1 A reverted transaction emits nothing

This is the big one. When opcode 35 refuses — `EncumbranceExceeded`,
`EncumbranceInsufficient`, `EncumbranceZeroBacking` — the transaction reverts, and
**every log in it is discarded.** There is no such thing as indexing a refusal from
the instruction.

So refusals can only be observed by something that *catches* the revert and
survives. That is `Tap.sol`, which already does exactly this — it try/catches each
maker and emits `MakerSkipped` (three call sites, `Tap.sol:234,238,262`). The
architecture is already right; it is missing the *reason*.

**Refusals come from Tap. Successful applications come from the instruction.
Neither can do the other's job.**

### 0.2 The instruction is `view` and must stop being

`Encumbrance._encumberedCap` is declared `internal view` (`Encumbrance.sol:139`), so
it cannot emit. Making it non-view is **type-compatible** — upstream's opcode array
is declared without `view`:

```solidity
// AquaOpcodes.sol:32
function _opcodes() internal pure virtual returns (function(Context memory, bytes calldata) internal[] memory result)
```

But `quote()` runs in a static context. Emitting there would revert every quote. So
follow the upstream pattern in `Balances._dynamicBalancesXD`, which guards its state
writes the same way:

```solidity
if (!ctx.vm.isStaticContext) {
    emit EncumbranceApplied(...);
}
```

**The emit must not change any amount.** Quote and swap must still compute
identical numbers; the only difference is that one of them logs. Add a test proving
quote and swap agree to the wei after this change.

---

## 1. Hard rules

1. **Never `git add -A` or `git add .`.** Exact paths only.
2. **`Tap.sol` is in scope for this phase only**, and only for the event signature
   change in §3. Do not touch its routing logic, its skip conditions, or anything
   else in it.
3. Do not touch `Wellhead.sol`, `Lens.sol`, `Beacon.sol`, `BeaconStrategy.sol`.
4. **Do not broadcast any transaction.** Fork tests only.
5. **Watch the bytecode budget.** `BoneDryRouter` is at 19,533 / 24,576 — about 5KB
   of headroom. Events cost bytecode. Re-assert the size test after every change and
   report the number.
6. **Never fake data.** If an entity cannot be computed from real chain data, do not
   invent a placeholder value — say so and stop.
7. **Stop at every `--- CHECKPOINT ---`.**
8. Commit per phase, exact paths, trailer:
   `Co-Authored-By: Antigravity <noreply@google.com>`
9. Unsure? **Ask Dhruv** rather than guessing.

---

## 2. Phase 6a — the instruction event

**File:** `contracts/src/vm/Encumbrance.sol`

```solidity
/// @notice Emitted when the encumbrance curve was applied to a real fill.
/// @dev Never emitted during quote() — see the isStaticContext guard. A refusal
///      emits nothing at all, because the transaction reverts; refusals are
///      observed by Tap.sol instead.
event EncumbranceApplied(
    address indexed maker,
    bytes32 indexed orderHash,
    address indexed token,      // tokenOut, the encumbered side
    uint256 encumbered,
    uint256 backing,
    uint256 utilBps,
    bool    isExactIn,
    uint256 adjustedFrom,       // amountOut (exactIn) or amountIn (exactOut), before
    uint256 adjustedTo          // ...and after
);
```

`adjustedFrom`/`adjustedTo` rather than naming a specific register, because the two
modes adjust different ones — see the `isExactIn` branch added in the last round.

Emit **after** the hard solvency floor passes, so a logged event always corresponds
to a fill that actually settled.

Keep `encumbered` and `backing` in the payload even though they look derivable: they
are the maker's state *at that block*, and recomputing them later is not possible
without an archive node. This event is the only cheap record.

**Verification:** all 15 existing tests still green; new test asserting `quote()` and
`swap()` return identical amounts after the mutability change; bytecode size reported.

`--- CHECKPOINT 6a --- report bytecode size and the quote/swap parity result.`

---

## 3. Phase 6b — refusal reasons in Tap

**File:** `contracts/src/Tap.sol` — event signature only.

Today:

```solidity
event MakerSkipped(address indexed maker, uint256 wanted);
```

A skip could be insolvency, a revoked allowance, an encumbrance refusal, or a plain
transfer failure, and the UI cannot tell them apart. Change to:

```solidity
event MakerSkipped(
    address indexed maker,
    bytes32 indexed strategyHash,
    address indexed token,
    uint256 wanted,
    bytes4  reason            // revert selector, or 0x0 if the revert data was empty
);
```

Capture `reason` as the first 4 bytes of the caught revert data at each of the three
existing emit sites. Do not change which conditions cause a skip.

**This signature change is safe right now and will not be later.** `subgraph.yaml`
has no Tap data source attached yet (see the long comment at the bottom of that
file explaining why mainnet's hook was never wired). Once a data source is deployed
against this ABI, changing the signature changes `topic0` and silently breaks the
mapping. Make the change now.

**Verification:** a fork test asserting a maker refused by opcode 35 produces
`MakerSkipped` with `reason == EncumbranceExceeded.selector`. This is the test that
proves the two halves of §0.1 connect.

`--- CHECKPOINT 6b --- paste that test's output.`

---

## 4. Phase 6c — subgraph schema and mappings

**Files:** `subgraph/schema.graphql`, `subgraph/src/aqua.ts`, `subgraph/src/tap.ts`,
`subgraph/subgraph.yaml`

Extend the existing seven entities; do not restructure them.

### 4.1 Decode the program bytes

`Shipped(maker, app, strategyHash, strategy)` already carries the full program. Walk
it in the mapping using `runLoop`'s exact layout — `[opcode:1][argsLength:1][args…]`
— find opcode `35`, and parse its args with the encoding from `EncumbranceArgsBuilder`.

This is why no extra on-chain registration event is needed: **the configuration is
already on chain, in a log we already index.** Do not add a contract to emit it.

Add to `Strategy`:

```graphql
usesEncumbrance:   Boolean!
maxUtilBps:        Int
widenBps:          Int
declaredSiblings:  [Bytes!]!
```

### 4.2 New entity for applications

```graphql
type EncumbranceApplication @entity(immutable: true) {
  id:          Bytes!        # txHash ++ logIndex
  maker:       Maker!
  strategy:    Strategy
  token:       Bytes!
  encumbered:  BigInt!
  backing:     BigInt!
  utilBps:     Int!
  isExactIn:   Boolean!
  adjustedFrom: BigInt!
  adjustedTo:  BigInt!
  blockNumber: BigInt!
  timestamp:   BigInt!
  txHash:      Bytes!
}
```

### 4.3 Extend `MakerRefusal`

It already exists with `maker, wanted, blockNumber`. Add `strategyHash: Bytes`,
`token: Bytes`, `reason: Bytes!`, and a human-readable `reasonName: String!` mapped
from the selector (`EncumbranceExceeded`, `EncumbranceInsufficient`,
`EncumbranceZeroBacking`, `TransferFailed`, `Unknown`).

### 4.4 Extend `MakerTokenPosition`

It has `totalCommitted` and `activeStrategies`. Add:

```graphql
backing:       BigInt!    # last observed min(balance, allowance)
utilBps:       Int!       # totalCommitted vs backing
lastUpdatedAt: BigInt!
```

`backing` can only be refreshed when an event gives it to us — `EncumbranceApplied`
carries it. **Do not call `eth_call` from a mapping to fill it in**; write the last
observed value and let `lastUpdatedAt` say how stale it is. The UI must show the
staleness, not hide it.

`--- CHECKPOINT 6c --- paste the schema diff and one matchstick test per new entity.`

---

## 5. Phase 6d — sibling-list completeness (the §9 gate)

**This is the most valuable entity in the whole plan.** It is the thing only an
index can compute, and it closes the gap left open in `PLAN-ANTIGRAVITY-VM.md` §9.

Add to `Strategy`:

```graphql
siblingListComplete: Boolean!
missingSiblings:     [Bytes!]!
liveSiblingCount:    Int!
```

For strategy `S` by maker `M` on token `T`: let `L` be every *other* strategy of `M`
that is live and holds `T`. Then `siblingListComplete = L ⊆ S.declaredSiblings`, and
`missingSiblings = L \ S.declaredSiblings`.

Recompute for every affected strategy on `Shipped` and `Docked` for that maker+token
— shipping a new strategy can invalidate the completeness of every sibling that
didn't declare it.

**Performance note, take it seriously:** our index measured a maker with **257
strategies on one token**. A naive nested loop on every ship is O(n²) and will make
the subgraph crawl. Keep a per-maker-per-token list of live strategy hashes on
`MakerTokenPosition` and diff against it. If it is still too slow, report the numbers
rather than silently capping the work.

This is what lets the Provide tab say: *"your strategy declares 3 siblings. You have
9 live. It will under-constrain."* Nothing on-chain can produce that sentence.

`--- CHECKPOINT 6d --- report indexing time over the full Base history.`

---

## 6. What the frontend gets (context — do not build UI in this phase)

So you can judge whether an entity is worth its cost:

| Surface | Needs |
|---|---|
| Provide: "your list is incomplete" warning | §5 `siblingListComplete`, `missingSiblings` |
| Provide: sibling list pre-filled | §5 `liveSiblingCount` + `MakerTokenPosition` |
| Swap: per-maker utilisation bar | §4.4 `utilBps`, `backing`, `lastUpdatedAt` |
| Refusal feed ("refused N times today") | §3 + §4.3 — **only** obtainable via Tap |
| Strategy detail: haircut history | §4.2 `EncumbranceApplication` |
| Strategy detail: parameters | §4.1 decoded `maxUtilBps` / `widenBps` |

---

## 7. Do not do these

- Do not touch `web/` in this phase.
- Do not change `Tap.sol` beyond the event signature and reason capture.
- Do not add a contract whose only job is emitting configuration — it is already in
  the `Shipped` program bytes (§4.1).
- Do not make quote and swap disagree. The emit is the only difference between them.
- Do not `eth_call` from a subgraph mapping to freshen `backing`.
- Do not silently cap the §5 recomputation to keep indexing fast. Report the cost.
- Do not deploy or broadcast anything.

## 8. Open questions — answer, don't assume

1. What does `EncumbranceApplied` cost per fill, in gas, measured? If it is above
   ~5k, propose a trimmed payload and let Dhruv choose.
2. After §2, is `_encumberedCap` still assignable to upstream's opcode array without
   any cast or wrapper? Confirm with the compiler, not by reasoning.
3. Does `Shipped` fire before or after `Pushed` in `Aqua.ship()`? §4.1's decode and
   §5's recompute both depend on ordering — check `Aqua.sol` and say which you relied
   on. (`Shipped` is emitted before the token loop; confirm and handle it.)
4. Can `reason` actually be captured at all three `Tap.sol` emit sites, or does one
   of them skip for a condition detected *before* any call is made — in which case
   what selector should it report?
