# Bone Dry on Base Sepolia

Aqua has never been deployed to a testnet — the 1inch SDK lists sixteen chains and
every one is a mainnet. So a testnet Bone Dry needs Aqua and the SwapVM router
deployed first, which 1inch confirmed is fine both in Discord ("it doesn't matter
whether you use your own deployment of these contracts or the ones already
deployed" — SevenSwen) and in the licence itself:

> You may read, use, deploy, and call Aqua (Core/Router/App).
> — Aqua Source License 1.1, non-binding summary

We deploy it **unmodified**, so the §3 copyleft does not apply, and Bone Dry's own
contracts only form calldata and read state — Pure Caller Use under §2.2. The
commercial triggers are $100k of fees or $10m under control; a hackathon is not
close.

## What is already on Base Sepolia (84532)

Verified on chain, not from documentation:

| Contract | Address | |
|---|---|---|
| Uniswap v4 PoolManager | `0x05E73354cFDd6745C338b50BcFDfA3Aa6fA03408` | live |
| WETH | `0x4200000000000000000000000000000000000006` | live |
| USDC (Circle) | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` | live |
| Aqua | — | we deploy |
| AquaSwapVMRouter | — | we deploy |

Faucets: Base Sepolia ETH from any Base faucet; USDC from
[faucet.circle.com](https://faucet.circle.com).

## Order of operations

`AquaRouter` is the deployment people mean when they say "Aqua" — it inherits the
core: `contract AquaRouter is Aqua, Simulator, Multicall, Rescuable`. The
canonical `0x1111113ccf…` on sixteen mainnets is one of these.

```bash
# 1. Aqua  (repo: github.com/1inch/aqua)
npm install && forge build
forge create src/AquaRouter.sol:AquaRouter \
  --rpc-url https://sepolia.base.org --private-key $PK \
  --constructor-args $OWNER

# 2. SwapVM router  (repo: github.com/1inch/swap-vm)
#    AquaSwapVMRouter(aqua, weth, owner, name, version)
npm install && forge build
forge create src/AquaSwapVMRouter.sol:AquaSwapVMRouter \
  --rpc-url https://sepolia.base.org --private-key $PK \
  --constructor-args $AQUA 0x4200000000000000000000000000000000000006 \
                     $OWNER "SwapVMRouter" "1.0.0"

# 3. Bone Dry itself
cd contracts && forge script script/Deploy.s.sol \
  --rpc-url https://sepolia.base.org --broadcast
```

The SwapVM build is slow — `via_ir` with `optimizer_runs = 10_000_000` over a
bytecode VM. Give it ten minutes and do not assume it has hung.

## Things that will bite

- **The strategy generator hardcodes addresses per chain.** `tools/gen-strategy.cjs`
  reads `AQUA_SWAP_VM_CONTRACT_ADDRESSES[chainId]` from the SDK, which has no entry
  for 84532. It needs an explicit override or it will silently build strategies
  pointing at a router that does not exist here.
- **The hook address is mined against a specific PoolManager.** Base Sepolia's is a
  different address to mainnet's, so the CREATE2 salt has to be re-mined; the flag
  bits (`0x88`) stay the same.
- **`name` and `version` feed the EIP-712 domain.** Ours will not match mainnet's,
  which is harmless here only because our strategies set
  `useAquaInsteadOfSignature` and never rely on a signed order hash.
- **The subgraph needs a second deployment** for `base-sepolia`. Studio supports the
  network; it is a separate subgraph, and the free plan allows three.

## What each network is for

They are not the same product and the app should not pretend otherwise.

**Base mainnet — the evidence.** Real Aqua: 436 strategies, 129 active, 111 makers,
1,862 fills, and the finding that seven of the twelve largest positions are
under-collateralised with five backed by nothing. Read-only; nobody spends
anything to look at it. This cannot be reproduced on a testnet because it is
other people's real behaviour.

**Base Sepolia — the playground.** Our Aqua, our pool, our makers, free tokens.
Connect a wallet and actually swap, actually make markets, for nothing.

## Rehearsed on a fork, 6 Sep

The whole stack went up against `anvil --fork-url https://sepolia.base.org`:

| | |
|---|---|
| Aqua (AquaRouter) | `0x889B728bCb44E614B464bB71d1e70666bA2683DF` |
| AquaSwapVMRouter | `0x18A3a929FfdeBC586D07aEBFCDF6496DccCF89c3` |
| Lens | `0x382f5bbCe04f50D5CD6DE7991fE666E718E39bBE` |
| Tap | `0x4444000000000000000000000000000000000088` |
| Wellhead | `0x88739809c2fe3f69bE7D04cac43afbe2D2CdF3A4` |

Makers shipped against our own Aqua and the pool initialized. Two things only a
rehearsal would have found:

**The currency order flips between the chains.** Mainnet has WETH `0x4200..` below
USDC `0x8335..`; Sepolia has Circle's USDC at `0x036C..`, below WETH. So WETH is
currency0 on one chain and currency1 on the other. A pool key written for mainnet
is rejected outright with `CurrenciesOutOfOrderOrEqual` — the loud failure — but
`zeroForOne` inverts too, which is the quiet one: a hardcoded direction sells the
wrong token. `Chains.currencies()` sorts, and the initial sqrt price is inverted
to match, since price is quoted currency1/currency0.

**The fixture is per chain.** Aqua sits at a different address on every network,
so one `strategy.json` meant regenerating for Sepolia silently repointed the whole
mainnet test suite at contracts that do not exist there — nineteen tests failed
with "Aqua has no code on Base". Fixtures are `strategy.<chainId>.json` now and
every script and test reads the one for the chain it is on.

## Strategies are immutable, permanently

`ship()` requires `tokensCount == 0` and `dock()` sets it to `0xff`, never back to
zero. So a strategy hash is spent the first time it is used and can never be
shipped again — Aqua's own error is called `StrategiesMustBeImmutable`.

Two consequences worth holding on to:

- **A maker cannot edit a strategy.** Changing a curve means shipping a different
  program, which is a different hash, and docking the old one. Any maker-facing
  UI has to present that as "replace", never as "update".
- **Tests need a chain where their hashes are unused.** Point `BASE_RPC_URL` at a
  fork with Aqua deployed but nothing shipped against these makers; a fork that
  has already been seeded will fail every test with an error about immutability
  that has nothing to do with the code under test.

## Status, 6 Sep

Mainnet: 19 passing, 1 skipped. Base Sepolia: 4 of 11. The remaining seven revert
with `NoSolventMaker` before the hook reaches its depth loop, which means the
strategies array is arriving empty — fixture plumbing on the testnet path, not the
contracts. Next session's first job.

## Live on Base Sepolia, 6 Sep

Everything is deployed and seeded. Addresses in `deployments/base-sepolia.json`.

The hook address is mined, not chosen: a v4 hook advertises its permissions
through the low fourteen bits of its own address, so `Deploy.s.sol` grinds a
CREATE2 salt until the result carries exactly BEFORE_SWAP |
BEFORE_SWAP_RETURNS_DELTA and nothing else. `0x2ae6…4088` — and
`0x4088 & 0x3FFF == 0x0088`. Total gas for the whole stack was under 0.0002 ETH.

`Lens` reads correctly against it. All three makers promise 0.015 WETH:

| Maker | Promises | Deliverable |
|---|---|---|
| `0xe4436B…` | 0.015 | 0.015 |
| `0xEeA25b…` | 0.015 | 0.010 |
| `0x4c8A0D…` | 0.015 | 0 |

### Solved: build the router from v1.0.2, not main

The SDK emits `0x1100`; `main` numbers `XYCSwap` as `0x50`. At `v1.0.2` the
opcodes are a jump table whose element 0 is overwritten with the array length, so
the dispatched opcode is the static index minus one — `XYCSwap` dispatches as
`0x11`, which is what the SDK and the mainnet routers agree on.

### It works

```
sold  USDC : 5000000
got   WETH : 1425979680696660
pool liquidity after : 0
```

Split three-to-two across the two solvent makers, matching their 0.015 : 0.010
depths. The WETH left their wallets and the pool held nothing at any point.
