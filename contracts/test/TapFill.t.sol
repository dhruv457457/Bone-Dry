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

/**
 * Bone Dry, end to end, on a Base mainnet fork.
 *
 * A real Uniswap v4 pool on the real PoolManager with ZERO liquidity, filled from
 * three independent Aqua makers' wallets — and correct when one of them quietly
 * walks away with their inventory.
 */
contract TapFillTest is BoneDryFork {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    IPoolManager constant PM = IPoolManager(0x498581fF718922c3f8e6A244956aF099B2652b2b);
    uint160 constant FLAGS = uint160(0x88); // beforeSwap | beforeSwapReturnDelta
    uint160 constant MAX_SQRT = 1461446703485210103287273052203988822378723970341;

    Tap tap;
    Lens lens;
    PoolSwapTest swapRouter;
    PoolKey key;
    address swapper = address(0xA11CE);

    function setUp() public {
        _forkAndLoadFixture();

        lens = new Lens(aqua);

        // v4 encodes hook permissions in the address, so the hook must live at an
        // address whose low bits are exactly our flag set.
        address hookAddr = address(uint160(0x4444 << 144) | FLAGS);
        deployCodeTo("Tap.sol:Tap", abi.encode(PM, router, lens), hookAddr);
        tap = Tap(hookAddr);

        swapRouter = new PoolSwapTest(PM);

        // WETH (0x42..) sorts below USDC (0x83..), so it is currency0.
        key = PoolKey({
            currency0: Currency.wrap(address(WETH)),
            currency1: Currency.wrap(address(USDC)),
            fee: 0,
            tickSpacing: 60,
            hooks: IHooks(hookAddr)
        });
        PM.initialize(key, 79228162514264337593543950336);

        vm.label(hookAddr, "Tap");
        vm.label(address(PM), "PoolManager");
        vm.label(swapper, "swapper");
    }

    function _hookData(uint256 count) internal view returns (bytes memory) {
        bytes[] memory s = new bytes[](count);
        for (uint256 i; i < count; ++i) s[i] = strategies[i];
        return abi.encode(Tap.TapData({strategies: s, takerTraits: takerTraits}));
    }

    function _swap(uint256 sell, bytes memory hookData) internal returns (uint256 gained) {
        deal(address(USDC), swapper, sell);
        uint256 before = WETH.balanceOf(swapper);
        vm.startPrank(swapper, swapper);
        USDC.approve(address(swapRouter), type(uint256).max);
        swapRouter.swap(
            key,
            SwapParams({zeroForOne: false, amountSpecified: -int256(sell), sqrtPriceLimitX96: MAX_SQRT}),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            hookData
        );
        vm.stopPrank();
        gained = WETH.balanceOf(swapper) - before;
    }

    function test_poolHasNoLiquidity_butSwapStillFills() public {
        _ship(0, 10_000e6, 3e18);

        assertEq(PM.getLiquidity(key.toId()), 0, "pool should start empty");

        uint256 makerUsdcBefore = USDC.balanceOf(makers[0]);
        uint256 gained = _swap(100e6, _hookData(1));

        console.log("pool liquidity      :", PM.getLiquidity(key.toId()));
        console.log("swapper WETH gained :", gained);
        console.log("maker USDC received :", USDC.balanceOf(makers[0]) - makerUsdcBefore);

        assertEq(PM.getLiquidity(key.toId()), 0, "pool STILL has zero liquidity");
        assertGt(gained, 0, "swapper received no WETH");
        assertEq(USDC.balanceOf(makers[0]) - makerUsdcBefore, 100e6, "maker did not receive USDC");
    }

    /// @dev Splitting across makers beats routing everything to one, because each
    ///      constant-product curve is walked less far up its own price impact.
    function test_splittingAcrossThreeMakers_beatsOne() public {
        _ship(0, 10_000e6, 3e18);
        _ship(1, 10_000e6, 3e18);
        _ship(2, 10_000e6, 3e18);

        uint256 sell = 5_000e6; // big enough for price impact to bite

        uint256 snap = vm.snapshotState();
        uint256 oneMaker = _swap(sell, _hookData(1));
        vm.revertToState(snap);
        uint256 threeMakers = _swap(sell, _hookData(3));

        console.log("one maker   WETH out:", oneMaker);
        console.log("three makers WETH out:", threeMakers);
        console.log("improvement (wei)   :", threeMakers - oneMaker);

        assertGt(threeMakers, oneMaker, "splitting should beat a single maker");
    }

    /// @dev The solvency filter. Maker 1 ships, then moves the inventory out of
    ///      their wallet. Their virtual balance still reads full — Aqua has no
    ///      on-chain guard for this — but the fill must route around them.
    function test_insolventMakerIsSkipped_notReverted() public {
        _ship(0, 10_000e6, 3e18);
        _ship(1, 10_000e6, 3e18);

        // maker 1 walks away with the WETH
        vm.prank(makers[1]);
        WETH.transfer(address(0xDEAD), 3e18);

        (, uint256 stillClaims) =
            aqua.safeBalances(makers[1], address(router), strategyHashes[1], address(USDC), address(WETH));
        assertEq(stillClaims, 3e18, "virtual balance should still read full");
        assertEq(
            lens.quotableDepth(makers[1], address(router), strategyHashes[1], address(WETH)),
            0,
            "lens should see through it"
        );
        console.log("maker1 virtual WETH :", stillClaims);
        console.log("maker1 real depth   :", lens.quotableDepth(makers[1], address(router), strategyHashes[1], address(WETH)));

        uint256 gained = _swap(100e6, _hookData(2));
        console.log("swapper WETH gained :", gained);

        assertGt(gained, 0, "swap should still fill from the solvent maker");
        assertEq(USDC.balanceOf(makers[1]), 10_000e6, "insolvent maker should not have been used");
    }
}
