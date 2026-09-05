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
| Ungated Aqua strategy fillable by any EOA on Base mainnet fork | proven by test |
| `Tap` — Uniswap v4 hook, zero-liquidity pool that fills | 5/5 tests green |
| `Lens` — solvency filter, skips makers who cannot deliver | done |
| Multi-maker pro-rata routing | +4848 bps on a 20k swap |
| Router API — indexes makers, ranks by real depth, emits hookData | live |
| `Aquifer` — the subgraph | deployed and synced on Base |
| Coverage view — the number Aqua cannot compute | live, cross-checked on-chain |
| Frontend | live |

Subgraph: `https://api.studio.thegraph.com/query/1758723/aquifer/v0.0.2`

## What the index found on Base

Aqua keys balances by `[maker][app][strategyHash][token]` and the mapping is not
enumerable — 1inch say so themselves. So nothing on-chain, and no amount of
`eth_call`, can total what one maker has promised across every strategy they have
live. Only an index over `Shipped`/`Pushed`/`Pulled`/`Docked` can.

Aquifer has indexed 436 shipped strategies, 129 still active, 111 makers and
1,862 fills. Setting each maker's committed total against their wallet balance
and Aqua allowance gives a coverage ratio, and **seven of the twelve largest
positions on Base are under-collateralised — five of them backed by nothing**:

| Maker | Live strategies | Committed | Actually backed | Coverage |
|---|---|---|---|---|
| `0x7553…4a55` | 8 | 12,694.5 DEGEN | 0 | **0.0%** |
| `0x7553…4a55` | 5 | 3,174.6 | 0 | **0.0%** |
| `0x1a09…88ec` | 4 | 139.8 | 0 | **0.0%** |
| `0x181b…380b` | 3 | 116,795 | 1,036.3 | 0.9% |
| `0x3a43…b77b` | 1 | 106,335 | 106,335 | 100.0% |
| `0xd18b…32a8` | 1 | 2,904,818 | 5,983,537 | 206.0% |

One maker runs eighteen live strategies across four tokens with allowance set to
infinite and wallets holding none of it. Every one of those strategies quotes
depth that cannot be delivered. That is the whole thesis of this project, sitting
on mainnet, and it took a subgraph to see it.

### Checked both ways

`Lens.coverage()` computes the same ratio on-chain — but it takes the strategy
hashes as calldata, because it cannot enumerate them either. The subgraph supplies
exactly the list the contract cannot produce, which makes the two independent
computations over the same facts. `/api/coverage` runs both and reports the
comparison: 11 of 12 agree exactly, and the twelfth is marked *inconclusive*
rather than failed, because the index sat 4,860 blocks ahead of the fork the
contract was reading. Summing `rawBalances` for that position against live Base
returns `40902390610653882910543` — the subgraph's total to the wei.

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

## The router API

Aqua's balance mapping is not enumerable — there is no on-chain way to ask who the
makers are. 1inch say so themselves and recommend building a reference indexer.
`web/` is that indexer plus the routing service that feeds `Tap` its candidate list.

```
GET /api/makers                    every live strategy + the only depth worth trusting
GET /api/route?amountIn=...        the plan, a real quote for it, and encoded hookData
GET /api/pool?hook=0x...           pool liquidity read straight from PoolManager storage
```

Against a Base fork with three seeded makers all *claiming* 3 WETH but backed by
3 / 2 / 0 — plus two genuine mainnet strategies the indexer picked up:

```
GET /api/makers
  indexed 5 · solvent 2 · totalDepth 5000000000000000000

  0xf39Fd6e5  virtual 3e18  wallet 3e18  depth 3e18  shortfall 0
  0x70997970  virtual 3e18  wallet 2e18  depth 2e18  shortfall 1e18
  0x3C44CdDd  virtual 3e18  wallet 0     depth 0     shortfall 3e18   INSOLVENT
```

```
GET /api/route?amountIn=5000000000        (sell 5,000 USDC)
  makers considered 5 · used 2 · skipped 3

  0xf39Fd6e5   in 3,000 USDC   out 0.692307692307692307 WETH
  0x70997970   in 2,000 USDC   out 0.500000000000000000 WETH

  split         1.192307692307692307 WETH
  single maker  1.000000000000000000 WETH
  improvement   +1923 bps
```

The `shortfall` column is phantom liquidity, measured. A strategy can quote depth
its wallet no longer backs; Aqua has no on-chain guard for it, so the router
carries one.

## Aquifer — the index

Aqua's `_balances` mapping is not enumerable. There is no on-chain way to ask who
the makers are, or how much one maker has committed across their whole book.
1inch state this plainly and recommend building a reference indexer; no hosted
subgraph exists. `subgraph/` is that index.

Five events, two data sources, from Aqua's Base deployment block **48839900**:

```
Aqua     Shipped · Docked · Pulled · Pushed
SwapVM   Swapped

join key   Swapped.orderHash == Shipped.strategyHash     (per the 1inch docs)
```

The entity that matters is `MakerTokenPosition` — one maker's committed total of a
token across every live strategy. That number cannot be computed on-chain, and
comparing it to the wallet balance is what produces a coverage ratio.

`Shipped` carries no amounts, so there is nothing to double-count: initial
balances arrive as `Pushed` events emitted from inside `ship()`.

The router API prefers the subgraph and falls back to paging `eth_getLogs` when
`GRAPH_URL` is unset, so it works with or without a deployment:

```json
{ "source": "aquifer-subgraph" }   // or "rpc-log-paging"
```

```bash
cd subgraph && npm i && npm run codegen && npm run build
npm run deploy          # needs a Subgraph Studio deploy key
```
