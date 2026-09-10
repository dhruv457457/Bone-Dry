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
    function balanceOf(address account) external view returns (uint256);
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
    error AmountOverflowsDelta();
    error NativeCurrencyNotSupported();
    error CouldNotFillEntireSwap(uint256 requested, uint256 filled);
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
        uint256 unplaced;
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
        uint256 requested = uint256(-params.amountSpecified);
        c.remaining = requested;

        (Currency inC, Currency outC) =
            params.zeroForOne ? (key.currency0, key.currency1) : (key.currency1, key.currency0);
        c.tokenIn = Currency.unwrap(inC);
        c.tokenOut = Currency.unwrap(outC);
        // Aqua settles in ERC-20s; a native-currency side has no contract to read a
        // balance or an allowance from. Say so rather than reverting inside a
        // balanceOf on address(0).
        if (c.tokenIn == address(0) || c.tokenOut == address(0)) revert NativeCurrencyNotSupported();

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

        // --- pass 2: place slices, borrowing only what each one uses ---
        //
        // `take` moves real tokens out of the PoolManager, and a zero-liquidity
        // pool has none of its own — it is borrowing against every other pool's
        // balance. Taking the whole `amountSpecified` up front therefore borrows
        // what this hook may have no way to place, and reverts outright when the
        // PoolManager is not holding that much. So each slice is taken
        // immediately before the fill that spends it, and the PoolManager's own
        // balance — not the swapper's ambition — is the ceiling on how much can be
        // placed at all. Beyond it the fill is partial, which v4 expresses
        // natively through the returned delta.
        uint256 available = IERC20Minimal(c.tokenIn).balanceOf(address(poolManager));
        if (c.remaining > available) revert CouldNotFillEntireSwap(requested, available);

        uint256 takeIn = c.remaining;

        // Pro-rata slices are integer division, so they add up to a wei or two
        // less than the input, and a Bone Dry fill has to consume every unit —
        // whatever is left over falls through to the PoolManager and pins the
        // price. That remainder used to be swept afterwards as a fill of its
        // own, which does not work: a lone wei of a 6-decimal token prices to
        // zero out on any curve, `_fill` reads a zero quote as "skip", and the
        // swap reverts on CouldNotFillEntireSwap having placed everything else.
        // Measured on Base mainnet, USDC/WETH: quote(1 wei) == 0 from every
        // maker, and the smallest input whose split leaves no remainder at all
        // is ~1.4e13 wei — 13.7 million USDC. So a two-maker route reverted
        // essentially always, and only single-maker routes (whose one slice is
        // the whole input, remainder-free) ever settled.
        //
        // The remainder is at most n-1 wei, so fold it into the first and
        // deepest slice instead of trying to place it alone. It rides along
        // with an amount large enough to quote, and the input is consumed
        // exactly.
        uint256 dust = takeIn;
        for (uint256 i; i < n; ++i) dust -= (takeIn * depth[i]) / c.totalDepth;

        for (uint256 i; i < n && c.remaining > 0; ++i) {
            uint256 slice = (takeIn * depth[i]) / c.totalDepth;
            if (i == 0) slice += dust;
            if (slice > c.remaining) slice = c.remaining;
            _fill(c, d, orders, depth, i, inC, slice);
        }

        // Still a sweep, but now only for a share a SKIPPED maker left behind —
        // an amount of real size, not integer-division crumbs.
        for (uint256 i; i < n && c.remaining > 0; ++i) {
            _fill(c, d, orders, depth, i, inC, c.remaining);
        }

        uint256 filledIn = takeIn - c.remaining;
        if (c.totalOut == 0) revert NoSolventMaker();

        // Everything the hook does not consume falls through to the PoolManager's
        // own swap — and against a pool with no liquidity that walks the price all
        // the way to the caller's limit and leaves it there. One partial fill
        // therefore pins the pool at MAX_SQRT_RATIO and every later swap in the
        // same direction reverts with PriceLimitAlreadyExceeded: the pool is
        // bricked by a swap that merely came up short.
        //
        // So a Bone Dry fill is all or nothing. Asking for more than the makers
        // can deliver is a revert, the same as any AMM refusing a swap that would
        // breach a limit, rather than a partial fill that quietly ruins the pool.
        if (filledIn != requested) revert CouldNotFillEntireSwap(requested, filledIn);

        // Do not leave a standing allowance behind; the next swap sets its own.
        IERC20Minimal(c.tokenIn).approve(address(router), 0);

        // Only slices that were taken and then not spent need returning. Input no
        // maker could absorb was never borrowed, so it is not here to give back —
        // the delta below charges the swapper for `filledIn` and nothing more.
        poolManager.sync(inC);
        if (c.unplaced > 0) IERC20Minimal(c.tokenIn).transfer(address(poolManager), c.unplaced);
        poolManager.settle();

        poolManager.sync(outC);
        IERC20Minimal(c.tokenOut).transfer(address(poolManager), c.totalOut);
        poolManager.settle();

        // v4 deltas are int128. Silently wrapping a large fill would hand the
        // PoolManager a delta of the wrong sign, so refuse instead.
        if (filledIn > uint256(int256(type(int128).max)) || c.totalOut > uint256(int256(type(int128).max))) {
            revert AmountOverflowsDelta();
        }

        return (
            IHooks.beforeSwap.selector,
            toBeforeSwapDelta(int128(int256(filledIn)), -int128(int256(c.totalOut))),
            0
        );
    }

    /**
     * @dev One maker, one slice. Quote before borrowing: depth caps the payout,
     *      not the slice, so an XYC curve bounded by the maker's VIRTUAL balance
     *      will happily quote more than the wallet backs and revert inside
     *      `pull()`. Asking first costs a staticcall and avoids both the borrow
     *      and the revert. The swap stays guarded anyway, because a quote is a
     *      promise about state a reentrant fill could still change.
     */
    function _fill(
        Ctx memory c,
        TapData memory d,
        ISwapVM.Order[] memory orders,
        uint256[] memory depth,
        uint256 i,
        Currency inC,
        uint256 slice
    ) private {
        if (depth[i] == 0 || slice == 0) return;

        uint256 expected;
        try router.quote(orders[i], c.tokenIn, c.tokenOut, slice, d.takerTraits) returns (
            uint256, uint256 out, bytes32
        ) {
            expected = out;
        } catch {
            emit MakerSkipped(orders[i].maker, slice);
            return;
        }
        if (expected == 0 || expected > depth[i]) {
            emit MakerSkipped(orders[i].maker, slice);
            return;
        }

        poolManager.take(inC, address(this), slice);
        // A failed fill leaves its approval behind, and tokens in the USDT mould
        // revert on a non-zero to non-zero approve. Clear it first so a maker who
        // reverted cannot block every maker after them.
        IERC20Minimal(c.tokenIn).approve(address(router), 0);
        IERC20Minimal(c.tokenIn).approve(address(router), slice);

        try router.swap(orders[i], c.tokenIn, c.tokenOut, slice, d.takerTraits) returns (
            uint256 usedIn, uint256 out, bytes32
        ) {
            // Spend what the router says it took, not what we offered. They are
            // equal for an exact-in fill, but assuming it strands any shortfall in
            // the hook AND charges the swapper for it.
            if (usedIn > slice) usedIn = slice;
            c.remaining -= usedIn;
            c.unplaced += slice - usedIn;
            c.totalOut += out;
            emit Filled(orders[i].maker, usedIn, out);
        } catch {
            c.unplaced += slice; // taken but not spent; handed back below
            emit MakerSkipped(orders[i].maker, slice);
        }
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
