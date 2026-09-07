// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice Minimal interfaces for the SwapVM Extruction opcode (index 0x20 in
/// the deployed router's Aqua instruction set) -- lets a maker delegate a
/// swap's pricing to an external contract instead of a built-in curve.
/// @dev These are structural copies of the real types, not an import of
/// 1inch/swap-vm's own source -- that repo ships under a different,
/// restrictive license (LicenseRef-Degensoft-SwapVM-1.1). ABI encoding only
/// depends on field order and type, not on which file declares the name, so
/// this is exactly the same pattern IAqua.sol and ISwapVM.sol already use to
/// avoid importing Aqua's own source under MIT here.
/// Full source: https://github.com/1inch/swap-vm/blob/main/src/instructions/Extruction.sol
/// Struct source: https://github.com/1inch/swap-vm/blob/main/src/libs/VM.sol

/// @dev Read-only swap information. Field order must match VM.sol exactly.
struct SwapQuery {
    bytes32 orderHash;
    address maker;
    address taker;
    address tokenIn;
    address tokenOut;
    bool isExactIn;
}

/// @dev Mutable registers used to compute the missing amount:
/// `isExactIn ? amountOut : amountIn`. Field order must match VM.sol exactly.
struct SwapRegisters {
    uint256 balanceIn;
    uint256 balanceOut;
    uint256 amountIn;
    uint256 amountOut;
}

/// @notice Invoked via a regular (non-static) CALL during an actual swap --
/// this is settlement, real value moving.
interface IExtruction {
    function extruction(
        bool isStaticContext,
        uint256 nextPC,
        SwapQuery calldata query,
        SwapRegisters calldata swap,
        bytes calldata args,
        bytes calldata takerData
    ) external returns (uint256 updatedNextPC, uint256 choppedLength, SwapRegisters memory updatedSwap);
}

/// @notice Invoked via STATICCALL when the router is only quoting. 1inch's
/// own docs require the two paths to be consistent -- a single `view`
/// function implementing this exact ABI satisfies both interfaces at once
/// (a view function is safe to call via either a STATICCALL or a plain CALL),
/// which is the only way to make that consistency structural rather than a
/// promise.
interface IStaticExtruction {
    function extruction(
        bool isStaticContext,
        uint256 nextPC,
        SwapQuery calldata query,
        SwapRegisters calldata swap,
        bytes calldata args,
        bytes calldata takerData
    ) external view returns (uint256 updatedNextPC, uint256 choppedLength, SwapRegisters memory updatedSwap);
}
