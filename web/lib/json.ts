/** BigInt does not survive JSON.stringify. Everything on-chain is a BigInt. */
export function j(data: unknown, init?: ResponseInit) {
  return new Response(
    JSON.stringify(data, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2),
    { headers: { "content-type": "application/json" }, ...init }
  );
}
export function fail(message: string, status = 400) {
  return j({ error: message }, { status });
}

/**
 * Turn an infrastructure failure into an honest status, without handing the
 * caller our RPC endpoint. viem's errors embed the URL and the request body,
 * which is useful in a log and not something to serve.
 */
export function chainFailure(e: unknown): Response | null {
  const m = (e as Error)?.message ?? "";
  // A public endpoint throttling us is not an outage and should not read like
  // one. It clears on its own, so say so and let the caller retry.
  if (/429|rate limit|too many requests/i.test(m)) {
    console.error("[chain] rate limited", m.slice(0, 200));
    return fail("the public RPC is rate limiting us — try again in a moment", 503);
  }
  if (/HTTP request failed|fetch failed|ECONNREFUSED|timed out|socket hang up/i.test(m)) {
    console.error("[chain]", m);
    return fail("cannot reach the chain right now", 503);
  }
  // A free-tier RPC that answered but refused the specific request -- an
  // archive-token upsell on an old block range, "invalid parameters" on a
  // range it does not like. Still an infrastructure limit, not a code bug,
  // and the raw message carries the endpoint URL and full request body the
  // same way the two patterns above do. Caught this leaking straight into a
  // UI label on Ethereum's coverage panel before this pattern existed.
  if (/archive|invalid parameters were provided/i.test(m)) {
    console.error("[chain] rpc refused the request", m.slice(0, 300));
    return fail("that RPC couldn't answer this request — retrying against a different one usually works", 503);
  }
  return null;
}
