// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {IAqua} from "../src/interfaces/IAqua.sol";
import {ISwapVM} from "../src/interfaces/ISwapVM.sol";

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
    function transfer(address, uint256) external returns (bool);
    function allowance(address, address) external view returns (uint256);
}

abstract contract BoneDryFork is Test {
    IERC20 constant USDC = IERC20(0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913);
    IERC20 constant WETH = IERC20(0x4200000000000000000000000000000000000006);

    IAqua aqua;
    ISwapVM router;
    bytes takerTraits;

    address[] makers;
    bytes[] strategies;
    bytes32[] strategyHashes;

    function _forkAndLoadFixture() internal {
        vm.createSelectFork(vm.envOr("BASE_RPC_URL", string("https://mainnet.base.org")));

        string memory j = vm.readFile(string.concat("fixtures/strategy.", vm.toString(block.chainid), ".json"));
        aqua = IAqua(vm.parseJsonAddress(j, ".aqua"));
        router = ISwapVM(vm.parseJsonAddress(j, ".router"));
        takerTraits = vm.parseJsonBytes(j, ".takerTraitsAndData");

        for (uint256 i; i < 3; ++i) {
            string memory n = vm.toString(i);
            makers.push(vm.parseJsonAddress(j, string.concat(".makers[", n, "]")));
            strategies.push(vm.parseJsonBytes(j, string.concat(".strategies[", n, "]")));
            strategyHashes.push(vm.parseJsonBytes32(j, string.concat(".strategyHashes[", n, "]")));
            vm.label(makers[i], string.concat("maker", n));
        }
        vm.label(address(aqua), "Aqua");
        vm.label(address(router), "AquaSwapVMRouter");
    }

    /// @dev maker funds their wallet, approves Aqua, and ships an ungated strategy
    function _ship(uint256 i, uint256 usdcAmt, uint256 wethAmt) internal {
        address m = makers[i];
        deal(address(USDC), m, usdcAmt);
        deal(address(WETH), m, wethAmt);

        address[] memory tokens = new address[](2);
        tokens[0] = address(USDC);
        tokens[1] = address(WETH);
        uint256[] memory amounts = new uint256[](2);
        amounts[0] = usdcAmt;
        amounts[1] = wethAmt;

        vm.startPrank(m);
        USDC.approve(address(aqua), type(uint256).max);
        WETH.approve(address(aqua), type(uint256).max);
        aqua.ship(address(router), strategies[i], tokens, amounts);
        vm.stopPrank();
    }
}
