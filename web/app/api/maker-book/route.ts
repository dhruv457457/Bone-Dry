import { makerBookAcrossChains } from "@/lib/makerBook";
import { addressParam, BadInput } from "@/lib/validate";
import { j, fail } from "@/lib/json";

export const dynamic = "force-dynamic";

/**
 * GET /api/maker-book?maker=
 *
 * One maker's book on Base and Ethereum: every live strategy with its claims read
 * from chain, the opcode-35 verdict for each, this maker's fills and refusals, and
 * per-token promised vs backing per chain and combined. Provide and Portfolio both
 * read this, so they cannot disagree.
 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const makerParam = url.searchParams.get("maker");
    if (!makerParam) throw new BadInput("maker address required");
    const maker = addressParam(makerParam, "0x0000000000000000000000000000000000000000");
    return j(await makerBookAcrossChains(maker));
  } catch (e) {
    if (e instanceof BadInput) return fail(e.message, 400);
    return fail((e as Error).message, 500);
  }
}
