/** Formatting helpers shared by the UI. All amounts arrive from the API as
 *  decimal strings, because BigInt does not survive JSON. */

/** An ERC-20 "infinite" approval. Rendering it as 115 undecillion tokens is
 *  technically true and completely useless — it is a flag, not a quantity. */
export const MAX_UINT256 = (1n << 256n) - 1n;
const UNLIMITED_FLOOR = MAX_UINT256 / 2n;

export function isUnlimited(raw: string | bigint): boolean {
  const v = typeof raw === "bigint" ? raw : BigInt(raw || "0");
  return v >= UNLIMITED_FLOOR;
}

/** Compact for table columns: 1.2M rather than 1,234,567. */
export function compact(raw: string | bigint, decimals: number): string {
  if (isUnlimited(raw)) return "∞";
  const v = typeof raw === "bigint" ? raw : BigInt(raw || "0");
  if (v === 0n) return "0";
  const whole = v / 10n ** BigInt(decimals);
  if (whole >= 1_000_000_000n) return `${(Number(whole / 1_000_000n) / 1000).toFixed(1)}B`;
  if (whole >= 1_000_000n) return `${(Number(whole / 1_000n) / 1000).toFixed(1)}M`;
  if (whole >= 10_000n) return `${(Number(whole) / 1000).toFixed(1)}K`;
  return units(v, decimals, 4);
}

export function units(raw: string | bigint, decimals: number, maxFrac = 4): string {
  const v = typeof raw === "bigint" ? raw : BigInt(raw || "0");
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = (abs % base).toString().padStart(decimals, "0").slice(0, maxFrac).replace(/0+$/, "");
  const grouped = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${neg ? "-" : ""}${grouped}${frac ? "." + frac : ""}`;
}

export function toRaw(input: string, decimals: number): bigint {
  const cleaned = input.trim().replace(/,/g, "");
  if (!/^\d*\.?\d*$/.test(cleaned) || cleaned === "" || cleaned === ".") return 0n;
  const [w, f = ""] = cleaned.split(".");
  return BigInt(w || "0") * 10n ** BigInt(decimals) + BigInt((f + "0".repeat(decimals)).slice(0, decimals) || "0");
}

export const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export const pct = (part: string | bigint, whole: string | bigint): number => {
  const p = typeof part === "bigint" ? part : BigInt(part || "0");
  const w = typeof whole === "bigint" ? whole : BigInt(whole || "0");
  if (w === 0n) return 0;
  return Number((p * 10000n) / w) / 100;
};
