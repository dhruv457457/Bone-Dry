# Bone Dry — Subgraph MCP: the unambiguous second Graph product

Context, so the "why" is clear: the Graph track requires composing two or
more Graph products. Token API (Pinax-operated, Substreams-powered) is
already built but sits in a gray area — it's officially linked from
`thegraph.com`'s docs, but branded and run by a partner company, not The
Graph Foundation directly. Defensible, but arguable.

The **Subgraph MCP** (`subgraphs.mcp.thegraph.com`) is not arguable — it's
on The Graph's own domain, and this project's existing Subgraph Studio API
key already authenticates against it (verified: `HTTP 200` on `/sse` with
that key, no second signup). This plan builds one real, honest use of it,
to remove any doubt about the "two products" claim rather than resting it
on Token API alone.

**This plan has a go/no-go gate as Task 1.** MCP's own docs say it covers
subgraphs on The Graph's decentralized network. Our subgraph
(`api.studio.thegraph.com/query/1758723/aquifer/v0.0.3`) is on the **free
Studio hosted service** — it is not confirmed that this is the same
population MCP can see. Task 1 finds out. Task 2 is two different builds
depending on the answer, written out below — do not guess which one applies
before Task 1 reports back.

---

## 0. Hard rules (same as every plan here)

1. **Never `git add -A` or `git add .`.** Exact paths only.
2. **Do not touch:** `web/app/ui/Landing.tsx`, `landing.module.css`,
   `Doodle.tsx`, `useIsomorphicLayoutEffect.ts`, `web/app/page.tsx`.
3. **Ask before touching:** `web/app/layout.tsx`, `globals.css`,
   `Motion.tsx`, `Web3.tsx`.
4. **Do not touch `contracts/` at all.** Nothing here needs a contract.
5. **Do not fake agentic behaviour.** MCP tools exist for an AI client to
   reason over — search, pick a result, decide what to query next. This
   plan is explicit everywhere about what is a fixed, deterministic call
   and what would require actual reasoning. If a step in your build starts
   needing judgment calls about which subgraph is "relevant" or what a
   result "means", stop — that is exactly the line between "we used the
   tool" and "we're pretending to have an agent we don't have."
6. **The MCP session key is already in this repo's `.env.local` as the
   existing Studio key** (used for `GRAPH_URL` already) — do not request a
   new key, do not hardcode it anywhere, read it the same way `GRAPH_URL`
   is already read.
7. **Every task ends with real verification.** Actual tool responses
   pasted, not descriptions of what should happen.
8. Commit per task, exact paths, trailer:
   `Co-Authored-By: Antigravity <noreply@google.com>`
9. **Unsure whether something is in scope? It is not.** Ask.

---

## Task 1 — Prove the handshake, and find out which world we're in

**Goal:** a real MCP tool call and response, end to end, from plain Node —
not a raw SSE connect (already proven), a full JSON-RPC round trip:
`initialize` → `tools/list` → call one real tool → get real data back.

MCP over SSE is a stateful protocol (session semantics, not a plain REST
call) — this is the one place in this plan real protocol complexity lives.
Read `https://thegraph.com/docs/en/subgraphs/subgraph-mcp/introduction/`
and `https://github.com/graphops/subgraph-mcp` before writing a client by
guesswork.

### What to do

1. Write a small standalone Node script (scratch file, not committed to
   `web/`) that does the full handshake against
   `https://subgraphs.mcp.thegraph.com/sse` (or `/mcp` if the docs say
   that's now preferred — check, don't assume the URL from an earlier
   probe is still current) using the existing Studio key.
2. Call `tools/list`. Paste the **real, complete** list of tool names and
   their input schemas in your report — this project needs to know exactly
   what's callable, not a summary from search results.
3. **The go/no-go check**: call whichever tool searches subgraphs by
   keyword with the query `"aqua"` or `"aquifer"`. Does our own subgraph
   (deployed at `api.studio.thegraph.com/query/1758723/aquifer/v0.0.3`)
   show up in the results, under any name?
   - **If yes** — proceed to Task 2A.
   - **If no** — our subgraph is Studio-hosted-only and outside what MCP
     indexes. Proceed to Task 2B instead. Do not attempt to "publish" the
     subgraph to the decentralized network to force a yes — that's a
     billing/staking action on a live project this far into a deadline,
     out of scope for you to decide, ask first if you think it's warranted.
4. Separately, call the search tool with a keyword that should have many
   real results regardless of our own subgraph's status (e.g. `"uniswap"`
   or `"aave"`) — confirms the tool works at all, independent of question 3.

### Verification

Paste, verbatim: the full `tools/list` response, the exact query you sent
for the "aqua"/"aquifer" search and its full response, and the
"uniswap"/"aave" search and its response. State plainly which of Task 2A /
2B applies.

### Commit

Nothing to commit yet — Task 1 is investigation. Report and wait.

---

## Task 2A — if our subgraph IS visible to MCP

**Goal:** an honest "indexed by The Graph" panel — MCP's own view of our
subgraph, shown next to our own claims about it, so a visitor (or a judge)
can see two independent sources agree. Same "verify, don't assert" instinct
as everything else in this project.

### What to build

`web/lib/subgraphMcp.ts` — a minimal client wrapping the handshake proven
in Task 1: one function, `mcpSubgraphInfo(): Promise<{schema: string; deploymentId: string; queryCount30d: number | null} | null>`.
Null on any failure — this must never break the page it's used on.

New route `web/app/api/mcp-check/route.ts` — calls it, returns the result,
`available: false` shape on failure (same pattern as every other route in
this codebase — check `coverage/route.ts` again if you need reminding of
the shape).

On the Explore tab, a small addition near the existing "Across Aqua"
section: fetched schema entity names from MCP, compared against
`subgraph/schema.graphql`'s own entity names (read at build time or hit the
committed file — do not hardcode the list twice). Show agreement plainly:
*"N of N entities match between our schema file and what The Graph's own
MCP reports."* If they don't match, show that honestly too — a mismatch is
a real finding, not a bug to hide.

### Verification

1. `npx tsc --noEmit` clean.
2. Screenshot the panel.
3. Paste the actual MCP response your comparison is built on.

### Commit
```
git add web/lib/subgraphMcp.ts web/app/api/mcp-check/ web/app/ui/Desk.tsx web/app/ui/desk.module.css
git commit -m "Cross-check our subgraph schema against The Graph's own Subgraph MCP"
```

---

## Task 2B — if our subgraph is NOT visible to MCP

**Goal:** don't force a self-referential feature that can't work. Use MCP
for what it's actually good at instead — real cross-protocol discovery on
the public lookup page, which is closer to the track's literal wording
("cross-protocol analysis") anyway.

### What to build

On `/app/lookup`, after a maker's positions load, for each **unrecognised**
token (the ones currently rendering as a truncated hex address with no
symbol — check `ExposureTable` for how that's detected today), call MCP's
subgraph-search tool with the token's address as the query. This is a fixed,
deterministic call — one input, one search, no judgment calls about what
the results mean.

Render whatever comes back as a plain list: subgraph name, and a link to
query it in Graph Explorer if the response includes an ID that maps to one.
**No synthesis.** Do not write copy that claims to explain what the token
is or what those subgraphs say about it — that would require reasoning this
feature does not have. The honest framing is: *"Other subgraphs mentioning
this address:"* — a discovery aid, not an analysis.

If a search returns nothing, say so plainly (`"No other subgraphs found for
this address"`), don't hide the row.

### Verification

1. `npx tsc --noEmit` clean.
2. Look up a real, well-known address (not a Bone Dry test wallet) that's
   likely to appear elsewhere — paste what came back.
3. Look up one of Bone Dry's own test maker addresses — likely near-empty,
   confirm it renders the "no results" state cleanly rather than erroring.

### Commit
```
git add web/lib/subgraphMcp.ts web/app/app/lookup/page.tsx web/app/ui/desk.module.css
git commit -m "Surface related subgraphs for unrecognised tokens via Subgraph MCP"
```

---

## What "done" means

Task 1's report is the most important one in this file — everything after
it depends on what it finds. Do not start Task 2A or 2B before Task 1 is
reported and confirmed. If the MCP handshake itself turns out to be too
unreliable to complete in reasonable time (session drops, undocumented
behaviour), say so plainly and stop — a flaky integration demoed live is
worse than no integration, and Token API alone (already built) plus the
"authenticates against MCP" fact already established is still a real,
honest position to submit from.
