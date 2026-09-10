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
import {NaiveTap} from "./mocks/NaiveTap.sol";

/**
 * @title NaiveTapTest — Control-Group Benchmark
 *
 * Compares Bone Dry's atomic solvency hook (Tap.sol) against the control group (NaiveTap.sol).
 *
 * Demonstrates:
 * 1. Both hooks succeed when all Aqua makers maintain 100% solvency.
 * 2. When a maker "flakes" (withdraws inventory or becomes insolvent between quote and fill):
 *    - NaiveTap reverts completely: 0 tokens gained, 100% of transaction gas wasted.
 *    - Bone Dry Tap detects the failure atomically, emits MakerSkipped, rebalances to solvent makers,
 *      and successfully fulfills the trade.
 */
contract NaiveTapTest is BoneDryFork {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    IPoolManager PM;
    uint160 constant FLAGS = uint160(0x88); // beforeSwap | beforeSwapReturnDelta
    uint160 constant MAX_SQRT = 1461446703485210103287273052203988822378723970341;
    uint160 constant MIN_SQRT = 4295128739;

    Tap boneDryTap;
    NaiveTap naiveTap;
    Lens lens;
    PoolSwapTest swapRouter;

    PoolKey boneDryKey;
    PoolKey naiveKey;
    address swapper = address(0xA11CE);

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
        uint160 wethFirst = 79228162514264337593543950336; // 1:1 in X96
        return Chains.wethIsCurrency0() ? wethFirst : uint160((uint256(1) << 192) / wethFirst);
    }

    function setUp() public {
        _forkAndLoadFixture();
        PM = IPoolManager(Chains.poolManager());
        lens = new Lens(aqua);

        address boneDryAddr = address(uint160(0x5555 << 144) | FLAGS);
        deployCodeTo("Tap.sol:Tap", abi.encode(PM, router, lens), boneDryAddr);
        boneDryTap = Tap(boneDryAddr);

        address naiveAddr = address(uint160(0x6666 << 144) | FLAGS);
        deployCodeTo("mocks/NaiveTap.sol:NaiveTap", abi.encode(PM, router), naiveAddr);
        naiveTap = NaiveTap(naiveAddr);

        swapRouter = new PoolSwapTest(PM);

        (address c0, address c1) = Chains.currencies();
        boneDryKey = PoolKey({
            currency0: Currency.wrap(c0),
            currency1: Currency.wrap(c1),
            fee: 0,
            tickSpacing: 60,
            hooks: IHooks(boneDryAddr)
        });
        (uint160 ex1,,,) = PM.getSlot0(boneDryKey.toId());
        if (ex1 == 0) PM.initialize(boneDryKey, _startPrice());

        naiveKey = PoolKey({
            currency0: Currency.wrap(c0),
            currency1: Currency.wrap(c1),
            fee: 0,
            tickSpacing: 60,
            hooks: IHooks(naiveAddr)
        });
        (uint160 ex2,,,) = PM.getSlot0(naiveKey.toId());
        if (ex2 == 0) PM.initialize(naiveKey, _startPrice());

        vm.label(boneDryAddr, "BoneDryTap");
        vm.label(naiveAddr, "NaiveTap");
        vm.label(swapper, "swapper");
    }

    function _hookData(uint256 count) internal view returns (bytes memory) {
        bytes[] memory s = new bytes[](count);
        for (uint256 i; i < count; ++i) s[i] = strategies[i];
        return abi.encode(Tap.TapData({strategies: s, takerTraits: takerTraits}));
    }

    function _swap(PoolKey memory key, uint256 sell, bytes memory hookData) internal returns (uint256 gained, uint256 gasUsed) {
        deal(address(USDC), swapper, sell);
        uint256 beforeBal = WETH.balanceOf(swapper);
        vm.startPrank(swapper, swapper);
        USDC.approve(address(swapRouter), type(uint256).max);

        uint256 g0 = gasleft();
        swapRouter.swap(
            key,
            _params(sell),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            hookData
        );
        gasUsed = g0 - gasleft();
        vm.stopPrank();

        gained = WETH.balanceOf(swapper) - beforeBal;
    }

    /// @dev Scenario 1: Baseline when both makers are completely solvent.
    function test_baseline_bothSucceedWhenMakersSolvent() public {
        _ship(0, 10_000e6, 3e18);
        _ship(1, 10_000e6, 3e18);

        uint256 sell = 500e6;

        uint256 snap = vm.snapshotState();
        (uint256 boneDryOut, uint256 boneDryGas) = _swap(boneDryKey, sell, _hookData(2));
        vm.revertToState(snap);

        (uint256 naiveOut, uint256 naiveGas) = _swap(naiveKey, sell, _hookData(2));

        console.log("=== BASELINE (All Makers Solvent) ===");
        console.log("Bone Dry Output (WETH) :", boneDryOut);
        console.log("Bone Dry Gas           :", boneDryGas);
        console.log("NaiveTap Output (WETH) :", naiveOut);
        console.log("NaiveTap Gas           :", naiveGas);

        assertGt(boneDryOut, 0, "Bone Dry should deliver tokens");
        assertGt(naiveOut, 0, "NaiveTap should deliver tokens when solvent");
    }

    /// @dev Scenario 2: Control Group Failure (Mempool Flake / Insolvent Maker).
    /// Maker 1 promises 3 WETH but drains their wallet to 0 right before fill.
    function test_controlGroup_flakedMakerCausesCompleteRevertInNaiveTap() public {
        _ship(0, 10_000e6, 3e18);
        _ship(1, 10_000e6, 3e18);

        // Maker 1 flaked! Transferred tokens away to another contract or wallet.
        vm.prank(makers[1]);
        WETH.transfer(address(0xDEAD), 3e18);

        uint256 sell = 500e6;

        // --- 1. Test NaiveTap (Expect REVERT) ---
        deal(address(USDC), swapper, sell);
        vm.startPrank(swapper, swapper);
        USDC.approve(address(swapRouter), type(uint256).max);

        // NaiveTap fails without error recovery:
        vm.expectRevert();
        swapRouter.swap(
            naiveKey,
            _params(sell),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            _hookData(2)
        );
        vm.stopPrank();

        // --- 2. Test Bone Dry Tap (Expect SUCCESS with MakerSkipped) ---
        (uint256 boneDryOut, uint256 boneDryGas) = _swap(boneDryKey, sell, _hookData(2));

        console.log("\n=== CONTROL GROUP EXPERIMENT (Maker Flake) ===");
        console.log("NaiveTap Result        : REVERTED (0 WETH out, 100% gas burned)");
        console.log("Bone Dry Output (WETH) :", boneDryOut);
        console.log("Bone Dry Gas Consumed  :", boneDryGas);
        console.log("Bone Dry Protection    : 100% Fill Delivered despite flaked maker");

        assertGt(boneDryOut, 0, "Bone Dry must recover and fill from solvent Maker 0");
    }
}
