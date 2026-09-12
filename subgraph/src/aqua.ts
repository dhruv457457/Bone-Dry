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
    p.skips = ZERO;
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
    m.skipsAsMaker = ZERO;
    m.totalVolumeSkipped = ZERO;
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

export class DecodedEncumbrance {
  usesEncumbrance: boolean;
  maxUtilBps: i32;
  widenBps: i32;
  declaredSiblings: Array<Bytes>;

  constructor() {
    this.usesEncumbrance = false;
    this.maxUtilBps = 0;
    this.widenBps = 0;
    this.declaredSiblings = new Array<Bytes>();
  }
}

export function extractProgram(strategy: Bytes): Bytes {
  // If ABI-encoded Order:
  // Offset 0x00..0x20 is offset to tuple (0x20 = 32)
  // Length is at least 160 bytes (0xa0)
  if (strategy.length >= 160) {
    let isAbiEncoded = true;
    for (let i = 0; i < 31; i++) {
      if (strategy[i] != 0) {
        isAbiEncoded = false;
        break;
      }
    }
    if (isAbiEncoded && strategy[31] == 0x20) {
      // It is abi.encode(Order)
      // traits is at offset 0x40 (64)
      // orderDataIndexes has index3 at bytes 4..5 of traits
      let programStartInData = (i32(strategy[64 + 4]) << 8) | i32(strategy[64 + 5]);

      // data offset is at strategy[96..128]. For standard Order, offset from struct start (32) is 96, so 32+96 = 128 (0x80)
      let dataOffset = 32 + ((i32(strategy[124]) << 24) | (i32(strategy[125]) << 16) | (i32(strategy[126]) << 8) | i32(strategy[127]));
      if (dataOffset + 32 <= strategy.length) {
        let dataLength = (i32(strategy[dataOffset + 28]) << 24) | (i32(strategy[dataOffset + 29]) << 16) | (i32(strategy[dataOffset + 30]) << 8) | i32(strategy[dataOffset + 31]);
        let dataStart = dataOffset + 32;
        let programStart = dataStart + programStartInData;
        let programEnd = dataStart + dataLength;
        if (programStart <= programEnd && programEnd <= strategy.length) {
          return changetype<Bytes>(strategy.slice(programStart, programEnd));
        }
      }
    }
  }
  return strategy;
}

export function decodeEncumbrance(program: Bytes): DecodedEncumbrance {
  let result = new DecodedEncumbrance();
  let pc = 0;
  while (pc + 2 <= program.length) {
    let opcode = program[pc];
    let argsLen = i32(program[pc + 1]);
    let argsStart = pc + 2;
    let nextPC = argsStart + argsLen;
    if (nextPC > program.length) {
      break;
    }
    if (opcode == 35) {
      result.usesEncumbrance = true;
      if (argsLen >= 38) {
        let siblingCount = (i32(program[argsStart + 32]) << 8) | i32(program[argsStart + 33]);
        let hashesEnd = argsStart + 34 + (siblingCount * 32);
        if (hashesEnd + 4 <= nextPC) {
          let siblings = new Array<Bytes>();
          for (let i = 0; i < siblingCount; i++) {
            let sibStart = argsStart + 34 + (i * 32);
            siblings.push(changetype<Bytes>(program.slice(sibStart, sibStart + 32)));
          }
          result.declaredSiblings = siblings;
          result.maxUtilBps = (i32(program[hashesEnd]) << 8) | i32(program[hashesEnd + 1]);
          result.widenBps = (i32(program[hashesEnd + 2]) << 8) | i32(program[hashesEnd + 3]);
        }
      }
      return result;
    }
    pc = nextPC;
  }
  return result;
}

export function handleShipped(e: Shipped): void {
  let ts = e.block.timestamp;
  let m = maker(e.params.maker, ts);
  m.totalStrategies = m.totalStrategies.plus(ONE);
  m.activeStrategies = m.activeStrategies.plus(ONE);
  m.save();

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

  let program = extractProgram(e.params.strategy);
  let enc = decodeEncumbrance(program);
  s.usesEncumbrance = enc.usesEncumbrance;
  s.maxUtilBps = enc.maxUtilBps;
  s.widenBps = enc.widenBps;
  s.declaredSiblings = enc.declaredSiblings;

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
