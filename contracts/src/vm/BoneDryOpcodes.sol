// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Context } from "@1inch/swap-vm/libs/VM.sol";
import { AquaOpcodes } from "@1inch/swap-vm/opcodes/AquaOpcodes.sol";
import { Controls } from "@1inch/swap-vm/instructions/Controls.sol";
import { XYCSwap } from "@1inch/swap-vm/instructions/XYCSwap.sol";
import { XYCConcentrate } from "@1inch/swap-vm/instructions/XYCConcentrate.sol";
import { Decay } from "@1inch/swap-vm/instructions/Decay.sol";
import { Fee } from "@1inch/swap-vm/instructions/Fee.sol";
import { Extruction } from "@1inch/swap-vm/instructions/Extruction.sol";
import { PeggedSwap } from "@1inch/swap-vm/instructions/PeggedSwap.sol";
import { Encumbrance } from "./Encumbrance.sol";

abstract contract BoneDryOpcodes is AquaOpcodes, Encumbrance {
    uint256 internal constant OP_ENCUMBERED_CAP = 35;

    constructor(address aqua) AquaOpcodes(aqua) Encumbrance(aqua) {}

    function _opcodes() internal pure virtual override returns (function(Context memory, bytes calldata) internal[] memory result) {
        function(Context memory, bytes calldata) internal[37] memory instructions = [
            _notInstruction,
            // Debug - reserved for debugging utilities (core infrastructure)
            _notInstruction,
            _notInstruction,
            _notInstruction,
            _notInstruction,
            _notInstruction,
            _notInstruction,
            _notInstruction,
            _notInstruction,
            _notInstruction,
            _notInstruction,
            // Controls - control flow (core infrastructure)
            Controls._jump,
            Controls._jumpIfTokenIn,
            Controls._jumpIfTokenOut,
            Controls._deadline,
            Controls._onlyTakerTokenBalanceNonZero,
            Controls._onlyTakerTokenBalanceGte,
            Controls._onlyTakerTokenSupplyShareGte,
            // XYCSwap - basic swap (most common swap type)
            XYCSwap._xycSwapXD,
            // XYCConcentrate - liquidity concentration (common AMM feature)
            XYCConcentrate._xycConcentrateGrowLiquidity2D,
            // Decay - Decay AMM (specific AMM)
            Decay._decayXD,
            // NOTE: Add new instructions here to maintain backward compatibility
            Controls._salt,
            Fee._flatFeeAmountInXD,
            _notInstruction,
            _notInstruction,
            _notInstruction,
            _notInstruction,
            _notInstruction,
            Fee._protocolFeeAmountInXD,
            Fee._aquaProtocolFeeAmountInXD,
            Fee._dynamicProtocolFeeAmountInXD,
            Fee._aquaDynamicProtocolFeeAmountInXD,
            PeggedSwap._peggedSwapGrowPriceRange2D,
            Extruction._extruction,
            Controls._onlyTxOriginTokenBalanceNonZero,
            _notInstruction,
            Encumbrance._encumberedCap
        ];

        // Efficiently turning static memory array into dynamic memory array
        // by rewriting _notInstruction with array length, so it's excluded from the result
        uint256 instructionsArrayLength = instructions.length - 1;
        assembly ("memory-safe") {
            result := instructions
            mstore(result, instructionsArrayLength)
        }
    }
}
