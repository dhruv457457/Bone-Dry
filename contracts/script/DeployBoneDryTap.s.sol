// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console} from "forge-std/Script.sol";
import {Chains} from "./Chains.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {ISwapVM} from "../src/interfaces/ISwapVM.sol";
import {Lens} from "../src/Lens.sol";
import {Tap} from "../src/Tap.sol";

/**
 * A second Tap on a chain that already has one, bound to BoneDryRouter.
 *
 * Deploy.s.sol cannot do this job. It reads the router out of
 * fixtures/strategy.<chainid>.json -- which is 1inch's canonical SwapVM -- and
 * deploys a fresh Lens and Wellhead alongside. Here the router is ours, Lens is
 * the one already on chain, and Wellhead is not touched at all: it only takes a
 * PoolManager (Wellhead.sol:47), so the live one serves any hook.
 *
 * Tap.router is immutable (Tap.sol:42), which is the whole reason this exists --
 * the Tap already on Base is welded to 1inch's router and can never reach
 * opcode 35. A hook's permissions are its address, so the new one has to be
 * mined rather than chosen.
 *
 *   forge script script/DeployBoneDryTap.s.sol --rpc-url <base> --broadcast
 */
interface IExtsload {
    function extsload(bytes32 slot) external view returns (bytes32);
}

contract DeployBoneDryTap is Script {
    address immutable PM = Chains.poolManager();

    uint160 constant FLAGS = 0x88; // BEFORE_SWAP | BEFORE_SWAP_RETURNS_DELTA
    uint160 constant FLAG_MASK = 0x3FFF;
    uint256 constant POOLS_SLOT = 6;
    uint160 constant SQRT_PRICE = 4543168963294864840402813952;

    function _mine(bytes memory initCode) internal pure returns (address addr, bytes32 salt) {
        bytes32 initHash = keccak256(initCode);
        for (uint256 i; i < 500_000; ++i) {
            salt = bytes32(i);
            addr = address(
                uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), CREATE2_FACTORY, salt, initHash))))
            );
            if (uint160(addr) & FLAG_MASK == FLAGS) return (addr, salt);
        }
        revert("no salt found");
    }

    function run() external {
        ISwapVM router = ISwapVM(vm.envAddress("BONEDRY_ROUTER"));
        Lens lens = Lens(vm.envAddress("LENS_ADDRESS"));
        uint256 pk = vm.envUint("MAINNET_PRIVATE_KEY");

        require(address(router).code.length > 0, "router not deployed");
        require(address(lens).code.length > 0, "lens not deployed");

        bytes memory initCode =
            abi.encodePacked(type(Tap).creationCode, abi.encode(IPoolManager(PM), router, lens));
        (address hookAddr, bytes32 salt) = _mine(initCode);
        console.log("mined hook  ", hookAddr);

        if (hookAddr.code.length == 0) {
            vm.startBroadcast(pk);
            Tap deployed = new Tap{salt: salt}(IPoolManager(PM), router, lens);
            vm.stopBroadcast();
            require(address(deployed) == hookAddr, "mined address did not match");
        } else {
            console.log("hook already deployed, left alone");
        }

        (address c0, address c1) = Chains.currencies();
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(c0),
            currency1: Currency.wrap(c1),
            fee: 0,
            tickSpacing: 60,
            hooks: IHooks(hookAddr)
        });

        bytes32 poolId = keccak256(abi.encode(key));
        bytes32 stateSlot = keccak256(abi.encode(poolId, uint256(POOLS_SLOT)));
        uint160 live = uint160(uint256(IExtsload(PM).extsload(stateSlot)));

        // sqrtPrice is currency1/currency0 and the two chains order the pair
        // oppositely, so the value inverts on whichever puts WETH first.
        uint160 startPrice =
            Chains.wethIsCurrency0() ? SQRT_PRICE : uint160((1 << 192) / uint256(SQRT_PRICE));

        if (live == 0) {
            vm.startBroadcast(pk);
            IPoolManager(PM).initialize(key, startPrice);
            vm.stopBroadcast();
            console.log("pool initialized");
        } else {
            console.log("pool already live, left alone");
        }

        console.log("router      ", address(router));
        console.log("lens        ", address(lens));
        console.log("tap         ", hookAddr);
        console.log("poolId      ", vm.toString(poolId));
    }
}
