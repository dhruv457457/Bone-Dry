import { BigInt, Bytes } from "@graphprotocol/graph-ts";
import { MakerSkipped } from "../generated/Tap/Tap";
import { MakerRefusal } from "../generated/schema";
import { protocol, maker } from "./aqua";

const ONE = BigInt.fromI32(1);

/** Tap hook -> the router it is immutably bound to (Base mainnet). */
function routerForHook(hook: Bytes): string | null {
  let h = hook.toHexString().toLowerCase();
  if (h == "0xeadd3c76bb9f3d8aa26fa9f793a893e2aba24088") return "0x111111338c5091e8440b67b168bae16a668ac0de"; // 1inch SwapVM router
  if (h == "0xac7bca41ea8fce76651684943db2c38003c98088") return "0x74195573fa9bc965667e03319f2c58567d4b96be"; // BoneDryRouter
  return null;
}

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
  // Strategies are keyed by the Aqua APP (the SwapVM router) they were shipped to,
  // not by the hook that emitted this event. Building the id from e.address (the
  // hook) pointed every refusal at a Strategy that does not exist. Each Tap's
  // router is immutable (Tap.sol:42), so the hook determines it exactly.
  let app = routerForHook(e.address);
  if (app != null) {
    r.strategy = app! + "-" + e.params.strategyHash.toHexString();
  }
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
