# FEEDBACK.md

Developer-experience notes from building **Bone Dry** — a Uniswap v4 pool with zero
liquidity, filled from 1inch Aqua maker wallets at swap time — during ETHOnline 2026.

Everything below is something we actually hit, with the file and version that caused
it. Nothing here is speculative.

---

## Uniswap v4

### 1. `BaseHook` is gone from `v4-periphery`, but every guide still says to extend it

`forge install Uniswap/v4-periphery` at HEAD ships no `BaseHook.sol`:

```
lib/v4-periphery/src/
  base/        BaseActionsRouter, DeltaResolver, SafeCallback, ImmutableState, ...
  hooks/       permissionedPools/
  # no BaseHook, no utils/
```

We searched `src/`, `src/utils/`, and `src/base/`. The hook tutorials and most
third-party posts still open with `contract MyHook is BaseHook`, so the first thing
a new hook developer does fails.

We implemented `IHooks` directly (`contracts/src/Tap.sol`), which turned out fine —
but it meant hand-writing nine stub methods and rediscovering `onlyPoolManager`.

**Suggestion:** either keep a `BaseHook` in periphery, or put a short note at the top
of the hooks docs saying where it moved and showing the bare-`IHooks` shape. A
`HookStub` with the unused callbacks already reverting would remove ~40 lines of
boilerplate from every hook project.

### 2. Permission flags in the address is the single biggest onboarding cliff

Encoding permissions into the hook address is elegant and completely non-obvious.
Nothing in the compiler or the error message tells you that a hook reverting on
`initialize` is an address-bits problem.

For tests we used `deployCodeTo` at a hand-built address:

```solidity
uint160 FLAGS = uint160(0x88); // beforeSwap | beforeSwapReturnDelta
address hookAddr = address(uint160(0x4444 << 144) | FLAGS);
deployCodeTo("Tap.sol:Tap", abi.encode(PM, router, lens), hookAddr);
```

Working that out took a while. Production needs `HookMiner`, which is a separate
concept again.

**Suggestion:** a one-page "hook address cheat sheet" — the flag table, the test
pattern above, and the mining pattern — would collapse hours into minutes. The flag
constants live in `Hooks.sol` but there is no worked example next to them.

### 3. Reading pool liquidity off-chain requires knowing storage internals

To prove our pool holds nothing, the backend reads liquidity from the PoolManager.
There is no view function, so we had to reimplement `StateLibrary` in TypeScript:

```ts
const poolId       = keccak256(encodeAbiParameters(key));
const stateSlot    = keccak256(encodePacked(["bytes32","bytes32"], [poolId, toHex(6n, {size:32})]));
const liquiditySlot = toHex(BigInt(stateSlot) + 3n, { size: 32 });   // POOLS_SLOT=6, LIQUIDITY_OFFSET=3
await poolManager.extsload(liquiditySlot);
```

Getting `encodePacked` vs `encode` right here is a silent-wrong-answer trap: both
produce a valid-looking slot and only one is correct.

**Suggestion:** document the `StateView` periphery contract prominently in the
"reading pool state" docs, with its deployed addresses per chain. We could not find
a canonical Base address for it and fell back to `extsload`.

### 4. Smaller things

- `SwapParams` moved to `types/PoolOperation.sol`; older imports point at
  `IPoolManager.SwapParams` and fail with a confusing error.
- The custom-curve / no-op hook pattern — take, fill externally, settle, return a
  `BeforeSwapDelta` — is the reason many people want v4, and there is no canonical
  minimal example. The sign convention on `toBeforeSwapDelta(specified, unspecified)`
  is the part everyone will get wrong first.

**What worked well:** flash accounting is a genuine pleasure once it clicks —
`take` / `sync` / `settle` made sourcing liquidity from an entirely different
protocol mid-swap feel routine. `PoolSwapTest` is excellent for fork tests.

---

## 1inch Aqua / SwapVM

### 1. `@1inch/swap-vm-sdk` cannot be imported as ESM

```
Cannot find module '.../@1inch/byte-utils/dist/constants'
imported from .../@1inch/swap-vm-sdk/dist/index.mjs
```

`swap-vm-sdk`'s `.mjs` build deep-imports `@1inch/byte-utils/dist/constants`, but
`byte-utils@3.1.8` is CJS-only with no `exports` map, so Node's ESM resolver cannot
follow it. `require()` works; `import` does not. Any Next.js or Vite project hits
this immediately.

**Fix:** add an `exports` map to `@1inch/byte-utils`, or bundle the constants into
`swap-vm-sdk`'s ESM output.

### 2. The KycNFT gate is under-documented in the place people look first

The capability-status page says takers are gated. It is only on the *access* page
that you learn the gate is the Controls opcode `onlyTxOriginTokenBalanceNonZero`,
which the dApp's **assembler embeds into the strategies it ships** — so a maker
writing their own program can simply omit it.

That distinction is the difference between "Aqua is unusable without a KYB
onboarding" and "anyone can build on Aqua today". We nearly abandoned the project
over it.

**Suggestion:** state it on the capability-status page, one line, in bold.

### 3. Docs and package are on different opcode numbering

`OpcodeList.sol` has `XYCSwap = 0x50`, but `AquaXYCAmmStrategy.new().build()` emits
`0x1100` — opcode `0x11` — because the deployed router dispatches from its own
function-pointer table. The docs warn about this, which is good, but the enum is
right there in the repo and reads as authoritative.

**What worked well:** the Aqua documentation is genuinely excellent — the access
model, the coverage formula, and the "known tooling caveats" section saved us days.
A complete Aqua XYC strategy being two bytes (`0x1100`) is a lovely result.
