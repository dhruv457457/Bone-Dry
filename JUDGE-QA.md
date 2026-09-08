# Bone Dry — answers to the hard questions

Three separate question sets, all converging on roughly the same dozen
concerns. Rather than answer each one individually (a lot of overlap), this
groups them by theme and answers each once, in depth, with file:line
references and measured numbers where the question demands proof rather
than a claim. Where the honest answer is "we haven't solved that yet,"
it says so — a judge who catches an overclaim will trust nothing else in
the doc, so there isn't one here on purpose.

---

## 1. Why does Bone Dry need to exist, if Aqua already has wallet + allowance info?

Because Aqua's own docs say plainly that it can't answer this question
itself. `rawBalances` is keyed `[maker][app][strategyHash][token]` — there
is no way to enumerate it. You cannot ask Aqua "who are the makers on this
pair" or "what does maker X's whole book add up to." 1inch's own docs
recommend building a reference indexer for exactly this reason; none
existed before this project's `Aquifer` subgraph.

Separately — and this is the part that actually matters for a taker,
not just an indexer — even if you *could* enumerate every strategy, a
maker's *virtual* balance (`rawBalances`) is a claim, not a guarantee.
1inch's own docs on `safeBalances` say it "can report room the wallet no
longer backs," because sibling strategies share one wallet and `pull()`
settles via `transferFrom`, which needs real balance *and* allowance —
two numbers `rawBalances` never looks at. So the gap isn't "Aqua hides
data," it's "Aqua's own accounting is honestly insufficient to answer
'can this maker actually deliver,' by design, because virtual balances
are the whole point of shared liquidity." Bone Dry is the thing that
closes that specific gap, external to Aqua's core, without asking Aqua
to change.

---

## 2. Full execution path, and is any of it atomic

Exact call path for one taker fill, file:line, in order:

```
Taker calls swap() on Wellhead (Wellhead.sol)
  → PoolManager.swap()
    → Tap.beforeSwap()                              Tap.sol:83
      for each candidate maker strategy:
        → Lens.quotableDepth(maker, app, hash, tokenOut)   Tap.sol:111 → Lens.sol:30
          reads Aqua.rawBalances (virtual)                 Lens.sol:35
          reads ERC20.balanceOf(maker)                     Lens.sol:39
          reads ERC20.allowance(maker, aqua)                Lens.sol:40
          returns min(virtual, wallet, allowance)           Lens.sol:42-44
      → PoolManager.take() pulls the input token into Tap  Tap.sol:223
      → router.quote() — sanity-check the maker's price     Tap.sol:210
      → router.swap() — the REAL pull, transferFrom from    Tap.sol:230
        the maker's wallet via Aqua, in a try/catch
      → PoolManager.settle() both legs                      Tap.sol:169-175
    ← returns the delta to PoolManager
  ← taker's swap completes
```

**Is any of it atomic?** All of it. `beforeSwap` is one function call,
invoked by `PoolManager` as part of one transaction. The `quotableDepth`
read at line 111 and the actual `router.swap()` pull at line 230 happen
in the same call frame, a few dozen lines of Solidity apart, not across
two transactions or an off-chain step feeding an on-chain one. There is
no window between "we checked" and "we pulled" for anything external to
happen in — nothing else can execute inside that gap except a reentrant
call *from this same transaction*, which is exactly what the `try/catch`
around `router.swap()` (Tap.sol:230) exists to handle: if that call
fails for any reason (including a maker's state having somehow changed),
that maker is skipped (`MakerSkipped`) and their slice is redistributed
to the other makers in the same pass — the trade doesn't revert, and it
doesn't silently under-deliver either.

---

## 3. Prove the solvency check can't go stale between validation and execution

This is the single most repeated question across all three sets, so:
the check and the pull are not two events with a gap — they are two
statements in the same function, in the same transaction, separated by
nothing that can be interrupted. There is no "T0/T1/T2/T3" with room for
an external actor to act in the middle, because Ethereum transactions
don't have a middle a third party can reach into. The only way state
changes between line 111 and line 230 is if the *maker's own contract*
calls back into this transaction (reentrancy) — and the `try/catch`
around the real pull means even that degrades to "this maker gets
skipped," not "the taker gets a bad fill."

If you want it demonstrated rather than argued: `contracts/test/
TapFill.t.sol`'s `test_insolventMakerIsSkipped_notReverted` and
`test_dustAcrossManyMakers_fillsOrRevertsButNeverCharges` are exactly
this — a maker with promised-but-unbacked liquidity, in the same routing
pass as solvent makers, and the insolvent one contributes nothing while
the solvent ones fill normally, same transaction, real balance changes
on both sides, no mocks.

---

## 4. Can a malicious maker bypass Bone Dry?

Going through the actual list of attack vectors asked about:

- **Change allowance / transfer tokens away mid-block** — covered above;
  there's no exploitable window because check and pull are the same
  transaction.
- **Manipulate the virtual amount** — `rawBalances` comes from Aqua
  itself via `ship()`/`dock()`; Bone Dry reads it, doesn't write it. A
  maker inflating their own virtual balance just makes `quotableDepth`
  clamp harder against their real wallet/allowance — it doesn't help them.
- **Manipulate an oracle** — relevant only to `BeaconStrategy`, see §7.
- **Manipulate routing** — the router API (`web/lib/router.ts`) picks
  routes off real depth reads, not maker-supplied claims; a maker can't
  advertise fake depth to get routed preferentially, because depth is
  computed by Lens reading their real state, not by trusting what they say.
- **Weird ERC-20 (fee-on-transfer, rebasing)** — **honest gap, not
  handled today.** `quotableDepth` compares raw `balanceOf`/`allowance`
  numbers; nothing here accounts for a token that delivers less than the
  transferred amount, or whose balance changes without a transfer. This
  hasn't been stress-tested against either. Worth stating plainly rather
  than pretending it's covered.
- **Reentrancy / callback (ERC-777-style)** — the deployed
  `AquaSwapVMRouter` guards reentrancy with transient storage (see
  `contracts/foundry.toml`'s own comment on why `evm_version = "cancun"`
  is required); Bone Dry inherits that protection rather than re-adding
  it, since the router is what actually moves tokens.
- **Griefing via fake liquidity → forced reverts** — can't grief the
  *router* this way: a maker can't cause a revert Bone Dry didn't already
  guard against, because `_fill`'s `try/catch` (Tap.sol:210, :230) means
  one maker's quote or swap failing costs that maker their slice, not the
  whole transaction. The taker's swap only reverts if *no* maker can
  deliver anything (`NoSolventMaker`), which is the correct behavior, not
  a griefing vector.

**Trust assumptions, stated plainly**: Bone Dry trusts the deployed
1inch Aqua and SwapVM router contracts to behave as documented (their
`rawBalances` accounting, their `pull()`/`transferFrom` semantics, their
reentrancy guard). It trusts standard ERC-20 semantics — exotic tokens
are an open gap, not a solved problem. It does not trust any individual
maker.

---

## 5. Why v4 at all — and why an external hook instead of a SwapVM opcode?

This is a real architectural choice, not an oversight, and the reason
is specific: **a SwapVM opcode lives inside a maker's own strategy
program.** A maker has to choose to include it when they build their
program (via `AquaProgramBuilder`, at ship time). That means an
opcode-based solvency guard — the approach at least one other team in
this hackathon (`overdraft`'s `SolvencyGuard`) has taken — only protects
takers against makers who specifically adopted that opcode. Every Aqua
maker who already shipped a strategy before such an opcode existed, or
who simply never adds it, is exactly as unverified to that system as to
raw Aqua.

Bone Dry's design goal is the opposite: protect a taker against *any*
existing Aqua maker, with zero cooperation required from that maker.
The only place that check can live is on the *taker's* side of the
trade — which means the router, not the maker's program. Uniswap v4's
hook system is what makes "run untrusted verification logic on every
swap, at the protocol level, without the maker's consent" possible in a
composable way. Without v4 (or something functionally equivalent), you'd
need a bespoke router contract every taker has to know about and choose
to use — v4 makes it a property of the *pool*, not an opt-in taker
behavior.

**What v4 alone (without Aqua) gives you**: nothing here — a v4 hook
with no Aqua integration is just a hook. **What Aqua alone (without v4)
gives you**: `Lens.sol` itself, fully functional and useful on its own —
see §11.

---

## 6. What's official Aqua/SwapVM, and what did this project add?

Stated plainly, boundary by boundary:

| Contract | Whose | What |
|---|---|---|
| Aqua core, `AquaSwapVMRouter` | **1inch's**, unmodified | Deployed from tag `v1.0.2` on Base Sepolia (1inch never put Aqua on a testnet — see `deployments/base-sepolia.json`); real, existing deployment on Base mainnet |
| `Lens.sol` | **Ours** | New contract, reads Aqua's public state, writes nothing |
| `Tap.sol` | **Ours** | Uniswap v4 hook, CREATE2-mined for `BEFORE_SWAP` permissions |
| `Wellhead.sol` | **Ours** | Thin router a wallet calls to initiate a swap |
| `BeaconStrategy.sol` | **Ours** | A maker strategy contract, external to the router, dispatched *by* SwapVM's real opcode `0x20` |
| SwapVM opcodes actually used | **1inch's, unmodified** | `0x11` (`xycSwapXD`, default pricing), `0x14` (`salt`), `0x15` (`flatFeeAmountInXD`), `0x20` (`Extruction`) — 4 of the ~19 non-empty opcodes in the deployed Aqua instruction set |

**Did we modify SwapVM itself?** No — and that's deliberate, not a
missed opportunity. `Extruction` (opcode `0x20`) is 1inch's own
extension point specifically *for* delegating pricing logic to an
external contract without touching the VM. `BeaconStrategy.sol` is that
external contract: it implements `IExtruction`/`IStaticExtruction`,
deployed at `0x1cAD1eCa368940F91b43B25Db0e3E9B32B46fFe7` on Base Sepolia,
and prices swaps off a live Chainlink oracle instead of the built-in XYC
curve. This *is* genuine SwapVM-level work — using the VM's real
extensibility mechanism to add a pricing model 1inch didn't ship — it's
just not a patch to the VM's core opcode dispatch, which the project
deliberately avoided touching (a forked, opcode-renumbered VM is a real
risk this project already hit once — see `FEEDBACK.md` on why `main`'s
opcode table doesn't match the deployed router's).

A real maker shipped through `BeaconStrategy` and a real taker filled
it, on-chain, on Base Sepolia:

```
ship tx : 0x70a3aef07a3b894c1e09fefec7861825e5acc4ab60fc3981a33a5391b2a257a3
swap tx : 0x8096393361f006fa3f1d054c7b2262295c3e6551fa11075787941064d3d2f252
```

Also worth stating: getting this deployment right required catching a
real mistake — the first `BeaconStrategy` deployment used a
`SwapRegisters` struct copied from `1inch/swap-vm`'s `main` branch,
which turned out to already be ahead of what the deployed router was
actually compiled from (an extra `amountNetPulled` field). That mismatch
changed the ABI selector, so the router could never reach it — every
call silently reverted. Caught by decoding the router's own verified
Sourcify source directly, not by trusting the git branch. Full story in
`contracts/src/interfaces/IExtruction.sol`'s own comments.

---

## 7. The oracle-priced (Extruction) strategy, in detail

**Mechanics**: `BeaconStrategy.extruction()` is called by the router
mid-swap (both the static/quote path via `IStaticExtruction` and the
real/swap path via `IExtruction` — same function, `view`, so it's
callable either way and structurally guaranteed to return identical
results for both, not just "supposed to"). It reads two Chainlink feeds
(one per token in the pair), computes each token's USD price normalized
to 18 decimals, and prices the swap at that ratio minus a fixed 20bps
spread — set once, at deploy time, no admin key to change it later.

**Is the oracle used for quoting, solvency, or both?** Quoting only.
`BeaconStrategy` has no opinion on solvency — that's still entirely
`Lens.sol`'s job, unchanged regardless of which pricing opcode a
maker's strategy uses. The two concerns are cleanly separate: Extruction
picks the *price*, Lens/Tap decide whether the maker can *deliver* it.

**Staleness**: `_priceUsdE18` reverts (`StalePrice`) if
`block.timestamp - updatedAt > 90_000` seconds (25 hours — matches
`web/lib/oracle.ts`'s own staleness bound exactly, so on-chain and
off-chain agree). A stale price fails the swap for that maker rather
than pricing off bad data.

**Manipulation resistance**: this relies on Chainlink's own oracle
security, same as any Chainlink-fed contract — Bone Dry doesn't add or
subtract from that. What it does add: the contract is fully immutable
and stateless (verified structurally, not just by inspection — see
`contracts/test/BeaconStrategy.t.sol`'s `test_NoStorageWritesDuringExecution`,
which uses `vm.accesses()` to prove zero SSTOREs happen during a real
call, and `test_StaticCallAndCallReturnIdenticalBytes`, which calls the
deployed contract both ways and diffs the raw returned bytes). There is
no admin key, no upgrade path, nothing to compromise except the
Chainlink feed itself.

**Rounding direction**: two sequential divisions (value-in, then
value-out), not one combined fraction — documented in the contract as a
deliberate overflow-safety tradeoff over a single higher-precision
division. This costs a few wei of rounding, the same tradeoff any
fixed-point on-chain price math makes; it is not currently proven to
favor one side over the other by convention (SwapVM's own core
invariants around exact-in/exact-out rounding direction weren't
specifically audited against this contract) — another honest gap worth
a closer pass if this becomes safety-critical beyond a hackathon demo.

**Why does this need Aqua at all, vs. a normal smart contract?** Because
the *distribution* mechanism — a maker's tokens staying in their own
wallet, multiple strategies sharing one balance, a taker routing across
several makers pro-rata — is Aqua's whole value proposition, and
Extruction is how a maker plugs custom pricing into that distribution
mechanism without leaving it. A standalone oracle-priced contract could
price a swap; it couldn't do so while also participating in Aqua's
shared-liquidity model.

---

## 8. Gas overhead — measured, not estimated

`contracts/test/GasBench.t.sol` isolates exactly this:

```
quotableDepth, one maker: 3,397 gas
```

Three external calls per maker checked (`rawBalances`, `balanceOf`,
`allowance`). For a route considering N candidate makers, that's
roughly `3,400 × N` gas of pure solvency-check overhead before any
tokens move — a few thousand gas per maker in a routing decision that,
per the same test suite, costs 900k-2.6M gas end-to-end depending on how
many makers actually get filled (`test_poolHasNoLiquidity_butSwapStillFills`:
928,971 gas single-maker; `test_splittingAcrossThreeMakers_beatsOne`:
2,622,616 gas three-maker). The solvency check is a small fraction of
total swap cost, not the dominant cost — most of the gas is the actual
token transfers and Aqua's own `pull()` accounting, which any Aqua fill
pays regardless of Bone Dry's involvement.

---

## 9. Economic incentive — why would anyone use this?

**For a maker**: nothing changes about how they operate — they ship a
normal Aqua strategy the same way they always would; Bone Dry never asks
them to register, opt in, or change anything. The benefit is indirect
but real: takers routing through a solvency-aware router send flow
disproportionately to makers who can actually back their claims, which
means an honest, well-backed maker gets *more* real fill volume relative
to a phantom-liquidity maker sharing the same nominal pool — Bone Dry's
routing literally deprioritizes and skips undercollateralized makers,
which is a direct advantage to a maker who keeps their wallet honestly
funded.

**For a taker**: the alternative is routing blind — sending a swap to
Aqua's advertised depth and finding out at settlement time whether it
was real. Bone Dry's coverage check happens *before* the swap is placed,
so a taker gets routed only to makers who can currently deliver, instead
of discovering a revert (or a partial fill against a pool this design
explicitly treats as all-or-nothing, see `Tap.sol`'s comment on why a
partial fill would brick the pool) after the fact.

---

## 10. A concrete "without Bone Dry" scenario, with real numbers

Not hypothetical — this is what `contracts/script/Seed.s.sol` actually
seeds, and what the deployed test fixture demonstrates:

```
Maker 0: claims 3 ETH worth of WETH, wallet actually holds 3 ETH  (fully backed)
Maker 1: claims 3 ETH worth of WETH, wallet actually holds 2 ETH  (partially backed)
Maker 2: claims 3 ETH worth of WETH, wallet actually holds 0 ETH  (phantom — never funded)
```

All three makers advertise the *identical* virtual balance — that's
allowed, even expected, under Aqua's shared-liquidity model. A router
that trusts `rawBalances` alone sees 9 ETH of advertised depth across
three makers. Real backing: 5 ETH.

**Without Bone Dry**: a taker routing a swap sized against the
advertised 9 ETH either gets a revert deep in `pull()` when maker 2's
`transferFrom` fails (wasted gas, no fill), or a naive router silently
routes a slice to maker 2 and that slice contributes nothing, degrading
the whole fill without the taker necessarily knowing which maker was the
problem.

**With Bone Dry**: `quotableDepth` reads maker 2's real wallet balance
and clamps their depth to 0 before routing ever happens. The taker's
swap is sized and routed only against the real 5 ETH, split pro-rata
across makers 0 and 1 by their actual coverage — verified live on Base
Sepolia (README's "Live on Base Sepolia" section): 5 USDC split
three-to-two matching the two solvent makers' real deliverable depths,
the third maker skipped, costing the taker nothing.

---

## 11. Minimum viable version — what survives if you remove v4, oracle, UI, everything

`Lens.sol` alone. Three view functions (`quotableDepth`, `coverage`,
`quotableDepthBatch`), no dependencies beyond Aqua's own interface,
callable by literally anything — another AMM, an off-chain router, a
different hook entirely, a wallet's own pre-trade check. That's the
actual invention: an external, permissionless, protocol-agnostic
solvency oracle for Aqua's shared liquidity, expressed as ~50 lines of
Solidity with no state and no admin. Uniswap v4's `Tap.sol` is the
*demonstration* that this primitive is real enforcement, not just
observation — proven by an actual pool that fills real swaps using it —
but the reusable artifact is the Lens contract itself.

This also answers "why isn't this just an indexer + frontend": an
indexer *observes* that liquidity is unbacked and reports it after the
fact (which is what `Aquifer`, the subgraph, does — and does honestly,
it's not claiming to be more than an index). `Lens` + `Tap` *enforce* it
— an insolvent maker gets zero routing weight before a taker's funds are
ever at risk, not a dashboard entry after the fact. Both exist in this
project; they're not the same thing, and the distinction is the whole
point.

---

## 12. Git history

Real commit-by-commit history exists for every piece named above —
`Lens.sol`, `Tap.sol`, the Aqua integration, `BeaconStrategy.sol`, all
landed across dozens of separate, dated commits over the build window,
not a single final-day dump. `git log --oneline` in this repo shows the
actual sequence, including commits that found and fixed real bugs along
the way (a URL-param regression, a hydration race in token icons, the
`Extruction` ABI mismatch above, a Pinax API pagination limit) rather
than a clean, suspiciously linear history.

---

## 13. Honest limitations — what we'd fix with another week

Stated without hedging, because a judge asking this wants to know we
know, not to hear "there aren't any":

1. **Exotic ERC-20 support** (fee-on-transfer, rebasing) is a real,
   unaddressed gap — see §4. Would need explicit balance-delta
   accounting around every transfer, not just trusting the nominal
   amount.
2. **`BeaconStrategy`'s rounding-direction convention** against SwapVM's
   own core invariants hasn't been specifically audited (§7) — worth a
   dedicated pass, especially before any real capital touches it.
3. **`BeaconStrategy` is Base Sepolia only, one fixed pair (WETH/USDC),
   one fixed spread.** A more general version would take the pair and
   spread as ship-time parameters per maker rather than one deployed
   instance per pair.
4. **No mainnet deployment of `Tap`/`Wellhead`/`Lens` yet** — mainnet
   reads (coverage, the subgraph) are real and live; mainnet *execution*
   through this project's own pool is not yet deployed as of this
   writing.
5. **No formal audit.** `Halmos`/symbolic verification hasn't been run
   against `Tap.sol`'s settlement path the way at least one other team
   in this hackathon has done for their own core patch — a fair, direct
   comparison point worth being honest about rather than avoiding.
