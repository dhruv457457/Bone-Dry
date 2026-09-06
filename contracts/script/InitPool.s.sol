// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console} from "forge-std/Script.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {Currency} from "v4-core/types/Currency.sol";

interface IExtsload {
    function extsload(bytes32 slot) external view returns (bytes32);
}

/**
 * Adds a second (or third, or Nth) pair to an already-deployed Bone Dry.
 *
 * Deploy.s.sol deploys Lens, mines and deploys Tap, deploys Wellhead, and
 * initializes one pool — the right shape for "stand the whole thing up from
 * nothing", and the wrong shape for "add a pair", because it redeploys Lens
 * and Wellhead unconditionally on every run and would leave two live,
 * unrelated copies of each behind a single strategy fixture.
 *
 * It does not need to do any of that. Tap reads currency0/currency1 off the
 * PoolKey PoolManager hands it in beforeSwap — it is not wired to any one
 * pair — so one deployed Tap can hook every pool this protocol ever adds.
 * This script only ever calls PoolManager.initialize() with a new PoolKey
 * that points at the Tap address already on chain. Nothing gets redeployed.
 *
 * Required env:
 *   POOL_MANAGER    the PoolManager this network uses
 *   TAP             the already-deployed Tap hook address
 *   TOKEN0, TOKEN1  the new pair (either order — this script sorts them)
 *   START_PRICE     sqrtPriceX96 for the *sorted* pair (currency1/currency0)
 * Optional env:
 *   FEE             default 0, matches the existing Bone Dry pool
 *   TICK_SPACING    default 60, matches the existing Bone Dry pool
 *   PRIVATE_KEY     falls back to anvil account 0, a published test key
 *
 *   forge script script/InitPool.s.sol --rpc-url $BASE_SEPOLIA_RPC_URL --broadcast
 */
contract InitPool is Script {
    uint256 constant POOLS_SLOT = 6;

    function run() external {
        address pm = vm.envAddress("POOL_MANAGER");
        address tap = vm.envAddress("TAP");
        address tokenA = vm.envAddress("TOKEN0");
        address tokenB = vm.envAddress("TOKEN1");
        uint160 startPrice = uint160(vm.envUint("START_PRICE"));
        uint24 fee = uint24(vm.envOr("FEE", uint256(0)));
        int24 tickSpacing = int24(int256(vm.envOr("TICK_SPACING", uint256(60))));
        uint256 pk = vm.envOr("PRIVATE_KEY", uint256(0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80));

        (address c0, address c1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        require(c0 != c1, "same token twice");

        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(c0),
            currency1: Currency.wrap(c1),
            fee: fee,
            tickSpacing: tickSpacing,
            hooks: IHooks(tap)
        });

        bytes32 poolId = keccak256(abi.encode(key));
        bytes32 stateSlot = keccak256(abi.encode(poolId, uint256(POOLS_SLOT)));
        uint160 existing = uint160(uint256(IExtsload(pm).extsload(stateSlot)));

        if (existing != 0) {
            console.log("pool already live, left alone");
        } else {
            vm.startBroadcast(pk);
            IPoolManager(pm).initialize(key, startPrice);
            vm.stopBroadcast();
            console.log("pool initialized");
        }

        console.log("currency0", c0);
        console.log("currency1", c1);
        console.log("hook (unchanged)", tap);
        console.logBytes32(poolId);
    }
}
