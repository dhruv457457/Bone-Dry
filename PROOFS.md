# Facility design — proofs

Run against **real Aqua on a Base mainnet fork** (`contracts/test/FacilityProof.t.sol`).
Four claims the liquidation-facility design rests on. Three we wanted true; one is
a flaw we expected and confirmed, because a design that pretends otherwise is
built on sand.

```
[PASS] test_P1_pullSettlesDirectlyToThirdParty
[PASS] test_P2_drawIsCappedByCommitment
[PASS] test_P3_dockIsInstantAndKillsTheDraw
[PASS] test_P4_crossStrategyExposureIsReadable
```

---

## P1 — Maker capital settles straight to a third party ✅

The mechanism the whole idea depends on. `Aqua.pull()` takes an arbitrary `to`:

```solidity
function pull(address maker, bytes32 strategyHash, address token, uint256 amount, address to)
```

Result of a 400 USDC draw against a 1,000 USDC facility:

| | before | after |
|---|---:|---:|
| maker wallet | 1,000 | 600 |
| third party (stands in for a lending pool) | 0 | **400** |
| **the facility contract** | 0 | **0** |

The app never takes custody, never holds a balance, needs no balance sheet.
**A draw can repay a debt atomically.** Nobody in the field is using this.

## P2 — A draw cannot exceed the commitment ✅

Wallet deliberately funded with 10,000 USDC against a 1,000 USDC commitment.
Drawing 1,001 reverts. The commitment is the cap, not the wallet.

## P3 — The flaw, confirmed and priced ❌

`dock()` is instant, unilateral, and effectively free:

```
gas the maker paid to revoke everything: 4,452
```

No delay, no penalty, no notice — and a pending draw reverts immediately after.
**A maker can revoke a $10M commitment for a fraction of a cent.**

Consequence: *no Aqua commitment is binding.* "Standby credit line," "guaranteed
depth," and anything else implying irrevocability is not buildable on Aqua, and a
1inch judge will know it. The design must offer **access**, not a promise —
failure mode is a revert and a fallback to an AMM, which costs the liquidator
nothing.

## P4 — Cross-strategy overcommitment is provable on-chain ✅

One maker, three strategies, one wallet:

```
promised across 3 strategies: 3,000 USDC
actually held in the wallet:  1,000 USDC
```

An app can read every sibling's `rawBalances` and compute true exposure **inside
a transaction**. So the solvency rule can live in the VM and refuse at fill time,
instead of being filtered off-chain by us and hoped for.

This is the on-chain counterpart to what the index measured across Ethereum
mainnet: 600 of 860 multi-strategy maker/token pairs overcommitted, 419 with
zero backing (see [COUNCIL-VERDICT.md](COUNCIL-VERDICT.md) §1).

---

## What this settles

**Build:** the draw path works, the cap is enforced, and exposure is verifiable
in-VM. Two new contracts (`Facility.sol`, a modified `Tap.sol`) plus one new
SwapVM instruction.

**Do not claim:** binding commitments, guaranteed depth, or anything that implies
a maker cannot walk away for 4,452 gas.

**Honest pitch:** more depth *reachable* than any pool shows, with live
verification of which part is real.
