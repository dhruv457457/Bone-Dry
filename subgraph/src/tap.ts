import { BigInt, Bytes } from "@graphprotocol/graph-ts";
import { MakerSkipped } from "../generated/Tap/Tap";
import { MakerRefusal } from "../generated/schema";
import { protocol, maker } from "./aqua";

const ONE = BigInt.fromI32(1);

export function getReasonName(reason: Bytes): string {
  let hex = reason.toHexString().toLowerCase();
  if (hex == "0x831f3352") return "EncumbranceExceeded";
  if (hex == "0xea7d00c7") return "EncumbranceInsufficient";
  if (hex == "0x78306a7e") return "EncumbranceZeroBacking";
  if (hex == "0x50b899a5") return "EncumbranceUnderdeclared";
  if (hex == "0xffffffff") return "QuoteUnusable";
  if (hex == "0x00000000") return "EmptyRevertData";
  return "Unknown";
}

/**
 * Indexes MakerSkipped events emitted by Bone Dry's Tap.sol hook.
 *
 * In standard Aqua, insolvent/flaked fills revert silently with zero emitted events (SUBFLOOR problem).
 * Bone Dry catches them via try/catch and logs MakerSkipped, creating the first queryable
 * on-chain refusal and reliability history in DeFi.
 *
 * NOTE (Correction 1): Tap.sol has two placement passes (initial slice and sweep), so a refused maker
 * emits twice in the same swap tx. To collapse retries within one swap to one refusal,
 * MakerRefusal is keyed on txHash ++ maker ++ strategyHash rather than txHash ++ logIndex.
 */
export function handleMakerSkipped(e: MakerSkipped): void {
  let id = e.transaction.hash.toHexString() + "-" + e.params.maker.toHexString() + "-" + e.params.strategyHash.toHexString();
  let existing = MakerRefusal.load(id);
  if (existing != null) {
    // Retry within one swap collapses to one refusal
    return;
  }

  let r = new MakerRefusal(id);
  r.maker = e.params.maker.toHexString();
  r.strategy = e.address.toHexString() + "-" + e.params.strategyHash.toHexString();
  r.strategyHash = e.params.strategyHash;
  r.token = e.params.token;
  r.reason = e.params.reason;
  r.reasonName = getReasonName(e.params.reason);
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
