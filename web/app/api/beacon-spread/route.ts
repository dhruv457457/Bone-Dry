import { beaconStrategyAbi } from "@/lib/chain";
import { networkFrom, clientFor } from "@/lib/networks";
import { j, fail, chainFailure } from "@/lib/json";

export const dynamic = "force-dynamic";

// Same address /api/strategy builds the Extruction opcode against. Duplicated
// rather than imported: that route's constant carries its own long comment
// about which deployment is actually reachable, and this one has nothing to
// add to that story -- it just needs to read the same contract.
const BEACON_STRATEGY_ADDRESS = "0x1cAD1eCa368940F91b43B25Db0e3E9B32B46fFe7"; // Base Sepolia only

/**
 * GET /api/beacon-spread?chain=
 *
 * The fee row in Ship-a-strategy's oracle mode used to show a literal "20"
 * typed into the component -- correct only because nobody had redeployed
 * BeaconStrategy since. spreadBps is immutable, set once at deploy and never
 * again, so there is no reason the UI should know it by any means other than
 * asking the contract.
 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const n = networkFrom(url.searchParams.get("chain"));
    if (n.id !== 84532) {
      return j({ available: false, reason: "BeaconStrategy is only deployed on Base Sepolia" });
    }
    const client = clientFor(n);
    const spreadBps = await client.readContract({
      address: BEACON_STRATEGY_ADDRESS,
      abi: beaconStrategyAbi,
      functionName: "spreadBps",
    });
    return j({ available: true, address: BEACON_STRATEGY_ADDRESS, spreadBps: Number(spreadBps) });
  } catch (e) {
    return chainFailure(e) ?? fail((e as Error).message ?? "failed to read BeaconStrategy");
  }
}
