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
| `Tap` — Uniswap v4 hook, zero-liquidity pool that fills | 11 tests green, fuzzed 1 USDC to 100M |
| `Lens` — solvency filter, skips makers who cannot deliver | done |
| Multi-maker pro-rata routing | +4848 bps on a 20k swap |
| Router API — indexes makers, ranks by real depth, emits hookData | live |
| `Aquifer` — the subgraph | deployed and synced on Base |
| Coverage view — the number Aqua cannot compute | live, cross-checked on-chain |
| `Wellhead` — the router a wallet calls | live, wallet connect + swap |
| Multi-pair support (USDC/WETH and WETH/MOCK) | live, reuses existing Tap hook |
| Maker strategy shipping (`/api/strategy`, `ShipStrategy`) | live on Base Sepolia |
| Oracle-deviation check (Chainlink feeds + `Beacon.sol`) | live in book, per-slice bps in route |
| Cross-app standardized schema proof (`/api/apps`) | live query across independent apps |
| Token icons with generative fallback | live across dashboard |
| Frontend trading desk (Swap, Provide, Portfolio, Explore) | live |
| `BeaconStrategy` — Extruction-priced strategy (opcode `0x20`) | deployed on Base Sepolia, real ship + real fill on-chain |
| Subgraph MCP — cross-protocol token discovery (`/app/lookup`) | live, second independent Graph product composed alongside Token API |

Subgraph: `https://api.studio.thegraph.com/query/1758723/aquifer/v0.0.3`

## Where to look

For judges verifying our code and contract integrations:

| Judging Concern | Exact File & Line | What happens there |
|---|---|---|
| **Uniswap v4 Hook** | [`contracts/src/Tap.sol:83`](contracts/src/Tap.sol#L83) (`beforeSwap`) | Fully overrides the swap (`BEFORE_SWAP_RETURNS_DELTA_FLAG`), reads maker solvency via Lens, pulls tokens straight from maker wallets via Aqua, and settles with PoolManager without touching pool liquidity (0 TVL before and after). |
| **Hook Address Mining** | [`contracts/script/Deploy.s.sol:60`](contracts/script/Deploy.s.sol#L60) (`_mine`) | Brute-forces CREATE2 salt to match Uniswap v4's `BEFORE_SWAP_FLAG` prefix before broadcasting deployment. |
| **Solvency Filter** | [`contracts/src/Lens.sol:30`](contracts/src/Lens.sol#L30) (`quotableDepth`) | Reads `min(virtualBalance, walletBalance, allowance)` directly on-chain so phantom liquidity cannot be quoted or filled. |
| **Maker Coverage Check** | [`contracts/src/Lens.sol:49`](contracts/src/Lens.sol#L49) (`coverage`) | Computes a maker's whole-book backing ratio on-chain given their live strategy hashes. |
| **Pool Re-use Script** | [`contracts/script/InitPool.s.sol:41`](contracts/script/InitPool.s.sol#L41) (`run`) | Initializes new token pairs against the existing Tap hook and PoolManager without redeploying contracts. |
| **Oracle Pricing Contract** | [`contracts/src/Beacon.sol:34`](contracts/src/Beacon.sol#L34) (`oraclePriceUsd`) | Standalone contract reading Chainlink feeds and calculating deviation basis points ([`line 47`](contracts/src/Beacon.sol#L47)). |
| **Oracle Pricing Service** | [`web/lib/oracle.ts:33`](web/lib/oracle.ts#L33) (`oraclePriceUsd`) | Fetches live Chainlink AggregatorV3 prices and computes deviation for every maker curve slice ([`line 55`](web/lib/oracle.ts#L55)). |
| **Maker Strategy Assembly** | [`web/app/api/strategy/route.ts:43`](web/app/api/strategy/route.ts#L43) (`POST`) | Encodes ungated, permissionless Aqua strategies with custom spread fees and salt for wallet signing. |
| **Multi-Pair Configuration** | [`web/lib/pairs.ts:25`](web/lib/pairs.ts#L25) (`PAIRS`) | Configures pair tokens, pool keys, and tick spacings across Base mainnet and Base Sepolia. |
| **Standardized Subgraph Schema** | [`subgraph/schema.graphql:1-11`](subgraph/schema.graphql#L1) | Proposed reusable schema for any Aqua consumer; indexes protocol-wide events rather than filtering to one app. |
| **Cross-App Subgraph Proof** | [`web/app/api/apps/route.ts:15`](web/app/api/apps/route.ts#L15) (`GET`) | Live endpoint querying [`web/lib/graph.ts:304`](web/lib/graph.ts#L304) (`appBreakdown`), proving the schema indexes multiple independent apps on Base mainnet. |
| **Standards Leverage Spec** | [`subgraph/STANDARD.md:1`](subgraph/STANDARD.md#L1) | Specification of the Aquifer schema as a reusable standard, live cross-app proof, and composition with Token API. |
| **Token API Balance Integration** | [`web/lib/tokenApi.ts:42`](web/lib/tokenApi.ts#L42) (`tokenBalances`) | Composes The Graph's Token API for live wallet balance lookups with automatic fallback to RPC multicall. |
| **Subgraph MCP Integration** | [`web/lib/subgraphMcp.ts:53`](web/lib/subgraphMcp.ts#L53) (`searchSubgraphsForTokens`) | Calls The Graph's own Subgraph MCP (`get_top_subgraph_deployments`) to surface other subgraphs indexing an unrecognised token, on [`/app/lookup`](web/app/app/lookup/page.tsx#L9) — the second, unambiguously first-party Graph product this project composes alongside Token API. |
| **Extruction-Priced Strategy** | [`contracts/src/BeaconStrategy.sol:1`](contracts/src/BeaconStrategy.sol#L1) (`extruction`) | A real Aqua strategy priced off Chainlink directly via SwapVM's Extruction opcode (`0x20`) instead of the built-in XYC curve — proves the router is extensible past its own built-ins. Deployed on Base Sepolia; a real maker shipped through it and a real taker filled it (tx hashes below). |
| **Extruction Interface** | [`contracts/src/interfaces/IExtruction.sol:1`](contracts/src/interfaces/IExtruction.sol#L1) | Structural copy of the real `IExtruction`/`IStaticExtruction` ABI, pulled from the deployed router's own verified Sourcify source (not a guessed git tag — an earlier version built from `1inch/swap-vm`'s `main` branch had the wrong `SwapRegisters` field count and was silently unreachable). |
| **Extruction Validator** | [`contracts/test/BeaconStrategy.t.sol:99`](contracts/test/BeaconStrategy.t.sol#L99) | Executes the two properties 1inch's own docs require of an Extruction target — STATICCALL and CALL return byte-identical results, and `vm.accesses()` confirms zero storage writes — rather than asserting them from reading the source. |
| **Oracle-Priced Ship Flow** | [`web/app/api/strategy/route.ts:31`](web/app/api/strategy/route.ts#L31) (`BEACON_STRATEGY_ADDRESS`) | `/api/strategy` builds an Extruction-priced program via `AquaProgramBuilder`'s base `.add()` (it has no `.extruction()` convenience method), gated to WETH/USDC on Base Sepolia only. Surfaced as a real, honestly-gated option in the existing Ship-a-strategy UI. |


## Live on Base Sepolia

Deployed and swappable by anyone, for free. Addresses in
[`deployments/base-sepolia.json`](deployments/base-sepolia.json).

1inch have never put Aqua on a testnet, so Aqua and the SwapVM router here are our
own deployments, built unmodified from their sources — which their licence permits
in as many words and which their team confirmed in Discord. The router is built
from tag `v1.0.2`: `main` has renumbered the opcodes and will not run the SDK's
own programs. That is written up in [FEEDBACK.md](FEEDBACK.md).

A real swap, on the public testnet:

```
sold  USDC : 5000000
got   WETH : 1425979680696660
pool liquidity after : 0
```

Five USDC split three-to-two across two makers, matching their 0.015 : 0.010
deliverable depths. The WETH left their wallets and the USDC arrived in them. A
third maker promised the same 0.015, holds none of it, and was skipped without
costing the swapper anything.

### An Extruction-priced strategy, filled for real

`BeaconStrategy` ([`contracts/src/BeaconStrategy.sol`](contracts/src/BeaconStrategy.sol))
is deployed at
[`0x1cAD1eCa368940F91b43B25Db0e3E9B32B46fFe7`](https://sepolia.basescan.org/address/0x1cAD1eCa368940F91b43B25Db0e3E9B32B46fFe7)
on Base Sepolia. It was redeployed once — the first attempt
([`0xAe91aEea...`](contracts/fixtures/beacon-strategy.84532.json)) used a
`SwapRegisters` struct copied from `1inch/swap-vm`'s `main` branch, which turned
out to already be ahead of what the deployed router was actually compiled from
(an extra `amountNetPulled` field). That mismatch changes the ABI selector, so
the router could never actually reach it — every call hit the wrong function and
reverted. The fix came from decoding the router's own verified Sourcify source
directly rather than trusting a git branch; see
[`IExtruction.sol`](contracts/src/interfaces/IExtruction.sol) for the full story.

One real maker shipped an Extruction-priced strategy through `/api/strategy`,
and one real taker filled it through the real deployed router:

```
ship tx : 0x70a3aef07a3b894c1e09fefec7861825e5acc4ab60fc3981a33a5391b2a257a3
swap tx : 0x8096393361f006fa3f1d054c7b2262295c3e6551fa11075787941064d3d2f252
sold    : 1,000,000 (1 USDC)
received: 403,768,485,249,334 (0.000403768485249334 WETH)
```

Priced at Chainlink oracle mid minus a fixed 0.20% spread — not a bonding
curve — confirmed via on-chain `balanceOf` before/after, not the swap's own
return value.

## Run it

Everything below works against a fork of Base mainnet, so no testnet deploy and
no faucet. The canonical Aqua and SwapVM contracts are the real ones.

```bash
# 0. contract dependencies. lib/ is not committed, and the default tag of
#    v4-core (v4.0.0) predates src/types/PoolOperation.sol, so the commit is
#    pinned. v4-periphery is not needed — nothing imports it.
cd contracts
forge install foundry-rs/forge-std               uniswap/v4-core@46c6834698c48bc4a463a86d8420f4eb1d7f3b75

# 1. a Base fork to work against
anvil --fork-url https://mainnet.base.org

# 2. build the strategies and seed three makers onto the fork
cd ../tools && npm i && node gen-strategy.cjs
cd ../contracts && forge script script/Seed.s.sol   --rpc-url http://127.0.0.1:8545 --broadcast
forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:8545 --broadcast

# 3. the app
cd ../web && npm i && cp .env.example .env.local && npm run dev
```

The seed gives maker 0 three WETH, maker 1 two, and maker 2 none — while all
three *claim* three. That is the whole point: the third is the phantom the router
has to route around, and the second is the one whose promise outruns its wallet.

`forge test` runs the contract suite against a Base fork (set `BASE_RPC_URL` to
use your own endpoint). `RouterAgreement` replays whatever `fixtures/route.json` holds and skips when it
is absent. The fixture is a snapshot of a running service against one chain
state, so it is not committed — capture it fresh, or the comparison is against a
quote the chain has since moved past:

```bash
curl 'http://localhost:3000/api/route?amountIn=20000000000' > contracts/fixtures/route.json
cd contracts && forge test
```

On Windows, clone somewhere short — v4-core's nested submodules (`solmate` →
`ds-test`) blow past `MAX_PATH` from a deep directory, and `git config
core.longpaths true` is worth setting.

The subgraph's handler tests need Matchstick, which has no Windows binary:

```bash
cd subgraph && npx graph test -d      # -d runs it in Docker
```

### The endpoints

| | |
|---|---|
| `GET /api/makers?token=` | every live strategy, with `min(virtual, wallet, allowance)` as its depth |
| `GET /api/route?tokenIn=&tokenOut=&amountIn=` | the split, a real quote for it, and the `hookData` the pool needs |
| `GET /api/pool?hook=` | the pool's own liquidity, read out of PoolManager storage |
| `GET /api/coverage?first=` | promised against held, per maker — subgraph only |
| `POST /api/strategy` | encodes ungated Aqua strategy calldata for wallet signing |
| `GET /api/apps?chain=` | every app shipping live strategies across Aqua per the subgraph |

Connect a wallet on the fork and press Swap, or take the same path without a
browser:

```bash
WELLHEAD=0x... node web/scripts/swap-smoke.mjs 20000000000
```

```
quoted   : 2.969705251715010073 WETH
status   : success
received : 2.969694882406596405 WETH
```

The pool holds nothing before that transaction and nothing after it. The WETH
came out of maker wallets and the USDC went into them.

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

### The API and the chain agree

The off-chain router and the hook no longer decide the same way. `/api/route`
bisects each slice down to what a maker can deliver, batching every candidate
into a single multicall; `Tap` cannot afford that inside a swap, so it quotes
each slice once and drops any maker whose quote exceeds their depth. Two
different algorithms — and if they disagree, the number the interface shows is
not the number the chain will pay.

`test/RouterAgreement.t.sol` replays the exact `hookData` the running API
emitted against the real PoolManager, using the API's own quote as the
expectation:

```
api quoted WETH : 2969705251715010073
chain paid WETH : 2969693471214161553
```

0.04 bps apart. The hook takes only the candidate set from calldata and recomputes
the split from its own `Lens` reading, so it never has to trust the amounts an
off-chain service hands it.

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

## Standards leverage

One schema covers every Aqua app rather than requiring an app-specific indexer, because Aquifer indexes Aqua's protocol-level events (`Shipped`, `Docked`, `Pushed`, `Pulled`, `Swapped`) across all routers. On Base mainnet today, a single query against this schema surfaces 132 active strategies across two independent Aqua applications without modification (documented in [`subgraph/STANDARD.md`](subgraph/STANDARD.md)). Furthermore, composing The Graph's Token API for wallet balances required no change to position-tracking because commitments and balances are decoupled concerns in the schema: Token API efficiently serves holder balances with an RPC fallback, while Aquifer tracks contract commitments.

A second, independent Graph product is composed alongside Token API: [`web/lib/subgraphMcp.ts`](web/lib/subgraphMcp.ts) calls The Graph's own Subgraph MCP (`subgraphs.mcp.thegraph.com`) — on the same domain as thegraph.com, authenticated with the same Subgraph Studio API key already used for `GRAPH_URL`, unambiguously first-party in a way Token API (Pinax-branded, though "Built with The Graph") is arguably but not definitively. `get_top_subgraph_deployments` is used deterministically — one contract address in, real deployments ranked by query fees out, no synthesized commentary — to surface other subgraphs indexing an unrecognised token on [`/app/lookup`](web/app/app/lookup/page.tsx). Its own `search_subgraphs_by_keyword` tool was tried first and found to match subgraph *display names*, not addresses — a raw address as the keyword returns zero results always, regardless of whether related subgraphs exist — which is why `get_top_subgraph_deployments` is the tool actually wired in.
