import { isAddress, getAddress, type Address } from "viem";
import { erc20Abi } from "@/lib/chain";
import { networkFrom, clientFor } from "@/lib/networks";
import { tokenMetadata } from "@/lib/tokenApi";
import { searchKnownTokens, tokensForChain, type SearchableToken } from "@/lib/tokenList";
import { j, fail } from "@/lib/json";

export const dynamic = "force-dynamic";

/**
 * GET /api/tokens?chain=&q=&address=
 *
 * Resolves token search queries:
 * 1. Fast match across known tokens on the selected chain
 * 2. On-chain / Token API resolution when a 0x address is provided
 *
 * Implements Phase C trust boundary: uncurated tokens discovered by address
 * are marked verified: false with source: "token-api" or source: "rpc".
 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const n = networkFrom(url.searchParams.get("chain"));
    const addressParam = url.searchParams.get("address")?.trim();
    const queryParam = url.searchParams.get("q")?.trim();

    // 1. Direct address lookup
    if (addressParam) {
      if (!isAddress(addressParam)) {
        return fail("invalid ethereum address", 400);
      }

      const checksummed = getAddress(addressParam);
      const lower = checksummed.toLowerCase();

      // Check known list first
      const known = tokensForChain(n.id).find((t) => t.address.toLowerCase() === lower);
      if (known) {
        return j({ token: known, found: true });
      }

      // Try The Graph / Pinax Token API
      const meta = await tokenMetadata(n, checksummed);
      if (meta && meta.symbol) {
        const token: SearchableToken = {
          address: checksummed,
          symbol: meta.symbol,
          name: meta.name || meta.symbol,
          decimals: meta.decimals || 18,
          verified: false,
          source: "token-api",
          holders: meta.holders,
          category: "imported",
        };
        return j({ token, found: true });
      }

      // Fallback: Read directly on-chain via RPC
      const client = clientFor(n);
      try {
        const [symbol, name, decimals] = await Promise.all([
          client.readContract({
            address: checksummed,
            abi: erc20Abi,
            functionName: "symbol",
          }).catch(() => `${checksummed.slice(0, 6)}…`),
          client.readContract({
            address: checksummed,
            abi: erc20Abi,
            functionName: "name",
          }).catch(() => "Unknown Token"),
          client.readContract({
            address: checksummed,
            abi: erc20Abi,
            functionName: "decimals",
          }).catch(() => 18),
        ]);

        const token: SearchableToken = {
          address: checksummed,
          symbol: String(symbol),
          name: String(name),
          decimals: Number(decimals),
          verified: false,
          source: "rpc",
          category: "imported",
        };
        return j({ token, found: true });
      } catch (e) {
        return fail(`Failed to read token contract at ${checksummed}: ${(e as Error).message}`, 404);
      }
    }

    // 2. Query search across known tokens
    const results = searchKnownTokens(n.id, queryParam || "");
    return j({ tokens: results });
  } catch (e) {
    return fail((e as Error).message, 500);
  }
}
