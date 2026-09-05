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
import {Wellhead} from "../src/Wellhead.sol";

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
interface IExtsload {
    function extsload(bytes32 slot) external view returns (bytes32);
}

contract Deploy is Script {
    address constant PM = 0x498581fF718922c3f8e6A244956aF099B2652b2b;
    address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address constant WETH = 0x4200000000000000000000000000000000000006;

    uint160 constant FLAGS = 0x88; // BEFORE_SWAP | BEFORE_SWAP_RETURNS_DELTA
    address constant HOOK = address(uint160(0x4444 << 144) | FLAGS);

    /// @dev PoolManager._pools lives at slot 6; slot0 is the first word of the state.
    uint256 constant POOLS_SLOT = 6;

    // 1 WETH ~ 3300 USDC. sqrtPriceX96 for currency1/currency0 at that ratio.
    uint160 constant SQRT_PRICE = 4543168963294864840402813952; // ~ sqrt(3300e6/1e18) << 96

    function run() external {
        string memory jsonBlob = vm.readFile("fixtures/strategy.json");
        IAqua aqua = IAqua(vm.parseJsonAddress(jsonBlob, ".aqua"));
        ISwapVM router = ISwapVM(vm.parseJsonAddress(jsonBlob, ".router"));

        // Falls back to anvil account 0 — a published test fixture, not a secret.
        uint256 pk = vm.envOr("PRIVATE_KEY", uint256(0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80));

        vm.startBroadcast(pk);
        Lens lens = new Lens(aqua);
        Tap staging = new Tap(IPoolManager(PM), router, lens);
        Wellhead wellhead = new Wellhead(IPoolManager(PM));
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

        // Re-running this script is normal — the hook changes far more often than
        // the pool does — so initialize only when the pool is not there yet.
        bytes32 poolId = keccak256(abi.encode(key));
        bytes32 stateSlot = keccak256(abi.encode(poolId, uint256(POOLS_SLOT)));
        uint160 sqrtPrice = uint160(uint256(IExtsload(PM).extsload(stateSlot)));

        if (sqrtPrice == 0) {
            vm.startBroadcast(pk);
            IPoolManager(PM).initialize(key, SQRT_PRICE);
            vm.stopBroadcast();
            console.log("pool initialized");
        } else {
            console.log("pool already live, left alone");
        }

        console.log("lens     ", address(lens));
        console.log("tap      ", HOOK);
        console.log("wellhead ", address(wellhead));
    }
}
