// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test, console} from "forge-std/Test.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {SwapParams} from "v4-core/types/PoolOperation.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";
import {PoolSwapTest} from "v4-core/test/PoolSwapTest.sol";
import {Tap} from "../src/Tap.sol";
import {IAqua} from "../src/interfaces/IAqua.sol";
import {ISwapVM} from "../src/interfaces/ISwapVM.sol";

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
}

/**
 * Bone Dry, end to end, on a Base mainnet fork.
 *
 * A real Uniswap v4 pool, on the real PoolManager, with ZERO liquidity — and a
 * swap through it still fills, because the Tap sources every token from a 1inch
 * Aqua maker's own wallet inside `beforeSwap`.
 */
contract TapFillTest is Test {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    IPoolManager constant PM = IPoolManager(0x498581fF718922c3f8e6A244956aF099B2652b2b);
    IERC20 constant USDC = IERC20(0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913);
    IERC20 constant WETH = IERC20(0x4200000000000000000000000000000000000006);

    // beforeSwap (1<<7) | beforeSwapReturnDelta (1<<3)
    uint160 constant FLAGS = uint160(0x88);

    IAqua aqua;
    ISwapVM router;
    Tap tap;
    PoolSwapTest swapRouter;

    address maker;
    address swapper = address(0xA11CE);

    bytes strategy;
    bytes32 strategyHash;
    bytes takerTraits;
    PoolKey key;

    function setUp() public {
        vm.createSelectFork(vm.envOr("BASE_RPC_URL", string("https://mainnet.base.org")));

        string memory j = vm.readFile("fixtures/strategy.json");
        aqua         = IAqua(vm.parseJsonAddress(j, ".aqua"));
        router       = ISwapVM(vm.parseJsonAddress(j, ".router"));
        maker        = vm.parseJsonAddress(j, ".maker");
        strategy     = vm.parseJsonBytes(j, ".strategy");
        strategyHash = vm.parseJsonBytes32(j, ".strategyHash");
        takerTraits  = vm.parseJsonBytes(j, ".takerTraitsAndData");

        // v4 encodes hook permissions in the address itself, so the hook has to
        // live at an address whose low bits are exactly our flag set.
        address hookAddr = address(uint160(0x4444 << 144) | FLAGS);
        deployCodeTo("Tap.sol:Tap", abi.encode(PM, router), hookAddr);
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
        PM.initialize(key, 79228162514264337593543950336); // sqrtPriceX96 = 1<<96

        vm.label(hookAddr, "Tap");
        vm.label(address(PM), "PoolManager");
        vm.label(maker, "maker");
        vm.label(swapper, "swapper");
    }

    function test_poolHasNoLiquidity_butSwapStillFills() public {
        // ---- maker ships inventory that never leaves their wallet ----
        uint256 usdcIn = 10_000e6;
        uint256 wethIn = 3e18;

        deal(address(USDC), maker, usdcIn);
        deal(address(WETH), maker, wethIn);

        address[] memory tokens = new address[](2);
        tokens[0] = address(USDC);
        tokens[1] = address(WETH);
        uint256[] memory amounts = new uint256[](2);
        amounts[0] = usdcIn;
        amounts[1] = wethIn;

        vm.startPrank(maker);
        USDC.approve(address(aqua), type(uint256).max);
        WETH.approve(address(aqua), type(uint256).max);
        aqua.ship(address(router), strategy, tokens, amounts);
        vm.stopPrank();

        // ---- the pool itself is empty, and stays empty ----
        uint128 liqBefore = PM.getLiquidity(key.toId());
        assertEq(liqBefore, 0, "pool should have zero liquidity");

        // ---- somebody swaps ----
        uint256 sell = 100e6;
        deal(address(USDC), swapper, sell);

        bytes memory hookData = abi.encode(Tap.TapData({strategy: strategy, takerTraits: takerTraits}));

        uint256 wethBefore = WETH.balanceOf(swapper);
        uint256 makerUsdcBefore = USDC.balanceOf(maker);

        vm.startPrank(swapper, swapper);
        USDC.approve(address(swapRouter), type(uint256).max);
        swapRouter.swap(
            key,
            SwapParams({
                zeroForOne: false,                 // selling currency1 (USDC) for currency0 (WETH)
                amountSpecified: -int256(sell),    // negative = exact input
                sqrtPriceLimitX96: 1461446703485210103287273052203988822378723970341 // MAX-1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            hookData
        );
        vm.stopPrank();

        uint256 gained = WETH.balanceOf(swapper) - wethBefore;
        console.log("pool liquidity      :", PM.getLiquidity(key.toId()));
        console.log("swapper WETH gained :", gained);
        console.log("maker USDC received :", USDC.balanceOf(maker) - makerUsdcBefore);

        assertEq(PM.getLiquidity(key.toId()), 0, "pool STILL has zero liquidity");
        assertGt(gained, 0, "swapper received no WETH");
        assertEq(USDC.balanceOf(maker) - makerUsdcBefore, sell, "maker did not receive the USDC");
    }
}
