// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Context } from "@1inch/swap-vm/libs/VM.sol";
import { AquaOpcodes } from "@1inch/swap-vm/opcodes/AquaOpcodes.sol";
import { Encumbrance } from "./Encumbrance.sol";

abstract contract BoneDryOpcodes is AquaOpcodes, Encumbrance {
    constructor(address aqua) AquaOpcodes(aqua) Encumbrance(aqua) {}

    function _opcodes() internal pure virtual override returns (function(Context memory, bytes calldata) internal[] memory result) {
        return AquaOpcodes._opcodes();
    }
}
