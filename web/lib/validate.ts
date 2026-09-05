import { isAddress, getAddress, type Address } from "viem";

/** Thrown for anything the caller got wrong. Handlers turn it into a 400. */
export class BadInput extends Error {}

export function addressParam(v: string | null, fallback: Address): Address {
  if (v === null || v === "") return fallback;
  if (!isAddress(v, { strict: false })) throw new BadInput(`not an address: ${v}`);
  return getAddress(v);
}

/** Amounts are unsigned. "-5" parses fine as a BigInt and then silently routes
 *  to nothing, which reads as "no maker available" rather than "you asked for a
 *  negative swap" — so reject it here rather than letting it look like depth. */
export function amountParam(v: string | null, fallback: bigint): bigint {
  if (v === null || v === "") return fallback;
  if (!/^\d+$/.test(v.trim())) throw new BadInput(`amount must be a non-negative integer: ${v}`);
  const n = BigInt(v);
  if (n >= 1n << 255n) throw new BadInput("amount exceeds uint256 range");
  return n;
}

export function uintParam(v: string | null, fallback: number, bits: number, name: string): number {
  if (v === null || v === "") return fallback;
  if (!/^\d+$/.test(v.trim())) throw new BadInput(`${name} must be a non-negative integer: ${v}`);
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n >= 2 ** bits) throw new BadInput(`${name} does not fit in uint${bits}`);
  return n;
}

export function distinct(tokenIn: Address, tokenOut: Address) {
  if (tokenIn.toLowerCase() === tokenOut.toLowerCase())
    throw new BadInput("tokenIn and tokenOut are the same token");
}
