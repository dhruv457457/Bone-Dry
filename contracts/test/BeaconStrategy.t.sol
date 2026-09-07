// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Test } from "forge-std/Test.sol";
import { BeaconStrategy } from "../src/BeaconStrategy.sol";
import { SwapQuery, SwapRegisters } from "../src/interfaces/IExtruction.sol";

/// @dev A Chainlink aggregator whose answer/updatedAt can be moved by the
/// test, nothing else -- this is the only mock in this file.
contract MockAggregator {
    uint8 public immutable decimals;
    int256 public answer;
    uint256 public updatedAt;

    constructor(uint8 _decimals, int256 _answer) {
        decimals = _decimals;
        answer = _answer;
        updatedAt = block.timestamp;
    }

    function set(int256 _answer, uint256 _updatedAt) external {
        answer = _answer;
        updatedAt = _updatedAt;
    }

    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 ans, uint256 startedAt, uint256 updated, uint80 answeredInRound)
    {
        return (1, answer, updatedAt, updatedAt, 1);
    }
}

/**
 * @dev Task 4: the Extruction validator this project's own plan reserved.
 * Two properties matter for an Extruction target, per 1inch's own docs:
 * (1) quote and swap paths must be consistent, and (2) the target should be
 * immutable. Both are checked here as real, executed assertions against the
 * actual deployed bytecode -- not read off the source and taken on faith.
 */
contract BeaconStrategyTest is Test {
    MockAggregator wethFeed; // 8 decimals, like real Chainlink USD feeds
    MockAggregator usdcFeed;
    BeaconStrategy strategy;

    address constant WETH = address(0x4200000000000000000000000000000000000006);
    address constant USDC = address(0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913);
    uint256 constant SPREAD_BPS = 20; // 0.20%

    function setUp() public {
        wethFeed = new MockAggregator(8, 2_500_00000000); // $2,500.00000000
        usdcFeed = new MockAggregator(8, 1_00000000); // $1.00000000
        strategy = new BeaconStrategy(WETH, address(wethFeed), 18, USDC, address(usdcFeed), 6, SPREAD_BPS);
    }

    function _query(bool isExactIn) internal pure returns (SwapQuery memory) {
        return SwapQuery({
            orderHash: bytes32(0),
            maker: address(0xAAAA),
            taker: address(0xBBBB),
            tokenIn: WETH,
            tokenOut: USDC,
            isExactIn: isExactIn
        });
    }

    /// @notice 1 WETH in at $2,500 mid, 0.20% spread -> ~2,495 USDC out.
    function test_ExactIn_PricesAtOracleMidMinusSpread() public {
        SwapRegisters memory swap = SwapRegisters({ balanceIn: 0, balanceOut: 0, amountIn: 1 ether, amountOut: 0 });
        (, , SwapRegisters memory out) = strategy.extruction(true, 0, _query(true), swap, "", "");

        // 1e18 * 2500e18 / 1e18 = 2500e18 USD; * 9980/10000 = 2495e18 USD;
        // / 1e18 (price) * 1e6 (USDC decimals) = 2,495,000,000 (2495.00 USDC).
        assertEq(out.amountOut, 2_495_000_000);
        assertEq(out.balanceIn, 0); // untouched -- Extruction prices, does not gate depth
        assertEq(out.balanceOut, 0);
    }

    /// @notice Asking for exactly the exact-in case's own output back should
    /// round-trip to (about) the original input -- proves the two directions
    /// use the same underlying price, not two independently-tuned formulas.
    function test_ExactOut_RoundTripsWithExactIn() public {
        SwapRegisters memory swap = SwapRegisters({ balanceIn: 0, balanceOut: 0, amountIn: 0, amountOut: 2_495_000_000 });
        (, , SwapRegisters memory out) = strategy.extruction(true, 0, _query(false), swap, "", "");

        // Integer division on the way in and back out can round by a few
        // hundred wei on an 18-decimal token; anchor to a tight tolerance,
        // not exact equality.
        assertApproxEqAbs(out.amountIn, 1 ether, 1e12);
    }

    /// @notice The property the whole opcode exists to guarantee: calling
    /// through IStaticExtruction's STATICCALL path (the router's quote mode)
    /// and through a plain CALL (the router's swap mode) must return
    /// byte-identical results. Proven here by making both kinds of call for
    /// real against the deployed contract and diffing the returned bytes --
    /// not inferred from the source being `view`.
    function test_StaticCallAndCallReturnIdenticalBytes() public {
        SwapRegisters memory swap = SwapRegisters({ balanceIn: 0, balanceOut: 0, amountIn: 1 ether, amountOut: 0 });
        bytes memory calldata_ = abi.encodeCall(strategy.extruction, (true, 7, _query(true), swap, "", ""));

        (bool okStatic, bytes memory retStatic) = address(strategy).staticcall(calldata_);
        (bool okCall, bytes memory retCall) = address(strategy).call(calldata_);

        assertTrue(okStatic, "staticcall reverted");
        assertTrue(okCall, "call reverted");
        assertEq(retStatic, retCall, "quote path and swap path disagree");
    }

    /// @notice Immutability, checked structurally: a real call through this
    /// contract must not write to a single storage slot. Reads every slot
    /// Foundry recorded as touched during the call and requires each one's
    /// value afterward equals what forge-std's own storage-write tracer saw
    /// before -- i.e. no SSTORE happened at all, not just that known slots
    /// didn't change.
    function test_NoStorageWritesDuringExecution() public {
        SwapRegisters memory swap = SwapRegisters({ balanceIn: 0, balanceOut: 0, amountIn: 1 ether, amountOut: 0 });

        vm.record();
        strategy.extruction(true, 0, _query(true), swap, "", "");
        (, bytes32[] memory writes) = vm.accesses(address(strategy));

        assertEq(writes.length, 0, "extruction() wrote to storage");
    }

    function test_RevertsOnStalePrice() public {
        wethFeed.set(2_500_00000000, block.timestamp);
        vm.warp(block.timestamp + 90_001);

        SwapRegisters memory swap = SwapRegisters({ balanceIn: 0, balanceOut: 0, amountIn: 1 ether, amountOut: 0 });
        vm.expectRevert(abi.encodeWithSelector(BeaconStrategy.StalePrice.selector, address(wethFeed), block.timestamp - 90_001));
        strategy.extruction(true, 0, _query(true), swap, "", "");
    }

    function test_RevertsOnUnsupportedToken() public {
        SwapQuery memory q = _query(true);
        q.tokenOut = address(0xDEAD);
        SwapRegisters memory swap = SwapRegisters({ balanceIn: 0, balanceOut: 0, amountIn: 1 ether, amountOut: 0 });

        vm.expectRevert(abi.encodeWithSelector(BeaconStrategy.UnsupportedToken.selector, address(0xDEAD)));
        strategy.extruction(true, 0, q, swap, "", "");
    }

    function test_ConstructorRejectsIdenticalTokens() public {
        vm.expectRevert(abi.encodeWithSelector(BeaconStrategy.IdenticalTokens.selector, WETH));
        new BeaconStrategy(WETH, address(wethFeed), 18, WETH, address(usdcFeed), 6, SPREAD_BPS);
    }

    function test_ConstructorRejectsExcessiveSpread() public {
        vm.expectRevert(abi.encodeWithSelector(BeaconStrategy.SpreadTooHigh.selector, uint256(1_000)));
        new BeaconStrategy(WETH, address(wethFeed), 18, USDC, address(usdcFeed), 6, 1_000);
    }
}
