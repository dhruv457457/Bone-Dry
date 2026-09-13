/**
 * High-performance client-side cache for routes, maker books, and cross-chain quotes.
 * Keeps keystrokes, tab flips, and pre-flight modal verifications at 0ms latency.
 */

type CacheEntry<T> = {
  data: T;
  timestamp: number;
  ttlMs: number;
};

// In-memory runtime cache
const memoryCache = new Map<string, CacheEntry<unknown>>();

/**
 * Read from memory cache (or sessionStorage fallback)
 */
export function getFromCache<T>(key: string): T | null {
  const entry = memoryCache.get(key) as CacheEntry<T> | undefined;
  const now = Date.now();

  if (entry) {
    if (now - entry.timestamp < entry.ttlMs) {
      return entry.data;
    }
    memoryCache.delete(key);
  }

  // Check sessionStorage fallback if in browser
  if (typeof window !== "undefined") {
    try {
      const raw = sessionStorage.getItem(`bd_cache_${key}`);
      if (raw) {
        const parsed = JSON.parse(raw) as CacheEntry<T>;
        if (now - parsed.timestamp < parsed.ttlMs) {
          memoryCache.set(key, parsed as CacheEntry<unknown>);
          return parsed.data;
        }
        sessionStorage.removeItem(`bd_cache_${key}`);
      }
    } catch {
      // sessionStorage quota or disabled
    }
  }

  return null;
}

/**
 * Write to memory cache (and sessionStorage)
 */
export function setInCache<T>(key: string, data: T, ttlMs = 30_000): void {
  const entry: CacheEntry<T> = {
    data,
    timestamp: Date.now(),
    ttlMs,
  };

  memoryCache.set(key, entry as CacheEntry<unknown>);

  if (typeof window !== "undefined") {
    try {
      sessionStorage.setItem(`bd_cache_${key}`, JSON.stringify(entry));
    } catch {
      // Ignore sessionStorage full / unavailable
    }
  }
}

/**
 * Generate standard cache keys
 */
export function routeCacheKey(
  chainId: number,
  tokenIn: string,
  tokenOut: string,
  amountIn: string | bigint
): string {
  return `route_${chainId}_${tokenIn.toLowerCase()}_${tokenOut.toLowerCase()}_${amountIn.toString()}`;
}

export function makersCacheKey(chainId: number, token: string): string {
  return `makers_${chainId}_${token.toLowerCase()}`;
}

/**
 * Pre-warm a route into the client cache in the background.
 * Returns immediately without blocking UI.
 */
export async function prewarmRoute(
  chainId: number,
  tokenIn: string,
  tokenOut: string,
  amountIn: string | bigint
): Promise<void> {
  const key = routeCacheKey(chainId, tokenIn, tokenOut, amountIn);
  if (getFromCache(key)) return;

  try {
    const q = `chain=${chainId}&tokenIn=${tokenIn}&tokenOut=${tokenOut}&amountIn=${amountIn}`;
    const res = await fetch(`/api/route?${q}`);
    if (!res.ok) return;
    const data = await res.json();
    if (!data.error) {
      setInCache(key, data, 45_000);
    }
  } catch {
    // Non-blocking background fetch error
  }
}
