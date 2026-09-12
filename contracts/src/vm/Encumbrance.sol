// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Context } from "@1inch/swap-vm/libs/VM.sol";

abstract contract Encumbrance {
    constructor(address /* aqua */) {}

    function _encumberedCap(Context memory /* ctx */, bytes calldata /* args */) internal view {}
}
