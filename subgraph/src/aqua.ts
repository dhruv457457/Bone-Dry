import { BigInt, Bytes, Address, store } from "@graphprotocol/graph-ts";
import { Shipped, Docked, Pulled, Pushed } from "../generated/Aqua/Aqua";
import { Protocol, Maker, Strategy, Commitment, MakerTokenPosition } from "../generated/schema";

const ZERO = BigInt.fromI32(0);
const ONE = BigInt.fromI32(1);

export function protocol(): Protocol {
  let p = Protocol.load("1");
  if (p == null) {
    p = new Protocol("1");
    p.strategiesShipped = ZERO;
    p.strategiesActive = ZERO;
    p.makers = ZERO;
    p.fills = ZERO;
    p.fillsAgainstAqua = ZERO;
  }
  return p as Protocol;
}

export function maker(addr: Address, ts: BigInt): Maker {
  let m = Maker.load(addr.toHexString());
  if (m == null) {
    m = new Maker(addr.toHexString());
    m.firstSeen = ts;
    m.activeStrategies = ZERO;
    m.totalStrategies = ZERO;
    m.fillsAsMaker = ZERO;
    let p = protocol();
    p.makers = p.makers.plus(ONE);
    p.save();
  }
  return m as Maker;
}

function sid(app: Address, hash: Bytes): string {
  return app.toHexString() + "-" + hash.toHexString();
}
function cid(app: Address, hash: Bytes, token: Address): string {
  return sid(app, hash) + "-" + token.toHexString();
}
function pid(m: Address, token: Address): string {
  return m.toHexString() + "-" + token.toHexString();
}

function position(m: Address, token: Address, ts: BigInt): MakerTokenPosition {
  let p = MakerTokenPosition.load(pid(m, token));
  if (p == null) {
    p = new MakerTokenPosition(pid(m, token));
    p.maker = m.toHexString();
    p.token = token;
    p.totalCommitted = ZERO;
    p.activeStrategies = ZERO;
  }
  p.updatedAt = ts;
  return p as MakerTokenPosition;
}

export function handleShipped(e: Shipped): void {
  let ts = e.block.timestamp;
  let m = maker(e.params.maker, ts);
  m.totalStrategies = m.totalStrategies.plus(ONE);
  m.activeStrategies = m.activeStrategies.plus(ONE);
  m.save();

  // Shipped carries no amounts — the initial balances arrive as Pushed events
  // from inside ship(). So there is nothing to double count here.
  //
  // A strategyHash is deterministic, so docking and shipping the same program
  // again reuses this id. Overwriting it with `new Strategy` would blank
  // `tokens` while the previous life's Commitment rows survived: handlePushed
  // skips the token-list bookkeeping for a Commitment that already exists, so
  // the list would stay empty, the next Docked would unwind nothing, and
  // MakerTokenPosition.totalCommitted would drift permanently high. Reuse the
  // row and clear the stale commitments instead.
  let id = sid(e.params.app, e.params.strategyHash);
  let s = Strategy.load(id);
  let reship = s != null;
  if (s == null) s = new Strategy(id);

  if (reship) {
    let stale = s.tokens;
    for (let i = 0; i < stale.length; i++) {
      let token = Address.fromBytes(stale[i]);
      let c = Commitment.load(cid(e.params.app, e.params.strategyHash, token));
      if (c == null) continue;
      if (c.remaining.gt(ZERO)) {
        // whatever the previous life still claimed was never pulled or docked
        let pos = position(e.params.maker, token, ts);
        pos.totalCommitted = pos.totalCommitted.gt(c.remaining)
          ? pos.totalCommitted.minus(c.remaining)
          : ZERO;
        pos.activeStrategies = pos.activeStrategies.gt(ZERO) ? pos.activeStrategies.minus(ONE) : ZERO;
        pos.save();
      }
      store.remove("Commitment", c.id);
    }
  }

  s.maker = m.id;
  s.app = e.params.app;
  s.strategyHash = e.params.strategyHash;
  s.strategy = e.params.strategy;
  s.active = true;
  s.shippedAt = ts;
  s.shippedTx = e.transaction.hash;
  s.dockedAt = null;
  s.tokens = [];
  s.save();

  let p = protocol();
  p.strategiesShipped = p.strategiesShipped.plus(ONE);
  p.strategiesActive = p.strategiesActive.plus(ONE);
  p.save();
}

export function handleDocked(e: Docked): void {
  let s = Strategy.load(sid(e.params.app, e.params.strategyHash));
  if (s == null) return;

  s.active = false;
  s.dockedAt = e.block.timestamp;

  // Docked zeroes every token at once, so unwind each commitment we recorded.
  let tokens = s.tokens;
  for (let i = 0; i < tokens.length; i++) {
    let token = Address.fromBytes(tokens[i]);
    let c = Commitment.load(cid(e.params.app, e.params.strategyHash, token));
    if (c == null) continue;

    let pos = position(e.params.maker, token, e.block.timestamp);
    pos.totalCommitted = pos.totalCommitted.minus(c.remaining);
    if (pos.totalCommitted.lt(ZERO)) pos.totalCommitted = ZERO;
    pos.activeStrategies = pos.activeStrategies.gt(ZERO) ? pos.activeStrategies.minus(ONE) : ZERO;
    pos.save();

    c.remaining = ZERO;
    c.save();
  }
  s.save();

  let m = Maker.load(e.params.maker.toHexString());
  if (m != null) {
    m.activeStrategies = m.activeStrategies.gt(ZERO) ? m.activeStrategies.minus(ONE) : ZERO;
    m.save();
  }

  let p = protocol();
  p.strategiesActive = p.strategiesActive.gt(ZERO) ? p.strategiesActive.minus(ONE) : ZERO;
  p.save();
}

export function handlePushed(e: Pushed): void {
  let s = Strategy.load(sid(e.params.app, e.params.strategyHash));
  if (s == null) return;

  let id = cid(e.params.app, e.params.strategyHash, e.params.token);
  let c = Commitment.load(id);
  if (c == null) {
    c = new Commitment(id);
    c.strategy = s.id;
    c.maker = e.params.maker.toHexString();
    c.token = e.params.token;
    c.remaining = ZERO;
    c.totalPushed = ZERO;
    c.totalPulled = ZERO;

    let tokens = s.tokens;
    tokens.push(e.params.token);
    s.tokens = tokens;
    s.save();

    let pos = position(e.params.maker, e.params.token, e.block.timestamp);
    pos.activeStrategies = pos.activeStrategies.plus(ONE);
    pos.save();
  }

  c.remaining = c.remaining.plus(e.params.amount);
  c.totalPushed = c.totalPushed.plus(e.params.amount);
  c.save();

  let pos2 = position(e.params.maker, e.params.token, e.block.timestamp);
  pos2.totalCommitted = pos2.totalCommitted.plus(e.params.amount);
  pos2.save();
}

export function handlePulled(e: Pulled): void {
  let c = Commitment.load(cid(e.params.app, e.params.strategyHash, e.params.token));
  if (c == null) return;

  c.remaining = c.remaining.gt(e.params.amount) ? c.remaining.minus(e.params.amount) : ZERO;
  c.totalPulled = c.totalPulled.plus(e.params.amount);
  c.save();

  let pos = position(e.params.maker, e.params.token, e.block.timestamp);
  pos.totalCommitted = pos.totalCommitted.gt(e.params.amount)
    ? pos.totalCommitted.minus(e.params.amount)
    : ZERO;
  pos.save();
}
