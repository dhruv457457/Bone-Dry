// SPDX-License-Identifier: LicenseRef-Degensoft-SwapVM-1.1
pragma solidity 0.8.30;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeCast } from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { Calldata } from "@1inch/solidity-utils/contracts/libraries/Calldata.sol";
import { IAqua } from "../interfaces/IAqua.sol";
import { Context } from "@1inch/swap-vm/libs/VM.sol";

library EncumbranceArgsBuilder {
    using SafeCast for uint256;
    using Calldata for bytes;

    /// @notice Maximum siblings encodable in a single SwapVM instruction (uint8 argsLength limit = 255 bytes).
    /// Fixed overhead = 32 (declaredTotalEncumbrance) + 2 (siblingCount) + 2 (maxUtilBps) + 2 (widenBps) = 38 bytes.
    /// (255 - 38) / 32 = 6 siblings max.
    uint256 internal constant MAX_INSTRUCTION_SIBLINGS = 6;

    error EncumbranceParsingMissingDeclaredTotal();
    error EncumbranceParsingMissingSiblingCount();
    error EncumbranceParsingMissingSiblingHashes();
    error EncumbranceParsingMissingMaxUtilBps();
    error EncumbranceParsingMissingWidenBps();
    error EncumbranceParsingSiblingCountExceedsCapacity(uint256 siblingCount, uint256 maxAllowed);
    error EncumbranceBuildingSiblingCountExceedsCapacity(uint256 siblingCount, uint256 maxAllowed);

    /// @notice Builds packed instruction calldata for OP_ENCUMBERED_CAP (opcode 35)
    /// @param declaredTotalEncumbrance Maker's declared total encumbrance across all strategies
    /// @param siblingHashes Hashes of sibling strategies sampled on-chain for spot-check (max 6)
    /// @param maxUtilBps Maximum utilisation basis points (1e4 = 100%) before reverting
    /// @param widenBps Haircut basis points applied to amountOut at 100% utilisation
    function build(
        uint256 declaredTotalEncumbrance,
        bytes32[] memory siblingHashes,
        uint16 maxUtilBps,
        uint16 widenBps
    ) internal pure returns (bytes memory) {
        if (siblingHashes.length > MAX_INSTRUCTION_SIBLINGS) {
            revert EncumbranceBuildingSiblingCountExceedsCapacity(siblingHashes.length, MAX_INSTRUCTION_SIBLINGS);
        }
        bytes memory packed = abi.encodePacked(
            declaredTotalEncumbrance,
            siblingHashes.length.toUint16()
        );
        for (uint256 i = 0; i < siblingHashes.length; i++) {
            packed = abi.encodePacked(packed, siblingHashes[i]);
        }
        return abi.encodePacked(packed, maxUtilBps, widenBps);
    }

    /// @notice Parses packed instruction calldata for OP_ENCUMBERED_CAP
    /// @param args Calldata arguments:
    ///   [0:32]            uint256 declaredTotalEncumbrance
    ///   [32:34]           uint16  siblingCount
    ///   [34 : 34+32n]     bytes32 siblingHashes[siblingCount]
    ///   [34+32n : 36+32n] uint16  maxUtilBps
    ///   [36+32n : 38+32n] uint16  widenBps
    function parse(bytes calldata args) internal pure returns (
        uint256 declaredTotalEncumbrance,
        uint256 siblingCount,
        bytes calldata siblingHashes,
        uint16 maxUtilBps,
        uint16 widenBps
    ) {
        unchecked {
            declaredTotalEncumbrance = uint256(bytes32(args.slice(0, 32, EncumbranceParsingMissingDeclaredTotal.selector)));
            siblingCount = uint16(bytes2(args.slice(32, 34, EncumbranceParsingMissingSiblingCount.selector)));
            if (siblingCount > MAX_INSTRUCTION_SIBLINGS) {
                revert EncumbranceParsingSiblingCountExceedsCapacity(siblingCount, MAX_INSTRUCTION_SIBLINGS);
            }
            uint256 hashesEnd = 34 + 32 * siblingCount;
            uint256 maxUtilEnd = hashesEnd + 2;
            uint256 widenEnd = maxUtilEnd + 2;

            siblingHashes = args.slice(34, hashesEnd, EncumbranceParsingMissingSiblingHashes.selector);
            maxUtilBps = uint16(bytes2(args.slice(hashesEnd, maxUtilEnd, EncumbranceParsingMissingMaxUtilBps.selector)));
            widenBps = uint16(bytes2(args.slice(maxUtilEnd, widenEnd, EncumbranceParsingMissingWidenBps.selector)));
        }
    }
}

abstract contract Encumbrance {
    using Calldata for bytes;

    /// @dev Marker used by Aqua to signify that a strategy has been docked
    uint8 private constant _AQUA_DOCKED = 0xff;

    /// @notice Maximum siblings encodable in a single SwapVM instruction (uint8 argsLength limit = 255 bytes).
    /// @dev Enforced explicitly in EncumbranceArgsBuilder.parse() and build().
    uint256 public constant MAX_INSTRUCTION_SIBLINGS = EncumbranceArgsBuilder.MAX_INSTRUCTION_SIBLINGS;

    /// @dev Reverts when maker has zero deliverable backing (balance == 0 or allowance == 0)
    error EncumbranceZeroBacking();

    /// @dev Reverts when maker's declared total encumbrance is less than the sampled sibling obligations
    error EncumbranceUnderdeclared(uint256 declaredTotal, uint256 sampledTotal);

    /// @dev Reverts when encumbrance utilisation exceeds the allowed maximum
    error EncumbranceExceeded(uint256 util, uint256 maxUtilBps);

    /// @dev Reverts when required output exceeds deliverable unencumbered backing
    error EncumbranceInsufficient(uint256 amountOut, uint256 free);

    /// @notice Emitted when the encumbrance curve was applied to a real fill.
    /// @dev Never emitted during quote() — see the isStaticContext guard. A refusal
    ///      emits nothing at all, because the transaction reverts; refusals are
    ///      observed by Tap.sol instead.
    event EncumbranceApplied(
        address indexed maker,
        bytes32 indexed orderHash,
        address indexed token,      // tokenOut, the encumbered side
        uint256 encumbered,
        uint256 backing,
        uint256 utilBps,
        bool    isExactIn,
        uint256 adjustedFrom,       // amountOut (exactIn) or amountIn (exactOut), before
        uint256 adjustedTo          // ...and after
    );

    /// @dev Provides access to IAqua, implemented by BoneDryOpcodes via AquaOpcodes._AQUA
    function _aqua() internal view virtual returns (IAqua);

    /// @notice Encumbrance-aware quote curve and solvency floor instruction.
    /// @dev Executes after pricing instructions set ctx.swap.amountOut (exactIn) or ctx.swap.amountIn (exactOut).
    ///
    /// QUOTE/SWAP DIVERGENCE: In quote mode (isStaticContext=true), this instruction reads balances
    /// and allowances at the instant of evaluation. Between quote() and swap(), a sibling strategy
    /// may be filled or the maker may withdraw funds or revoke approvals. If subsequent utilisation
    /// reaches maxUtilBps or deliverable free backing drops below amountOut, the swap() call will revert
    /// (EncumbranceExceeded or EncumbranceInsufficient). This dynamic divergence is intentional: the
    /// instruction protects takers from toxic or empty executions.
    ///
    /// EXACT-IN VS EXACT-OUT DYNAMICS:
    /// - exactIn (ctx.query.isExactIn == true): amountIn is fixed by taker; amountOut was computed by pricing.
    ///   Encumbrance widens price by haircutting (decreasing) amountOut.
    /// - exactOut (ctx.query.isExactIn == false): amountOut is fixed by taker; amountIn was computed by pricing.
    ///   Encumbrance widens price by penalizing (increasing) amountIn.
    /// - In both modes, deliverable amountOut is strictly checked against free unencumbered backing.
    ///
    /// SPOT-CHECK VERIFICATION & DECLARED TOTAL:
    /// Makers declare their total encumbrance across all strategies in `declaredTotalEncumbrance`.
    /// SwapVM samples up to 6 siblings on-chain as a spot-check. If declared total is less than
    /// the sampled commitments, execution reverts (EncumbranceUnderdeclared).
    /// Utilisation and solvency are computed directly against the declared total.
    ///
    /// SELF-REFERENCE HANDLING: If the maker includes the current strategy's own orderHash
    /// in the siblingHashes array, it is skipped to prevent double-counting.
    ///
    /// SIBLING ENCODING BOUND: SwapVM's runLoop uses a uint8 instruction length, capping calldata args
    /// at 255 bytes. With 38 bytes overhead (32 declaredTotal + 2 count + 2 maxUtil + 2 widen), up to 6 siblings can be sampled per instruction call.
    ///
    /// @param ctx VM Context
    /// @param args Packed calldata containing declaredTotalEncumbrance, sibling hashes, maxUtilBps, and widenBps
    function _encumberedCap(Context memory ctx, bytes calldata args) internal {
        (
            uint256 declaredTotalEncumbrance,
            uint256 siblingCount,
            bytes calldata siblingHashes,
            uint16 maxUtilBps,
            uint16 widenBps
        ) = EncumbranceArgsBuilder.parse(args);

        IAqua aqua = _aqua();
        uint256 sampledEncumbered = 0;
        for (uint256 i = 0; i < siblingCount; i++) {
            bytes32 siblingHash = bytes32(siblingHashes.slice(i * 32, (i + 1) * 32));

            // Prevent double-counting the current strategy if maker passed self in sibling list
            if (siblingHash == ctx.query.orderHash) {
                continue;
            }

            (uint248 bal, uint8 tokensCount) = aqua.rawBalances(
                ctx.query.maker,
                address(this),
                siblingHash,
                ctx.query.tokenOut
            );

            // Skip docked strategies: 0xff marker in Aqua indicates strategy has been deactivated
            if (tokensCount == _AQUA_DOCKED) {
                continue;
            }

            sampledEncumbered += bal;
        }

        // On-chain spot-check: maker cannot declare less encumbrance than sampled sibling commitments
        if (declaredTotalEncumbrance < sampledEncumbered) {
            revert EncumbranceUnderdeclared(declaredTotalEncumbrance, sampledEncumbered);
        }

        uint256 balOut = IERC20(ctx.query.tokenOut).balanceOf(ctx.query.maker);
        uint256 allowOut = IERC20(ctx.query.tokenOut).allowance(ctx.query.maker, address(aqua));
        uint256 backing = Math.min(balOut, allowOut);

        if (backing == 0) {
            revert EncumbranceZeroBacking();
        }

        // 512-bit intermediate multiplication avoids overflow even on arbitrarily massive commitments
        uint256 util = Math.mulDiv(declaredTotalEncumbrance, 1e4, backing);

        // Report true untruncated utilization in EncumbranceExceeded
        if (util >= maxUtilBps) {
            revert EncumbranceExceeded(util, maxUtilBps);
        }

        uint256 adjustedFrom = ctx.query.isExactIn ? ctx.swap.amountOut : ctx.swap.amountIn;

        // Apply price widening curve based on swap direction
        if (widenBps > 0 && util > 0) {
            if (ctx.query.isExactIn) {
                if (ctx.swap.amountOut > 0) {
                    uint256 haircut = Math.mulDiv(ctx.swap.amountOut, uint256(widenBps) * util, 1e8);
                    ctx.swap.amountOut -= haircut;
                }
            } else {
                if (ctx.swap.amountIn > 0) {
                    uint256 penalty = Math.mulDiv(ctx.swap.amountIn, uint256(widenBps) * util, 1e8, Math.Rounding.Ceil);
                    ctx.swap.amountIn += penalty;
                }
            }
        }

        uint256 adjustedTo = ctx.query.isExactIn ? ctx.swap.amountOut : ctx.swap.amountIn;

        // Hard solvency floor: deliverable amountOut cannot exceed free backing
        uint256 free = backing > declaredTotalEncumbrance ? backing - declaredTotalEncumbrance : 0;
        if (ctx.swap.amountOut > free) {
            revert EncumbranceInsufficient(ctx.swap.amountOut, free);
        }

        // Emit only during real swap execution, never in static quote context
        if (!ctx.vm.isStaticContext) {
            emit EncumbranceApplied(
                ctx.query.maker,
                ctx.query.orderHash,
                ctx.query.tokenOut,
                declaredTotalEncumbrance,
                backing,
                util,
                ctx.query.isExactIn,
                adjustedFrom,
                adjustedTo
            );
        }
    }
}
