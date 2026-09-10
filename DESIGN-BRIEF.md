# Bone Dry — design brief for the `/app` product surface

You are being asked to **design** this, not to implement someone else's design. Nothing below
tells you what it should look like, and that is deliberate. No palette, no typeface, no light/dark
decision, no layout, no component library has been chosen for you. Those are the questions we
want your answer to.

What follows is: what the product is, who looks at it, every screen that exists, every piece of
data each screen has to put on the page, every state each of those pieces can be in, and the
things that are not allowed to change. Design against that.

---

## 1. What the product is

**Bone Dry is a solvency check for a liquidity network that cannot check itself.**

1inch Aqua is a shared-liquidity layer. A market maker keeps their tokens in their own wallet and
publishes "strategies" — standing offers to fill trades — against that wallet. Crucially, **one
wallet can back many strategies at once.** A maker holding 100 USDC can publish five separate
strategies each promising 100 USDC. Aqua records all five promises. Aqua cannot tell you that only
one of them can be honoured.

It cannot tell you because the balance mapping is keyed
`[maker][app][strategyHash][token]` and is **not enumerable** — there is no on-chain way to ask
"list everything this maker has promised." 1inch document this limitation themselves.

Bone Dry does three things about that:

1. **Indexes** every strategy from the registry's events, so the set of promises can be totalled.
2. **Measures** what each promise is actually worth right now:
   `deliverable = min(promised amount, wallet balance, token allowance)`.
   The gap between the promise and that number is the **shortfall**.
3. **Trades on it.** A Uniswap v4 pool that holds zero liquidity of its own intercepts every swap
   and fills it out of Aqua makers' wallets — routing only to makers that pass the solvency check,
   and skipping the rest rather than failing the trade.

The finished sentence the product exists to say, with a live number in it, is:

> *"79 of 142 real maker positions on Base can't deliver what they promised, right now."*

Everything on the screen is either that claim, the evidence under it, or the trade that proves it
is actionable. **If a design decision makes that sentence harder to find or harder to believe, it
is the wrong decision.**

## 2. Who is looking at it

Two audiences, and they want opposite things from the same pixels.

**Hackathon judges** (this is a competition entry — 1inch, Uniswap Foundation, and The Graph
tracks). They will spend somewhere between ninety seconds and five minutes, will probably not
connect a wallet, and are comparing this against a dozen other entries in the same hour. They need
to understand what is novel here and see proof it is real, fast, without reading.

**Actual DeFi users** — someone about to swap, or a maker deciding whether to publish liquidity.
They want a fast, legible, trustworthy trading surface and do not care about the competition at
all.

The current build serves neither well. It reads like a research paper that happens to have inputs
in it.

## 3. The specific failure to design your way out of

The honest self-assessment: the app is *dense, accurate, and undifferentiated*. Every number on it
is real and hard-won, and it all arrives at the same visual volume — a wall of small monospace
figures in near-identical tables. A reader cannot tell, without reading every cell, which numbers
are the point and which are supporting evidence.

There are five tables on this product. Four of them are *variations on the same idea* (promised vs.
actually-backed, at different scopes: per-strategy, per-maker, per-wallet, per-app). A reader who
has understood one has understood all four, but the current design gives them no way to notice
that. Making that family resemblance visible — so the fourth table is instantly readable because
the first one taught it — is a large part of this job.

Second failure: **the product's headline claim is a number that changes, and the interface does
not behave like anything is live.** Data arrives asynchronously from several sources at different
speeds; right now that appears as text swapping in place.

Third failure: **there is no on-ramp.** A visitor arrives mid-conversation with no idea what Aqua
is, what a "maker" is, or why an unbacked promise matters. They are handed a swap form and four
tables.

## 4. Hard constraints

These are settled. Design around them.

- **The marketing landing page at `/` is finished and is not in scope.** It has a deliberate,
  spare, editorial look with a hand-drawn animated hero, and it does not change. You are designing
  everything *behind* it. It is fine — arguably good — if the product surface does not look like
  the landing page, but the two have to be recognisably the same company.
- **Nothing may be faked, ever.** Not a placeholder chart line, not a plausible-looking maker row,
  not a fabricated APY. This product's entire argument is that it tells you the uncomfortable truth
  about someone else's numbers; a single invented pixel destroys it. Where data is absent, the
  design must have an honest empty state that says *why* it is absent. **Empty and error states are
  not an afterthought here — they are a feature, and you should design them first, not last.**
- **Two networks, and they are not equivalent.** Base mainnet has real 1inch Aqua makers but no
  Bone Dry contracts deployed, so it is *read-only*: real evidence, no trading. Base Sepolia has
  our own full deployment and free test tokens, so it is *fully interactive* but the makers on it
  are ours. The design has to make this distinction obvious and unembarrassing, because a visitor
  who lands on the read-only network and finds a dead swap button concludes the product is broken.
  This is currently the single worst first-impression problem in the app.
- **Numbers are data.** Amounts, addresses, hashes, and ratios need to be scannable and
  column-comparable. Whatever you do typographically has to survive an address like
  `0x4200000000000000000000000000000000000006` and an amount like `12,694.284471` sitting in the
  same table.
- Web app, React. Desktop is the primary case (judges are at a laptop) but it must not be broken
  on a phone.
- Accessibility is not optional: keyboard-reachable controls, a real focus state, contrast that
  holds, and a `prefers-reduced-motion` path for anything that moves.

## 5. Every surface that exists

Five destinations. Four are tabs on one page; one is a standalone route.

### 5.1 Swap *(the default landing tab)*

Sell one token, receive another, filled from Aqua makers' wallets rather than pool reserves.

**The Finding** — the hero. One large live figure of the form *"N of M real maker positions on
Base can't deliver what they promised, right now"*, a short paragraph of explanation, and a link
into the full breakdown. This is the most important object in the product.

**Swap form** — a "you pay" amount input with the wallet balance shown as a one-click max, a token
picker per side, a direction-flip control, a "you receive" quoted readout, and a primary action
button. When the route splits across several makers it also reports *"+N bps better than any single
maker alone, by splitting across K makers"* — that improvement figure is a real competitive result
and currently gets no visual weight at all.

**Route evidence panel** — the receipt for the quote above it: pool liquidity read directly from
Uniswap v4 `PoolManager` storage (it is zero, and that zero is the point — the pool holds nothing);
pool ID; how many wallets filled out of how many considered; how many were skipped because they
could not pay; how many returned an unfillable quote; and any amount that could not be filled at
this size.

**Maker book** — a table of every live strategy for the token being bought:
`Maker · Promised · Wallet · Allowance · Deliverable · Shortfall · vs Oracle`, with rows the
current route actually used marked as such, and a summary line reading *"S solvent of L live"*.

**Raw hook data** — the exact bytes handed to the on-chain hook. Collapsed by default. Present for
the one reader in fifty who wants to verify the claim themselves; it must be findable and must not
cost anything visually.

### 5.2 Provide — "Ship a strategy"

Become a maker: publish a standing offer backed by your own wallet.

- **Pricing model choice.** Two genuinely different mechanisms: a constant-product curve, or a
  Chainlink-oracle-priced strategy (which is deployed on the test network only, and needs an honest
  unavailable state on the other). These are not two styling variants of one thing — they price
  differently and should read differently.
- **A real price chart** with range presets (±10%, ±20%, full range, custom) and the selected range
  marked on it. Currently sourced from Chainlink; it may be a live spot price rather than a
  historical series, and if so it must say so rather than drawing a curve it cannot justify.
- **Claim amounts** — how much of each token this strategy offers.
- **Fee / spread in basis points** that the maker earns per fill.
- A submit action that signs and publishes on chain, with the full pending → confirmed → failed
  lifecycle.

The thing this screen must communicate and currently does not: **the amount you claim is a promise
your wallet has to keep, and you are allowed to over-promise.** This is the exact behaviour the
rest of the product exists to detect. A maker configuring a position should be able to see, live,
whether what they are about to publish is covered by what they hold — including everything they
have already published. That is the app's own thesis, applied to its own user, and it is the
strongest single idea on this screen.

### 5.3 Portfolio — "Your exposure, claimed against held"

For a connected wallet, per token: `Token · Claimed · Held in wallet · Coverage`. Coverage is a
ratio and it is the whole point of the table — 100% means every promise is backed, anything less
means some of them are not.

### 5.4 Explore

The evidence, at network scale. Four blocks:

- **Coverage per maker** — `Maker · Token · Live strategies · Committed · Actually backed ·
  Coverage`. This is the table the Finding hero is a summary of.
- **Across Aqua** — `App · Status · Live strategies · Distinct makers`. Every application on Aqua
  this index can see, not only ours. It is a credibility move: the index is general, not
  self-serving.
- **Look up any wallet** — an entry point to 5.5.
- **Deployed contracts** — addresses and explorer links for the current network.

### 5.5 `/app/lookup` — check any wallet

A standalone page. Paste any address, either network, no wallet connection required. Returns that
address's claimed-vs-held position.

This page is quietly one of the most important in the product for the judge audience, because it
is the only thing here that works with zero setup. Design it as a destination, not a utility page.

### 5.6 Token search *(overlay, reachable from several places)*

Search the full token universe by name, symbol, or pasted contract address; also switch between
known trading pairs. A token found by open search has never been verified by this app, and the
design must mark it as unverified in a way that is honest without being alarmist — the same
treatment already applied to unrecognised tokens elsewhere.

## 6. States — design these first

Most of what is wrong with the current build is that it was designed for the happy path. Every
component above needs all of these, and several of them are the *normal* case, not the exception:

- **Loading**, and specifically *slow* loading — several of these calls take two to four seconds
  against live chains, every time.
- **Partially loaded** — the Finding hero resolves from one data source while the maker book is
  still reading from another. This happens on every single page load and is currently unhandled.
- **Empty because the network has no index** — real, and it must explain itself.
- **Empty because there is genuinely nothing to show** — different from the above, and must not
  look like a failure.
- **Read-only network** — everything reads, nothing can be signed. See §4.
- **Wallet not connected** — the default for most visitors, and the app should be substantially
  useful in it.
- **Wallet connected to the wrong chain** — needs a recovery action, not a scolding.
- **Data source failed** — an upstream RPC or index returned an error. Must degrade to whatever is
  still available rather than blanking the screen.
- **Transaction lifecycle** — idle → awaiting signature → pending on chain → confirmed → reverted.
- **Live update** — numbers change under the reader while they are looking at them, and the design
  has to make that feel like life rather than instability.

## 7. What we would like you to solve, without being told how

1. **A visual hierarchy that separates the claim from the evidence.** Right now they compete.
2. **A single readable pattern for "promised vs. actually backed"** that works at four different
   scopes, so learning it once is enough.
3. **A way for a judge who will not connect a wallet to see the product actually work.** This is
   currently the biggest gap between this entry and the competition. What that is — a recorded run,
   a guided walkthrough, a pre-filled demonstration, something else entirely — is your call, but it
   has to be unambiguously labelled as a recording and never presented as live.
4. **An on-ramp for someone who has never heard of Aqua**, without turning the product into a
   brochure.
5. **A treatment for the two-network split** that makes the read-only network feel like the
   authoritative one rather than the broken one.
6. **Motion with a job.** There is a real live-data story here and no motion language for it. Every
   moving thing must earn its place and must have a still equivalent under reduced-motion.

## 8. What to hand back

A design proposal, in whatever form communicates it best — we are not prescribing artefacts either.
What we need to be able to act on:

- The **reasoning**: what you decided this product is, and why the visual system follows from that
  rather than from taste. If your first move is to argue that a premise in this brief is wrong,
  make that argument — it is more useful than a compliant answer.
- A **system**: colour with defined roles (something has to encode "backed" versus "short", and
  something has to encode "this is a live number"), type, spacing, elevation or its absence, and a
  stated position on light versus dark and why.
- **The screens**, at least: Swap in its default state, Swap fully loaded with a route, the maker
  book, Provide, Explore, and lookup.
- **The states from §6** — at minimum every empty and failure state, because they are on screen
  more often than the happy path.
- **The motion language**, described.

Ask about anything ambiguous. Push back on anything that seems wrong. The one thing that is not
negotiable is §4.
