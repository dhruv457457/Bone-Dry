// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {BalanceDelta} from "v4-core/types/BalanceDelta.sol";
import {SwapParams} from "v4-core/types/PoolOperation.sol";

interface IERC20Minimal {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/**
 * @title Wellhead — the tap you can actually turn.
 * @notice The user-facing entry point for a Bone Dry pool.
 *
 * A Uniswap v4 swap has to happen inside `unlock`, so something has to hold the
 * lock and settle the deltas. `PoolSwapTest` does this in the test suite, but a
 * thing called Test has no business being the contract a wallet talks to.
 *
 * Deliberately minimal: one entry point, exact-input only, a slippage floor, and
 * no custody. Tokens move from the swapper to the PoolManager and back out to the
 * swapper inside a single call — this contract never holds a balance between
 * transactions, so there is nothing here to rescue, sweep or steal.
 */
contract Wellhead is IUnlockCallback {
    IPoolManager public immutable poolManager;

    error NotPoolManager();
    error ExactInputOnly();
    error TooLittleReceived(uint256 got, uint256 minimum);

    event Swapped(
        address indexed swapper, address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 amountOut
    );

    struct Callback {
        PoolKey key;
        SwapParams params;
        bytes hookData;
        address swapper;
    }

    constructor(IPoolManager _poolManager) {
        poolManager = _poolManager;
    }

    /**
     * @param key        the Bone Dry pool
     * @param zeroForOne true to sell currency0
     * @param amountIn   exact input, in the token being sold
     * @param minOut     revert below this, so a maker who vanished mid-block cannot
     *                   turn a quote into a bad fill
     * @param hookData   the candidate set from the router API — Aqua's balances are
     *                   not enumerable, so the hook cannot discover makers itself
     */
    function swap(PoolKey calldata key, bool zeroForOne, uint256 amountIn, uint256 minOut, bytes calldata hookData)
        external
        returns (uint256 amountOut)
    {
        if (amountIn == 0) revert ExactInputOnly();

        Currency outC = zeroForOne ? key.currency1 : key.currency0;
        uint256 before = IERC20Minimal(Currency.unwrap(outC)).balanceOf(msg.sender);

        poolManager.unlock(
            abi.encode(
                Callback({
                    key: key,
                    params: SwapParams({
                        zeroForOne: zeroForOne,
                        amountSpecified: -int256(amountIn),
                        sqrtPriceLimitX96: zeroForOne ? MIN_SQRT + 1 : MAX_SQRT - 1
                    }),
                    hookData: hookData,
                    swapper: msg.sender
                })
            )
        );

        amountOut = IERC20Minimal(Currency.unwrap(outC)).balanceOf(msg.sender) - before;
        if (amountOut < minOut) revert TooLittleReceived(amountOut, minOut);
    }

    uint160 constant MIN_SQRT = 4295128739;
    uint160 constant MAX_SQRT = 1461446703485210103287273052203988822378723970342;

    function unlockCallback(bytes calldata raw) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        Callback memory c = abi.decode(raw, (Callback));

        BalanceDelta delta = poolManager.swap(c.key, c.params, c.hookData);

        // A negative delta is what we owe the PoolManager; a positive one is what
        // it owes us. The hook may have filled only part of the input, so settle
        // whatever the delta actually says rather than what was asked for.
        _settle(c.key.currency0, delta.amount0(), c.swapper);
        _settle(c.key.currency1, delta.amount1(), c.swapper);

        emit Swapped(
            c.swapper,
            Currency.unwrap(c.params.zeroForOne ? c.key.currency0 : c.key.currency1),
            Currency.unwrap(c.params.zeroForOne ? c.key.currency1 : c.key.currency0),
            c.params.zeroForOne ? uint256(uint128(-delta.amount0())) : uint256(uint128(-delta.amount1())),
            c.params.zeroForOne ? uint256(uint128(delta.amount1())) : uint256(uint128(delta.amount0()))
        );

        return "";
    }

    /// @dev Pays a debt straight from the swapper, or forwards a credit straight
    ///      to them. Nothing rests here in between.
    function _settle(Currency currency, int128 amount, address swapper) private {
        if (amount == 0) return;
        if (amount < 0) {
            uint256 owed = uint256(uint128(-amount));
            poolManager.sync(currency);
            IERC20Minimal(Currency.unwrap(currency)).transferFrom(swapper, address(poolManager), owed);
            poolManager.settle();
        } else {
            poolManager.take(currency, swapper, uint256(uint128(amount)));
        }
    }
}
