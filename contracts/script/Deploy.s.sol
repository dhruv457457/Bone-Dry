// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console} from "forge-std/Script.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {IAqua} from "../src/interfaces/IAqua.sol";
import {ISwapVM} from "../src/interfaces/ISwapVM.sol";
import {Lens} from "../src/Lens.sol";
import {Tap} from "../src/Tap.sol";

/**
 * Puts a live Bone Dry pool on the chain the RPC points at.
 *
 * A v4 hook's permissions live in its address, so Tap has to end up at an
 * address whose low bits are BEFORE_SWAP | BEFORE_SWAP_RETURNS_DELTA. On a local
 * fork we get there by deploying once and etching the runtime code — immutables
 * are baked into runtime code, so the etched copy is the same contract. On a
 * real chain this step is replaced by CREATE2 address mining.
 *
 *   forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:8545 --broadcast
 */
contract Deploy is Script {
    address constant PM = 0x498581fF718922c3f8e6A244956aF099B2652b2b;
    address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address constant WETH = 0x4200000000000000000000000000000000000006;

    uint160 constant FLAGS = 0x88; // BEFORE_SWAP | BEFORE_SWAP_RETURNS_DELTA
    address constant HOOK = address(uint160(0x4444 << 144) | FLAGS);

    // 1 WETH ≈ 3300 USDC. sqrtPriceX96 for currency1/currency0 at that ratio.
    uint160 constant SQRT_PRICE = 4543168963294864840402813952; // ~ sqrt(3300e6/1e18) << 96

    function run() external {
        string memory jsonBlob = vm.readFile("fixtures/strategy.json");
        IAqua aqua = IAqua(vm.parseJsonAddress(jsonBlob, ".aqua"));
        ISwapVM router = ISwapVM(vm.parseJsonAddress(jsonBlob, ".router"));

        uint256 pk = vm.envOr("PRIVATE_KEY", uint256(0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80));

        vm.startBroadcast(pk);
        Lens lens = new Lens(aqua);
        Tap staging = new Tap(IPoolManager(PM), router, lens);
        vm.stopBroadcast();

        // Move the code to the address whose bits declare the permissions.
        vm.rpc("anvil_setCode", string.concat('["', vm.toString(HOOK), '","', vm.toString(address(staging).code), '"]'));

        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(WETH),
            currency1: Currency.wrap(USDC),
            fee: 0,
            tickSpacing: 60,
            hooks: IHooks(HOOK)
        });

        vm.startBroadcast(pk);
        IPoolManager(PM).initialize(key, SQRT_PRICE);
        vm.stopBroadcast();

        console.log("lens ", address(lens));
        console.log("tap  ", HOOK);
    }
}
