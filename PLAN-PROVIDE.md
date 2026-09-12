# Bone Dry — the Provide tab, rebuilt (2026-09-12)

**Scope: `web/app/ui/app/Provide.tsx`, `web/app/ui/app/DepthChart.tsx`,
`web/app/api/strategy/route.ts`, and a new `web/lib/encumbrance.ts`.**
Nothing here touches `Landing.tsx`, `Doodle.tsx`, `contracts/`, or `subgraph/`.
`app.module.css` is shared — additive classes only, never re-tune an existing one.

Read §0 before writing a line. The layout complaint that opened this is real but
it is the *smallest* thing wrong with this page.

---

## 0. What is actually wrong

Every item below was read out of the source, not guessed. File:line given so you
can check each one yourself before you touch it.

### 0.1 The page does not ship what it says it ships — **fix this first**

The tab is titled "Encumbered strategy builder". It has a Refusal Ceiling slider,
a Spread Widening slider, a sibling list, and a button reading **"Publish
Encumbered Strategy"**. It sends both parameters to the server:

```ts
// Provide.tsx:222-224
maxUtilBps,
widenBps,
```

`web/app/api/strategy/route.ts` **never reads either one.** Grep it. There is no
`maxUtilBps`, no `widenBps`, no `siblingHashes`, no `declaredTotalEncumbrance`,
and no opcode 35 anywhere in the file. The program it actually builds is:

```ts
// route.ts:117-120
if (feeBps !== 0) builder = builder.flatFeeAmountInXD({ fee: BigInt(feeBps) });
program = builder.xycSwapXD().build();
```

A plain constant-product strategy with no solvency constraint of any kind — that
is, **precisely the unbacked promise this entire project exists to measure and
condemn.** Every slider on the left column is decoration. A maker who drags
Refusal Ceiling to 50% and publishes gets a strategy that refuses nothing.

This is not a UI bug. It is the product's central claim not being true on its own
maker surface, and it is the first thing a judge who reads the code will find.
It outranks every other item in this document.

### 0.2 Oracle Spread reads a function that doesn't exist, at an address that doesn't exist

```ts
// Provide.tsx:67
const BEACON_STRATEGY: Address = "0x7890123456789012345678901234567890123456";
// Provide.tsx:70-74
name: "fixedSpreadBps",
outputs: [{ name: "", type: "uint16" }],
```

Three separate errors:

- `0x7890…3456` is a keyboard-walk placeholder. The real BeaconStrategy is
  `0x1cAD1eCa368940F91b43B25Db0e3E9B32B46fFe7`, and it is already written down
  in `route.ts:31`.
- The function is not `fixedSpreadBps`. `BeaconStrategy.sol:60` declares
  `uint256 public immutable spreadBps`.
- So the call always throws, always lands in the catch, and always renders the
  hardcoded fallback:

```ts
// Provide.tsx:88
.catch(() => { if (active) setBeaconSpreadBps(50); });
```

The **"50 bps (0.50%)"** the user sees under "fixed spread" is a made-up number
that has never touched the chain. That is the "Oracle spread is not working"
the user reported, and the cause is worse than the symptom.

Two further problems in the same feature: the toggle is offered on every network
and every pair, but `route.ts:82-92` rejects anything that is not **Base Sepolia
WETH/USDC** — so on Base mainnet the user configures a whole strategy and is
refused at signing time. And the catch-all fallback means a *genuine* RPC outage
is indistinguishable from a correct read.

### 0.3 The exposure card measures the wrong token, and the wrong quantity

`Encumbrance.sol:193-195` — the only definition that matters:

```solidity
uint256 balOut   = IERC20(ctx.query.tokenOut).balanceOf(ctx.query.maker);
uint256 allowOut = IERC20(ctx.query.tokenOut).allowance(ctx.query.maker, address(aqua));
uint256 backing  = Math.min(balOut, allowOut);
```

Backing is **tokenOut**, and it is **min(balance, allowance)**.

`Provide.tsx:125-137` looks up `tokenInPos` — the **tokenIn** position — and
takes `held` alone, ignoring allowance entirely. So "Wallet Backing", "Free
Capacity", "Current Utilization", the progress bar, and the live dot on the
chart are all computed on the wrong side of the pair, from a quantity the
contract does not use.

A maker holding 10 WETH with zero Aqua allowance reads as **100% backed** here
and reverts `EncumbranceZeroBacking` on-chain. On this page of all pages, that
is the exact failure mode being sold as solved.

### 0.4 "Exact On-Chain Arithmetic" is not the on-chain arithmetic

`Provide.tsx:1137-1146` renders a `<pre>` block captioned **"Contract
Implementation (§7.1)"**:

```solidity
uint256 utilBps = rawBalance > 0 ? (encumbered * 10_000) / rawBalance : 10_000;
if (utilBps > maxUtilBps) {
    return (0, RefusalReason.EncumbranceExceeded);
}
```

None of that is in the contract. Really:

- the numerator is `declaredTotalEncumbrance`, not a sum named `encumbered`
- the denominator is `min(balanceOf, allowance)`, not `rawBalance`
- the comparison is `util >= maxUtilBps` (`Encumbrance.sol:206`), not `>`
- it **reverts**; there is no `RefusalReason` return type anywhere in the repo

Inventing a code listing and labelling it "exact" is a worse error than having no
listing. Either paste the real lines or delete the card.

### 0.5 The page shows one refusal reason. The contract has four.

```
Encumbrance.sol:191  EncumbranceUnderdeclared(declared, sampled)
Encumbrance.sol:199  EncumbranceZeroBacking()
Encumbrance.sol:207  EncumbranceExceeded(util, maxUtilBps)
Encumbrance.sol:232  EncumbranceInsufficient(amountOut, free)
```

Only `EncumbranceExceeded` — the cliff — appears in the UI. The last one is the
interesting one and is invisible: even *below* the ceiling, a fill is refused if
`amountOut > backing - declaredTotalEncumbrance`. That is a second, lower,
size-dependent ceiling that the chart does not draw and the copy never mentions.

### 0.6 The live-utilisation dot still uses the curve that was deleted

```tsx
// Provide.tsx:958
cy={... TOP_AXIS_Y + Math.pow(currentUtilPct / (maxUtilBps / 100), 1.35) * (widenBps / 10000) * 130 ...}
```

The curve itself was corrected to the contract's linear law in `1440f31`; this
marker was missed. The dot now floats off the line it is supposed to sit on.
Replace with the same expression the path uses:
`TOP_AXIS_Y + ((currentUtilPct / 100) * widenBps / 10000) * 130`.

### 0.7 The depth curve is a gaussian with a hand-picked sigma

```ts
// DepthChart.tsx:110-126
if (preset === "10") return 0.09; ...
const z = Math.log(p / spot) / sigma;
const depth = Math.exp(-0.5 * z * z);
```

This is a bell curve whose width is chosen by which preset button is lit. It is
not `x·y = k`, not indexed maker depth, and not related to any number on the
chain — while the caption calls it "Continuous AMM Liquidity & Depth Curve" and
the strip beneath it says `Invariant: x · y = k`.

Same class of defect as §0.4 and as the solvency curve already fixed: a picture
asserting a maths it does not compute. `web/lib/indexedDepth.ts` exists; real
maker depth for the pair is the honest fill. If that is out of reach, the curve
must be labelled a schematic — not an invariant.

### 0.8 Siblings are not filtered to the token being encumbered

```ts
// Provide.tsx:196-199
return exposure.strategies;   // every strategy this maker has, any token
```

Encumbrance is per-token (`§0.3`). A maker with 4 WETH/USDC strategies and 3
DAI/USDC ones is told they have **7 siblings** and shown the red
`UNDER-CONSTRAINED (7 > 6)` warning, when only 4 are siblings for this pair.
Filter on `strat.sides.some(sd => sd.token === tokenOut.address)`.

### 0.9 Reference deployments are hardcoded to one network, and one of them is not an address

`Provide.tsx:1153-1182` prints a card stamped **"Base Sepolia"** with two fixed
values, regardless of the network selected in the header. On Base mainnet it is
simply wrong — the router there is `0x74195573Fa9bC965667e03319F2C58567d4B96BE`
(`deployments/base.json:7`).

Worse, the row labelled `EncumbranceStrategy 0x7b2e…67e3` is not a contract at
all. It is `encumbranceStrategy.strategyHash` out of
`deployments/base-sepolia.json:11` — a **bytes32 strategy hash**, presented in a
list of contract addresses with a copy button. Anyone who pastes it into a block
explorer gets nothing.

### 0.10 The spot price falls back to a hardcoded number under a "live" indicator

```ts
// DepthChart.tsx:71-77
priceData?.spotUsd ?? (WETH ? 2538.33 : USDC ? 1.0 : null)
```

When the feed is unavailable, `2538.33` renders in the same large type, beside
the same `.spotPip` whose `title` reads **"Live Chainlink AggregatorV3 feed"**
(`DepthChart.tsx:196`). A fabricated price wearing a live badge. The empty state
directly below it (`:234-244`) is already written and correct — it is just
unreachable for WETH and USDC.

### 0.11 The scroll, which is what was reported

Right column stacks: hero chart card → formulas card → deployments card. Left
column stacks five cards. Roughly 2,400px of page for one action.

The fat: the range presets are rendered **twice** (`Provide.tsx:528-541` and
again inside `DepthChart.tsx:216-227`, same four buttons, same handler); the
formulas card is a wall of prose whose headline claim is false (§0.4); several
cards carry a paragraph explaining Aqua that the header already says in one line
(`Provide.tsx:339-341`, `418-420`, `1072-1074`).

---

## 1. Work order

Strictly sequential. **Do not start a phase until the one before it is verified.**
`npx tsc --noEmit` clean at the end of every phase, no exceptions.

### Phase 1 — make the button true (§0.1)

The only phase that matters if you run out of time.

1. New `web/lib/encumbrance.ts`, a TS port of `EncumbranceArgsBuilder.build`.
   The wire format is fixed by `Encumbrance.sol:52-79` — match it byte for byte:

   ```
   [0:32]              uint256  declaredTotalEncumbrance   (big-endian)
   [32:34]             uint16   siblingCount
   [34 : 34+32n]       bytes32  siblingHashes[siblingCount]
   [34+32n : 36+32n]   uint16   maxUtilBps
   [36+32n : 38+32n]   uint16   widenBps
   ```

   Throw on `siblingCount > 6` — the same cap `build()` enforces, for the same
   reason (`argsLength` is a `uint8`, so 255 bytes total).

2. `route.ts` accepts `maxUtilBps`, `widenBps`, and `siblingHashes[]`, validates
   them through `uintParam`, and appends the instruction:
   `uint8(35), uint8(args.length), args`. `ShipEncumbranceBase.s.sol:110-113` is
   the working reference — read it before you write this.

3. `declaredTotalEncumbrance` is the sum of the maker's live `tokenOut` claims
   across the siblings being declared. It **must not be under-declared** or the
   swap reverts `EncumbranceUnderdeclared` (`:191`) at fill time, which is the
   silent-failure shape this project exists to remove. Compute it server-side
   from the same `makerBook` the exposure route uses — never trust a client
   number for it.

4. Round-trip test before touching any UI: POST the route, decode the returned
   `programHex`, assert opcode 35 is present and that its args parse back to the
   values sent.

**If any part of this phase cannot be landed, the button text must change** —
"Publish strategy (no encumbrance cap)" — and the two sliders must be disabled
with a visible reason. Shipping a live lie is worse than shipping a smaller
feature. That is the whole thesis of the project.

### Phase 2 — correct the numbers (§0.2, §0.3, §0.6, §0.8)

- Point the Beacon read at `0x1cAD1eCa368940F91b43B25Db0e3E9B32B46fFe7`,
  function `spreadBps`, `uint256`. Export the address from one module; two
  copies is how this drifted.
- On failure show `—` and "could not read spread", never a number. Hide the
  Oracle toggle unless `chainId === 84532` **and** the pair is WETH/USDC, with a
  one-line note saying why — the same condition `route.ts:82-92` enforces.
- Rebuild the exposure card on **tokenOut**, with `backing = min(balance,
  allowance)`. Show both, and call out `allowance < balance` explicitly — a
  maker who has not approved Aqua needs to see that here, not in a revert.
- Fix the §0.6 marker.
- Filter siblings by tokenOut (§0.8).

### Phase 3 — the graphs

Solvency chart (the hero — it is the one thing on this page nothing else does):

- Draw the **second** ceiling from §0.5: shade `amountOut > free` as a distinct
  band. Two refusal boundaries, drawn, is a genuinely novel picture and it is
  currently missing.
- Put the four metric tiles (`:818-850`) in the chart card head as a single
  compact row; they are a 4-column grid inside a column that is already narrow.
- Give it the full card width at ≥1280px, `height: 260` not 200.

Depth chart — pick one and commit:

- **(a)** feed it real indexed depth from `lib/indexedDepth.ts`, or
- **(b)** keep the gaussian, retitle to "Illustrative shape", and delete the
  `Invariant: x · y = k` strip (`DepthChart.tsx:230`).

**(a) is worth real effort** — no competitor draws real Aqua depth. But (b)
shipped honestly beats (a) half-done. What is not allowed is the present state:
invented maths under a truthful-sounding caption.

Also: fix §0.10 — no hardcoded `2538.33`; fall through to the empty state that
is already written. And remove the duplicated presets (§0.11) — keep the pair
inside `DepthChart`, delete `Provide.tsx:524-542`.

### Phase 4 — the scroll and the layout

Left column is the form, right is evidence. Ratio is already right after
`1440f31` (`.colsBuild`, 437px / 752px measured) — **leave `.colsBuild` alone.**

- Collapse the five left cards to three: *Your backing* (exposure + allowance),
  *The promise* (pricing, sizes, fee), *The limits* (both sliders + siblings +
  publish). The publish button goes sticky at the bottom of the column.
- Delete the standalone formulas card. Fold the three correct one-liners into a
  `<details>` under the chart. If the real contract source is pasted, it must be
  copied from `Encumbrance.sol` verbatim with a line reference (§0.4).
- Make the deployments card derive from `deployments/*.json` via `NETWORKS` for
  the active chain, and drop the mislabelled strategy hash (§0.9).
- Delete the three redundant Aqua paragraphs (§0.11). The page header says it
  once; that is enough.

Target: the action fits one screen at 1440×900 with the chart beside it.

### Phase 5 — states

Loading, no-wallet, wrong-chain, read-only Ethereum, zero-allowance, and
>6 siblings. `exposureLoading` is already tracked at `:98` and never rendered —
right now an empty wallet and a loading wallet look identical.

---

## 2. Acceptance — each one is a check you run, not a claim you make

1. POST `/api/strategy` with `maxUtilBps: 5000`; decode `programHex`; **opcode 35
   present and parsing back to 5000.** Paste the decoded bytes in the checkpoint.
2. Oracle Spread shows the value `spreadBps` actually returns on Base Sepolia —
   and `—` when the read fails. Prove the failure path by pointing at a bad
   address once.
3. "Wallet Backing" equals `min(balanceOf, allowance)` of **tokenOut**. Prove it
   against a wallet with allowance < balance.
4. The live dot sits **on** the curve at three different `maxUtilBps` values.
5. Sibling count for a maker with strategies on two pairs shows only this pair's.
6. Deployments card changes when the header network changes.
7. No hardcoded price ever renders beside the live pip.
8. `npx tsc --noEmit` clean. Screenshot at 1440×900 and at 390px.

---

## 3. Do not

- **Do not** write `.tsx` files through `node -e` with escaped template literals.
  That is what produced the truncated writes and the `Use \`{ instead of {`
  errors last round. Use targeted edits, or a heredoc in the Git-Bash shell.
- **Do not** touch `.colsBuild`, `.footerInner`, `--shell`, or the chain
  switcher in `Shell.tsx` — each was fixed once already and each regressed once.
- **Do not** invent a formula, a curve, or a fallback number. Three of the eleven
  defects above are exactly that, and this project's entire pitch is that
  unbacked claims should be refused before they are made. Every number on this
  page must be traceable to a chain read, an index row, or a contract line — or
  it must render as `—`.
- **Do not** report a phase complete without the check from §2 run and its
  output pasted. "Should work" is not a checkpoint.
