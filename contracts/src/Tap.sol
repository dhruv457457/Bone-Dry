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

interface IERC20Minimal {
    function transfer(address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/**
 * @title Tap — the wellhead where dispersed liquidity surfaces.
 * @notice A Uniswap v4 hook for a pool that holds nothing.
 *
 * The pool's own reserves are never touched, because there aren't any. Every
 * swap is intercepted in `beforeSwap` and filled out of a 1inch Aqua maker's
 * own wallet, in the same transaction, then settled back through v4's flash
 * accounting.
 *
 * Ledger of one swap (exact-in), from the hook's point of view:
 *   take(tokenIn)   -> hook owes the PoolManager `amountIn`
 *   Aqua fill       -> hook receives `amountOut` from the maker's wallet
 *   settle(tokenOut)-> hook is owed `amountOut` by the PoolManager
 *   BeforeSwapDelta -> those two are handed to the swapper, netting to zero
 */
contract Tap is IHooks {
    IPoolManager public immutable poolManager;
    ISwapVM public immutable router;

    error NotPoolManager();
    error ExactOutputNotSupported();
    error NothingFilled();
    error HookNotImplemented();

    /// @param strategy   abi.encode(ISwapVM.Order) — the maker's shipped Aqua strategy
    /// @param takerTraits packed TakerTraits blob for the fill
    struct TapData {
        bytes strategy;
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
        // v1 handles exact-in only. Exact-out needs the curve solved in reverse,
        // which SwapVM supports but the accounting below does not yet.
        if (params.amountSpecified >= 0) revert ExactOutputNotSupported();

        uint256 amountIn = uint256(-params.amountSpecified);

        (Currency inC, Currency outC) =
            params.zeroForOne ? (key.currency0, key.currency1) : (key.currency1, key.currency0);
        address tokenIn = Currency.unwrap(inC);
        address tokenOut = Currency.unwrap(outC);

        TapData memory d = abi.decode(hookData, (TapData));
        ISwapVM.Order memory order = abi.decode(d.strategy, (ISwapVM.Order));

        // Pull the swapper's input out of the PoolManager. This opens a debt.
        poolManager.take(inC, address(this), amountIn);

        // Fill it against the maker's wallet. Tokens move maker -> hook here;
        // nothing was ever deposited into a pool.
        IERC20Minimal(tokenIn).approve(address(router), amountIn);
        (, uint256 amountOut,) = router.swap(order, tokenIn, tokenOut, amountIn, d.takerTraits);
        if (amountOut == 0) revert NothingFilled();

        // Hand the proceeds to the PoolManager, closing the loop.
        poolManager.sync(outC);
        IERC20Minimal(tokenOut).transfer(address(poolManager), amountOut);
        poolManager.settle();

        return (
            IHooks.beforeSwap.selector,
            toBeforeSwapDelta(int128(int256(amountIn)), -int128(int256(amountOut))),
            0
        );
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
