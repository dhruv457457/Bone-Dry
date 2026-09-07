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
///
/// Pulled from the ACTUAL verified source of the deployed router
/// (0xD0a0A94711aa39EfcC3Ab2aF63ffa5BAD4E640a7 on Base Sepolia, confirmed
/// via Sourcify's v2 API, runtimeMatch: "match"), not from 1inch/swap-vm's
/// `main` branch on GitHub -- an earlier version of this file was built from
/// `main`, which turned out to already be ahead of what this router was
/// actually compiled from: `main`'s SwapRegisters has 4 fields, the real
/// deployed one has 5 (an extra `amountNetPulled`). That mismatch changes
/// the ABI-encoded selector, so the first deployed BeaconStrategy was
/// unreachable -- every call the real router made to it hit the wrong
/// function and reverted. Confirmed by decoding the router's actual revert
/// trace: it called selector 0xb77cc3e2, this file's earlier 4-field
/// version computes 0xccd435ec.
/// Full source: https://github.com/1inch/swap-vm/blob/main/src/instructions/Extruction.sol
/// Struct source: https://github.com/1inch/swap-vm/blob/main/src/libs/VM.sol
/// (both read as of the date above -- verify against the live router's own
/// Sourcify entry again before trusting either if this ever needs revisiting)

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
/// `isExactIn ? amountOut : amountIn`. Field order must match the REAL
/// deployed VM.sol exactly -- five fields, not the four `main` currently
/// shows. `amountNetPulled` is the router's own fee-accounting register;
/// a strategy that doesn't deal in fees passes it through unchanged
/// (BeaconStrategy does, via `updatedSwap = swap` before touching only
/// amountIn/amountOut).
struct SwapRegisters {
    uint256 balanceIn;
    uint256 balanceOut;
    uint256 amountIn;
    uint256 amountOut;
    uint256 amountNetPulled;
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
