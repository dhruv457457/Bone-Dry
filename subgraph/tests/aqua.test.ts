import {
  assert,
  describe,
  test,
  clearStore,
  afterEach,
  newMockEvent,
} from "matchstick-as/assembly/index";
import { Address, BigInt, Bytes, ethereum } from "@graphprotocol/graph-ts";
import { Shipped, Docked, Pushed, Pulled } from "../generated/Aqua/Aqua";
import { handleShipped, handleDocked, handlePushed, handlePulled } from "../src/aqua";

/**
 * The handlers see whatever order the chain hands them, and real Base data only
 * exercises the happy path. These are the orderings that would corrupt the one
 * number this index exists to produce — MakerTokenPosition.totalCommitted —
 * without ever throwing.
 */

const MAKER = "0x1111111111111111111111111111111111111111";
const APP = "0x2222222222222222222222222222222222222222";
const TOKEN = "0x3333333333333333333333333333333333333333";
const HASH = "0x00000000000000000000000000000000000000000000000000000000000000aa";

function sid(): string {
  return APP + "-" + HASH;
}
function pid(): string {
  return MAKER + "-" + TOKEN;
}

function shipped(): Shipped {
  let e = changetype<Shipped>(newMockEvent());
  e.parameters = new Array();
  e.parameters.push(
    new ethereum.EventParam("maker", ethereum.Value.fromAddress(Address.fromString(MAKER)))
  );
  e.parameters.push(
    new ethereum.EventParam("app", ethereum.Value.fromAddress(Address.fromString(APP)))
  );
  e.parameters.push(
    new ethereum.EventParam("strategyHash", ethereum.Value.fromBytes(Bytes.fromHexString(HASH)))
  );
  e.parameters.push(
    new ethereum.EventParam("strategy", ethereum.Value.fromBytes(Bytes.fromHexString("0x1100")))
  );
  return e;
}

function docked(): Docked {
  let e = changetype<Docked>(newMockEvent());
  e.parameters = new Array();
  e.parameters.push(
    new ethereum.EventParam("maker", ethereum.Value.fromAddress(Address.fromString(MAKER)))
  );
  e.parameters.push(
    new ethereum.EventParam("app", ethereum.Value.fromAddress(Address.fromString(APP)))
  );
  e.parameters.push(
    new ethereum.EventParam("strategyHash", ethereum.Value.fromBytes(Bytes.fromHexString(HASH)))
  );
  return e;
}

function moved<T>(amount: BigInt): T {
  let e = changetype<T>(newMockEvent());
  e.parameters = new Array();
  e.parameters.push(
    new ethereum.EventParam("maker", ethereum.Value.fromAddress(Address.fromString(MAKER)))
  );
  e.parameters.push(
    new ethereum.EventParam("app", ethereum.Value.fromAddress(Address.fromString(APP)))
  );
  e.parameters.push(
    new ethereum.EventParam("strategyHash", ethereum.Value.fromBytes(Bytes.fromHexString(HASH)))
  );
  e.parameters.push(
    new ethereum.EventParam("token", ethereum.Value.fromAddress(Address.fromString(TOKEN)))
  );
  e.parameters.push(
    new ethereum.EventParam("amount", ethereum.Value.fromUnsignedBigInt(amount))
  );
  return e;
}

describe("Aqua handlers", () => {
  afterEach(() => {
    clearStore();
  });

  test("ship then push records the commitment once", () => {
    handleShipped(shipped());
    handlePushed(moved<Pushed>(BigInt.fromI32(100)));

    assert.fieldEquals("MakerTokenPosition", pid(), "totalCommitted", "100");
    assert.fieldEquals("MakerTokenPosition", pid(), "activeStrategies", "1");
    assert.fieldEquals("Strategy", sid(), "active", "true");
  });

  test("a second push to the same token adds without a second position", () => {
    handleShipped(shipped());
    handlePushed(moved<Pushed>(BigInt.fromI32(100)));
    handlePushed(moved<Pushed>(BigInt.fromI32(50)));

    assert.fieldEquals("MakerTokenPosition", pid(), "totalCommitted", "150");
    assert.fieldEquals("MakerTokenPosition", pid(), "activeStrategies", "1");
  });

  test("dock releases exactly what was committed", () => {
    handleShipped(shipped());
    handlePushed(moved<Pushed>(BigInt.fromI32(100)));
    handleDocked(docked());

    assert.fieldEquals("MakerTokenPosition", pid(), "totalCommitted", "0");
    assert.fieldEquals("MakerTokenPosition", pid(), "activeStrategies", "0");
    assert.fieldEquals("Strategy", sid(), "active", "false");
  });

  test("pull reduces the commitment", () => {
    handleShipped(shipped());
    handlePushed(moved<Pushed>(BigInt.fromI32(100)));
    handlePulled(moved<Pulled>(BigInt.fromI32(40)));

    assert.fieldEquals("MakerTokenPosition", pid(), "totalCommitted", "60");
    assert.fieldEquals("Commitment", sid() + "-" + TOKEN, "totalPulled", "40");
  });

  test("a pull larger than the commitment floors at zero rather than wrapping", () => {
    handleShipped(shipped());
    handlePushed(moved<Pushed>(BigInt.fromI32(100)));
    handlePulled(moved<Pulled>(BigInt.fromI32(500)));

    assert.fieldEquals("MakerTokenPosition", pid(), "totalCommitted", "0");
  });

  test("events for a strategy that was never shipped are ignored, not crashed on", () => {
    handlePushed(moved<Pushed>(BigInt.fromI32(100)));
    handlePulled(moved<Pulled>(BigInt.fromI32(100)));
    handleDocked(docked());

    assert.entityCount("Strategy", 0);
    assert.entityCount("MakerTokenPosition", 0);
  });

  test("re-shipping a docked strategy does not leave the old commitment behind", () => {
    handleShipped(shipped());
    handlePushed(moved<Pushed>(BigInt.fromI32(100)));
    handleDocked(docked());

    handleShipped(shipped());
    handlePushed(moved<Pushed>(BigInt.fromI32(70)));

    // 70 is the whole of the new life, not 170 carried over from the old one
    assert.fieldEquals("MakerTokenPosition", pid(), "totalCommitted", "70");
    assert.fieldEquals("MakerTokenPosition", pid(), "activeStrategies", "1");
    assert.fieldEquals("Strategy", sid(), "active", "true");
  });

  test("re-shipping WITHOUT docking first still releases the stale commitment", () => {
    handleShipped(shipped());
    handlePushed(moved<Pushed>(BigInt.fromI32(100)));

    // no Docked in between — the row is reused while it still claims 100
    handleShipped(shipped());
    handlePushed(moved<Pushed>(BigInt.fromI32(70)));

    assert.fieldEquals("MakerTokenPosition", pid(), "totalCommitted", "70");
    assert.fieldEquals("MakerTokenPosition", pid(), "activeStrategies", "1");
  });

  test("docking twice does not drive the counters negative", () => {
    handleShipped(shipped());
    handlePushed(moved<Pushed>(BigInt.fromI32(100)));
    handleDocked(docked());
    handleDocked(docked());

    assert.fieldEquals("MakerTokenPosition", pid(), "totalCommitted", "0");
    assert.fieldEquals("MakerTokenPosition", pid(), "activeStrategies", "0");
    assert.fieldEquals("Maker", MAKER, "activeStrategies", "0");
    assert.fieldEquals("Protocol", "1", "strategiesActive", "0");
  });
});
