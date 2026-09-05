// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {BalanceDelta} from "v4-core/types/BalanceDelta.sol";
import {SwapParams, ModifyLiquidityParams} from "v4-core/types/PoolOperation.sol";
import {BeforeSwapDelta, toBeforeSwapDelta} from "v4-core/types/BeforeSwapDelta.sol";
import {ISwapVM} from "./interfaces/ISwapVM.sol";
import {Lens} from "./Lens.sol";

interface IERC20Minimal {
    function transfer(address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
}

/**
 * @title Tap — the wellhead where dispersed liquidity surfaces.
 * @notice A Uniswap v4 hook for a pool that holds nothing.
 *
 * Every swap is intercepted in `beforeSwap` and filled out of 1inch Aqua makers'
 * own wallets, in the same transaction, then settled back through v4's flash
 * accounting. The pool's reserves are never touched, because there aren't any.
 *
 * Two things make this more than a demo:
 *
 *  1. SOLVENCY. A virtual balance is a promise. Makers share one wallet across
 *     many strategies, so a strategy can quote depth its wallet no longer backs.
 *     Every candidate is checked against real balance and allowance first, and
 *     anyone who cannot deliver is skipped rather than reverting the swap.
 *
 *  2. ROUTING. Aqua stores no list of its makers — the mapping is not
 *     enumerable — so the candidate set arrives as calldata from an off-chain
 *     index. Input is split across them pro-rata to real depth, which on a
 *     constant-product curve beats routing it all to one.
 */
contract Tap is IHooks {
    IPoolManager public immutable poolManager;
    ISwapVM public immutable router;
    Lens public immutable lens;

    error NotPoolManager();
    error ExactOutputNotSupported();
    error NoSolventMaker();
    error HookNotImplemented();

    event Filled(address indexed maker, uint256 amountIn, uint256 amountOut);
    event MakerSkipped(address indexed maker, uint256 wanted);

    /// @param strategies  each is abi.encode(ISwapVM.Order) as shipped to Aqua
    /// @param takerTraits packed TakerTraits blob, shared across the fills
    struct TapData {
        bytes[] strategies;
        bytes takerTraits;
    }

    struct Ctx {
        address tokenIn;
        address tokenOut;
        uint256 remaining;
        uint256 totalOut;
        uint256 totalDepth;
    }

    constructor(IPoolManager _poolManager, ISwapVM _router, Lens _lens) {
        poolManager = _poolManager;
        router = _router;
        lens = _lens;
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

        Ctx memory c;
        c.remaining = uint256(-params.amountSpecified);

        (Currency inC, Currency outC) =
            params.zeroForOne ? (key.currency0, key.currency1) : (key.currency1, key.currency0);
        c.tokenIn = Currency.unwrap(inC);
        c.tokenOut = Currency.unwrap(outC);

        TapData memory d = abi.decode(hookData, (TapData));
        uint256 n = d.strategies.length;

        // --- pass 1: who can actually deliver? ---
        ISwapVM.Order[] memory orders = new ISwapVM.Order[](n);
        uint256[] memory depth = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            orders[i] = abi.decode(d.strategies[i], (ISwapVM.Order));
            depth[i] = lens.quotableDepth(
                orders[i].maker, address(router), keccak256(d.strategies[i]), c.tokenOut
            );
            c.totalDepth += depth[i];
        }
        if (c.totalDepth == 0) revert NoSolventMaker();

        // --- pass 2: split the input pro-rata to real depth ---
        uint256 takeIn = c.remaining;
        IERC20Minimal(c.tokenIn).approve(address(router), takeIn);
        poolManager.take(inC, address(this), takeIn);

        for (uint256 i; i < n && c.remaining > 0; ++i) {
            if (depth[i] == 0) {
                emit MakerSkipped(orders[i].maker, 0);
                continue;
            }
            uint256 slice = _lastSolvent(depth, i) ? c.remaining : (takeIn * depth[i]) / c.totalDepth;
            if (slice == 0) continue;
            if (slice > c.remaining) slice = c.remaining;

            (, uint256 out,) =
                router.swap(orders[i], c.tokenIn, c.tokenOut, slice, d.takerTraits);

            c.remaining -= slice;
            c.totalOut += out;
            emit Filled(orders[i].maker, slice, out);
        }

        uint256 filledIn = takeIn - c.remaining;
        if (c.totalOut == 0) revert NoSolventMaker();

        // Anything we could not place goes straight back to the PoolManager.
        poolManager.sync(inC);
        if (c.remaining > 0) IERC20Minimal(c.tokenIn).transfer(address(poolManager), c.remaining);
        poolManager.settle();

        poolManager.sync(outC);
        IERC20Minimal(c.tokenOut).transfer(address(poolManager), c.totalOut);
        poolManager.settle();

        return (
            IHooks.beforeSwap.selector,
            toBeforeSwapDelta(int128(int256(filledIn)), -int128(int256(c.totalOut))),
            0
        );
    }

    /// @dev true when no later entry has depth, so this one sweeps the remainder
    function _lastSolvent(uint256[] memory depth, uint256 i) private pure returns (bool) {
        for (uint256 j = i + 1; j < depth.length; ++j) {
            if (depth[j] > 0) return false;
        }
        return true;
    }

    // --- everything else is deliberately unimplemented -----------------------

    function beforeInitialize(address, PoolKey calldata, uint160) external pure returns (bytes4) {
        return IHooks.beforeInitialize.selector;
    }
    function afterInitialize(address, PoolKey calldata, uint160, int24) external pure returns (bytes4) {
        revert HookNotImplemented();
    }
    function beforeAddLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata)
        external pure returns (bytes4) { revert HookNotImplemented(); }
    function afterAddLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, BalanceDelta, BalanceDelta, bytes calldata)
        external pure returns (bytes4, BalanceDelta) { revert HookNotImplemented(); }
    function beforeRemoveLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata)
        external pure returns (bytes4) { revert HookNotImplemented(); }
    function afterRemoveLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, BalanceDelta, BalanceDelta, bytes calldata)
        external pure returns (bytes4, BalanceDelta) { revert HookNotImplemented(); }
    function afterSwap(address, PoolKey calldata, SwapParams calldata, BalanceDelta, bytes calldata)
        external pure returns (bytes4, int128) { revert HookNotImplemented(); }
    function beforeDonate(address, PoolKey calldata, uint256, uint256, bytes calldata)
        external pure returns (bytes4) { revert HookNotImplemented(); }
    function afterDonate(address, PoolKey calldata, uint256, uint256, bytes calldata)
        external pure returns (bytes4) { revert HookNotImplemented(); }
}
