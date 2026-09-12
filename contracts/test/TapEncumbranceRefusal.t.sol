// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test, console} from "forge-std/Test.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {SwapParams} from "v4-core/types/PoolOperation.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";
import {PoolSwapTest} from "v4-core/test/PoolSwapTest.sol";
import {Vm} from "forge-std/Vm.sol";

import {BoneDryRouter} from "../src/vm/BoneDryRouter.sol";
import {Encumbrance, EncumbranceArgsBuilder} from "../src/vm/Encumbrance.sol";
import {MakerTraitsLib} from "@1inch/swap-vm/libs/MakerTraits.sol";
import {ISwapVM} from "@1inch/swap-vm/interfaces/ISwapVM.sol";
import {IAqua} from "../src/interfaces/IAqua.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Chains} from "../script/Chains.sol";
import {Tap} from "../src/Tap.sol";
import {Lens} from "../src/Lens.sol";

/**
 * @title TapEncumbranceRefusalTest
 * @notice Phase 6b verification test:
 *         Proves that an encumbered maker whose utilisation exceeds maxUtilBps
 *         is refused by Opcode 35 in BoneDryRouter and caught by Tap.sol,
 *         emitting MakerSkipped with reason == EncumbranceExceeded.selector,
 *         while the swap reroutes to a solvent maker and completes.
 */
contract TapEncumbranceRefusalTest is Test {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    IPoolManager PM;
    uint160 constant FLAGS = uint160(0x88); // beforeSwap | beforeSwapReturnDelta
    uint160 constant MAX_SQRT = 1461446703485210103287273052203988822378723970341;
    uint160 constant MIN_SQRT = 4295128739;

    BoneDryRouter router;
    Lens lens;
    Tap tap;
    PoolSwapTest swapRouter;
    PoolKey key;
    IAqua aqua;
    IERC20 USDC;
    IERC20 WETH;

    address maker0 = makeAddr("maker0_encumbered");
    address maker1 = makeAddr("maker1_solvent");
    address swapper = address(0xA11CE);

    bytes strat0Bytes;
    bytes strat1Bytes;
    bytes32 strat0Hash;
    bytes32 strat1Hash;

    bytes takerTraits = hex"00000000000000000000000000000000000000000041";

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
        vm.createSelectFork(vm.envOr("BASE_RPC_URL", string("https://mainnet.base.org")));
        PM = IPoolManager(Chains.poolManager());
        USDC = IERC20(Chains.usdc());
        WETH = IERC20(Chains.weth());
        aqua = IAqua(0x1111113CCf1426A8E30e2bfF5E005d929bF6a90a);

        lens = new Lens(aqua);
        router = new BoneDryRouter(address(aqua), address(WETH), address(this), "BoneDryRouter", "1");

        address hookAddr = address(uint160(0x4444 << 144) | FLAGS);
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
        vm.label(address(router), "BoneDryRouter");
        vm.label(address(PM), "PoolManager");
        vm.label(address(USDC), "USDC");
        vm.label(address(WETH), "WETH");
        vm.label(maker0, "maker0_encumbered");
        vm.label(maker1, "maker1_solvent");
        vm.label(swapper, "swapper");

        // Fund makers
        deal(address(USDC), maker0, 10_000e6);
        deal(address(WETH), maker0, 10e18);
        deal(address(USDC), maker1, 10_000e6);
        deal(address(WETH), maker1, 10e18);

        vm.startPrank(maker0);
        USDC.approve(address(aqua), type(uint256).max);
        WETH.approve(address(aqua), type(uint256).max);
        vm.stopPrank();

        vm.startPrank(maker1);
        USDC.approve(address(aqua), type(uint256).max);
        WETH.approve(address(aqua), type(uint256).max);
        vm.stopPrank();

        // 1. Ship Maker0: Encumbered strategy
        // Backing is 10 WETH. Declared total encumbrance is 8 WETH.
        // maxUtilBps = 7500 (75%).
        // Utilisation with 8 WETH committed out of 10 WETH is 80% (8000 bps) > 7500 bps.
        // Opcode 35 will revert with EncumbranceExceeded(utilBps, 7500).
        bytes memory encArgs = EncumbranceArgsBuilder.build(
            8e18,               // declaredTotalEncumbrance
            new bytes32[](0),   // sampled siblings
            7500,               // maxUtilBps (75%)
            0                   // widenBps
        );
        bytes memory prog0 = abi.encodePacked(
            hex"1408", uint64(1001),                    // salt
            hex"1100",                                // XYCSwap
            uint8(35), uint8(encArgs.length), encArgs  // Opcode 35
        );
        ISwapVM.Order memory order0 = MakerTraitsLib.build(MakerTraitsLib.Args({
            maker: maker0,
            receiver: address(0),
            shouldUnwrapWeth: false,
            useAquaInsteadOfSignature: true,
            allowZeroAmountIn: false,
            hasPreTransferInHook: false,
            hasPostTransferInHook: false,
            hasPreTransferOutHook: false,
            hasPostTransferOutHook: false,
            preTransferInTarget: address(0),
            preTransferInData: "",
            postTransferInTarget: address(0),
            postTransferInData: "",
            preTransferOutTarget: address(0),
            preTransferOutData: "",
            postTransferOutTarget: address(0),
            postTransferOutData: "",
            program: prog0
        }));
        strat0Bytes = abi.encode(order0);

        // 2. Ship Maker1: Solvent unencumbered strategy (XYCSwap only)
        bytes memory prog1 = abi.encodePacked(
            hex"1408", uint64(2001), // salt
            hex"1100"               // XYCSwap
        );
        ISwapVM.Order memory order1 = MakerTraitsLib.build(MakerTraitsLib.Args({
            maker: maker1,
            receiver: address(0),
            shouldUnwrapWeth: false,
            useAquaInsteadOfSignature: true,
            allowZeroAmountIn: false,
            hasPreTransferInHook: false,
            hasPostTransferInHook: false,
            hasPreTransferOutHook: false,
            hasPostTransferOutHook: false,
            preTransferInTarget: address(0),
            preTransferInData: "",
            postTransferInTarget: address(0),
            postTransferInData: "",
            preTransferOutTarget: address(0),
            preTransferOutData: "",
            postTransferOutTarget: address(0),
            postTransferOutData: "",
            program: prog1
        }));
        strat1Bytes = abi.encode(order1);

        address[] memory tokens = new address[](2);
        tokens[0] = address(USDC);
        tokens[1] = address(WETH);
        uint256[] memory amounts = new uint256[](2);
        amounts[0] = 10_000e6;
        amounts[1] = 3e18;

        vm.prank(maker0);
        strat0Hash = aqua.ship(address(router), strat0Bytes, tokens, amounts);

        vm.prank(maker1);
        strat1Hash = aqua.ship(address(router), strat1Bytes, tokens, amounts);
    }

    function test_makerRefusedByOpcode35_emitsMakerSkippedWithEncumbranceExceededSelector() public {
        uint256 sell = 100e6; // 100 USDC
        deal(address(USDC), swapper, sell);

        bytes[] memory strats = new bytes[](2);
        strats[0] = strat0Bytes;
        strats[1] = strat1Bytes;
        bytes memory hookData = abi.encode(Tap.TapData({strategies: strats, takerTraits: takerTraits}));

        // Verify quotable depth: both makers have full quotable depth according to lens
        uint256 depth0 = lens.quotableDepth(maker0, address(router), strat0Hash, address(WETH));
        uint256 depth1 = lens.quotableDepth(maker1, address(router), strat1Hash, address(WETH));
        assertEq(depth0, 3e18, "maker0 must have quotable depth");
        assertEq(depth1, 3e18, "maker1 must have quotable depth");

        uint256 swapperWethBefore = WETH.balanceOf(swapper);

        // Record logs during swap
        vm.recordLogs();

        vm.startPrank(swapper, swapper);
        USDC.approve(address(swapRouter), type(uint256).max);
        swapRouter.swap(
            key,
            _params(sell),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            hookData
        );
        vm.stopPrank();

        uint256 gained = WETH.balanceOf(swapper) - swapperWethBefore;
        console.log("Swap completed! Swapper WETH gained:", gained);
        assertGt(gained, 0, "Swapper must have received WETH from solvent maker1");

        // Inspect recorded logs to find MakerSkipped for maker0
        Vm.Log[] memory entries = vm.getRecordedLogs();
        bytes32 makerSkippedTopic = keccak256("MakerSkipped(address,bytes32,address,uint256,bytes4)");
        bytes4 expectedReason = Encumbrance.EncumbranceExceeded.selector;

        bool foundRefusal = false;
        for (uint256 i = 0; i < entries.length; i++) {
            Vm.Log memory entry = entries[i];
            if (entry.emitter == address(tap) && entry.topics.length > 0 && entry.topics[0] == makerSkippedTopic) {
                address loggedMaker = address(uint160(uint256(entry.topics[1])));
                bytes32 loggedStratHash = entry.topics[2];
                address loggedToken = address(uint160(uint256(entry.topics[3])));
                (uint256 wanted, bytes4 reason) = abi.decode(entry.data, (uint256, bytes4));

                console.log("Found MakerSkipped event:");
                console.log("  maker:       ", loggedMaker);
                console.log("  token:       ", loggedToken);
                console.log("  wanted:      ", wanted);
                console.logBytes4(reason);

                if (loggedMaker == maker0) {
                    assertEq(loggedStratHash, strat0Hash, "strategyHash mismatch");
                    assertEq(loggedToken, address(WETH), "token mismatch");
                    assertGt(wanted, 0, "wanted amount must be > 0");
                    assertEq(reason, expectedReason, "revert selector must match EncumbranceExceeded");
                    foundRefusal = true;
                }
            }
        }

        assertTrue(foundRefusal, "Must have caught MakerSkipped event for maker0 with EncumbranceExceeded selector");
        console.log("Successfully verified: Opcode 35 refusal caught by Tap and logged with EncumbranceExceeded selector!");
    }
}
