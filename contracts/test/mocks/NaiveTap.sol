// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {BalanceDelta} from "v4-core/types/BalanceDelta.sol";
import {SwapParams, ModifyLiquidityParams} from "v4-core/types/PoolOperation.sol";
import {BeforeSwapDelta, toBeforeSwapDelta} from "v4-core/types/BeforeSwapDelta.sol";
import {ISwapVM} from "../../src/interfaces/ISwapVM.sol";

interface IERC20Minimal {
    function transfer(address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/**
 * @title NaiveTap — Control Group implementation of an Aqua Hook.
 * @notice Demonstrates what happens when a Uniswap v4 hook routes to 1inch Aqua
 *         WITHOUT Bone Dry's atomic solvency lens, try/catch skipping, and
 *         residual rebalancing.
 *
 * In NaiveTap:
 * 1. Slices are determined naively from off-chain quotes without dynamic balance protection.
 * 2. router.swap() is called directly without try/catch error handling.
 * 3. If any maker flakes (moves funds out of wallet, revokes allowance, or is insolvent),
 *    the entire transaction reverts, wasting 100% of the user's gas and yielding 0 tokens.
 */
contract NaiveTap is IHooks {
    IPoolManager public immutable poolManager;
    ISwapVM public immutable router;

    error NotPoolManager();
    error ExactOutputNotSupported();
    error HookNotImplemented();

    struct TapData {
        bytes[] strategies;
        bytes takerTraits;
    }

    constructor(IPoolManager _poolManager, ISwapVM _router) {
        poolManager = _poolManager;
        router = _router;
    }

    modifier onlyPoolManager() {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        _;
    }

    function beforeSwap(address, PoolKey calldata key, SwapParams calldata params, bytes calldata hookData)
        external
        onlyPoolManager
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        if (params.amountSpecified >= 0) revert ExactOutputNotSupported();

        uint256 requested = uint256(-params.amountSpecified);
        (Currency inC, Currency outC) =
            params.zeroForOne ? (key.currency0, key.currency1) : (key.currency1, key.currency0);
        address tokenIn = Currency.unwrap(inC);
        address tokenOut = Currency.unwrap(outC);

        TapData memory d = abi.decode(hookData, (TapData));
        uint256 n = d.strategies.length;

        ISwapVM.Order[] memory orders = new ISwapVM.Order[](n);
        for (uint256 i; i < n; ++i) {
            orders[i] = abi.decode(d.strategies[i], (ISwapVM.Order));
        }

        uint256 totalOut;
        uint256 remaining = requested;
        uint256 slice = requested / n;

        // Naively execute each slice directly against the router without try/catch:
        for (uint256 i; i < n && remaining > 0; ++i) {
            uint256 currentSlice = (i == n - 1) ? remaining : slice;
            if (currentSlice == 0) continue;

            poolManager.take(inC, address(this), currentSlice);
            IERC20Minimal(tokenIn).approve(address(router), currentSlice);

            // UNGUARDED CALL: If maker cannot deliver, this reverts the whole tx!
            (, uint256 out,) = router.swap(orders[i], tokenIn, tokenOut, currentSlice, d.takerTraits);

            remaining -= currentSlice;
            totalOut += out;
        }

        poolManager.sync(inC);
        poolManager.settle();

        poolManager.sync(outC);
        IERC20Minimal(tokenOut).transfer(address(poolManager), totalOut);
        poolManager.settle();

        return (
            IHooks.beforeSwap.selector,
            toBeforeSwapDelta(int128(int256(requested)), -int128(int256(totalOut))),
            0
        );
    }

    function beforeInitialize(address, PoolKey calldata, uint160) external pure returns (bytes4) {
        return IHooks.beforeInitialize.selector;
    }
    function afterInitialize(address, PoolKey calldata, uint160, int24) external pure returns (bytes4) { revert HookNotImplemented(); }
    function beforeAddLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata) external pure returns (bytes4) { revert HookNotImplemented(); }
    function afterAddLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, BalanceDelta, BalanceDelta, bytes calldata) external pure returns (bytes4, BalanceDelta) { revert HookNotImplemented(); }
    function beforeRemoveLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata) external pure returns (bytes4) { revert HookNotImplemented(); }
    function afterRemoveLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, BalanceDelta, BalanceDelta, bytes calldata) external pure returns (bytes4, BalanceDelta) { revert HookNotImplemented(); }
    function beforeDonate(address, PoolKey calldata, uint256, uint256, bytes calldata) external pure returns (bytes4) { revert HookNotImplemented(); }
    function afterDonate(address, PoolKey calldata, uint256, uint256, bytes calldata) external pure returns (bytes4) { revert HookNotImplemented(); }
    function afterSwap(address, PoolKey calldata, SwapParams calldata, BalanceDelta, bytes calldata) external pure returns (bytes4, int128) { revert HookNotImplemented(); }
}
