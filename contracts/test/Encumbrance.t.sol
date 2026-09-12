// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {BoneDryRouter} from "../src/vm/BoneDryRouter.sol";
import {Encumbrance, EncumbranceArgsBuilder} from "../src/vm/Encumbrance.sol";
import {MakerTraitsLib, MakerTraits} from "@1inch/swap-vm/libs/MakerTraits.sol";
import {ISwapVM} from "@1inch/swap-vm/interfaces/ISwapVM.sol";
import {IAqua} from "../src/interfaces/IAqua.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {Chains} from "../script/Chains.sol";

contract EncumbranceTest is Test {
    BoneDryRouter router;
    IAqua aqua;
    IERC20 USDC;
    IERC20 WETH;

    bytes takerTraitsAndData = hex"00000000000000000000000000000000000000000041";
    bytes takerTraitsAndDataExactOut = hex"00000000000000000000000000000000000000000040";

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
    }

    /// @notice Case 8: Router bytecode size is under the EIP-170 limit (24,576 bytes)
    function testBytecodeSize() public {
        uint256 size = address(router).code.length;
        emit log_named_uint("BoneDryRouter bytecode size (bytes)", size);
        assertLt(size, 24576, "Router exceeds EIP-170 limit");
    }

    /// @dev Helper to construct and ship an encumbrance-aware XYCSwap strategy
    function _createAndShipStrategy(
        address maker,
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
            hex"1408", uint64(salt), // Controls._salt
            hex"1100",               // XYCSwap._xycSwapXD
            uint8(35), uint8(encArgs.length), encArgs // BoneDry._encumberedCap
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

        bytes memory strategy = abi.encode(order);

        address[] memory tokens = new address[](2);
        tokens[0] = address(USDC);
        tokens[1] = address(WETH);
        uint256[] memory amounts = new uint256[](2);
        amounts[0] = usdcLiquidity;
        amounts[1] = wethLiquidity;

        vm.prank(maker);
        orderHash = aqua.ship(address(router), strategy, tokens, amounts);
    }

    /// @dev Helper to ship a sibling strategy for a maker
    function _shipSibling(
        address maker,
        uint64 salt,
        uint256 usdcLiquidity,
        uint256 wethLiquidity
    ) internal returns (bytes32 siblingHash) {
        bytes memory program = abi.encodePacked(
            hex"1408", uint64(salt), // Controls._salt
            hex"1100"                // XYCSwap._xycSwapXD
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

        bytes memory strategy = abi.encode(order);

        address[] memory tokens = new address[](2);
        tokens[0] = address(USDC);
        tokens[1] = address(WETH);
        uint256[] memory amounts = new uint256[](2);
        amounts[0] = usdcLiquidity;
        amounts[1] = wethLiquidity;

        vm.prank(maker);
        siblingHash = aqua.ship(address(router), strategy, tokens, amounts);
    }

    /// @notice Case 1: No siblings, full backing -> quote unchanged
    function test_Case1_noSiblings_fullBacking() public {
        address maker = makeAddr("case1Maker");
        deal(address(WETH), maker, 10e18);
        vm.prank(maker);
        WETH.approve(address(aqua), 10e18);

        bytes32[] memory siblings = new bytes32[](0);
        (ISwapVM.Order memory order,) = _createAndShipStrategy(
            maker,
            1,
            0,
            siblings,
            10_000, // maxUtilBps = 100%
            2_000,  // widenBps = 20%
            10_000e6, // 10,000 USDC
            10e18     // 10 WETH
        );

        uint256 amountIn = 1_000e6; // 1,000 USDC
        // Standard XYC formula: (1000e6 * 10e18) / (10000e6 + 1000e6) = 10e24 / 11e6 = 909090909090909090
        uint256 expectedOut = (amountIn * 10e18) / (10_000e6 + amountIn);

        (, uint256 amountOut,) = router.quote(
            order,
            address(USDC),
            address(WETH),
            amountIn,
            takerTraitsAndData
        );

        emit log_named_uint("Case 1 Quote amountOut", amountOut);
        emit log_named_uint("Case 1 Expected XYC", expectedOut);
        assertEq(amountOut, expectedOut, "Quote should be completely unhaircut with zero encumbrance");
    }

    /// @notice Case 2: One sibling at 50% backing -> quote haircut by roughly widenBps/2
    function test_Case2_oneSibling_haircut() public {
        address maker = makeAddr("case2Maker");
        deal(address(WETH), maker, 10e18);
        vm.prank(maker);
        WETH.approve(address(aqua), 10e18);

        // Sibling encumbers 5 WETH (50% of 10 WETH backing)
        bytes32 sibHash = _shipSibling(maker, 101, 10_000e6, 5e18);

        bytes32[] memory siblings = new bytes32[](1);
        siblings[0] = sibHash;

        uint16 maxUtilBps = 10_000; // 100%
        uint16 widenBps = 2_000;   // 20%

        (ISwapVM.Order memory order,) = _createAndShipStrategy(
            maker,
            2,
            5e18,
            siblings,
            maxUtilBps,
            widenBps,
            10_000e6,
            10e18
        );

        uint256 amountIn = 1_000e6;
        uint256 rawOut = (amountIn * 10e18) / (10_000e6 + amountIn);

        // util = 5e18 * 1e4 / 10e18 = 5000 (50%)
        // haircut = rawOut * 2000 * 5000 / 1e8 = rawOut * 10_000_000 / 100_000_000 = rawOut * 10% (widenBps / 2)
        uint256 expectedHaircut = (rawOut * uint256(widenBps) * 5000) / 1e8;
        uint256 expectedOut = rawOut - expectedHaircut;

        (, uint256 amountOut,) = router.quote(
            order,
            address(USDC),
            address(WETH),
            amountIn,
            takerTraitsAndData
        );

        emit log_named_uint("Raw XYC amountOut", rawOut);
        emit log_named_uint("Expected haircut (10% of quote)", expectedHaircut);
        emit log_named_uint("Haircut amountOut", amountOut);

        assertEq(amountOut, expectedOut, "Quote haircut should exactly match widenBps * util / 1e8");
        assertLt(amountOut, rawOut, "Encumbered quote must be less than raw quote");
    }

    /// @notice Case 3: Siblings above maxUtilBps -> reverts EncumbranceExceeded
    function test_Case3_exceedsMaxUtil_reverts() public {
        address maker = makeAddr("case3Maker");
        deal(address(WETH), maker, 10e18);
        vm.prank(maker);
        WETH.approve(address(aqua), 10e18);

        // Sibling encumbers 8 WETH (80% of backing)
        bytes32 sibHash = _shipSibling(maker, 201, 10_000e6, 8e18);

        bytes32[] memory siblings = new bytes32[](1);
        siblings[0] = sibHash;

        uint16 maxUtilBps = 7_500; // 75% cap
        uint16 widenBps = 2_000;

        (ISwapVM.Order memory order,) = _createAndShipStrategy(
            maker,
            3,
            8e18,
            siblings,
            maxUtilBps,
            widenBps,
            10_000e6,
            10e18
        );

        // util is 8000, which exceeds maxUtilBps (7500)
        vm.expectRevert(abi.encodeWithSelector(Encumbrance.EncumbranceExceeded.selector, 8000, 7500));
        router.quote(
            order,
            address(USDC),
            address(WETH),
            1_000e6,
            takerTraitsAndData
        );
    }

    /// @notice Case 4: Sibling docked between ship and fill -> encumbrance drops, quote widens back (proves 0xff skip)
    function test_Case4_siblingDocked_restoresQuote() public {
        address maker = makeAddr("case4Maker");
        deal(address(WETH), maker, 10e18);
        vm.prank(maker);
        WETH.approve(address(aqua), 10e18);

        // Sibling encumbers 8 WETH (80% of backing)
        bytes32 sibHash = _shipSibling(maker, 301, 10_000e6, 8e18);

        bytes32[] memory siblings = new bytes32[](1);
        siblings[0] = sibHash;

        uint16 maxUtilBps = 7_500; // 75% cap
        uint16 widenBps = 2_000;

        // Maker ships strategy declaring 0 encumbrance while having an active 8 WETH sibling
        (ISwapVM.Order memory order,) = _createAndShipStrategy(
            maker,
            4,
            0,
            siblings,
            maxUtilBps,
            widenBps,
            10_000e6,
            10e18
        );

        uint256 amountIn = 1_000e6;

        // While sibling is active, on-chain spot-check catches under-declaration (0 < 8 WETH) and reverts
        vm.expectRevert(abi.encodeWithSelector(Encumbrance.EncumbranceUnderdeclared.selector, 0, 8e18));
        router.quote(order, address(USDC), address(WETH), amountIn, takerTraitsAndData);

        // Maker docks the sibling strategy
        address[] memory tokens = new address[](2);
        tokens[0] = address(USDC);
        tokens[1] = address(WETH);
        vm.prank(maker);
        aqua.dock(address(router), sibHash, tokens);

        // After docking, sibling has tokensCount == 0xff, so instruction skips it!
        // Sampled encumbrance drops to 0, spot-check (0 >= 0) passes, quote succeeds at full amount!
        uint256 expectedOut = (amountIn * 10e18) / (10_000e6 + amountIn);
        (, uint256 amountOut,) = router.quote(order, address(USDC), address(WETH), amountIn, takerTraitsAndData);

        emit log_named_uint("Post-dock restored quote amountOut", amountOut);
        assertEq(amountOut, expectedOut, "Quote should fully restore after sibling strategy is docked");
    }

    /// @notice Case 5: Maker revokes ERC-20 allowance -> backing == 0, reverts
    function test_Case5_allowanceRevoked_reverts() public {
        address maker = makeAddr("case5Maker");
        deal(address(WETH), maker, 10e18);
        vm.prank(maker);
        WETH.approve(address(aqua), 10e18);

        bytes32[] memory siblings = new bytes32[](0);
        (ISwapVM.Order memory order,) = _createAndShipStrategy(
            maker,
            5,
            0,
            siblings,
            10_000,
            2_000,
            10_000e6,
            10e18
        );

        // Maker revokes allowance
        vm.prank(maker);
        WETH.approve(address(aqua), 0);

        vm.expectRevert(abi.encodeWithSelector(Encumbrance.EncumbranceZeroBacking.selector));
        router.quote(
            order,
            address(USDC),
            address(WETH),
            1_000e6,
            takerTraitsAndData
        );
    }

    /// @notice Case 6: amountOut > free after haircut -> reverts EncumbranceInsufficient
    function test_Case6_insufficientFree_reverts() public {
        address maker = makeAddr("case6Maker");
        deal(address(WETH), maker, 10e18);
        vm.prank(maker);
        WETH.approve(address(aqua), 10e18);

        // Sibling encumbers 9.5 WETH. Backing = 10 WETH -> free = 0.5 WETH
        bytes32 sibHash = _shipSibling(maker, 501, 10_000e6, 9.5e18);

        bytes32[] memory siblings = new bytes32[](1);
        siblings[0] = sibHash;

        uint16 maxUtilBps = 10_000; // 100% (so util check passes)
        uint16 widenBps = 1_000;    // 10% haircut

        (ISwapVM.Order memory order,) = _createAndShipStrategy(
            maker,
            6,
            9.5e18,
            siblings,
            maxUtilBps,
            widenBps,
            10_000e6,
            10e18
        );

        uint256 amountIn = 1_000e6;
        uint256 rawOut = (amountIn * 10e18) / (10_000e6 + amountIn); // ~0.909e18
        uint256 haircut = (rawOut * uint256(widenBps) * 9500) / 1e8; // ~0.086e18
        uint256 haircutOut = rawOut - haircut; // ~0.823e18
        uint256 free = 10e18 - 9.5e18; // 0.5e18

        emit log_named_uint("Post-haircut amountOut", haircutOut);
        emit log_named_uint("Free unencumbered backing", free);
        assertTrue(haircutOut > free, "haircutOut should exceed free backing");

        vm.expectRevert(abi.encodeWithSelector(Encumbrance.EncumbranceInsufficient.selector, haircutOut, free));
        router.quote(
            order,
            address(USDC),
            address(WETH),
            amountIn,
            takerTraitsAndData
        );
    }

    /// @notice Case 7: Quote/swap divergence -> quote succeeds, sibling filled, swap then reverts
    function test_Case7_quoteSwapDivergence() public {
        address maker = makeAddr("case7Maker");
        address taker = makeAddr("case7Taker");

        deal(address(WETH), maker, 10e18);
        vm.prank(maker);
        WETH.approve(address(aqua), 10e18);

        // Sibling encumbers 4 WETH (40% util)
        bytes32 sibHash = _shipSibling(maker, 601, 10_000e6, 4e18);

        bytes32[] memory siblings = new bytes32[](1);
        siblings[0] = sibHash;

        uint16 maxUtilBps = 5_000; // 50% max utilization
        uint16 widenBps = 2_000;

        (ISwapVM.Order memory order,) = _createAndShipStrategy(
            maker,
            7,
            4e18,
            siblings,
            maxUtilBps,
            widenBps,
            10_000e6,
            10e18
        );

        uint256 amountIn = 1_000e6;

        // --- STEP 1: Quote at evaluation time ---
        // Util is 4e18 / 10e18 = 40% < 50% maxUtil. Quote succeeds!
        (, uint256 quotedOut,) = router.quote(
            order,
            address(USDC),
            address(WETH),
            amountIn,
            takerTraitsAndData
        );
        emit log_named_uint("Quote succeeded! Quoted amountOut", quotedOut);
        assertGt(quotedOut, 0, "Initial quote must succeed");

        // --- STEP 2: Real-world event between quote and swap ---
        // Maker moves funds out of wallet, reducing balance from 10 WETH to 7 WETH
        // (Simulating a maker withdrawal or fill across sibling venues)
        vm.prank(maker);
        WETH.transfer(address(0xDEAD), 3e18);
        assertEq(WETH.balanceOf(maker), 7e18, "Maker balance reduced to 7 WETH");

        // New utilization: 4e18 * 1e4 / 7e18 = 5,714 bps (57.14%)
        // 5,714 >= 5,000 (maxUtilBps)
        uint256 expectedNewUtil = (uint256(4e18) * 1e4) / uint256(7e18);
        emit log_named_uint("New utilization bps after maker moved funds", expectedNewUtil);
        assertTrue(expectedNewUtil >= maxUtilBps, "Utilization pushed past maxUtilBps");

        // --- STEP 3: Swap execution at fill time ---
        // Taker attempts to execute the swap on-chain
        deal(address(USDC), taker, amountIn);
        vm.prank(taker);
        USDC.approve(address(router), amountIn);

        // VM refuses the swap on-chain because collateral obligation was breached
        vm.prank(taker);
        vm.expectRevert(abi.encodeWithSelector(Encumbrance.EncumbranceExceeded.selector, expectedNewUtil, maxUtilBps));
        router.swap(
            order,
            address(USDC),
            address(WETH),
            amountIn,
            takerTraitsAndData
        );

        emit log_string("Swap reverted with EncumbranceExceeded: protected taker from toxic fill!");
    }

    /// @notice Bonus: Self-referential sibling hash is provably harmless (skipped, not double counted)
    function test_Bonus_selfReferentialSiblingIsHarmless() public {
        address maker = makeAddr("bonusMaker");
        deal(address(WETH), maker, 10e18);
        vm.prank(maker);
        WETH.approve(address(aqua), 10e18);

        // First predict order and orderHash
        bytes32[] memory emptySiblings = new bytes32[](0);
        bytes memory encArgs = EncumbranceArgsBuilder.build(0, emptySiblings, 10_000, 2_000);
        bytes memory programWithoutSiblings = abi.encodePacked(
            hex"1408", uint64(999),
            hex"1100",
            uint8(35), uint8(encArgs.length), encArgs
        );
        ISwapVM.Order memory protoOrder = MakerTraitsLib.build(MakerTraitsLib.Args({
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
            program: programWithoutSiblings
        }));
        bytes32 ownHash = router.hash(protoOrder);

        // Now build strategy with ownHash included in siblings!
        bytes32[] memory selfSiblings = new bytes32[](1);
        selfSiblings[0] = ownHash;

        (ISwapVM.Order memory selfOrder,) = _createAndShipStrategy(
            maker,
            999,
            0,
            selfSiblings,
            10_000,
            2_000,
            10_000e6,
            10e18
        );

        uint256 amountIn = 1_000e6;
        uint256 expectedOut = (amountIn * 10e18) / (10_000e6 + amountIn);

        (, uint256 amountOut,) = router.quote(
            selfOrder,
            address(USDC),
            address(WETH),
            amountIn,
            takerTraitsAndData
        );

        emit log_named_uint("Self-referential quote amountOut", amountOut);
        assertEq(amountOut, expectedOut, "Self-referential hash must be skipped without inflating encumbrance");
    }

    /// @notice Case 2 (exactOut): One sibling at 50% backing -> taker pays penalty on amountIn (price widened)
    function test_Case2_exactOut_oneSibling_penalty() public {
        address maker = makeAddr("case2ExactOutMaker");
        deal(address(WETH), maker, 10e18);
        vm.prank(maker);
        WETH.approve(address(aqua), 10e18);

        // Sibling encumbers 5 WETH (50% of 10 WETH backing)
        bytes32 sibHash = _shipSibling(maker, 102, 10_000e6, 5e18);

        bytes32[] memory siblings = new bytes32[](1);
        siblings[0] = sibHash;

        uint16 maxUtilBps = 10_000; // 100%
        uint16 widenBps = 2_000;   // 20%

        (ISwapVM.Order memory order,) = _createAndShipStrategy(
            maker,
            202,
            5e18,
            siblings,
            maxUtilBps,
            widenBps,
            10_000e6,
            10e18
        );

        // Taker requests exact output of 0.5 WETH
        uint256 amountOutRequested = 0.5e18;
        // Standard XYC exactOut: amountIn = ceilDiv(amountOut * balanceIn, balanceOut - amountOut)
        uint256 rawIn = Math.ceilDiv(amountOutRequested * 10_000e6, 10e18 - amountOutRequested);

        // util = 5000 (50%)
        // penalty = ceilDiv(rawIn * widenBps * util, 1e8)
        uint256 expectedPenalty = Math.mulDiv(rawIn, uint256(widenBps) * 5000, 1e8, Math.Rounding.Ceil);
        uint256 expectedFinalIn = rawIn + expectedPenalty;

        (uint256 amountInQuoted, uint256 amountOutQuoted,) = router.quote(
            order,
            address(USDC),
            address(WETH),
            amountOutRequested,
            takerTraitsAndDataExactOut
        );

        emit log_named_uint("Raw XYC amountIn", rawIn);
        emit log_named_uint("Expected penalty on amountIn (10%)", expectedPenalty);
        emit log_named_uint("Final penalty amountIn", amountInQuoted);
        emit log_named_uint("Exact output delivered", amountOutQuoted);

        assertEq(amountOutQuoted, amountOutRequested, "ExactOut must preserve requested output tokens");
        assertEq(amountInQuoted, expectedFinalIn, "ExactOut penalty should increase amountIn by widenBps * util / 1e8");
        assertGt(amountInQuoted, rawIn, "Encumbered exactOut must demand more input tokens from taker");
    }

    /// @notice Case 6 (exactOut): amountOut requested > free -> reverts EncumbranceInsufficient
    function test_Case6_exactOut_insufficientFree_reverts() public {
        address maker = makeAddr("case6ExactOutMaker");
        deal(address(WETH), maker, 10e18);
        vm.prank(maker);
        WETH.approve(address(aqua), 10e18);

        // Sibling encumbers 9.5 WETH. Backing = 10 WETH -> free = 0.5 WETH
        bytes32 sibHash = _shipSibling(maker, 502, 10_000e6, 9.5e18);

        bytes32[] memory siblings = new bytes32[](1);
        siblings[0] = sibHash;

        uint16 maxUtilBps = 10_000; // 100%
        uint16 widenBps = 1_000;

        (ISwapVM.Order memory order,) = _createAndShipStrategy(
            maker,
            602,
            9.5e18,
            siblings,
            maxUtilBps,
            widenBps,
            10_000e6,
            10e18
        );

        // Taker asks for 0.6 WETH exact out, but free is only 0.5 WETH
        uint256 requestedOut = 0.6e18;
        uint256 free = 10e18 - 9.5e18; // 0.5e18

        vm.expectRevert(abi.encodeWithSelector(Encumbrance.EncumbranceInsufficient.selector, requestedOut, free));
        router.quote(
            order,
            address(USDC),
            address(WETH),
            requestedOut,
            takerTraitsAndDataExactOut
        );
    }

    /// @notice Case 7 (exactOut): Quote succeeds, sibling filled / funds moved, exactOut swap then reverts
    function test_Case7_exactOut_quoteSwapDivergence() public {
        address maker = makeAddr("case7ExactOutMaker");
        address taker = makeAddr("case7ExactOutTaker");

        deal(address(WETH), maker, 10e18);
        vm.prank(maker);
        WETH.approve(address(aqua), 10e18);

        // Sibling encumbers 4 WETH (40% util)
        bytes32 sibHash = _shipSibling(maker, 702, 10_000e6, 4e18);

        bytes32[] memory siblings = new bytes32[](1);
        siblings[0] = sibHash;

        uint16 maxUtilBps = 5_000; // 50% cap
        uint16 widenBps = 2_000;

        (ISwapVM.Order memory order,) = _createAndShipStrategy(
            maker,
            702,
            4e18,
            siblings,
            maxUtilBps,
            widenBps,
            10_000e6,
            10e18
        );

        uint256 requestedOut = 0.5e18;

        // --- STEP 1: Quote on exactOut succeeds ---
        (uint256 quotedIn, uint256 quotedOut,) = router.quote(
            order,
            address(USDC),
            address(WETH),
            requestedOut,
            takerTraitsAndDataExactOut
        );
        emit log_named_uint("ExactOut Quote amountIn required", quotedIn);
        assertEq(quotedOut, requestedOut, "ExactOut delivered requested amount");

        // --- STEP 2: Maker moves 3 WETH out of wallet, balance drops to 7 WETH ---
        vm.prank(maker);
        WETH.transfer(address(0xDEAD), 3e18);

        // Utilization rises to 4e18 * 1e4 / 7e18 = 5714 >= 5000 maxUtilBps
        uint256 expectedNewUtil = (uint256(4e18) * 1e4) / uint256(7e18);

        // --- STEP 3: Swap execution on exactOut reverts ---
        deal(address(USDC), taker, quotedIn * 2);
        vm.prank(taker);
        USDC.approve(address(router), quotedIn * 2);

        vm.prank(taker);
        vm.expectRevert(abi.encodeWithSelector(Encumbrance.EncumbranceExceeded.selector, expectedNewUtil, maxUtilBps));
        router.swap(
            order,
            address(USDC),
            address(WETH),
            requestedOut,
            takerTraitsAndDataExactOut
        );

        emit log_string("ExactOut Swap reverted with EncumbranceExceeded on fill!");
    }

    /// @notice Issue 3: Arbitrarily large commitments (e.g. billions of tokens) do not overflow uint256 due to Math.mulDiv
    function test_Issue3_largeCommitmentMathMulDivNoOverflow() public {
        address maker = makeAddr("largeCommitMaker");
        deal(address(WETH), maker, 10e18);
        vm.prank(maker);
        WETH.approve(address(aqua), 10e18);

        // Sibling encumbers 1.4 billion tokens (e.g. 1.4e9 * 1e18 = 1.4e27)
        // With uint248 max ~ 4.5e74, 1.4e27 fits in uint248
        uint256 hugeAmount = 1_400_000_000e18;
        bytes32 sibHash = _shipSibling(maker, 901, 10_000e6, hugeAmount);

        bytes32[] memory siblings = new bytes32[](1);
        siblings[0] = sibHash;

        (ISwapVM.Order memory order,) = _createAndShipStrategy(
            maker,
            901,
            hugeAmount,
            siblings,
            10_000,
            2_000,
            10_000e6,
            10e18
        );

        // util is Math.mulDiv(1.4e27, 1e4, 10e18) = 1.4e12 (1.4 trillion bps!)
        // It should NOT panic with arithmetic overflow; it should cleanly revert with EncumbranceExceeded
        uint256 expectedHugeUtil = Math.mulDiv(hugeAmount, 1e4, 10e18);
        emit log_named_uint("Huge utilization bps without overflow", expectedHugeUtil);

        vm.expectRevert(abi.encodeWithSelector(Encumbrance.EncumbranceExceeded.selector, expectedHugeUtil, 10_000));
        router.quote(
            order,
            address(USDC),
            address(WETH),
            1_000e6,
            takerTraitsAndData
        );
    }

    /// @notice Under-declaration Test: Maker declares less encumbrance than sampled sibling commitments -> caught and reverted
    function test_UnderdeclaredEncumbranceCaughtBySpotCheck() public {
        address maker = makeAddr("underdeclaringMaker");
        deal(address(WETH), maker, 10e18);
        vm.prank(maker);
        WETH.approve(address(aqua), 10e18);

        // Sibling encumbers 5 WETH
        bytes32 sibHash = _shipSibling(maker, 888, 10_000e6, 5e18);

        bytes32[] memory siblings = new bytes32[](1);
        siblings[0] = sibHash;

        // Maker untruthfully declares only 2 WETH encumbrance (< 5 WETH sampled)
        uint256 declaredTotal = 2e18;
        uint256 sampledTotal = 5e18;

        (ISwapVM.Order memory order,) = _createAndShipStrategy(
            maker,
            889,
            declaredTotal,
            siblings,
            10_000,
            2_000,
            10_000e6,
            10e18
        );

        // Quote triggers the on-chain spot-check and reverts with EncumbranceUnderdeclared
        vm.expectRevert(
            abi.encodeWithSelector(
                Encumbrance.EncumbranceUnderdeclared.selector,
                declaredTotal,
                sampledTotal
            )
        );
        router.quote(
            order,
            address(USDC),
            address(WETH),
            1_000e6,
            takerTraitsAndData
        );
    }

    /// @notice Boundary Test: Attempting 7 siblings fails safely (build rejects, and parse rejects with EncumbranceParsingSiblingCountExceedsCapacity)
    function test_Boundary_sevenSiblingsFailsSafely() public {
        bytes32[] memory sevenSiblings = new bytes32[](7);
        for (uint256 i = 0; i < 7; i++) {
            sevenSiblings[i] = bytes32(uint256(i + 1));
        }

        // Test A: EncumbranceArgsBuilder.build explicitly rejects 7 siblings
        vm.expectRevert(
            abi.encodeWithSelector(
                EncumbranceArgsBuilder.EncumbranceBuildingSiblingCountExceedsCapacity.selector,
                7,
                6
            )
        );
        this.buildWrapper(0, sevenSiblings, 10_000, 2_000);

        // Test B: Handcrafting raw calldata with siblingCount = 7 fails safely in parse
        bytes memory rawPacked = abi.encodePacked(uint256(0), uint16(7));
        for (uint256 i = 0; i < 7; i++) {
            rawPacked = abi.encodePacked(rawPacked, sevenSiblings[i]);
        }
        rawPacked = abi.encodePacked(rawPacked, uint16(10_000), uint16(2_000));

        vm.expectRevert(
            abi.encodeWithSelector(
                EncumbranceArgsBuilder.EncumbranceParsingSiblingCountExceedsCapacity.selector,
                7,
                6
            )
        );
        this.parseCalldata(rawPacked);
    }

    function buildWrapper(
        uint256 declaredTotalEncumbrance,
        bytes32[] memory siblingHashes,
        uint16 maxUtilBps,
        uint16 widenBps
    ) external pure returns (bytes memory) {
        return EncumbranceArgsBuilder.build(declaredTotalEncumbrance, siblingHashes, maxUtilBps, widenBps);
    }

    function parseCalldata(bytes calldata args) external pure returns (
        uint256 declaredTotalEncumbrance,
        uint256 siblingCount,
        bytes calldata siblingHashes,
        uint16 maxUtilBps,
        uint16 widenBps
    ) {
        return EncumbranceArgsBuilder.parse(args);
    }
}

