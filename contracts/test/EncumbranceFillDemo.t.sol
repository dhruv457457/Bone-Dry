// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {BoneDryRouter} from "../src/vm/BoneDryRouter.sol";
import {Encumbrance, EncumbranceArgsBuilder} from "../src/vm/Encumbrance.sol";
import {MakerTraitsLib} from "@1inch/swap-vm/libs/MakerTraits.sol";
import {ISwapVM} from "@1inch/swap-vm/interfaces/ISwapVM.sol";
import {IAqua} from "../src/interfaces/IAqua.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Chains} from "../script/Chains.sol";

/**
 * @title EncumbranceFillDemo
 * @notice ETHOnline 2026 Submission Money Shot Demo (Phase 5).
 *
 * Demonstrates on a live Base mainnet fork against canonical Aqua:
 * 1. Maker with ONE strategy -> fill succeeds at the full quote on-chain.
 * 2. Same maker, same wallet, after sibling strategies encumber the balance
 *    -> the exact same quote refuses on-chain in the SwapVM.
 */
contract EncumbranceFillDemo is Test {
    BoneDryRouter router;
    IAqua aqua;
    IERC20 USDC;
    IERC20 WETH;

    address maker = makeAddr("demoMaker");
    address taker = makeAddr("demoTaker");

    bytes takerTraitsAndData = hex"00000000000000000000000000000000000000000041";

    function setUp() public {
        vm.createSelectFork(vm.envOr("BASE_RPC_URL", string("https://mainnet.base.org")));
        aqua = IAqua(0x1111113CCf1426A8E30e2bfF5E005d929bF6a90a);
        USDC = IERC20(Chains.usdc());
        WETH = IERC20(Chains.weth());

        router = new BoneDryRouter(address(aqua), address(WETH), address(this), "BoneDryRouter", "1");
        vm.label(address(aqua), "Aqua");
        vm.label(address(router), "BoneDryRouter");
        vm.label(address(USDC), "USDC");
        vm.label(address(WETH), "WETH");
        vm.label(maker, "maker");
        vm.label(taker, "taker");

        // Fund maker with 10 WETH and approve Aqua
        deal(address(WETH), maker, 10e18);
        deal(address(USDC), maker, 10_000e6);
        vm.startPrank(maker);
        WETH.approve(address(aqua), type(uint256).max);
        USDC.approve(address(aqua), type(uint256).max);
        vm.stopPrank();
    }

    function _shipStrategy(
        uint64 salt,
        uint256 declaredTotalEncumbrance,
        bytes32[] memory siblingHashes,
        uint16 maxUtilBps,
        uint16 widenBps,
        uint256 usdcLiquidity,
        uint256 wethLiquidity
    ) internal returns (ISwapVM.Order memory order, bytes32 orderHash) {
        bytes memory encArgs = EncumbranceArgsBuilder.build(declaredTotalEncumbrance, siblingHashes, maxUtilBps, widenBps);
        bytes memory program = abi.encodePacked(
            hex"1408", uint64(salt), // Controls._salt (unique nonce)
            hex"1100",               // XYCSwap._xycSwapXD (Opcode 17)
            uint8(35), uint8(encArgs.length), encArgs // BoneDry._encumberedCap (Opcode 35)
        );

        order = MakerTraitsLib.build(MakerTraitsLib.Args({
            maker: maker,
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
            program: program
        }));

        address[] memory tokens = new address[](2);
        tokens[0] = address(USDC);
        tokens[1] = address(WETH);
        uint256[] memory amounts = new uint256[](2);
        amounts[0] = usdcLiquidity;
        amounts[1] = wethLiquidity;

        vm.prank(maker);
        orderHash = aqua.ship(address(router), abi.encode(order), tokens, amounts);
    }

    function _shipSibling(uint64 salt, uint256 usdcLiquidity, uint256 wethLiquidity) internal returns (bytes32 siblingHash) {
        bytes memory program = abi.encodePacked(
            hex"1408", uint64(salt),
            hex"1100"
        );

        ISwapVM.Order memory order = MakerTraitsLib.build(MakerTraitsLib.Args({
            maker: maker,
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
            program: program
        }));

        address[] memory tokens = new address[](2);
        tokens[0] = address(USDC);
        tokens[1] = address(WETH);
        uint256[] memory amounts = new uint256[](2);
        amounts[0] = usdcLiquidity;
        amounts[1] = wethLiquidity;

        vm.prank(maker);
        siblingHash = aqua.ship(address(router), abi.encode(order), tokens, amounts);
    }

    /// @notice The submission demo: side-by-side fill comparison
    function test_EndToEndFillDemo() public {
        uint256 swapAmountIn = 1_000e6; // 1,000 USDC
        uint16 maxUtilBps = 7_500;       // 75% max utilization before refusing
        uint16 widenBps = 2_000;         // 20% haircut at 100% util

        emit log_string("=========================================================================");
        emit log_string("BONE DRY (1INCH AQUA TRACK) - VM ENCUMBRANCE POSITION DEMO");
        emit log_string("Testing on Base Mainnet Fork against Canonical Aqua (0x1111113CCf...)");
        emit log_string("=========================================================================");

        // ---------------------------------------------------------------------
        // SCENARIO 1: Maker with ONE strategy (Unencumbered)
        // ---------------------------------------------------------------------
        bytes32[] memory emptySiblings = new bytes32[](0);
        (ISwapVM.Order memory order1, bytes32 orderHash1) = _shipStrategy(
            1001,
            0,
            emptySiblings,
            maxUtilBps,
            widenBps,
            10_000e6, // 10,000 USDC
            10e18     // 10 WETH
        );

        emit log_string("\n--- SCENARIO 1: UNENCUMBERED FILL ---");
        emit log_named_address("Maker Address", maker);
        emit log_named_uint("Maker Wallet WETH Balance", WETH.balanceOf(maker));
        emit log_named_uint("Maker Sibling Strategies", 0);
        emit log_named_uint("Encumbered WETH", 0);

        // Taker executes fill
        deal(address(USDC), taker, swapAmountIn);
        vm.prank(taker);
        USDC.approve(address(router), swapAmountIn);

        uint256 takerWethBefore = WETH.balanceOf(taker);
        vm.prank(taker);
        (uint256 amountIn1, uint256 amountOut1, bytes32 executedHash1) = router.swap(
            order1,
            address(USDC),
            address(WETH),
            swapAmountIn,
            takerTraitsAndData
        );
        uint256 takerWethReceived = WETH.balanceOf(taker) - takerWethBefore;

        emit log_named_uint("Taker Input (USDC)", amountIn1);
        emit log_named_uint("Taker Received Output (WETH)", amountOut1);
        emit log_named_bytes32("Order Hash", executedHash1);
        emit log_string("RESULT: Swap succeeded at 100% of full XYC quote on-chain!");

        assertEq(executedHash1, orderHash1, "Order hash matches");
        assertEq(takerWethReceived, amountOut1, "Taker received exact tokens");
        assertEq(amountOut1, (swapAmountIn * 10e18) / (10_000e6 + swapAmountIn), "Full unhaircut XYC quote delivered");

        // ---------------------------------------------------------------------
        // SCENARIO 2: Same maker, same wallet, after sibling strategies encumber balance
        // ---------------------------------------------------------------------
        emit log_string("\n--- SCENARIO 2: SIBLING ENCUMBRANCE TRIGGERED ---");

        // Maker ships a sibling strategy encumbering 8 WETH
        bytes32 siblingHash = _shipSibling(2001, 10_000e6, 8e18);
        emit log_named_bytes32("Maker shipped Sibling Strategy", siblingHash);
        emit log_named_uint("Sibling Promised WETH", 8e18);

        // Remaining maker wallet balance after Fill 1
        uint256 makerRemainingWeth = WETH.balanceOf(maker);
        emit log_named_uint("Maker Real Wallet WETH Balance", makerRemainingWeth);

        // Ship Strategy 2 whose program monitors its sibling commitments
        bytes32[] memory siblings = new bytes32[](1);
        siblings[0] = siblingHash;

        (ISwapVM.Order memory order2,) = _shipStrategy(
            1002,
            8e18,
            siblings,
            maxUtilBps,
            widenBps,
            10_000e6,
            10e18
        );

        // Calculate on-chain utilization: encumbered (8 WETH) / backing (~9.09 WETH) = ~88.00%
        uint256 expectedUtil = (8e18 * 1e4) / makerRemainingWeth;
        emit log_named_uint("Calculated Sibling Utilization (bps)", expectedUtil);
        emit log_named_uint("Max Allowed Utilization (bps)", maxUtilBps);
        assertTrue(expectedUtil >= maxUtilBps, "Utilization strictly exceeds max threshold");

        // Taker attempts the EXACT SAME swap against Strategy 2
        deal(address(USDC), taker, swapAmountIn);
        vm.prank(taker);
        USDC.approve(address(router), swapAmountIn);

        emit log_string("Taker initiates swap against Strategy 2 on-chain...");

        // Opcode 35 detects the sibling encumbrance on Aqua and REFUSES execution
        vm.prank(taker);
        vm.expectRevert(
            abi.encodeWithSelector(
                Encumbrance.EncumbranceExceeded.selector,
                expectedUtil,
                maxUtilBps
            )
        );
        router.swap(
            order2,
            address(USDC),
            address(WETH),
            swapAmountIn,
            takerTraitsAndData
        );

        emit log_string("RESULT: Swap REFUSED on-chain in VM by Opcode 35!");
        emit log_string("Revert: EncumbranceExceeded(utilization >= maxThreshold)");
        emit log_string("PROTECTION: Zero gas wasted on empty/toxic settlement; taker protected.");
        emit log_string("=========================================================================\n");
    }
}
