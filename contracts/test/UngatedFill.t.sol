// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test, console} from "forge-std/Test.sol";
import {IAqua} from "../src/interfaces/IAqua.sol";
import {ISwapVM} from "../src/interfaces/ISwapVM.sol";

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
    function decimals() external view returns (uint8);
}

/**
 * THE LOAD-BEARING TEST.
 *
 * 1inch gate Aqua takers behind a soulbound `KycNFT`, minted only to KYB-verified
 * resolver firms. If that gate were enforced by the router, Bone Dry could never
 * run on mainnet and every demo would be a self-deployed testnet toy.
 *
 * It isn't. The gate is the Controls opcode `onlyTxOriginTokenBalanceNonZero`,
 * which the 1inch dApp's assembler *embeds into the strategy program it ships*.
 * Makers are permissionless. A maker who builds their own program simply leaves
 * that opcode out — and then any EOA on earth can fill it.
 *
 * This test proves that against the REAL canonical contracts on a Base mainnet
 * fork. Nothing here is deployed by us except the tokens we deal ourselves.
 */
contract UngatedFillTest is Test {
    IERC20 constant USDC = IERC20(0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913);
    IERC20 constant WETH = IERC20(0x4200000000000000000000000000000000000006);

    IAqua aqua;
    ISwapVM router;

    address maker;
    address taker = address(0xBEEF);

    bytes strategy;
    bytes32 strategyHash;
    bytes takerTraits;

    function setUp() public {
        vm.createSelectFork(vm.envOr("BASE_RPC_URL", string("https://mainnet.base.org")));

        string memory j = vm.readFile("fixtures/strategy.json");
        aqua         = IAqua(vm.parseJsonAddress(j, ".aqua"));
        router       = ISwapVM(vm.parseJsonAddress(j, ".router"));
        maker        = vm.parseJsonAddress(j, ".maker");
        strategy     = vm.parseJsonBytes(j, ".strategy");
        strategyHash = vm.parseJsonBytes32(j, ".strategyHash");
        takerTraits  = vm.parseJsonBytes(j, ".takerTraitsAndData");

        vm.label(address(aqua), "Aqua");
        vm.label(address(router), "AquaSwapVMRouter");
        vm.label(maker, "maker");
        vm.label(taker, "taker");
    }

    function test_canonicalContractsAreLive() public view {
        assertGt(address(aqua).code.length, 0, "Aqua has no code on Base");
        assertGt(address(router).code.length, 0, "router has no code on Base");
        console.log("Aqua   code size:", address(aqua).code.length);
        console.log("router code size:", address(router).code.length);
    }

    function test_strategyHashMatchesKeccakOfStrategy() public view {
        assertEq(keccak256(strategy), strategyHash, "strategyHash != keccak256(strategy)");
    }

    /// @dev The whole thesis in one test.
    function test_ungatedStrategy_isFillableByAnyEOA() public {
        uint256 usdcIn = 10_000e6;   // maker inventory
        uint256 wethIn = 3e18;
        uint256 sell   = 100e6;      // taker sells 100 USDC

        // ---- maker ships, entirely permissionlessly ----
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
        bytes32 got = aqua.ship(address(router), strategy, tokens, amounts);
        vm.stopPrank();

        assertEq(got, strategyHash, "ship returned a different strategyHash");

        (uint256 vUsdc, uint256 vWeth) =
            aqua.safeBalances(maker, address(router), strategyHash, address(USDC), address(WETH));
        assertEq(vUsdc, usdcIn, "virtual USDC wrong");
        assertEq(vWeth, wethIn, "virtual WETH wrong");
        console.log("shipped. virtual USDC:", vUsdc, " virtual WETH:", vWeth);

        // ---- an anonymous EOA fills it. No KycNFT anywhere. ----
        ISwapVM.Order memory order = abi.decode(strategy, (ISwapVM.Order));
        assertEq(order.maker, maker, "decoded order.maker mismatch");

        deal(address(USDC), taker, sell);

        uint256 takerWethBefore = WETH.balanceOf(taker);
        uint256 makerUsdcBefore = USDC.balanceOf(maker);

        vm.startPrank(taker, taker); // tx.origin == taker, and taker holds NO KycNFT
        USDC.approve(address(router), type(uint256).max);
        (uint256 amountIn, uint256 amountOut,) =
            router.swap(order, address(USDC), address(WETH), sell, takerTraits);
        vm.stopPrank();

        console.log("amountIn (USDC) :", amountIn);
        console.log("amountOut (WETH):", amountOut);

        assertEq(amountIn, sell, "exact-in amount mismatch");
        assertGt(amountOut, 0, "no WETH out");
        assertEq(WETH.balanceOf(taker) - takerWethBefore, amountOut, "taker did not receive WETH");
        assertEq(USDC.balanceOf(maker) - makerUsdcBefore, amountIn, "maker did not receive USDC");
    }
}
