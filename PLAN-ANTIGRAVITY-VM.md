# Bone Dry — the encumbrance-aware position (SwapVM work, 2026-09-12)

Context for whoever reads this (Antigravity, or Dhruv reading it back): this is a
**new workstream**, not a replacement for `PLAN-ANTIGRAVITY.md` — that file is an
active UI punch-list and still applies. This one covers contracts only, in
`contracts/`, which that file explicitly forbids touching. Don't interleave them;
finish a phase here, get it reviewed, move on.

**Read sections 0 and 1 before touching anything.** Section 0 is the mechanism —
if you don't understand why the sibling list is maker-supplied, you will build the
wrong thing and it will look like it works.

---

## 0. What we are building, and why it is shaped this way

The 1inch Aqua track asks for *"a custom Aqua app that implements a sophisticated
DeFi position"* and says *"projects that utilize SwapVM will be scored higher."*

Every competitor prices off **external** state — an oracle (Keel), volatility
(Riptide), a pool (Bebecita), an auction (Glasshouse). We are building the first
Aqua position that prices off **its own wallet's existing obligations**.

### The mechanism

`Aqua.ship()` performs no aggregate check. One wallet can back any number of
strategies. Measured on Ethereum mainnet: 600 of 860 multi-strategy maker/token
pairs are overcommitted, 419 with zero backing at all
(see `COUNCIL-VERDICT.md` §1). Advertised WETH depth is 102,593; deliverable is 4.

So the position is: **as a maker's sibling strategies consume the wallet, this
strategy's quote widens, then refuses.** Inventory defined by *encumbrance*, not
by balance.

```
encumbered = Σ rawBalances(maker, app, siblingHash_i, tokenOut)
backing    = min(tokenOut.balanceOf(maker), tokenOut.allowance(maker, AQUA))
free       = backing > encumbered ? backing - encumbered : 0
util       = encumbered * 1e4 / backing          // basis points
```

Then widen `amountOut` as `util` rises, and revert past `maxUtilBps`.

### Why the sibling list is supplied by the maker (read this twice)

Aqua's balance mapping is **not enumerable**. There is no on-chain way to ask
"what else has this maker shipped." So the strategy program carries the sibling
hashes as immediate args.

A dishonest maker can therefore pass an empty list and get no constraint. **That
is expected and it is not a hole** — it is the seam where the rest of Bone Dry
becomes load-bearing:

- The **instruction** enforces the constraint on-chain, at fill time.
- The **index / subgraph** verifies the list is *complete* — it is the only thing
  that knows every strategy a maker has live.
- **`Tap.sol`** refuses to route to strategies whose sibling list is incomplete.

Do not try to "fix" this in Solidity. It cannot be fixed in Solidity; that's the
point, and it's why the off-chain half of this project exists.

### Already proven — do not re-litigate

`contracts/test/FacilityProof.t.sol` passes against real Aqua on a Base mainnet
fork (see `PROOFS.md`):

- **P4** — cross-strategy exposure is readable on-chain inside a transaction
  (3,000 promised vs 1,000 held). This instruction is that read, in the VM.
- **P3** — `dock()` costs 4,452 gas and is instant. **Never write a comment, doc
  or UI string implying an Aqua commitment is binding.** It is not.

---

## 1. Hard rules

1. **Never `git add -A` or `git add .`.** Exact paths only.
2. **Do not touch `web/` in this workstream at all.** UI comes later, in its own
   phase, after the contracts are reviewed.
3. **Do not modify existing contracts** — `Tap.sol`, `Wellhead.sol`, `Lens.sol`,
   `Beacon.sol`, `BeaconStrategy.sol` stay exactly as they are in this pass.
   Everything new goes in `contracts/src/vm/`.
4. **Do not broadcast any transaction.** No `--broadcast`, no deploy scripts run
   against a live network. Fork tests only. Deployment is a separate, explicit
   decision by Dhruv.
5. **Do not vendor or copy code from any competitor repo** (Riptide, Solvent,
   Glasshouse, Subfloor, Keel, Bebecita, or any other ETHGlobal entry). Upstream
   `1inch/swap-vm` and `1inch/aqua` are the only external Solidity sources.
6. **Never fake data or stub a passing test.** If something cannot be proven on a
   fork, say so and stop — do not write a mock that makes a green checkmark.
7. **Stop at every `--- CHECKPOINT ---`** and report. Do not run ahead.
8. Commit per phase, exact paths, trailer:
   `Co-Authored-By: Antigravity <noreply@google.com>`
9. Unsure whether something is in scope? **Ask Dhruv rather than guessing.**

---

## 2. Phase 1 — dependency and skeleton

We are **not forking the swap-vm repo.** `AquaOpcodes._opcodes()` is declared
`internal pure virtual`, so we subclass and override it. That is cleaner than a
fork, keeps upstream updatable, and still satisfies the track's *"redeployments of
a modified SwapVM contract is allowed."*

**2.1** Install upstream at the production tag. `main` is not a release —
1inch confirmed on Discord that `release/1.0.2` is the only production version:

```
forge install 1inch/swap-vm@release/1.0.2
```

**2.2** Add remappings to `contracts/remappings.txt` (append, don't rewrite):

```
@1inch/swap-vm/=lib/swap-vm/src/
```

You will likely also need `@1inch/solidity-utils/` and `@openzeppelin/` —
check what `lib/swap-vm` actually requires and install those too. Note
`foundry.toml` already pins `solc = 0.8.30`, `via_ir = true`, `evm_version =
"cancun"`, and the comment there explains why all four are mandatory for SwapVM
(internal function pointer dispatch + transient storage). Do not change them.

**2.3** Create three files, empty of logic for now, just compiling:

- `contracts/src/vm/Encumbrance.sol` — the instruction
- `contracts/src/vm/BoneDryOpcodes.sol` — extends `AquaOpcodes`, overrides `_opcodes()`
- `contracts/src/vm/BoneDryRouter.sol` — mirrors `AquaSwapVMRouter`

Reference shape for the router (upstream `src/routers/AquaSwapVMRouter.sol`):

```solidity
contract BoneDryRouter is Simulator, SwapVM, BoneDryOpcodes {
    constructor(address aqua, address weth, address owner, string memory name, string memory version)
        SwapVM(aqua, weth, owner, name, version) BoneDryOpcodes(aqua) {}

    function _instructions() internal pure override returns (function(Context memory, bytes calldata) internal[] memory) {
        return _opcodes();
    }
}
```

**Verification:** `forge build` clean.

`--- CHECKPOINT 1 --- report the remappings you added and any extra deps.`

---

## 3. Phase 2 — the opcode table

**File:** `contracts/src/vm/BoneDryOpcodes.sol`

Upstream `AquaOpcodes._opcodes()` builds a fixed `[35]` array. Indices 0–34 are
assigned; **indices 23–27 are `_notInstruction` placeholders** and the file says
*"New instructions should be added at the end to maintain backward compatibility."*

**Append ours at index 35. Do not reuse 23–27, and do not reorder anything.**
Every index 0–34 must keep its exact upstream meaning, or previously-encoded
programs silently execute the wrong instruction.

```solidity
uint256 internal constant OP_ENCUMBERED_CAP = 35;
```

If the router exceeds the EIP-170 24,576-byte limit, strip **unused** mixins
(`XYCConcentrate`, `Decay`, `PeggedSwap` are the likely candidates) by replacing
those slots with `_notInstruction` — **keeping every remaining index where it
is.** Report what you stripped and the resulting bytecode size.

**Verification:** a test asserting `address(router).code.length < 24576`.

`--- CHECKPOINT 2 --- report bytecode size and anything stripped.`

---

## 4. Phase 3 — the instruction

**File:** `contracts/src/vm/Encumbrance.sol`

### Args encoding

Follow the upstream idiom in `src/instructions/Balances.sol` — a
`…ArgsBuilder` library with `build()` and `parse()`, using
`@1inch/solidity-utils` `Calldata.slice` with a named error selector per field.

```
[0:2]                    uint16  siblingCount
[2 : 2+32n]              bytes32 siblingHashes[siblingCount]
[2+32n : 4+32n]          uint16  maxUtilBps      // revert at/above this utilisation
[4+32n : 6+32n]          uint16  widenBps        // quote haircut at 100% utilisation
```

### Behaviour

Runs **after** the pricing instruction has set `ctx.swap.amountOut`.

1. `encumbered = Σ AQUA.rawBalances(ctx.query.maker, address(this), siblingHashes[i], ctx.query.tokenOut).balance`
   - **Skip any sibling whose `tokensCount == 0xff`** — that is Aqua's `_DOCKED`
     marker (`Aqua.sol`, `uint8 private constant _DOCKED = 0xff`). A docked
     sibling encumbers nothing.
2. `backing = min(balanceOf(maker), allowance(maker, AQUA))` for `tokenOut`.
3. `if (backing == 0) revert` — nothing is deliverable.
4. `util = encumbered * 1e4 / backing`, saturating at `type(uint16).max`.
5. `if (util >= maxUtilBps) revert EncumbranceExceeded(util, maxUtilBps);`
6. Otherwise haircut the quote:
   `ctx.swap.amountOut -= ctx.swap.amountOut * widenBps * util / (1e4 * 1e4)`
7. `free = backing - encumbered;`
   `if (ctx.swap.amountOut > free) revert EncumbranceInsufficient(amountOut, free);`

The haircut is what makes this a **position with a curve** rather than a binary
guard. Step 7 is the hard floor underneath it.

### Things that will bite you

- **`address(this)` is the app.** Strategies are shipped to the router address, so
  inside an instruction `address(this)` is the correct `app` argument to
  `rawBalances`. Do not pass the Aqua address there.
- **Do not include the current strategy's own hash** in the sibling list — it
  double-counts. Add a test proving a maker passing their own `ctx.query.orderHash`
  is either rejected or provably harmless, and document which you chose.
- **Quote/swap divergence is inherent here** and must be documented in a doc
  comment, the way upstream `Balances.sol` documents its own. A quote can succeed
  and the swap revert if a sibling was filled in between. That is correct
  behaviour — it is the entire point — but it must be written down.
- Keep the instruction `internal view`. It must not write state.

`--- CHECKPOINT 3 --- paste the full instruction for review before writing tests.`

---

## 5. Phase 4 — tests

**File:** `contracts/test/Encumbrance.t.sol`, Base mainnet fork.

Model it on `contracts/test/FacilityProof.t.sol`, which already ships a maker,
approves Aqua, and reads `rawBalances` against the real deployment. Reuse that
setup idiom; do not invent a new one.

Required cases:

| # | Case | Expectation |
|---|---|---|
| 1 | No siblings, full backing | quote unchanged — the instruction is inert when nothing is encumbered |
| 2 | One sibling at 50% of backing | quote haircut by roughly `widenBps/2`, exact value asserted |
| 3 | Siblings above `maxUtilBps` | reverts `EncumbranceExceeded` |
| 4 | Sibling docked between ship and fill | encumbrance drops, quote widens back — proves the `0xff` skip |
| 5 | Maker revokes ERC-20 allowance | `backing == 0`, reverts |
| 6 | `amountOut > free` after haircut | reverts `EncumbranceInsufficient` |
| 7 | Quote/swap divergence | quote succeeds, sibling filled, swap then reverts |
| 8 | Bytecode size | router under 24,576 bytes |

Case 7 is the one a judge will ask about. Make it explicit and readable.

**Verification:** `forge test --match-contract Encumbrance -vv`, all green, and
paste the full output including logs.

`--- CHECKPOINT 4 --- paste test output.`

---

## 6. Phase 5 — end-to-end fill (the demo)

One test that ships a strategy whose program *uses* opcode 35 and executes a real
fill through the router, on a Base mainnet fork, against canonical Aqua
(`0x1111113ccf1426a8e30e2bff5e005d929bf6a90a`).

Two fills, side by side, and this is the demo:

- Maker with **one** strategy → fill succeeds at the full quote.
- Same maker, same wallet, after siblings encumber the balance → **the same quote
  refuses**, on-chain, in the VM.

That pair is the submission's money shot. Log both clearly.

`--- CHECKPOINT 5 --- stop here. Deployment and UI are separate decisions.`

---

## 7. Do not do these

- Do not deploy anything. Do not run any script with `--broadcast`.
- Do not touch `web/`, or any contract outside `contracts/src/vm/`.
- Do not edit `foundry.toml`'s `solc` / `via_ir` / `optimizer` / `evm_version`.
- Do not reorder or reuse upstream opcode indices 0–34.
- Do not claim, in code comments or anywhere else, that an Aqua commitment is
  binding, guaranteed, or irrevocable. `dock()` costs 4,452 gas (`PROOFS.md` P3).
- Do not copy code from competitor repos.
- Do not write a mock to turn a red test green. Report the blocker instead.

## 8. Open questions — answer, don't assume

1. Does `widenBps` belong in the program (maker-chosen, immutable per strategy) or
   should it be taker-supplied? Current spec says program. Flag if you disagree.
2. Should step 5 revert, or clamp `amountOut` to zero and let a downstream
   `MinRate` instruction do the refusing? Spec says revert; say so if the router
   handles a zero-out badly.
3. What is the gas cost per sibling? If a 20-sibling list is prohibitive, we need
   a different encoding and Dhruv should hear about it at Checkpoint 3, not later.

---

## 9. Explicit Unenforced Gap (Future Work — Tracked, Not Done)

- **The Instruction Limit**: SwapVM's `runLoop` uses a `uint8` instruction length (`uint256 argsLength = uint8(programBytes[pc++]);`), which caps calldata args to 255 bytes per instruction. With 38 bytes overhead (`declaredTotalEncumbrance: 32`, `siblingCount: 2`, `maxUtilBps: 2`, `widenBps: 2`), exactly 6 sibling hashes (`38 + 32 * 6 = 230 <= 255`) fit in a single opcode payload. This is explicitly enforced on-chain via `EncumbranceArgsBuilder.MAX_INSTRUCTION_SIBLINGS = 6`.
- **The Spot-Check Resolution**: To eliminate the risk of a maker with up to 257 strategies understating risk by only listing a subset, the maker declares their aggregate commitments across all strategies in `declaredTotalEncumbrance`. The sampled sibling list (up to 6) serves as an on-chain spot-check: `require(declaredTotalEncumbrance >= Σ sampled siblings)`. If the maker under-declares obligations, execution reverts with `EncumbranceUnderdeclared(declaredTotal, sampledTotal)`. Utilisation and solvency floors are computed directly against `declaredTotalEncumbrance`.
- **Current Status**: Verifying off-chain that `declaredTotalEncumbrance` equals the maker's full global encumbrance across >6 strategies via `Tap.sol` and the subgraph index is **explicitly future work, not done in this pass**. The current instruction strictly spot-checks up to 6 siblings on-chain and enforces full solvency against the declared total.
- **Untested Worst Case**: Base has 549 strategies shipped and ~150 active. The pathological maker with 257 strategies on one token lives on Ethereum mainnet, which the Base subgraph does not index. The O(k·m) diff algorithm is sound but has never processed its pathological input on-chain. The performance question remains open until tested against full Ethereum mainnet history.
