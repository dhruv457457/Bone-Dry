// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {console} from "forge-std/Test.sol";
import {BoneDryFork, IERC20} from "./Base.t.sol";
import {ISwapVM} from "../src/interfaces/ISwapVM.sol";

/**
 * THE LOAD-BEARING TEST.
 *
 * 1inch gate Aqua takers behind a soulbound `KycNFT`, minted only to KYB-verified
 * resolver firms. If that gate were enforced by the router, Bone Dry could never
 * run on mainnet.
 *
 * It isn't. The gate is the Controls opcode `onlyTxOriginTokenBalanceNonZero`,
 * which the 1inch dApp's assembler embeds into the strategies *it* ships. Makers
 * are permissionless; one who builds their own program leaves it out, and any EOA
 * can fill it. Proven here against the canonical contracts on a Base mainnet fork.
 */
contract UngatedFillTest is BoneDryFork {
    address taker = address(0xBEEF);

    function setUp() public {
        _forkAndLoadFixture();
        vm.label(taker, "taker");
    }

    function test_canonicalContractsAreLive() public view {
        assertGt(address(aqua).code.length, 0, "Aqua has no code on Base");
        assertGt(address(router).code.length, 0, "router has no code on Base");
        console.log("Aqua   code size:", address(aqua).code.length);
        console.log("router code size:", address(router).code.length);
    }

    function test_strategyHashMatchesKeccakOfStrategy() public view {
        for (uint256 i; i < 3; ++i) {
            assertEq(keccak256(strategies[i]), strategyHashes[i], "hash mismatch");
        }
    }

    function test_ungatedStrategy_isFillableByAnyEOA() public {
        _ship(0, 10_000e6, 3e18);

        (uint256 vUsdc, uint256 vWeth) =
            aqua.safeBalances(makers[0], address(router), strategyHashes[0], address(USDC), address(WETH));
        assertEq(vUsdc, 10_000e6);
        assertEq(vWeth, 3e18);

        ISwapVM.Order memory order = abi.decode(strategies[0], (ISwapVM.Order));
        assertEq(order.maker, makers[0], "decoded maker mismatch");

        uint256 sell = 100e6;
        deal(address(USDC), taker, sell);
        uint256 wethBefore = WETH.balanceOf(taker);
        uint256 makerUsdcBefore = USDC.balanceOf(makers[0]);

        vm.startPrank(taker, taker); // tx.origin == taker, holds NO KycNFT
        USDC.approve(address(router), type(uint256).max);
        (uint256 amountIn, uint256 amountOut,) =
            router.swap(order, address(USDC), address(WETH), sell, takerTraits);
        vm.stopPrank();

        console.log("amountIn (USDC) :", amountIn);
        console.log("amountOut (WETH):", amountOut);

        assertEq(amountIn, sell);
        assertGt(amountOut, 0);
        assertEq(WETH.balanceOf(taker) - wethBefore, amountOut, "taker did not receive WETH");
        assertEq(USDC.balanceOf(makers[0]) - makerUsdcBefore, amountIn, "maker did not receive USDC");
    }
}
