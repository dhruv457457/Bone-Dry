# Bone Dry

**Zero TVL. Full depth.**

A Uniswap v4 pool that holds nothing. The depth is real — it is still sitting in
makers' wallets on [1inch Aqua](https://github.com/1inch/aqua), and it only
surfaces at the instant of a fill.

Built for ETHOnline 2026 — 1inch (Build an Aqua App), Uniswap Foundation
(Stack Contribution), The Graph (Composable & Standardized).

## Status

| Milestone | State |
|---|---|
| Ungated Aqua strategy fillable by any EOA on Base mainnet fork | ✅ proven by test |
| `Tap` — Uniswap v4 hook, zero-liquidity pool that fills | ✅ 6/6 tests green |
| `Lens` — solvency filter, skips makers who can't deliver | ✅ |
| Multi-maker pro-rata routing | ✅ +28.6% on a 5k swap |
| `Aquifer` — the subgraph | todo |
| Next.js app + router API | todo |

## The finding that makes this possible

1inch gate Aqua takers behind a soulbound `KycNFT` minted only to KYB-verified
resolver firms. That gate is **not enforced by the router** — it is the Controls
opcode `onlyTxOriginTokenBalanceNonZero`, which the 1inch dApp's assembler embeds
into every strategy *it* ships.

Makers are permissionless. A maker who builds their own program omits that opcode,
and any EOA can fill it. `test/UngatedFill.t.sol` proves this against the canonical
contracts on a Base mainnet fork:

```
Aqua   0x1111113ccf1426a8e30e2bff5e005d929bf6a90a   (code size 5619)
router 0x111111338c5091e8440b67b168bae16a668ac0de   (code size 20541)

maker ships 10,000 USDC + 3 WETH  (permissionless)
0xBEEF sells 100 USDC             (holds no KycNFT)
        -> receives 29702970297029702 wei WETH
```

That output is exactly `3e18 * 100 / (10000 + 100)` — constant product, settled
against real contracts.

## Why routing across makers matters

Aqua's mapping is not enumerable, so the candidate makers arrive as calldata from
an off-chain index. Splitting the input across them pro-rata to *real* depth walks
each constant-product curve less far up its own price impact:

```
sell 5,000 USDC

  one maker      1.000000000000000000 WETH
  three makers   1.285714285714285712 WETH
                 ---------------------------
  improvement            +28.6%
```

## Solvency is not optional

A virtual balance is a promise. Makers share one wallet across many strategies, so
a strategy can quote depth its wallet no longer backs — 1inch document this and
provide no on-chain guard. `Lens` takes the floor of virtual balance, wallet
balance and Aqua allowance, and `Tap` routes around anyone who comes up short
instead of reverting the swap:

```
maker1 virtual WETH : 3000000000000000000   <- still reads full
maker1 real depth   : 0                     <- wallet was emptied
swapper WETH gained : 29702970297029702     <- filled from the solvent maker
```

## Run it

```bash
cd tools && npm i && node gen-strategy.cjs   # build the ungated strategy fixture
cd ../contracts && forge test -vv            # fork Base and fill it
```

## Setup

```bash
cd contracts && forge install foundry-rs/forge-std --no-git
```
