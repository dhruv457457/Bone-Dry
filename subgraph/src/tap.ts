import { BigInt } from "@graphprotocol/graph-ts";
import { MakerSkipped } from "../generated/Tap/Tap";
import { MakerRefusal } from "../generated/schema";
import { protocol, maker } from "./aqua";

const ONE = BigInt.fromI32(1);

/**
 * Indexes MakerSkipped events emitted by Bone Dry's Tap.sol hook.
 *
 * In standard Aqua, insolvent/flaked fills revert silently with zero emitted events (SUBFLOOR problem).
 * Bone Dry catches them via try/catch and logs MakerSkipped, creating the first queryable
 * on-chain refusal and reliability history in DeFi.
 */
export function handleMakerSkipped(e: MakerSkipped): void {
  let id = e.transaction.hash.toHexString() + "-" + e.logIndex.toString();
  let r = new MakerRefusal(id);
  r.maker = e.params.maker.toHexString();
  r.wanted = e.params.wanted;
  r.blockNumber = e.block.number;
  r.timestamp = e.block.timestamp;
  r.txHash = e.transaction.hash;
  r.save();

  let m = maker(e.params.maker, e.block.timestamp);
  m.skipsAsMaker = m.skipsAsMaker.plus(ONE);
  m.totalVolumeSkipped = m.totalVolumeSkipped.plus(e.params.wanted);
  m.save();

  let p = protocol();
  p.skips = p.skips.plus(ONE);
  p.save();
}
