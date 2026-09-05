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
import {Wellhead} from "../src/Wellhead.sol";

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

    /// @dev PARTIAL SOLVENCY — the case the depth filter alone does not catch.
    ///
    ///      Maker 1 ships promising 3 WETH and then moves out all but a sliver.
    ///      Their depth is non-zero, so they survive the filter and get a slice —
    ///      but the slice is large enough that the XYC curve quotes out more than
    ///      the sliver, and `pull()` reverts inside the router.
    ///
    ///      Before Tap wrapped the fill, that revert took the whole swap down with
    ///      it, including maker 0's perfectly good liquidity. It must not.
    function test_makerWhoRevertsMidFill_doesNotKillTheSwap() public {
        _ship(0, 10_000e6, 3e18);
        _ship(1, 10_000e6, 3e18);

        // maker 1 keeps a token dust of inventory: non-zero depth, useless depth
        vm.prank(makers[1]);
        WETH.transfer(address(0xDEAD), 3e18 - 1000);

        uint256 depth1 = lens.quotableDepth(makers[1], address(router), strategyHashes[1], address(WETH));
        assertGt(depth1, 0, "maker 1 must survive the depth filter for this test to mean anything");
        console.log("maker1 depth (wei)  :", depth1);

        uint256 maker0UsdcBefore = USDC.balanceOf(makers[0]);
        uint256 gained = _swap(5_000e6, _hookData(2));
        console.log("swapper WETH gained :", gained);

        assertGt(gained, 0, "one bad maker must not fail the whole swap");
        assertGt(USDC.balanceOf(makers[0]), maker0UsdcBefore, "solvent maker should still have been filled");
        assertEq(PM.getLiquidity(key.toId()), 0, "pool still holds nothing");
    }

    /// @dev A maker who reverts mid-fill must not cost the swapper their fill.
    ///      Their share is swept onto whoever will still take it, so the swap
    ///      completes in full and routes around the failure rather than coming up
    ///      short — which matters more than it sounds, because a short fill pins
    ///      a zero-liquidity pool at its price limit.
    function test_skippedMakersShareIsReRouted_notDropped() public {
        _ship(0, 10_000e6, 3e18);
        _ship(1, 10_000e6, 3e18);

        vm.prank(makers[1]);
        WETH.transfer(address(0xDEAD), 3e18 - 1000); // depth survives, delivery does not

        uint256 sell = 5_000e6;
        deal(address(USDC), swapper, sell);
        uint256 usdcBefore = USDC.balanceOf(swapper);
        uint256 maker1UsdcBefore = USDC.balanceOf(makers[1]);

        vm.startPrank(swapper, swapper);
        USDC.approve(address(swapRouter), type(uint256).max);
        swapRouter.swap(
            key,
            SwapParams({zeroForOne: false, amountSpecified: -int256(sell), sqrtPriceLimitX96: MAX_SQRT}),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            _hookData(2)
        );
        vm.stopPrank();

        uint256 spent = usdcBefore - USDC.balanceOf(swapper);
        console.log("offered USDC        :", sell);
        console.log("actually spent USDC :", spent);

        assertEq(spent, sell, "the fill must consume everything or revert");
        assertEq(USDC.balanceOf(makers[1]), maker1UsdcBefore, "the failing maker must not have been paid");
        assertEq(USDC.balanceOf(address(tap)), 0, "hook must not sit on swapper funds");
        assertEq(WETH.balanceOf(address(tap)), 0, "hook must not sit on maker output");
    }

    /// @dev Invariants that must hold for ANY swap size, not just the ones I
    ///      thought to write down. Three makers, one of them holding a sliver,
    ///      so the fill path crosses solvency, clamping and mid-fill reverts.
    function testFuzz_swapInvariants(uint256 sell) public {
        sell = bound(sell, 1e6, 100_000_000e6);

        _ship(0, 10_000e6, 3e18);
        _ship(1, 10_000e6, 3e18);
        _ship(2, 10_000e6, 3e18);
        vm.prank(makers[2]);
        WETH.transfer(address(0xDEAD), 3e18 - 1000); // depth survives, delivery does not

        deal(address(USDC), swapper, sell);
        uint256 usdcBefore = USDC.balanceOf(swapper);
        uint256 wethBefore = WETH.balanceOf(swapper);

        vm.startPrank(swapper, swapper);
        USDC.approve(address(swapRouter), type(uint256).max);
        try swapRouter.swap(
            key,
            SwapParams({zeroForOne: false, amountSpecified: -int256(sell), sqrtPriceLimitX96: MAX_SQRT}),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            _hookData(3)
        ) {
            uint256 spent = usdcBefore - USDC.balanceOf(swapper);
            // All or nothing: anything the hook leaves unconsumed falls through to
            // the PoolManager and pins a zero-liquidity pool at its price limit.
            assertEq(spent, sell, "a fill that succeeded must have consumed everything");
            assertGt(WETH.balanceOf(swapper) - wethBefore, 0, "paid and received nothing");
        } catch {
            assertEq(USDC.balanceOf(swapper), usdcBefore, "a reverted swap must cost nothing");
        }
        vm.stopPrank();

        assertEq(PM.getLiquidity(key.toId()), 0, "pool must never hold liquidity");
        assertEq(USDC.balanceOf(address(tap)), 0, "hook kept swapper input");
        assertEq(WETH.balanceOf(address(tap)), 0, "hook kept maker output");
    }

    /// @dev Dust across several makers. The pro-rata split gives each maker a
    ///      slice of a couple of wei, which some curves round to a zero payout —
    ///      and a maker who would pay nothing must be skipped, not filled. If no
    ///      maker can pay anything the swap reverts, and it must cost nothing.
    function test_dustAcrossManyMakers_fillsOrRevertsButNeverCharges() public {
        _ship(0, 10_000e6, 3e18);
        _ship(1, 10_000e6, 3e18);
        _ship(2, 10_000e6, 3e18);

        deal(address(USDC), swapper, 1e6);
        uint256 before = USDC.balanceOf(swapper);

        vm.startPrank(swapper, swapper);
        USDC.approve(address(swapRouter), type(uint256).max);
        try swapRouter.swap(
            key,
            SwapParams({zeroForOne: false, amountSpecified: -2, sqrtPriceLimitX96: MAX_SQRT}),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            _hookData(3)
        ) {
            // filled: the swapper must have received something for what they paid
            uint256 spent = before - USDC.balanceOf(swapper);
            console.log("dust spent          :", spent);
            assertGt(WETH.balanceOf(swapper), 0, "charged for a swap that paid nothing");
        } catch {
            assertEq(USDC.balanceOf(swapper), before, "a reverted dust swap must cost nothing");
        }
        vm.stopPrank();

        assertEq(USDC.balanceOf(address(tap)), 0, "hook kept dust");
        assertEq(WETH.balanceOf(address(tap)), 0, "hook kept output");
    }

    /// @dev A pool holding nothing borrows its input from the PoolManager, whose
    ///      balance belongs to every other pool. It cannot lend what it does not
    ///      have — and it must refuse rather than fill part of the way, because
    ///      whatever the hook leaves unconsumed falls through to the PoolManager's
    ///      own swap, which against zero liquidity walks the price to the caller's
    ///      limit and leaves it there. One partial fill would pin the pool at
    ///      MAX_SQRT_RATIO and revert every later swap in the same direction.
    function test_swapLargerThanPoolManagerHolds_revertsWithoutMovingThePrice() public {
        _ship(0, 10_000e6, 3e18);
        _ship(1, 10_000e6, 3e18);

        uint256 held = USDC.balanceOf(address(PM));
        uint256 sell = held * 3;
        uint160 priceBefore = _sqrtPrice();

        deal(address(USDC), swapper, sell);
        uint256 before = USDC.balanceOf(swapper);

        vm.startPrank(swapper, swapper);
        USDC.approve(address(swapRouter), type(uint256).max);
        vm.expectRevert();
        swapRouter.swap(
            key,
            SwapParams({zeroForOne: false, amountSpecified: -int256(sell), sqrtPriceLimitX96: MAX_SQRT}),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            _hookData(2)
        );
        vm.stopPrank();

        assertEq(USDC.balanceOf(swapper), before, "a refused swap must cost nothing");
        assertEq(_sqrtPrice(), priceBefore, "the price must not have moved");
    }

    /// @dev The regression for the bug above: after a swap the pool must still be
    ///      swappable in the same direction. A partial fill used to pin the price
    ///      at the limit, so the second swap here reverted rather than filling.
    function test_poolStaysSwappableAfterAFill() public {
        _ship(0, 10_000e6, 3e18);
        _ship(1, 10_000e6, 3e18);

        uint256 first = _swap(1_000e6, _hookData(2));
        assertGt(first, 0, "first swap should fill");

        uint160 afterFirst = _sqrtPrice();
        assertLt(afterFirst, MAX_SQRT, "price was pinned at the limit by the first fill");

        uint256 second = _swap(1_000e6, _hookData(2));
        assertGt(second, 0, "the pool stopped being swappable after one fill");
    }

    function _sqrtPrice() internal view returns (uint160 sqrtPriceX96) {
        (sqrtPriceX96,,,) = PM.getSlot0(key.toId());
    }

    /// @dev The path an actual wallet takes. No test harness in the loop: an EOA
    ///      approves Wellhead, calls swap, and receives WETH. This is the thing
    ///      the front end sends, so it had better work end to end.
    function test_walletCanSwapThroughWellhead() public {
        _ship(0, 10_000e6, 3e18);
        _ship(1, 10_000e6, 3e18);

        Wellhead wellhead = new Wellhead(PM);
        uint256 sell = 5_000e6;

        deal(address(USDC), swapper, sell);
        uint256 wethBefore = WETH.balanceOf(swapper);

        vm.startPrank(swapper, swapper);
        USDC.approve(address(wellhead), type(uint256).max);
        uint256 reported = wellhead.swap(key, false, sell, 1, _hookData(2));
        vm.stopPrank();

        uint256 gained = WETH.balanceOf(swapper) - wethBefore;
        console.log("wellhead reported  :", reported);
        console.log("wallet actually got:", gained);

        assertEq(reported, gained, "reported output must match what the wallet received");
        assertGt(gained, 0, "wallet received nothing");
        assertEq(PM.getLiquidity(key.toId()), 0, "pool still holds nothing");
        assertEq(USDC.balanceOf(address(wellhead)), 0, "router must not custody input");
        assertEq(WETH.balanceOf(address(wellhead)), 0, "router must not custody output");
    }

    /// @dev The slippage floor is the swapper's only protection against a maker
    ///      who empties their wallet between the quote and the fill.
    function test_wellheadRevertsBelowMinOut() public {
        _ship(0, 10_000e6, 3e18);

        Wellhead wellhead = new Wellhead(PM);
        deal(address(USDC), swapper, 100e6);

        vm.startPrank(swapper, swapper);
        USDC.approve(address(wellhead), type(uint256).max);
        vm.expectRevert();
        wellhead.swap(key, false, 100e6, 100 ether, _hookData(1)); // absurd floor
        vm.stopPrank();

        assertEq(USDC.balanceOf(swapper), 100e6, "a reverted swap must cost nothing");
    }
}
