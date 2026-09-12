import {
  assert,
  describe,
  test,
  clearStore,
  afterEach,
  newMockEvent,
} from "matchstick-as/assembly/index";
import { Address, BigInt, Bytes, ethereum } from "@graphprotocol/graph-ts";
import { Shipped, Pushed } from "../generated/Aqua/Aqua";
import { MakerSkipped } from "../generated/Tap/Tap";
import { EncumbranceApplied } from "../generated/SwapVM/SwapVM";
import { handleShipped, handlePushed } from "../src/aqua";
import { handleMakerSkipped } from "../src/tap";
import { handleEncumbranceApplied } from "../src/swapvm";
import { MakerTokenPosition } from "../generated/schema";

const MAKER = "0x1111111111111111111111111111111111111111";
const APP = "0x2222222222222222222222222222222222222222";
const TOKEN = "0x3333333333333333333333333333333333333333";
const HASH = "0x00000000000000000000000000000000000000000000000000000000000000aa";
const TX_HASH = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd";

// Encumbered strategy program: salt (opcode 20), XYCSwap (opcode 17), Opcode 35 (_encumberedCap)
// args: declaredTotal = 8e18, 1 sibling (0x11...11), maxUtilBps = 7500, widenBps = 100
const PROG_HEX = "0x140800000000000003e9110023460000000000000000000000000000000000000000000000006f05b59d3b200000000111111111111111111111111111111111111111111111111111111111111111111d4c0064";

function sid(): string {
  return APP + "-" + HASH;
}

function pid(): string {
  return MAKER + "-" + TOKEN;
}

function mockShippedEncumbered(): Shipped {
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
    new ethereum.EventParam("strategy", ethereum.Value.fromBytes(Bytes.fromHexString(PROG_HEX)))
  );
  return e;
}

function mockPushed(amount: BigInt): Pushed {
  let e = changetype<Pushed>(newMockEvent());
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

function mockMakerSkipped(wanted: BigInt, reason: Bytes, logIndex: i32): MakerSkipped {
  let e = changetype<MakerSkipped>(newMockEvent());
  e.transaction.hash = Bytes.fromHexString(TX_HASH);
  e.logIndex = BigInt.fromI32(logIndex);
  e.address = Address.fromString(APP);
  e.parameters = new Array();
  e.parameters.push(
    new ethereum.EventParam("maker", ethereum.Value.fromAddress(Address.fromString(MAKER)))
  );
  e.parameters.push(
    new ethereum.EventParam("strategyHash", ethereum.Value.fromBytes(Bytes.fromHexString(HASH)))
  );
  e.parameters.push(
    new ethereum.EventParam("token", ethereum.Value.fromAddress(Address.fromString(TOKEN)))
  );
  e.parameters.push(
    new ethereum.EventParam("wanted", ethereum.Value.fromUnsignedBigInt(wanted))
  );
  e.parameters.push(
    new ethereum.EventParam("reason", ethereum.Value.fromBytes(reason))
  );
  return e;
}

function mockEncumbranceApplied(
  encumbered: BigInt,
  backing: BigInt,
  utilBps: BigInt,
  isExactIn: boolean,
  adjFrom: BigInt,
  adjTo: BigInt,
  logIndex: i32
): EncumbranceApplied {
  let e = changetype<EncumbranceApplied>(newMockEvent());
  e.transaction.hash = Bytes.fromHexString(TX_HASH);
  e.logIndex = BigInt.fromI32(logIndex);
  e.address = Address.fromString(APP);
  e.parameters = new Array();
  e.parameters.push(
    new ethereum.EventParam("maker", ethereum.Value.fromAddress(Address.fromString(MAKER)))
  );
  e.parameters.push(
    new ethereum.EventParam("orderHash", ethereum.Value.fromBytes(Bytes.fromHexString(HASH)))
  );
  e.parameters.push(
    new ethereum.EventParam("token", ethereum.Value.fromAddress(Address.fromString(TOKEN)))
  );
  e.parameters.push(
    new ethereum.EventParam("encumbered", ethereum.Value.fromUnsignedBigInt(encumbered))
  );
  e.parameters.push(
    new ethereum.EventParam("backing", ethereum.Value.fromUnsignedBigInt(backing))
  );
  e.parameters.push(
    new ethereum.EventParam("utilBps", ethereum.Value.fromUnsignedBigInt(utilBps))
  );
  e.parameters.push(
    new ethereum.EventParam("isExactIn", ethereum.Value.fromBoolean(isExactIn))
  );
  e.parameters.push(
    new ethereum.EventParam("adjustedFrom", ethereum.Value.fromUnsignedBigInt(adjFrom))
  );
  e.parameters.push(
    new ethereum.EventParam("adjustedTo", ethereum.Value.fromUnsignedBigInt(adjTo))
  );
  e.block.timestamp = BigInt.fromI32(1700000000);
  return e;
}

describe("Phase 6c Encumbrance & Events", () => {
  afterEach(() => {
    clearStore();
  });

  test("decodes opcode 35 program and populates Strategy encumbrance fields", () => {
    handleShipped(mockShippedEncumbered());

    assert.fieldEquals("Strategy", sid(), "usesEncumbrance", "true");
    assert.fieldEquals("Strategy", sid(), "maxUtilBps", "7500");
    assert.fieldEquals("Strategy", sid(), "widenBps", "100");
    assert.fieldEquals(
      "Strategy",
      sid(),
      "declaredSiblings",
      "[0x1111111111111111111111111111111111111111111111111111111111111111]"
    );
  });

  test("two identical MakerSkipped logs in one tx collapse to exactly one MakerRefusal entity", () => {
    let reason = Bytes.fromHexString("0x831f3352");
    let wanted = BigInt.fromI64(50000000);

    // Pass 1: pro-rata slice skip (logIndex 1)
    let e1 = mockMakerSkipped(wanted, reason, 1);
    handleMakerSkipped(e1);

    let refusalId = TX_HASH + "-" + MAKER + "-" + HASH;
    assert.entityCount("MakerRefusal", 1);
    assert.fieldEquals("MakerRefusal", refusalId, "reasonName", "EncumbranceExceeded");
    assert.fieldEquals("MakerRefusal", refusalId, "wanted", "50000000");
    assert.fieldEquals("Maker", MAKER, "skipsAsMaker", "1");

    // Pass 2: sweep skip for remaining within the same swap transaction (logIndex 2)
    let e2 = mockMakerSkipped(wanted, reason, 2);
    handleMakerSkipped(e2);

    // Assert retries collapsed: exactly one MakerRefusal entity exists, skips counter not double-incremented
    assert.entityCount("MakerRefusal", 1);
    assert.fieldEquals("Maker", MAKER, "skipsAsMaker", "1");
  });

  test("MakerSkipped with REASON_QUOTE_UNUSABLE maps reasonName to QuoteUnusable", () => {
    let reason = Bytes.fromHexString("0xffffffff");
    let wanted = BigInt.fromI64(25000000);

    let e = mockMakerSkipped(wanted, reason, 1);
    handleMakerSkipped(e);

    let refusalId = TX_HASH + "-" + MAKER + "-" + HASH;
    assert.fieldEquals("MakerRefusal", refusalId, "reasonName", "QuoteUnusable");
  });

  test("freshly-shipped strategy leaves backing, utilBps, and backingObservedAt null", () => {
    handleShipped(mockShippedEncumbered());
    handlePushed(mockPushed(BigInt.fromString("3000000000000000000")));

    assert.fieldEquals("MakerTokenPosition", pid(), "totalCommitted", "3000000000000000000");
    assert.fieldEquals("MakerTokenPosition", pid(), "activeStrategies", "1");

    let pos = MakerTokenPosition.load(pid())!;
    assert.assertTrue(pos.get("backing") == null);
    assert.assertTrue(pos.get("utilBps") == null);
    assert.assertTrue(pos.get("backingObservedAt") == null);
  });

  test("EncumbranceApplied creates EncumbranceApplication and refreshes MakerTokenPosition", () => {
    // 1. Initial ship and push
    handleShipped(mockShippedEncumbered());
    handlePushed(mockPushed(BigInt.fromString("3000000000000000000"))); // 3 WETH committed

    // Verify initial position has null backing metrics
    assert.fieldEquals("MakerTokenPosition", pid(), "totalCommitted", "3000000000000000000");
    let posBefore = MakerTokenPosition.load(pid())!;
    assert.assertTrue(posBefore.get("backing") == null);
    assert.assertTrue(posBefore.get("utilBps") == null);
    assert.assertTrue(posBefore.get("backingObservedAt") == null);

    // 2. EncumbranceApplied: 10 WETH backing, 80% util, exactIn, logIndex 5
    let e = mockEncumbranceApplied(
      BigInt.fromString("8000000000000000000"),  // encumbered: 8 WETH
      BigInt.fromString("10000000000000000000"), // backing: 10 WETH
      BigInt.fromI32(8000),                      // utilBps: 8000
      true,                                      // isExactIn
      BigInt.fromString("1000000000000000000"),  // adjustedFrom
      BigInt.fromString("950000000000000000"),   // adjustedTo
      5
    );
    handleEncumbranceApplied(e);

    // Verify EncumbranceApplication entity created
    let appId = Bytes.fromHexString(TX_HASH).concatI32(5).toHexString();
    assert.entityCount("EncumbranceApplication", 1);
    assert.fieldEquals("EncumbranceApplication", appId, "utilBps", "8000");
    assert.fieldEquals("EncumbranceApplication", appId, "isExactIn", "true");
    assert.fieldEquals("EncumbranceApplication", appId, "backing", "10000000000000000000");
    assert.fieldEquals("EncumbranceApplication", appId, "encumbered", "8000000000000000000");

    // Verify MakerTokenPosition refreshed: backing = 10 WETH, utilBps = (3 WETH / 10 WETH) * 10000 = 3000 bps, backingObservedAt = 1700000000
    assert.fieldEquals("MakerTokenPosition", pid(), "backing", "10000000000000000000");
    assert.fieldEquals("MakerTokenPosition", pid(), "utilBps", "3000");
    assert.fieldEquals("MakerTokenPosition", pid(), "backingObservedAt", "1700000000");
  });
});