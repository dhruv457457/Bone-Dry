# Bone Dry — token icons, README refresh, jargon check (for Antigravity)

The oracle-deviation and "Across Aqua" passes are done, verified, merged.
This plan goes back to two things flagged early and never actually built:
the dashboard has no token logos anywhere, and the README is now stale
relative to everything shipped since it was last touched — it does not
mention the maker-ship flow, multi-pair support, the oracle check, or the
cross-app proof, and it does not satisfy a requirement the Uniswap track
states explicitly: *"Make sure your README clearly points to the relevant
contracts and lines of code so we can verify your integration."* Right now
it doesn't point at any.

Three tasks, no engineering risk — no contracts, no subgraph, nothing that
touches chain state. Read this whole file before starting.

---

## 0. Hard rules (same as every plan here)

1. **Never `git add -A` or `git add .`.** Stage exact paths only.
2. **Do not touch:** `web/app/ui/Landing.tsx`, `web/app/ui/landing.module.css`,
   `web/app/ui/Doodle.tsx`, `web/app/ui/useIsomorphicLayoutEffect.ts`,
   `web/app/page.tsx`.
3. **Ask before touching:** `web/app/layout.tsx`, `web/app/globals.css`,
   `web/app/ui/Motion.tsx`, `web/app/ui/Web3.tsx`.
4. **Do not touch `contracts/` or `subgraph/` in this plan.** Nothing here
   needs either.
5. **Do not add anything not asked for.** The last plan's biggest problem
   was an unrequested feature (URL deep-linking) that broke the network
   switcher and had to be reverted. If you think of something else worth
   adding while working on this, say so in your report — do not just add
   it. This applies especially to Task 3 below.
6. **Every task ends with a real verification step**, actual output pasted.
7. **Commit after each task**, exact paths, with:
   ```
   Co-Authored-By: Antigravity <noreply@google.com>
   ```
8. **Unsure whether something is in scope? It is not.** Ask.

---

## Task 1 — Token icons, with an honest fallback

**Goal:** every place a token symbol renders (USDC, WETH, MOCK) shows a small
icon next to it. A real logo for real tokens, a plain generated fallback for
`MOCK` — it is our own throwaway Sepolia test token, it has no real logo,
and pretending otherwise (e.g. reusing a real coin's logo for it) would be
actively dishonest. Do not do that.

### What to add

New file `web/lib/tokenIcons.ts`:
```ts
import type { Address } from "viem";

/**
 * Trust Wallet's public asset repo, keyed by checksummed address, per chain.
 * No auth, no rate limit issues we have hit in testing. A 404 here is
 * expected and normal for any token without a listing (MOCK, always) --
 * TokenIcon below must render its fallback on that, not a broken image.
 */
const TRUST_WALLET_CHAIN = { 8453: "base", 84532: "base" } as const; // Sepolia has no separate TW listing; same-chain fallback is fine, most Sepolia addresses will 404 anyway and fall back cleanly

export function iconUrl(chainId: number, address: Address): string | null {
  const chain = TRUST_WALLET_CHAIN[chainId as keyof typeof TRUST_WALLET_CHAIN];
  if (!chain) return null;
  return `https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/${chain}/assets/${address}/logo.png`;
}
```

New file `web/app/ui/TokenIcon.tsx`:
```tsx
"use client";

import { useState } from "react";
import { iconUrl } from "@/lib/tokenIcons";
import type { Address } from "viem";

/**
 * A token's logo, or a plain letter-in-circle if it doesn't have one (every
 * Sepolia demo token, MOCK included, and any real token the CDN 404s on).
 * The fallback is not a placeholder to feel bad about -- a real dashboard
 * showing a generated circle for an unlisted token is normal and honest;
 * showing the wrong logo, or no visual at all, are the two actually wrong
 * options here.
 */
export function TokenIcon({
  chainId,
  address,
  symbol,
  size = 20,
}: {
  chainId: number;
  address: Address;
  symbol: string;
  size?: number;
}) {
  const [failed, setFailed] = useState(false);
  const url = iconUrl(chainId, address);

  if (!url || failed) {
    return (
      <span
        aria-hidden
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: size,
          height: size,
          borderRadius: "50%",
          background: "var(--ink)",
          color: "var(--paper)",
          fontSize: size * 0.42,
          fontFamily: "var(--mono)",
          flexShrink: 0,
        }}
      >
        {symbol.slice(0, 1).toUpperCase()}
      </span>
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element -- external CDN, not a local asset
    <img
      src={url}
      alt=""
      aria-hidden
      width={size}
      height={size}
      style={{ borderRadius: "50%", flexShrink: 0 }}
      onError={() => setFailed(true)}
    />
  );
}
```

Check whether this repo's `next.config` needs a `remotePatterns` entry for
external `<img>` sources, or whether a plain `<img>` tag (not `next/image`)
sidesteps that entirely — the draft above deliberately uses a plain `<img>`
for exactly this reason, do not switch it to `next/image` without checking
that config change wouldn't be needed first.

### Where to use it

Every place a token ticker/symbol currently renders as bare text next to an
amount: the swap card's "You pay"/"You receive" rows, the ship-a-strategy
form's claim fields, the maker book table's implicit token context, the
exposure table's token column. Grep `desk.module.css` for `.ticker` to find
every call site systematically — do not rely on memory of the file, it has
changed across several plans now.

Place the icon immediately before the symbol text, `size={16}` inline next
to running text (amount rows), `size={20}` in table cells. Match spacing to
whatever gap already exists between elements in each spot rather than
inventing new spacing values.

### Verification

1. `npx tsc --noEmit` clean.
2. Screenshot the Swap tab — USDC and WETH should show real logos.
3. Screenshot the WETH/MOCK pair — WETH shows its real logo, MOCK shows the
   letter-circle fallback (not a broken image icon, not someone else's
   logo).
4. Throttle or block the Trust Wallet domain in dev tools briefly (or just
   note in your report that you traced the `onError` path manually) and
   confirm a real token's icon still falls back cleanly if the CDN is
   unreachable — this must never render as a broken-image icon.

### Commit
```
git add web/lib/tokenIcons.ts web/app/ui/TokenIcon.tsx web/app/ui/Desk.tsx web/app/ui/Exposure.tsx web/app/app/lookup/page.tsx
git commit -m "Show token icons, with an honest fallback for tokens with none"
```
(Adjust the file list to whatever you actually touched — this is a guess at
which files have ticker displays, confirm the real list from your own grep.)

---

## Task 2 — README: bring it up to date, and point at real lines

**Goal:** two separate problems, one task. The `Status` table stops at the
router/subgraph/frontend milestone from several passes ago — it doesn't
mention the maker-ship flow, multi-pair support, the oracle-deviation
check, `Beacon.sol`, or the cross-app subgraph proof, all of which are real
and shipped. And nothing in the README points at specific contract lines,
which the Uniswap track's own stated requirement asks for by name.

### What to change

In `README.md`:

1. Update the `Status` table with rows for what's actually shipped since it
   was last written — check `git log --oneline` for the real list rather
   than guessing, but at minimum: the ship-a-strategy flow (`/api/strategy`,
   `ShipStrategy` in Desk.tsx), multi-pair support (`web/lib/pairs.ts`),
   the oracle-deviation check (`web/lib/oracle.ts`, per-slice deviation in
   `/api/route`, `Beacon.sol`), and the cross-app subgraph proof (`/api/apps`,
   the "Across Aqua" section).
2. Add a new section, `## Where to look` (or similar — pick a heading that
   fits this file's existing voice, read a few of its section headings
   first), with a short table or list mapping **judging concern → exact
   file and line**:
   - The v4 hook itself: `contracts/src/Tap.sol:83` (`beforeSwap`) — this
     is the one Uniswap's own requirement most directly wants; say in one
     sentence what happens there (it fully overrides the swap and delivers
     from Aqua maker wallets, matching what `PoolProof` on the Swap tab
     already shows: liquidity is 0 both before and after).
   - Hook address mining: `contracts/script/Deploy.s.sol` (find the `_mine`
     function's current line with `grep -n "_mine" contracts/script/Deploy.s.sol`
     — do not hardcode a line number without checking it directly first).
   - The solvency check: `contracts/src/Lens.sol` (find and cite its main
     entry point the same way — grep it, do not guess).
   - The maker-ship route: `web/app/api/strategy/route.ts`.
   - The oracle-deviation check: `web/lib/oracle.ts` and
     `contracts/src/Beacon.sol`.
   - The subgraph schema (for the Graph track specifically): point at the
     header comment in `subgraph/schema.graphql` that describes it as a
     reusable schema, and at `/api/apps` as the live proof of that claim.

Every line number you write into this file **must be one you checked with
`grep -n` or by reading the file directly** in this same working session —
not carried over from an earlier version of this plan, not estimated. Code
shifts between commits; a wrong line number in a document whose entire
purpose is "here is exactly where to look" is worse than not having the
section at all.

3. Do not rewrite sections that are still accurate (the "Live on Base
   Sepolia" proof, the "Run it" instructions) — this is an update, not a
   rewrite. Read the whole file first so you know what's already fine.

### Verification

1. Paste the actual `grep -n` output you used for every line number you
   cited, in your report — not just the final README text.
2. Re-read the finished README top to bottom once, as if you were a judge
   with five minutes, and note in your report whether it actually answers
   "where's the hook" and "where's the thing that checks solvency" quickly.

### Commit
```
git add README.md
git commit -m "Update the README with everything shipped since it was last touched, and point at exact lines"
```

---

## Task 3 — Spot-check remaining jargon (small, do not over-scope)

**Goal:** this is smaller than it might sound. A previous polish pass
already fixed most of this — the maker book table now reads "Promised" /
"Deliverable" / "Shortfall" rather than raw "depth", and other tables use
"Committed" / "Actually backed". Read the actual current copy before
assuming a rewrite is needed.

### What to check

Grep the following across `web/app/ui/*.tsx` and read each hit in context:
`virtual`, `strategyHash`, `hookData`, `solvent` (as UI-facing text, not a
variable name), `depth` (as UI-facing text). For each hit that is genuinely
user-facing copy (not a variable name, not already behind the `.disclosure`
that hides `hookData`), judge whether a newcomer to the project — not
someone who has read the whitepaper — would understand it in context. If
yes, leave it. If no, propose a plain-language replacement and make the
change.

**Do not touch copy that's already plain.** If your grep turns up mostly
variable names and already-fine copy, say that in your report and make
few or no changes — a report saying "checked, found it in better shape
than expected, changed two things" is a completely fine outcome for this
task, better than inventing rewrites to seem thorough.

### Verification

1. List every UI-facing string you actually changed, old vs new, in your
   report.
2. `npx tsc --noEmit` clean.
3. Screenshot any spot where the copy changed.

### Commit
```
git add [exact files you changed]
git commit -m "Plain-language pass on remaining jargon in the dashboard"
```

---

## What "done" means

Report per task: files changed, actual verification output, and — for
Task 2 specifically — the real `grep -n` output behind every line number
you cited. For Task 3, an honest account of how much (or little) needed
changing is a better report than padding it out.
