# Bone Dry — closing both tracks' literal requirements

Two tracks have gaps against their own written qualification criteria. This
plan closes both. It also corrects a mistake I made earlier in this project
that is still sitting in this file's git history.

---

## 0. Correction, read first

An earlier version of this plan stated, as a hard rule, that the SwapVM
`Extruction` opcode does not exist at tag `v1.0.2` (the version our router
is built from) and must not be used. **That was wrong.**

The cause was a typo in a search pattern: `extrud` (as in "extrude") instead
of `extruc` — the identifier is `Extruc**t**ion`. The grep returned nothing
and the false negative was reported as a verified fact.

Verified now, three ways:
- `https://raw.githubusercontent.com/1inch/swap-vm/v1.0.2/src/instructions/Extruction.sol` → HTTP 200
- `v1.0.2`'s `AquaOpcodes.sol` imports it, inherits it, and dispatches it
- Its opcode number is **`0x20`**, cross-checked against three opcode values
  this project has independently generated and proven live (`0x11` XYCSwap,
  `0x14` salt, `0x15` flatFee — all match the same table)

If anything in this repo's history contradicts the above, this section wins.

---

## 1. What each track literally requires, and where we stand

### 1inch — Build an Aqua App

| Requirement | Status |
|---|---|
| Official Aqua/SwapVM contracts used | met |
| Onchain token transfers demonstrated | met, beyond (real testnet, not a fork) |
| Proper git history | met (17/38/24 commits across three days) |
| Demonstrated via tests, scripts or UI | met, all three |
| "Sophisticated DeFi position" | **weak** — our strategies are plain XYC + salt + fee |
| "Define your own instructions" | **not claimed** |

### The Graph — Composable or Standardized

| Requirement | Status |
|---|---|
| Consume live data from a Graph provider | met |
| Public repo | met |
| **Compose 2+ Graph products, OR build on a standardized schema** | **NOT MET** |
| "Simply querying one Subgraph… does not qualify" | **this describes us today** |
| Show what became easier because of the shared schema | not written anywhere |
| Demo video (2-4 min) | outstanding, not yours |

Task 1 below is the only item in this plan that closes a **pass/fail**
requirement. Do it first, and do not start anything else until it is
verified working.

---

## 2. Hard rules (unchanged, and one addition)

1. **Never `git add -A` or `git add .`.** Exact paths only.
2. **Do not touch:** `web/app/ui/Landing.tsx`, `landing.module.css`,
   `Doodle.tsx`, `useIsomorphicLayoutEffect.ts`, `web/app/page.tsx`.
3. **Ask before touching:** `web/app/layout.tsx`, `globals.css`,
   `Motion.tsx`, `Web3.tsx`.
4. **Do not touch `contracts/src/Tap.sol`, its address, or the hook-mining
   logic in `Deploy.s.sol`.** Changing Tap's bytecode changes its mined
   address, which orphans every pool already initialised against it.
5. **Tasks 3 and 4 are contracts work and are NOT yours** — they are listed
   here so you understand the whole shape, but do not start them. If you
   finish Tasks 1 and 2, stop and report.
6. **Verify, then report.** Actual command output, not descriptions.
7. Commit per task, exact paths, trailer:
   `Co-Authored-By: Antigravity <noreply@google.com>`
8. **Unsure whether something is in scope? It is not.** Ask.

---

## Task 1 — Token API: a second Graph product (THE priority)

**Goal:** the Graph track requires composing two or more of The Graph's
products. We use exactly one (our subgraph). This adds a second — The
Graph's **Token API** — for the balance reads that currently go out as raw
`eth_call` multicalls.

This is not box-ticking. It genuinely removes work: `/api/exposure`
currently does a 3-call multicall per position (`balanceOf`, `allowance`,
`decimals`) against a rate-limited public RPC, which is the slowest part of
that route.

### Before writing code

The Token API needs an account and a bearer token. Check with me before
signing anything up — the key goes in `web/.env.local` as
`TOKEN_API_KEY`, server-side only, **never** `NEXT_PUBLIC_`.

Then verify the endpoint yourself before building on it, the same way every
Chainlink address in this repo was verified — a real request, real
response, pasted into your report. Do not take the docs' word for the URL
shape. Two candidate hosts appear in The Graph's own docs and its
provider's docs; confirm which one actually answers:
```
https://token-api.thegraph.com/v1/evm/balances?network=base&address=0x...
https://api.pinax.network/v1/evm/balances?network=base&address=0x...
```
Report which worked, the exact response shape, and **whether Base Sepolia
is supported at all** (I expect not — plan for that, see below).

### What to build

New file `web/lib/tokenApi.ts`:
- `tokenBalances(n: Network, holder: Address): Promise<Map<string, bigint> | null>`
- Returns `null` — not a throw, not an empty map — when the API key is
  missing, the network is unsupported, or the call fails. `null` means "this
  source could not answer", which the caller must be able to distinguish
  from "this wallet holds nothing".
- Key it by lowercase token address, matching every other address-keyed
  lookup in this codebase.

Then in `web/app/api/exposure/route.ts`:
- Try Token API first for `balanceOf`.
- Fall back to the existing multicall path when it returns `null`.
- **Keep the `allowance` reads on RPC regardless** — allowance is not a
  balance and the Token API does not serve it. This is the honest split:
  Token API for balances, RPC for allowance, subgraph for commitments.
- Add a `sources` field to the response naming which source answered each
  part, e.g.
  `{ balances: "token-api" | "rpc", commitments: "subgraph", allowances: "rpc" }`.
  This is what makes the composition **visible** rather than a claim — the
  track explicitly asks you to "show what became easier".

### Verification

1. `npx tsc --noEmit` clean.
2. `curl /api/exposure?chain=8453&maker=0x181b8E10c8ffE94984964904908C312aB3CF380b`
   — paste the full response. `sources.balances` must read `token-api`.
3. Same call with `TOKEN_API_KEY` temporarily unset — must still return
   correct data with `sources.balances: "rpc"`. **Test this explicitly.**
   A composition that breaks the app when one source is down is worse than
   not composing.
4. `curl /api/exposure?chain=84532&maker=...` — Sepolia. Must not error.
5. Compare a balance from Token API against the same balance read via
   `cast call ... "balanceOf(address)"`. They must match exactly. Paste both.

### Commit
```
git add web/lib/tokenApi.ts web/app/api/exposure/route.ts web/app/ui/types.ts
git commit -m "Read balances from The Graph's Token API, with an RPC fallback"
```

---

## Task 2 — Make the composition and the standard visible

**Goal:** the track asks you to "make the standards leverage clear: show
what became easier". Right now nothing in the repo or UI says this.

### What to build

**2a. A `sources` line in the UI.** On the Portfolio and `/app/lookup`
views, under the exposure table, one quiet line naming where each number
came from, e.g.:
> Commitments from the Aquifer subgraph · balances from The Graph Token API · allowances from RPC

Use the `.label` class. This is not decoration — it is the evidence for the
composition claim, and it is honest about the fallback (if
`sources.balances` came back `rpc`, say `rpc`, not `token-api`).

**2b. `subgraph/STANDARD.md`.** The schema header already claims to be "a
reusable schema any Aqua app can adopt". Promote that from a comment to a
document:
- The entities and what each field means
- The join key (`Swapped.orderHash == Shipped.strategyHash`, per 1inch's docs)
- **The evidence it generalises**: `/api/apps` shows this one schema
  indexing two independent Aqua apps on Base mainnet today — 1inch's own
  router and one unrelated app — because it indexes Aqua's contract events
  rather than filtering to one app. Include the live numbers and how to
  re-run the query.
- What another Aqua app would have to do to adopt it (short — change the
  network and start block, nothing else)

**2c. A "Standards leverage" section in `README.md`** — three or four
sentences, concrete: one schema covers every Aqua app rather than one per
app; adding Token API for balances required no change to position-tracking
because commitments and balances are separate concerns in the schema.

### Verification

1. Screenshot the sources line on Portfolio with a connected wallet.
2. Screenshot it on `/app/lookup` after a real lookup.
3. Confirm the line changes to `rpc` when the Token API key is unset —
   screenshot that too.
4. Paste the `/api/apps?chain=8453` output you cite in `STANDARD.md`.

### Commit
```
git add web/app/ui/Exposure.tsx web/app/app/lookup/page.tsx web/app/ui/desk.module.css subgraph/STANDARD.md README.md
git commit -m "Show which product answered each number, and write the schema down as a standard"
```

**Stop here and report. Tasks 3 and 4 are mine.**

---

## Task 3 (MINE, not Antigravity's) — an Extruction-priced strategy

Closes 1inch's "sophisticated DeFi position" and "define your own
instructions" in one move, **on official unmodified contracts** — no router
fork, no EIP-170 budget, no redeploy of anything already working.

`Extruction` (opcode `0x20`) lets a maker delegate pricing to an external
contract implementing both `IExtruction` (swap path, state-modifying) and
`IStaticExtruction` (quote path, view). A `BeaconStrategy` contract prices
from the Chainlink feed `Beacon.sol` already reads, instead of a constant
product curve — oracle-priced market making, which is a materially more
sophisticated position than XYC + salt + fee.

Encoding is already known and proven from this project's own generated
bytes — `<opcode><arg length><args>`:
```
0x11 00                      XYCSwap, no args
0x14 08 <8-byte salt>        salt
0x15 04 <4-byte fee>         flat fee
0x20 14 <20-byte target>     Extruction, target only     ← new
```
The SDK's `AquaProgramBuilder` has no `extruction()` helper, but
`tools/gen-strategy.cjs` already accepts a raw `PROGRAM` hex override, so
the program can be hand-assembled.

**The hard part, and why this is mine:** `IExtruction` and
`IStaticExtruction` must return identical results for identical inputs, or
quote and swap diverge and fills revert. The contract must be immutable and
deterministic. That is a subtle correctness property, not a coding task.

## Task 4 (MINE) — the Extruction validator

1inch's own `Extruction.sol` documentation says takers **"MUST validate
strategy consistency before execution"**, **"verify target contract is
non-upgradeable"**, and **"review target contract code"** — and ships no
tooling to do any of it.

That is the same shape as the gap this project already exists to close.
Claim one was *"I have the liquidity"* → `Lens`. Claim two is *"my pricing
contract is safe and consistent"* → a validator that, for any strategy
using opcode `0x20`:
- extracts the 20-byte target from the program
- checks it has code, and checks EIP-1967 proxy slots for upgradeability
- calls the static path twice and compares, and compares against a
  simulated swap-path result
- surfaces pass/fail beside the existing solvency badge

This is the natural second instance of the project's own thesis, it is
differentiated from what any other team is building, and it is the strongest
available answer to "why does this project deserve the Aqua prize".

---

## Definition of done for your part

Report per task: files changed, real verification output (responses and
screenshots, not descriptions), and anything you stopped on. Task 1's
fallback test (key unset → `rpc`, still correct) is the one I will check
first, so make sure it is real.
