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
