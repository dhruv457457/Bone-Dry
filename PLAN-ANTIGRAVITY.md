# Bone Dry — put BeaconStrategy in the actual product, not just the repo

Context: `BeaconStrategy` (a maker strategy priced off Chainlink via SwapVM's
Extruction opcode, `0x20`, instead of the built-in XYC curve) is written,
tested, and **already deployed for real** on Base Sepolia:

```
address:  0xAe91aEea982563F69ff6D8B97043A7a79c77340a
deployTx: 0xdce896e38b6a3516b7f4316ef34539aac98762f8b6515cc936cf79561bbc450b
pair:     WETH (0x4200000000000000000000000000000000000006)
        / USDC (0x036CbD53842c5426634e7929541eC2318f3dCF7e)
spread:   20 bps below oracle mid, fixed at deploy time
```

Also recorded in `contracts/fixtures/beacon-strategy.84532.json`. I called
`extruction()` on it live against the real on-chain Chainlink feed (not a
mock) as part of verifying the deploy: 1 WETH exact-in returned 2,478.72
USDC, real oracle mid minus the spread, computed for real on testnet.

**What's still missing:** nothing in the app knows this contract exists. A
maker can't choose it. This plan wires it into the real "Ship a strategy"
flow that already exists (`ShipStrategy` in `Desk.tsx`, `/api/strategy`) —
not a new page, not a script, the same flow every other maker on this app
already uses.

**What this plan does NOT include:** actually shipping a strategy through
this new option and swapping against it for a real transaction hash. That
needs a funded wallet signing real transactions, which is the same
`contracts/` / broadcasting boundary every plan here has kept off your
plate — I'll do that myself once your part is live, using the exact code
path you build (proving the product code is real, not a separate demo
script).

---

## 0. Hard rules (same as every plan here)

1. **Never `git add -A` or `git add .`.** Exact paths only.
2. **Do not touch:** `web/app/ui/Landing.tsx`, `landing.module.css`,
   `Doodle.tsx`, `useIsomorphicLayoutEffect.ts`, `web/app/page.tsx`.
3. **Ask before touching:** `web/app/layout.tsx`, `globals.css`,
   `Motion.tsx`, `Web3.tsx`.
4. **Do not touch `contracts/` at all**, and do not broadcast any
   transaction from any script. `BeaconStrategy` is already deployed; you
   are only teaching the web app about the address above.
5. **This strategy only exists for one pair, on one chain.** WETH/USDC on
   Base Sepolia (84532) only — there is no mainnet deployment yet, and no
   other pair is supported. The UI must make this a hard constraint, not a
   soft suggestion: hide or disable the option entirely when the connected
   network or selected pair doesn't match, rather than letting a maker
   select it and hit a confusing revert.
6. **Every task ends with real verification.** Actual output pasted, not
   descriptions of what should happen.
7. Commit per task, exact paths, trailer:
   `Co-Authored-By: Antigravity <noreply@google.com>`
8. **Unsure whether something is in scope? It is not.** Ask.

---

## Task 1 — teach `/api/strategy` to build an Extruction-priced program

**The one non-obvious part, read this first:** the SDK's `AquaProgramBuilder`
does NOT have a convenience method for Extruction — `.xycSwapXD()` exists,
`.salt()` exists, `.extruction()` does not, even though opcode `0x20` is in
the Aqua instruction set the deployed router actually dispatches (verified
directly against `@1inch/swap-vm-sdk@0.4.1`'s compiled `aquaInstructions`
array — it's real, just missing a wrapper method). Use the base class's
generic escape hatch instead:

```ts
import { AquaProgramBuilder, Order, MakerTraits, instructions } from "@1inch/swap-vm-sdk";
import { Address as SdkAddress, HexString } from "@1inch/sdk-core";

const { extruction } = instructions;

const BEACON_STRATEGY_ADDRESS = "0xAe91aEea982563F69ff6D8B97043A7a79c77340a"; // Base Sepolia only

const program = new AquaProgramBuilder()
  .add(
    extruction.extruction.createIx(
      new extruction.ExtructionArgs(new SdkAddress(BEACON_STRATEGY_ADDRESS), HexString.EMPTY)
    )
  )
  .build();
```

`ExtructionArgs`' second argument (`extructionArgs`) is per-call data passed
to the target contract — `BeaconStrategy` ignores it entirely (its spread is
fixed at deploy time), so `HexString.EMPTY` is correct, not a placeholder to
fill in later.

### What to change

`web/app/api/strategy/route.ts`:

1. Accept a new optional body field: `pricing: "xyc" | "oracle"`, default
   `"xyc"` — every existing call to this route must keep behaving exactly as
   it does today.
2. When `pricing === "oracle"`:
   - Validate `n.id === 84532`. Anything else is a `BadInput` with a message
     naming the reason (`"BeaconStrategy is only deployed on Base Sepolia"`),
     not a silent fallback to XYC.
   - Validate the pair is WETH/USDC in either direction (compare against
     `n.weth` / `n.usdc`, already available on `Network` — check
     `web/lib/networks.ts` for the exact field names, don't hardcode
     addresses a second time in this file). Anything else is a `BadInput`
     naming the reason.
   - Build the program as shown above instead of calling `.xycSwapXD()`.
     Do NOT also apply `flatFeeAmountInXD` on top even if `feeBps` was sent —
     `BeaconStrategy`'s spread is the only fee this strategy has; layering a
     second, independent fee on top muddies what the strategy is actually
     demonstrating. Ignore `feeBps` when `pricing === "oracle"` (the UI in
     Task 2 will stop sending it in this mode, but the route should not
     trust that alone).
   - `salt()` may still be applied if one was requested — it doesn't affect
     price, only order-hash uniqueness, no reason to block it.
3. The response already includes `programHex` — no change needed there,
   but it's your primary verification tool: decode it and confirm the
   Extruction opcode is really what got encoded (see Verification).

### Verification

1. `npx tsc --noEmit` clean.
2. A real POST to `/api/strategy` with `pricing: "oracle"`, a WETH/USDC
   pair, on chain 84532 — paste the actual JSON response.
3. Decode the returned `programHex` and show the raw bytes: confirm the
   opcode byte is `0x20` (32 decimal) and the following 20 bytes equal
   `0xAe91aEea982563F69ff6D8B97043A7a79c77340a`, case-insensitively. This is
   the load-bearing check — a wrong program silently ships something that
   isn't actually oracle-priced.
4. A real POST with `pricing: "oracle"` but the wrong chain (e.g. 8453) —
   paste the actual 400 response, confirm it's a clear `BadInput`, not a
   500 or a silent XYC fallback.
5. A real POST with `pricing: "oracle"` but a non-WETH/USDC pair — same,
   paste the actual 400 response.
6. Confirm a plain `pricing` omitted (or `"xyc"`) request still returns the
   exact same shape it did before this change — paste it.

### Commit

```
git add web/app/api/strategy/route.ts
git commit -m "Let /api/strategy build an Extruction-priced program for BeaconStrategy"
```

---

## Task 2 — surface it in the real "Ship a strategy" UI

**Goal:** a maker looking at the existing Provide tab can actually choose
this, honestly gated to when it's real.

### What to change

`web/app/ui/Desk.tsx`'s `ShipStrategy` component:

1. Add a pricing selector — two options, "Constant-product curve" (today's
   default XYC behaviour, unchanged) and "Oracle (Chainlink, via Beacon)".
2. The oracle option is only *selectable* when `net.id === 84532` AND the
   current `tokenIn`/`tokenOut` pair is WETH/USDC in either direction.
   Outside that, either hide the second option entirely or show it visibly
   disabled with a one-line reason ("Only available for WETH/USDC on Base
   Sepolia right now") — a maker should never be able to select it and then
   get a confusing error back from the route.
3. When oracle pricing is selected, hide the fee-bps input (or show it
   disabled with a note: "BeaconStrategy charges a fixed 0.20% spread,
   set at deploy — not configurable here") and send `pricing: "oracle"` in
   the POST body instead of the current implicit XYC path.
4. Everything else about the flow (claim amounts, wallet connect, signing,
   the shipped-strategy-hash confirmation) stays exactly as it is today —
   this is a pricing choice, not a new flow.

### Verification

1. `npx tsc --noEmit` clean.
2. Screenshot the Provide tab on Base Sepolia with a WETH/USDC pair
   selected, showing the pricing selector with oracle enabled.
3. Screenshot it again on Base mainnet (or any non-WETH/USDC pair) showing
   the oracle option correctly disabled/hidden.
4. Do not actually click "Ship this strategy" for the oracle option — that
   needs a funded wallet and is the part I'm doing myself next. Stop after
   confirming the UI sends the right request body (check the network tab
   or add a temporary console.log you remove before committing).

### Commit

```
git add web/app/ui/Desk.tsx web/app/ui/desk.module.css
git commit -m "Add an oracle-priced (BeaconStrategy) option to Ship a strategy"
```

---

## What "done" means

After Task 2, a real maker with a real wallet on Base Sepolia can choose
"Oracle (Chainlink, via Beacon)" for a WETH/USDC strategy and get calldata
that actually ships an Extruction-priced position — through the same UI
every other maker on this app uses, not a side script. That closes the
"nothing in the app knows this exists" gap on the product side.

The remaining piece — one real maker actually shipping through this path
and one real swap filling against it, with real transaction hashes — is
mine. I'll do it right after Task 2 lands, and report back with the hashes.
