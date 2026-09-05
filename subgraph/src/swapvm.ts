import { BigInt } from "@graphprotocol/graph-ts";
import { Swapped } from "../generated/SwapVM/SwapVM";
import { Fill, Strategy } from "../generated/schema";
import { protocol, maker } from "./aqua";

const ONE = BigInt.fromI32(1);

/**
 * The join the 1inch docs specify: Swapped.orderHash == Shipped.strategyHash.
 * The router address is the `app` a strategy was shipped under, so the Strategy
 * id reconstructs directly.
 *
 * On Base today that join always lands: all 1,862 fills indexed so far match a
 * strategy. `againstAqua` is not there because unmatched fills are common — it
 * is there so that if one ever appears it is visible instead of being counted
 * as Aqua activity. A fill whose Shipped predates this subgraph's start block
 * is the case that would produce one.
 */
export function handleSwapped(e: Swapped): void {
  let f = new Fill(e.transaction.hash.toHexString() + "-" + e.logIndex.toString());

  let strategyId = e.address.toHexString() + "-" + e.params.orderHash.toHexString();
  let s = Strategy.load(strategyId);
  let againstAqua = s != null;
  if (s != null) f.strategy = s.id;

  f.orderHash = e.params.orderHash;
  f.maker = e.params.maker;
  f.taker = e.params.taker;
  f.tokenIn = e.params.tokenIn;
  f.tokenOut = e.params.tokenOut;
  f.amountIn = e.params.amountIn;
  f.amountOut = e.params.amountOut;
  f.againstAqua = againstAqua;
  f.blockNumber = e.block.number;
  f.timestamp = e.block.timestamp;
  f.txHash = e.transaction.hash;
  f.save();

  // Load-or-create rather than load-or-drop. A maker whose Shipped predates this
  // subgraph's start block, or a fill that lands before any Shipped in the same
  // block, would otherwise go uncounted forever — and the counter would be quietly
  // wrong rather than visibly missing.
  let m = maker(e.params.maker, e.block.timestamp);
  m.fillsAsMaker = m.fillsAsMaker.plus(ONE);
  m.save();

  let p = protocol();
  p.fills = p.fills.plus(ONE);
  if (againstAqua) p.fillsAgainstAqua = p.fillsAgainstAqua.plus(ONE);
  p.save();
}
