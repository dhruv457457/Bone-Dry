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
  if (/HTTP request failed|fetch failed|ECONNREFUSED|timed out|socket hang up/i.test(m)) {
    console.error("[chain]", m);
    return fail("cannot reach the chain right now", 503);
  }
  return null;
}
