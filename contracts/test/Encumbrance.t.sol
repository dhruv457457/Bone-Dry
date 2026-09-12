// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {BoneDryRouter} from "../src/vm/BoneDryRouter.sol";
import {Chains} from "../script/Chains.sol";

contract EncumbranceTest is Test {
    BoneDryRouter router;

    function setUp() public {
        address aqua = 0x1111113CCf1426A8E30e2bfF5E005d929bF6a90a;
        address weth = Chains.weth();
        router = new BoneDryRouter(aqua, weth, address(this), "BoneDryRouter", "1");
    }

    function testBytecodeSize() public {
        uint256 size = address(router).code.length;
        emit log_named_uint("BoneDryRouter bytecode size (bytes)", size);
        assertLt(size, 24576, "Router exceeds EIP-170 limit");
    }
}
