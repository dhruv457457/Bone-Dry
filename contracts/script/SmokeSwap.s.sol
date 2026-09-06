// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console} from "forge-std/Script.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {Chains} from "./Chains.sol";
import {Tap} from "../src/Tap.sol";
import {Wellhead} from "../src/Wellhead.sol";

interface IERC20 {
    function approve(address, uint256) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

/**
 * One real swap against a real Bone Dry pool, with no web stack in the way.
 *
 * Reads the same fixture the API would, assembles the same hookData the router
 * would emit, and sends it through Wellhead exactly as the Swap button does. If
 * this fills, the deployment is real — and the pool it filled from is empty
 * before and after, because the WETH comes out of maker wallets.
 *
 *   HOOK=0x.. WELLHEAD=0x.. SELL=5000000 \
 *   forge script script/SmokeSwap.s.sol --rpc-url <rpc> --broadcast
 */
contract SmokeSwap is Script {
    function run() external {
        string memory blob =
            vm.readFile(string.concat("fixtures/strategy.", vm.toString(block.chainid), ".json"));

        address hook = vm.envAddress("HOOK");
        address payable wellhead = payable(vm.envAddress("WELLHEAD"));
        uint256 sell = vm.envOr("SELL", uint256(5_000_000)); // 5 USDC
        uint256 pk = vm.envUint("PRIVATE_KEY");

        // The candidate set. Aqua's balances are not enumerable, so the hook
        // cannot find these itself — they arrive as calldata, which is the whole
        // reason an off-chain index exists.
        bytes[] memory strategies = new bytes[](3);
        for (uint256 i; i < 3; ++i) {
            strategies[i] = vm.parseJsonBytes(blob, string.concat(".strategies[", vm.toString(i), "]"));
        }
        bytes memory hookData = abi.encode(
            Tap.TapData({strategies: strategies, takerTraits: vm.parseJsonBytes(blob, ".takerTraitsAndData")})
        );

        (address c0, address c1) = Chains.currencies();
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(c0),
            currency1: Currency.wrap(c1),
            fee: 0,
            tickSpacing: 60,
            hooks: IHooks(hook)
        });

        // Selling USDC. Which side that is depends on the chain's token ordering,
        // so it is derived rather than assumed.
        bool zeroForOne = !Chains.wethIsCurrency0();
        address swapper = vm.addr(pk);
        uint256 before = IERC20(Chains.weth()).balanceOf(swapper);

        vm.startBroadcast(pk);
        IERC20(Chains.usdc()).approve(wellhead, type(uint256).max);
        uint256 got = Wellhead(wellhead).swap(key, zeroForOne, sell, 1, hookData);
        vm.stopBroadcast();

        console.log("sold  USDC :", sell);
        console.log("got   WETH :", got);
        console.log("wallet delta:", IERC20(Chains.weth()).balanceOf(swapper) - before);
    }
}
