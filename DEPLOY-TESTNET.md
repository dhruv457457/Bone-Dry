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
