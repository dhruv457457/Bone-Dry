import { BigInt } from "@graphprotocol/graph-ts";
import { Swapped } from "../generated/SwapVM/SwapVM";
import { Fill, Strategy, Maker, Protocol } from "../generated/schema";

const ONE = BigInt.fromI32(1);

/**
 * The join the 1inch docs specify: Swapped.orderHash == Shipped.strategyHash.
 * The router address is the `app` a strategy was shipped under, so the Strategy
 * id reconstructs directly.
 */
export function handleSwapped(e: Swapped): void {
  let f = new Fill(e.transaction.hash.toHexString() + "-" + e.logIndex.toString());

  let strategyId = e.address.toHexString() + "-" + e.params.orderHash.toHexString();
  let s = Strategy.load(strategyId);
  if (s != null) f.strategy = s.id;

  f.orderHash = e.params.orderHash;
  f.maker = e.params.maker;
  f.taker = e.params.taker;
  f.tokenIn = e.params.tokenIn;
  f.tokenOut = e.params.tokenOut;
  f.amountIn = e.params.amountIn;
  f.amountOut = e.params.amountOut;
  f.blockNumber = e.block.number;
  f.timestamp = e.block.timestamp;
  f.txHash = e.transaction.hash;
  f.save();

  let m = Maker.load(e.params.maker.toHexString());
  if (m != null) {
    m.fillsAsMaker = m.fillsAsMaker.plus(ONE);
    m.save();
  }

  let p = Protocol.load("1");
  if (p != null) {
    p.fills = p.fills.plus(ONE);
    p.save();
  }
}
