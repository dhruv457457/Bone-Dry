import type { Hex } from "viem";

/**
 * Maximum siblings encodable in a single SwapVM instruction (uint8 argsLength limit = 255 bytes).
 * Fixed overhead = 32 (declaredTotalEncumbrance) + 2 (siblingCount) + 2 (maxUtilBps) + 2 (widenBps) = 38 bytes.
 * (255 - 38) / 32 = 6 siblings max.
 *
 * Matches EncumbranceArgsBuilder.MAX_INSTRUCTION_SIBLINGS in contracts/src/vm/Encumbrance.sol:18
 */
export const MAX_INSTRUCTION_SIBLINGS = 6;

/**
 * Opcode for OP_ENCUMBERED_CAP in BoneDryOpcodes.
 * Matches BoneDryOpcodes.sol:17
 */
export const OP_ENCUMBERED_CAP = 35; // 0x23

export class EncumbranceBuildingSiblingCountExceedsCapacity extends Error {
  constructor(count: number, maxAllowed: number = MAX_INSTRUCTION_SIBLINGS) {
    super(`sibling count ${count} exceeds maximum allowed capacity ${maxAllowed}`);
    this.name = "EncumbranceBuildingSiblingCountExceedsCapacity";
  }
}

export class EncumbranceParsingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EncumbranceParsingError";
  }
}

export interface EncumbranceArgs {
  declaredTotalEncumbrance: bigint;
  siblingHashes: Hex[];
  maxUtilBps: number;
  widenBps: number;
}

/**
 * Builds packed instruction calldata for OP_ENCUMBERED_CAP (opcode 35).
 * Matches EncumbranceArgsBuilder.build() in contracts/src/vm/Encumbrance.sol:33-50 byte for byte:
 *
 *   [0:32]              uint256  declaredTotalEncumbrance   (big-endian)
 *   [32:34]             uint16   siblingCount               (big-endian)
 *   [34 : 34+32n]       bytes32  siblingHashes[siblingCount]
 *   [34+32n : 36+32n]   uint16   maxUtilBps                 (big-endian)
 *   [36+32n : 38+32n]   uint16   widenBps                   (big-endian)
 */
export function buildEncumbranceArgs(args: EncumbranceArgs): Hex {
  const { declaredTotalEncumbrance, siblingHashes, maxUtilBps, widenBps } = args;

  if (siblingHashes.length > MAX_INSTRUCTION_SIBLINGS) {
    throw new EncumbranceBuildingSiblingCountExceedsCapacity(siblingHashes.length, MAX_INSTRUCTION_SIBLINGS);
  }
  if (declaredTotalEncumbrance < 0n || declaredTotalEncumbrance >= 1n << 256n) {
    throw new RangeError(`declaredTotalEncumbrance ${declaredTotalEncumbrance} out of uint256 range`);
  }
  if (!Number.isSafeInteger(maxUtilBps) || maxUtilBps < 0 || maxUtilBps > 65535) {
    throw new RangeError(`maxUtilBps ${maxUtilBps} out of uint16 range`);
  }
  if (!Number.isSafeInteger(widenBps) || widenBps < 0 || widenBps > 65535) {
    throw new RangeError(`widenBps ${widenBps} out of uint16 range`);
  }

  const totalLength = 38 + 32 * siblingHashes.length;
  const buffer = new Uint8Array(totalLength);
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);

  // [0:32] declaredTotalEncumbrance (uint256, big-endian)
  let temp = declaredTotalEncumbrance;
  for (let i = 31; i >= 0; i--) {
    buffer[i] = Number(temp & 0xffn);
    temp >>= 8n;
  }

  // [32:34] siblingCount (uint16, big-endian)
  view.setUint16(32, siblingHashes.length, false);

  // [34 : 34+32n] siblingHashes (bytes32 each)
  let offset = 34;
  for (let sIdx = 0; sIdx < siblingHashes.length; sIdx++) {
    const hash = siblingHashes[sIdx];
    const clean = hash.startsWith("0x") ? hash.slice(2) : hash;
    if (clean.length !== 64 || !/^[0-9a-fA-F]{64}$/.test(clean)) {
      throw new TypeError(`Invalid siblingHash at index ${sIdx}: expected 32 bytes (64 hex chars), got "${hash}"`);
    }
    for (let i = 0; i < 32; i++) {
      buffer[offset + i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    }
    offset += 32;
  }

  // [34+32n : 36+32n] maxUtilBps (uint16, big-endian)
  view.setUint16(offset, maxUtilBps, false);
  offset += 2;

  // [36+32n : 38+32n] widenBps (uint16, big-endian)
  view.setUint16(offset, widenBps, false);

  const hexBody = Array.from(buffer)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  return `0x${hexBody}` as Hex;
}

/**
 * Parses packed instruction arguments for OP_ENCUMBERED_CAP.
 * Matches EncumbranceArgsBuilder.parse() in contracts/src/vm/Encumbrance.sol:59-80.
 */
export function parseEncumbranceArgs(data: Hex | Uint8Array): EncumbranceArgs {
  const bytes =
    typeof data === "string"
      ? (() => {
          const clean = data.startsWith("0x") ? data.slice(2) : data;
          if (clean.length % 2 !== 0) {
            throw new EncumbranceParsingError(`Hex data has odd length ${clean.length}`);
          }
          const out = new Uint8Array(clean.length / 2);
          for (let i = 0; i < out.length; i++) {
            out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
          }
          return out;
        })()
      : data;

  if (bytes.length < 38) {
    throw new EncumbranceParsingError(`Encumbrance args too short: expected >= 38 bytes, got ${bytes.length}`);
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // [0:32] declaredTotalEncumbrance (uint256)
  let declaredTotalEncumbrance = 0n;
  for (let i = 0; i < 32; i++) {
    declaredTotalEncumbrance = (declaredTotalEncumbrance << 8n) | BigInt(bytes[i]);
  }

  // [32:34] siblingCount (uint16)
  const siblingCount = view.getUint16(32, false);
  if (siblingCount > MAX_INSTRUCTION_SIBLINGS) {
    throw new EncumbranceParsingError(
      `siblingCount ${siblingCount} exceeds capacity ${MAX_INSTRUCTION_SIBLINGS}`
    );
  }

  const expectedLength = 38 + 32 * siblingCount;
  if (bytes.length < expectedLength) {
    throw new EncumbranceParsingError(
      `Encumbrance args truncated: expected ${expectedLength} bytes for ${siblingCount} siblings, got ${bytes.length}`
    );
  }

  const siblingHashes: Hex[] = [];
  let offset = 34;
  for (let i = 0; i < siblingCount; i++) {
    const hashHex = Array.from(bytes.slice(offset, offset + 32))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    siblingHashes.push(`0x${hashHex}` as Hex);
    offset += 32;
  }

  const maxUtilBps = view.getUint16(offset, false);
  offset += 2;

  const widenBps = view.getUint16(offset, false);

  return {
    declaredTotalEncumbrance,
    siblingHashes,
    maxUtilBps,
    widenBps,
  };
}

/**
 * Builds the complete SwapVM instruction for OP_ENCUMBERED_CAP:
 *   [0]      uint8 opcode (35 = 0x23)
 *   [1]      uint8 argsLength
 *   [2 : ..] encArgs (packed EncumbranceArgs)
 */
export function buildEncumbranceInstruction(args: EncumbranceArgs): Hex {
  const encArgs = buildEncumbranceArgs(args);
  const cleanArgs = encArgs.slice(2);
  const argLen = cleanArgs.length / 2;
  if (argLen > 255) {
    throw new RangeError(`Encumbrance args length ${argLen} exceeds uint8 limit (255)`);
  }
  const opcodeHex = OP_ENCUMBERED_CAP.toString(16).padStart(2, "0");
  const lenHex = argLen.toString(16).padStart(2, "0");
  return `0x${opcodeHex}${lenHex}${cleanArgs}` as Hex;
}

/**
 * Finds and decodes the OP_ENCUMBERED_CAP instruction from a SwapVM program hex string.
 * Iterates instructions: uint8 opcode, uint8 argsLength, args.
 */
export function findEncumbranceInProgram(
  programHex: string
): { opcode: number; argsLength: number; args: EncumbranceArgs; offset: number } | null {
  const clean = programHex.startsWith("0x") ? programHex.slice(2) : programHex;
  let offset = 0; // byte offset

  while (offset + 2 <= clean.length / 2) {
    const opcode = parseInt(clean.slice(offset * 2, offset * 2 + 2), 16);
    const argsLen = parseInt(clean.slice((offset + 1) * 2, (offset + 1) * 2 + 2), 16);
    const instrEnd = offset + 2 + argsLen;

    if (instrEnd > clean.length / 2) {
      break; // Corrupt instruction or end of stream
    }

    if (opcode === OP_ENCUMBERED_CAP) {
      const rawArgsHex = clean.slice((offset + 2) * 2, instrEnd * 2);
      const args = parseEncumbranceArgs(`0x${rawArgsHex}`);
      return {
        opcode,
        argsLength: argsLen,
        args,
        offset,
      };
    }

    offset = instrEnd;
  }

  return null;
}
