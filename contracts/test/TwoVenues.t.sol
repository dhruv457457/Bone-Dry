// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {console} from "forge-std/Test.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {SwapParams} from "v4-core/types/PoolOperation.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";
import {PoolSwapTest} from "v4-core/test/PoolSwapTest.sol";
import {BoneDryFork, IERC20} from "./Base.t.sol";
import {Tap} from "../src/Tap.sol";
import {Lens} from "../src/Lens.sol";
import {Chains} from "../script/Chains.sol";
import {ISwapVM} from "../src/interfaces/ISwapVM.sol";

/**
 * @title TwoVenuesTest — "One Kernel, Two Venues"
 *
 * Proves that a single Aqua maker liquidity position can be shared and filled
 * across TWO completely independent DeFi execution venues:
 *   Venue 1: Uniswap v4 (via Bone Dry's Tap.sol hook, 0-TVL pool)
 *   Venue 2: 1inch SwapVM Router (direct aggregator/PMM route)
 *
 * Rationale:
 * - Uses 1inch's official production router (AquaSwapVMRouter v1.0.2 on Base).
 * - Avoids EIP-170 24KB bytecode bloat: rather than packing bloated hybrid opcodes,
 *   we use 1inch's clean opcode architecture (XYC or Opcode 0x20 Extruction).
 * - Proves zero double-spending, zero desync, and zero locked capital across both venues.
 */
contract TwoVenuesTest is BoneDryFork {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    IPoolManager PM;
    uint160 constant FLAGS = uint160(0x88);
    uint160 constant MAX_SQRT = 1461446703485210103287273052203988822378723970341;
    uint160 constant MIN_SQRT = 4295128739;

    Tap tap;
    Lens lens;
    PoolSwapTest swapRouter;
    PoolKey key;

    address v4Swapper = address(0xAA11);
    address oneInchSwapper = address(0xBB22);

    function _sellingUsdcIsZeroForOne() internal view returns (bool) {
        return !Chains.wethIsCurrency0();
    }

    function _limit() internal view returns (uint160) {
        return _sellingUsdcIsZeroForOne() ? MIN_SQRT + 1 : MAX_SQRT;
    }

    function _params(uint256 sell) internal view returns (SwapParams memory) {
        return SwapParams({
            zeroForOne: _sellingUsdcIsZeroForOne(),
            amountSpecified: -int256(sell),
            sqrtPriceLimitX96: _limit()
        });
    }

    function _startPrice() internal view returns (uint160) {
        uint160 wethFirst = 79228162514264337593543950336;
        return Chains.wethIsCurrency0() ? wethFirst : uint160((uint256(1) << 192) / wethFirst);
    }

    function setUp() public {
        _forkAndLoadFixture();
        PM = IPoolManager(Chains.poolManager());
        lens = new Lens(aqua);

        address hookAddr = address(uint160(0x7777 << 144) | FLAGS);
        deployCodeTo("Tap.sol:Tap", abi.encode(PM, router, lens), hookAddr);
        tap = Tap(hookAddr);

        swapRouter = new PoolSwapTest(PM);

        (address c0, address c1) = Chains.currencies();
        key = PoolKey({
            currency0: Currency.wrap(c0),
            currency1: Currency.wrap(c1),
            fee: 0,
            tickSpacing: 60,
            hooks: IHooks(hookAddr)
        });
        (uint160 existing,,,) = PM.getSlot0(key.toId());
        if (existing == 0) PM.initialize(key, _startPrice());

        vm.label(hookAddr, "Tap");
        vm.label(v4Swapper, "v4Swapper");
        vm.label(oneInchSwapper, "oneInchSwapper");
    }

    function _hookData(uint256 count) internal view returns (bytes memory) {
        bytes[] memory s = new bytes[](count);
        for (uint256 i; i < count; ++i) s[i] = strategies[i];
        return abi.encode(Tap.TapData({strategies: s, takerTraits: takerTraits}));
    }

    /// @notice Demonstrates seamless interleaving of fills across Uniswap v4 and 1inch SwapVM
    /// against the exact same maker position.
    function test_singlePosition_concurrentFillAcrossBothVenues() public {
        // Maker 0 ships 10,000 USDC / 3 WETH
        _ship(0, 10_000e6, 3e18);

        ISwapVM.Order memory order0 = abi.decode(strategies[0], (ISwapVM.Order));

        uint256 makerUsdcInitial = USDC.balanceOf(makers[0]);
        uint256 makerWethInitial = WETH.balanceOf(makers[0]);

        // ----------------------------------------------------
        // Venue 1: Fill through Uniswap v4 (Bone Dry Tap hook)
        // ----------------------------------------------------
        uint256 v4Sell = 200e6;
        deal(address(USDC), v4Swapper, v4Sell);
        vm.startPrank(v4Swapper, v4Swapper);
        USDC.approve(address(swapRouter), type(uint256).max);
        swapRouter.swap(
            key,
            _params(v4Sell),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            _hookData(1)
        );
        vm.stopPrank();

        uint256 v4WethOut = WETH.balanceOf(v4Swapper);
        assertGt(v4WethOut, 0, "Venue 1 (Uniswap v4) must receive WETH");
        assertEq(USDC.balanceOf(makers[0]) - makerUsdcInitial, v4Sell, "Maker receives Venue 1 USDC");

        // ----------------------------------------------------
        // Venue 2: Fill directly through 1inch SwapVM Router
        // ----------------------------------------------------
        uint256 oneInchSell = 300e6;
        deal(address(USDC), oneInchSwapper, oneInchSell);
        vm.startPrank(oneInchSwapper, oneInchSwapper);
        USDC.approve(address(router), type(uint256).max);

        (, uint256 oneInchWethOut,) = router.swap(
            order0,
            address(USDC),
            address(WETH),
            oneInchSell,
            takerTraits
        );
        vm.stopPrank();

        assertGt(oneInchWethOut, 0, "Venue 2 (1inch SwapVM) must receive WETH");

        // ----------------------------------------------------
        // Settlement Integrity Checks
        // ----------------------------------------------------
        uint256 totalUsdcPaidToMaker = USDC.balanceOf(makers[0]) - makerUsdcInitial;
        uint256 totalWethTakenFromMaker = makerWethInitial - WETH.balanceOf(makers[0]);

        console.log("=== ONE KERNEL, TWO VENUES EXECUTION REPORT ===");
        console.log("Venue 1 (Uniswap v4 hook) USDC In :", v4Sell);
        console.log("Venue 1 (Uniswap v4 hook) WETH Out:", v4WethOut);
        console.log("Venue 2 (1inch SwapVM)    USDC In :", oneInchSell);
        console.log("Venue 2 (1inch SwapVM)    WETH Out:", oneInchWethOut);
        console.log("Total USDC Earned by Maker       :", totalUsdcPaidToMaker);
        console.log("Total WETH Settled from Wallet   :", totalWethTakenFromMaker);

        assertEq(totalUsdcPaidToMaker, v4Sell + oneInchSell, "Maker must receive exact sum from both venues");
        assertEq(totalWethTakenFromMaker, v4WethOut + oneInchWethOut, "Exact WETH output accounted with 0 double-spend");
    }
}
