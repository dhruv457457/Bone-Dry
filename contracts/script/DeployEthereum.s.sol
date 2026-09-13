// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console} from "forge-std/Script.sol";
import {Chains} from "./Chains.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {IAqua} from "../src/interfaces/IAqua.sol";
import {ISwapVM} from "../src/interfaces/ISwapVM.sol";
import {Lens} from "../src/Lens.sol";
import {Tap} from "../src/Tap.sol";
import {Wellhead} from "../src/Wellhead.sol";
import {BoneDryRouter} from "../src/vm/BoneDryRouter.sol";

interface IExtsload {
    function extsload(bytes32 slot) external view returns (bytes32);
}

/**
 * Bone Dry on Ethereum mainnet: the same five contracts as Base, in one run.
 *
 *   1. BoneDryRouter  SwapVM with opcode 35 appended at index 35
 *   2. Lens           quotable depth = min(virtual, balance, allowance)
 *   3. Wellhead       the swap entry point (takes only a PoolManager)
 *   4. Tap x2         one hook per book, because Tap.router is immutable:
 *                       tapLegacy -> 1inch's canonical router, where Ethereum's
 *                                    real third-party makers already live
 *                       tap       -> BoneDryRouter, where opcode 35 runs
 *   5. two pools      USDC/WETH, fee 0, tickSpacing 60, one per hook, zero liquidity
 *
 * Everything 1inch deployed is reused, not redeployed: Aqua and the canonical
 * SwapVM router sit at the same addresses as on Base. Every address below is
 * checked to hold code before anything is sent, and the hook addresses are mined
 * against the CREATE2 factory so their low bits carry exactly
 * BEFORE_SWAP | BEFORE_SWAP_RETURNS_DELTA.
 *
 * Re-running is safe: a hook whose mined address already has code is left alone,
 * and a pool that is already initialised is not touched. The router, Lens and
 * Wellhead are plain CREATEs, so a re-run WOULD deploy them again -- pass
 * BONEDRY_ROUTER / LENS / WELLHEAD to reuse ones from a previous run.
 *
 *   # rehearse (no ETH needed)
 *   forge script script/DeployEthereum.s.sol --rpc-url $MAINNET_RPC_URL --skip-simulation
 *   # deploy, with a gas price you accept
 *   forge script script/DeployEthereum.s.sol --rpc-url $MAINNET_RPC_URL --broadcast --slow --with-gas-price 2gwei
 */
contract DeployEthereum is Script {
    address constant AQUA = 0x1111113CCf1426A8E30e2bfF5E005d929bF6a90a;
    address constant ONEINCH_ROUTER = 0x111111338c5091E8440b67B168bAe16a668AC0De;

    uint160 constant FLAGS = 0x88; // BEFORE_SWAP | BEFORE_SWAP_RETURNS_DELTA
    uint160 constant FLAG_MASK = 0x3FFF;
    uint256 constant POOLS_SLOT = 6;
    // Nominal ~3300 USDC/WETH in WETH-first orientation; a Bone Dry pool never
    // prices anything, it only needs a valid start. Inverted below because on
    // Ethereum USDC sorts first.
    uint160 constant SQRT_PRICE = 4543168963294864840402813952;

    function _mine(bytes memory initCode) internal pure returns (address addr, bytes32 salt) {
        bytes32 initHash = keccak256(initCode);
        for (uint256 i; i < 500_000; ++i) {
            salt = bytes32(i);
            addr = address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), CREATE2_FACTORY, salt, initHash)))));
            if (uint160(addr) & FLAG_MASK == FLAGS) return (addr, salt);
        }
        revert("no salt found");
    }

    function _hook(uint256 pk, IPoolManager pm, ISwapVM router, Lens lens) internal returns (address hookAddr) {
        bytes memory initCode = abi.encodePacked(type(Tap).creationCode, abi.encode(pm, router, lens));
        bytes32 salt;
        (hookAddr, salt) = _mine(initCode);
        if (hookAddr.code.length == 0) {
            vm.startBroadcast(pk);
            Tap deployed = new Tap{salt: salt}(pm, router, lens);
            vm.stopBroadcast();
            require(address(deployed) == hookAddr, "mined address did not match");
        } else {
            console.log("hook already deployed, left alone:", hookAddr);
        }
        require(address(Tap(hookAddr).router()) == address(router), "hook bound to the wrong router");
    }

    function _pool(uint256 pk, IPoolManager pm, address hookAddr) internal returns (bytes32 poolId) {
        (address c0, address c1) = Chains.currencies();
        PoolKey memory key =
            PoolKey({currency0: Currency.wrap(c0), currency1: Currency.wrap(c1), fee: 0, tickSpacing: 60, hooks: IHooks(hookAddr)});
        poolId = keccak256(abi.encode(key));
        bytes32 stateSlot = keccak256(abi.encode(poolId, POOLS_SLOT));
        uint160 live = uint160(uint256(IExtsload(address(pm)).extsload(stateSlot)));
        if (live == 0) {
            uint160 startPrice = Chains.wethIsCurrency0() ? SQRT_PRICE : uint160((1 << 192) / uint256(SQRT_PRICE));
            vm.startBroadcast(pk);
            pm.initialize(key, startPrice);
            vm.stopBroadcast();
        } else {
            console.log("pool already live, left alone");
        }
    }

    function run() external {
        require(block.chainid == Chains.ETHEREUM, "this script is for Ethereum mainnet only");
        uint256 pk = vm.envUint("MAINNET_PRIVATE_KEY");
        address deployer = vm.addr(pk);
        IPoolManager pm = IPoolManager(Chains.poolManager());
        address weth = Chains.weth();

        // Everything this depends on must already be on chain.
        require(AQUA.code.length > 0, "Aqua not found");
        require(ONEINCH_ROUTER.code.length > 0, "1inch SwapVM router not found");
        require(address(pm).code.length > 0, "v4 PoolManager not found");
        require(CREATE2_FACTORY.code.length > 0, "CREATE2 factory not found");
        require(weth.code.length > 0 && Chains.usdc().code.length > 0, "WETH/USDC not found");

        console.log("deployer          ", deployer);
        console.log("balance (wei)     ", deployer.balance);

        address routerAddr = vm.envOr("BONEDRY_ROUTER_ETH", address(0));
        address lensAddr = vm.envOr("LENS_ETH", address(0));
        address wellheadAddr = vm.envOr("WELLHEAD_ETH", address(0));

        vm.startBroadcast(pk);
        if (routerAddr == address(0)) {
            routerAddr = address(new BoneDryRouter(AQUA, weth, deployer, "BoneDryRouter", "1"));
        }
        if (lensAddr == address(0)) lensAddr = address(new Lens(IAqua(AQUA)));
        if (wellheadAddr == address(0)) wellheadAddr = address(new Wellhead(pm));
        vm.stopBroadcast();

        require(routerAddr.code.length > 0 && lensAddr.code.length > 0 && wellheadAddr.code.length > 0, "reused address has no code");

        address tapLegacy = _hook(pk, pm, ISwapVM(ONEINCH_ROUTER), Lens(lensAddr));
        address tap = _hook(pk, pm, ISwapVM(routerAddr), Lens(lensAddr));

        bytes32 poolLegacy = _pool(pk, pm, tapLegacy);
        bytes32 pool = _pool(pk, pm, tap);

        console.log("--- deployments/ethereum.json ---");
        console.log("boneDryRouter     ", routerAddr);
        console.log("lens              ", lensAddr);
        console.log("wellhead          ", wellheadAddr);
        console.log("tapLegacy (1inch) ", tapLegacy);
        console.log("tap (Bone Dry)    ", tap);
        console.log("poolIdLegacy      ", vm.toString(poolLegacy));
        console.log("poolId            ", vm.toString(pool));
        console.log("router bytes      ", routerAddr.code.length);
    }
}
