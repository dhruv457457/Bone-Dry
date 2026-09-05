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
| `Wellhead` — the AquaApp | in progress |
| `Tap` — the Uniswap v4 hook | todo |
| `Aquifer` — the subgraph | todo |

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

## Run it

```bash
cd tools && npm i && node gen-strategy.cjs   # build the ungated strategy fixture
cd ../contracts && forge test -vv            # fork Base and fill it
```

## Setup

```bash
cd contracts && forge install foundry-rs/forge-std --no-git
```
