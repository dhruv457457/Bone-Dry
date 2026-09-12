# Bone Dry — what we claim, against what today proved (2026-09-12)

Not an engineering plan. This is an audit of the **public-facing claims** — `README.md`,
the landing page, `PROOFS.md` — against what was verified on chain today.

It exists because the README was written on 2026-09-11, before we learned that opcode 35
never executes in the product, that no refusal is ever read back, and that every Base swap
reverted until commit `1a0a49a`. Documents written before those findings may now assert
things the code no longer supports.

The stakes are specific. A judge who catches one overclaim stops believing the other
forty, across all three tracks at once. And for a project whose entire subject is promises
made without backing, shipping our own is the one failure we cannot argue our way out of.

**The finding is that the README is wrong in both directions at the same time:** it
overstates the mechanism and understates the deployment. The second is doing us more
damage than the first.

---

## 1. The overclaim that must change before submission

`README.md:133-142`, the numbered walkthrough under the architecture diagram:

> 3. It quotes each candidate maker through **`BoneDryRouter`**.
> 4. **Opcode 35** sums the maker's sibling commitments, reads real backing, and either
>    adjusts the quote or reverts.

**This does not happen in the deployed app.** The live Swap path uses the hook at
`0xeAdD3C76…` (`NEXT_PUBLIC_HOOK_ADDRESS`), and `Tap.router` is `immutable`
(`Tap.sol:42`). Read on chain today:

```
tapLegacy 0xeAdD3C76…  router = 0x111111338c5091E8440b67B168bAe16a668AC0De   (1inch canonical)
tap       0xaC7bCA41…  router = 0x74195573Fa9bC965667e03319F2C58567d4B96BE   (BoneDryRouter)
```

The app uses the first. 1inch's opcode table ends at 34. Steps 3 and 4 describe the second
hook, which nothing routes through — see `PLAN-TWO-BOOKS.md`.

The same passage's step 6 — *"A maker who refused is caught by the hook and logged with
the revert selector"* — is true of `Tap.sol` and false of everything downstream. The
diagram's `LOG["logs → subgraph"]` edge does not exist: the `Tap` data source is a template
nothing instantiates, and the RPC fallback filters the wrong `topic0`. See
`PLAN-GRAPH.md` §0.2 and §0.4.

**Fix, today, without waiting for either plan:** keep the section, retitle it *"The
mechanism, and where it runs"*, and mark steps 3, 4 and 6 as **built and fork-tested;
reachable through the opcode-35 hook, which the app does not yet route to.** That sentence
costs nothing — the work is real, 54 fork tests green — and it converts the single most
dangerous paragraph in the repo into a credible one.

Do **not** delete the section. The mechanism is the best thing here. It just needs to say
where it runs.

---

## 2. The claims that understate us — and cost more than the overclaim

Judges score what you claim. Three places tell them we have not done work we have done.

### 2.1 The status table says BoneDryRouter is not deployed. It is.

`README.md`:

| | State |
|---|---|
| `BoneDryRouter` deployed to a public network | **not yet** |
| Provide-tab encumbrance builder | **not yet** |

Both are now false:

- `BoneDryRouter` has been on Base mainnet since commit `7b3d435` —
  `0x74195573Fa9bC965667e03319F2C58567d4B96BE`, tx `0xd034eb62…`, 19,793 bytes,
  `deployments/base.json`.
- The Provide-tab builder ships opcode 35 as of `e284380`, verified end to end:
  `declaredTotalEncumbrance = 36000000000000`, matching `base.json`'s `totalPromisedWeth`
  exactly.

The table's own preamble is *"A status table that overclaims is worse than none."* The
instinct is right; the table simply went stale in the honest direction.

### 2.2 "Base (8453) — read-only" omits five deployed contracts

The address table lists Aqua, 1inch's router, and the subgraph, and says **read-only,
against canonical Aqua**. Deployed on Base mainnet and verified by bytecode today:

| Contract | Address | Evidence |
|---|---|---|
| `BoneDryRouter` | `0x74195573Fa9bC965667e03319F2C58567d4B96BE` | 19,793 bytes |
| `Tap` (opcode-35 hook) | `0xaC7bCA41EA8Fce76651684943Db2c38003c98088` | 6,158 bytes |
| `Tap` (legacy, in use) | `0xeAdD3C76bB9f3D8Aa26fA9F793A893e2aBa24088` | 5,849 bytes |
| `Lens` | `0xbC7C42DA3a234cAf8d44cbeB440610CDB8790Fd6` | queried live today |
| `Wellhead` | `0xae0188F3b68804847a740C0F7016e1A4E0bB4E64` | every swap calls it |

Plus three live, genuinely backed encumbrance strategies, and two initialised v4 pools
(`0x620f798e…`, `0x33e4c020…`).

Calling that "read-only" is the most costly sentence in the README. Base mainnet is the
strongest thing this project has: a custom SwapVM opcode, a v4 hook, and a real backed
position on a chain judges can open in a block explorer. The document currently hides it.

### 2.3 The Base subgraph row is true but incomplete

"`Aquifer` subgraph on Base — **deployed and synced**" is accurate: 163 active strategies,
≥1000 fills, 358 maker positions, head block 51,220,498, `hasIndexingErrors: false`.

But the deployed build serves six of `schema.graphql`'s eight entities — `MakerRefusal` and
`EncumbranceApplication` are absent from the deployed schema entirely. Add "(v0.0.3 —
predates the encumbrance entities)".

---

## 3. An internal contradiction a careful reader will find

Known limits says:

> **Sepolia's `Tap`** predates a dust-fold fix present on the Base mainnet deployment.

This asserts a Base mainnet `Tap`. The address table two sections earlier says Base is
read-only with no Bone Dry contracts. One of the two is wrong in the same document, and
§2.2 says which.

---

## 4. Claims that survive the audit — leave them alone

Being precise about what is *right* matters as much as what is wrong; over-correcting is
how a good document gets gutted.

| Claim | Status |
|---|---|
| `ship()` writes a number, transfers nothing — with source | verified, quoted from `Aqua.sol` |
| `dock()` costs 4,452 gas, instant and unilateral | `PROOFS.md` P3, fork-measured |
| Pool liquidity is 0, before and after a swap | `/api/pool` returns `"liquidity": "0"` today |
| 257 strategies on one wallet against one token | `COUNCIL-VERDICT.md` |
| "Nothing on Aqua is binding, and nothing here claims otherwise" | true, and the best sentence in the repo |
| 6-sibling cap from `uint8` argsLength | verified — `MAX_INSTRUCTION_SIBLINGS = 6` |
| The >6-sibling under-declaration limit, disclosed | honest, and the `Tap` gate is correctly listed as not built |
| Landing proof strip: 0 / 257 / 4,452 | all three measured |
| Ethereum: "No Bone Dry contracts are deployed here" | true |

`PROOFS.md` comes through clean. Its §83 — *"**Do not claim:** binding commitments,
guaranteed depth"* — is a standing instruction to ourselves that has been followed.

---

## 5. Two numbers that need one line of reconciliation

Not wrong, but a judge will notice and we should answer first.

- **"166 live positions" (app) vs 163 active strategies (subgraph).** Different
  denominators — positions are per maker-token, strategies are per strategy. Say which is
  which wherever both appear.
- **"Base only carries 549 strategies in total" (Known limits) vs 163 active today.**
  Lifetime versus currently-active. Label it, or the smaller number reads as a regression.

---

## 6. The edits, in priority order

1. **§1** — mark steps 3/4/6 as built-and-tested, not live-in-app. *The submission-critical one.*
2. **§2.2** — replace "Base — read-only" with the real five-contract table. *Largest gain for least work.*
3. **§2.1** — flip the two stale "not yet" rows to deployed, with tx hashes.
4. **§3** — resolve the Sepolia/Base `Tap` contradiction.
5. **§2.3** — note the subgraph version.
6. **§5** — label the two denominators.

1 and 2 are an hour together and are worth more than any remaining feature.

---

## 7. The rule this audit implies

The status table was right to exist and went stale in nine days, in both directions.

**A deployment is not finished until the README row changes with it.** Put the row in the
same commit as the deploy. `deployments/base.json` was updated the day `BoneDryRouter`
landed; the README row beside it was not, and that is the whole gap.

This project's argument is that a claim should be checkable against what backs it. That
applies to the claims in our own documentation, and this audit is the first time anyone has
actually run that check.
