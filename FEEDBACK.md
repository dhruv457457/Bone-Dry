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

### 4. The SDK and `swap-vm` main are on different opcode tables, and nothing says so

This one cost most of a day, so it is worth spelling out.

1inch have never deployed Aqua to a testnet — `AQUA_CONTRACT_ADDRESSES` lists
sixteen chains and every one is a mainnet. The advice in Discord is to deploy your
own, which works: both repos build cleanly and `AquaRouter` needs one constructor
argument. Aqua, the SwapVM router, and a whole v4 hook stack went onto Base
Sepolia for under 0.0002 ETH of gas.

Then every `quote` reverts.

The reason is that `@1inch/swap-vm-sdk` emits `0x1100` for an XYC strategy —
opcode `0x11` — which is what the routers on mainnet dispatch on. Building from
`main` gets you a router where `XYCSwap` is `0x50`. Same SDK, same repo, an
instruction set that does not match. The failure surfaces as a bare revert inside
`quote`, so from the outside it is indistinguishable from an unfunded maker or a
malformed order, and the natural assumption is that your own strategy encoding is
wrong.

Working out which tag matches the deployment is not obvious either. At `v1.0.2`
the opcodes are a function-pointer jump table whose element 0 is deliberately
overwritten with the array length, so the dispatched opcode is the static index
minus one — `XYCSwap` sits at static 18 and dispatches as `0x11`. On `main` the
same instruction is an enum entry at `0x50` in `src/libs/OpcodeList.sol`. Neither
file mentions the other numbering, and the SDK does not declare which router
version it targets.

Three things would have saved the day:

- A line in the SDK's README naming the `swap-vm` tag its programs are built for.
- A `version()` on the router that a client can compare against, or an opcode-set
  identifier in the EIP-712 domain.
- An `UnknownOpcode(uint8)` revert instead of falling through to a generic one, so
  a mismatch says what it is.

The wider point: telling hackathon teams to self-deploy is generous and it works,
but it silently opts them into whatever `main` looks like that week. A testnet
deployment of Aqua at the canonical address would remove the whole class of
problem.

### 3. Docs and package are on different opcode numbering

`OpcodeList.sol` has `XYCSwap = 0x50`, but `AquaXYCAmmStrategy.new().build()` emits
`0x1100` — opcode `0x11` — because the deployed router dispatches from its own
function-pointer table. The docs warn about this, which is good, but the enum is
right there in the repo and reads as authoritative.

**What worked well:** the Aqua documentation is genuinely excellent — the access
model, the coverage formula, and the "known tooling caveats" section saved us days.
A complete Aqua XYC strategy being two bytes (`0x1100`) is a lovely result.

---

## The Graph

### 1. `graph test` has no Windows binary, and the fallback needs Docker running

```
$ graph test
Error: Failed to get matchstick binary: Unsupported platform: Windows_NT x64 10
Consider using -d flag to run it in Docker instead:
  graph test -d
```

The suggestion is good, but `-d` then needs a running Docker engine, which is a
much larger ask than "run my unit tests" implies — and on a hackathon clock it is
the difference between writing handler tests and not writing them. The error
arrives only after `matchstick-as` is installed and the tests are written, so the
cost is paid before the limitation is discovered.

Worth surfacing on the [unit testing
page](https://thegraph.com/docs/en/subgraphs/developing/creating/unit-testing-framework/)
next to the install instructions rather than at runtime. A note that the Docker
path is the only supported one on Windows would have changed how we sequenced the
work.

### 2. A syncing subgraph is indistinguishable from an empty one

`_meta` reports `block.number` and `hasIndexingErrors`, which is enough to detect
lag — but only if you already know to look. A subgraph that is 2M blocks behind
answers every query truthfully and uselessly: zero rows, no error, no warning.

The natural client shape is `const rows = await fromGraph() ?? await fromRpc()`,
and that is silently wrong, because `[] ?? rpc` is `[]`. We shipped exactly that
bug and only caught it because the first deploy synced while we watched.

Two things would help:

- A `_meta { isSynced }` or `blocksBehind` field, so freshness is one boolean
  rather than a subtraction against a separately fetched chain head.
- A note in the querying docs that results from a syncing subgraph are partial
  rather than empty, with the null-vs-empty distinction spelled out.

### 3. Studio's deploy key and the account API key are easy to confuse

The API Keys page and the subgraph page both show a 32-hex-character secret. Only
the second one works with `graph deploy`, and using the first fails with
`Deploy key not found` — which reads as "your key is wrong" rather than "that is
the other kind of key". Naming the failure (`this looks like a query API key; the
deploy key is on your subgraph's page`) would resolve it instantly.
