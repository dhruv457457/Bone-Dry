// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console} from "forge-std/Script.sol";
import {Chains} from "./Chains.sol";
import {IAqua} from "../src/interfaces/IAqua.sol";

interface IWETH {
    function deposit() external payable;
    function approve(address, uint256) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

interface IERC20 {
    function approve(address, uint256) external returns (bool);
}

/**
 * Seeds three Aqua makers on a local Base fork so the router API has something
 * real to index. Maker 2 ships without ever funding its wallet — the phantom
 * liquidity case the Lens is built to see through.
 *
 *   forge script script/Seed.s.sol --rpc-url http://127.0.0.1:8545 --broadcast
 */
contract Seed is Script {
    address immutable USDC = Chains.usdc();
    address immutable WETH = Chains.weth();


    // Anvil's first three deterministic accounts. These are published in the
    // anvil banner and shipped inside forge-std's own tests — they are test
    // fixtures, not credentials, and they control nothing on any real network.
    uint256[3] PKS = [
        0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80,
        0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d,
        0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a
    ];

    // how much WETH each maker actually backs their promise with
    uint256[3] REAL = [3 ether, 2 ether, 0];

    function run() external {
        string memory j = vm.readFile(string.concat("fixtures/strategy.", vm.toString(block.chainid), ".json"));
        IAqua aqua = IAqua(vm.parseJsonAddress(j, ".aqua"));
        address router = vm.parseJsonAddress(j, ".router");

        for (uint256 i; i < 3; ++i) {
            bytes memory strategy = vm.parseJsonBytes(j, string.concat(".strategies[", vm.toString(i), "]"));
            address maker = vm.addr(PKS[i]);

            vm.startBroadcast(PKS[i]);

            if (REAL[i] > 0) IWETH(WETH).deposit{value: REAL[i]}();
            IWETH(WETH).approve(address(aqua), type(uint256).max);
            IERC20(USDC).approve(address(aqua), type(uint256).max);

            address[] memory tokens = new address[](2);
            tokens[0] = USDC;
            tokens[1] = WETH;
            uint256[] memory amounts = new uint256[](2);
            amounts[0] = 10_000e6;   // claimed
            amounts[1] = 3 ether;    // claimed by ALL THREE, backed by only two

            aqua.ship(router, strategy, tokens, amounts);
            vm.stopBroadcast();

            console.log("maker", i, maker);
            console.log("   real WETH in wallet:", IWETH(WETH).balanceOf(maker));
        }
    }
}
