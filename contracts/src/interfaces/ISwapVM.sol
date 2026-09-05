// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice Minimal interface to the canonical AquaSwapVMRouter (v1.0.2).
/// @dev `data` is hooksData || program. For Aqua strategies the maker traits set
///      USE_AQUA_INSTEAD_OF_SIGNATURE, so no signature is verified — the router
///      reads virtual balances from Aqua instead.
interface ISwapVM {
    struct Order {
        address maker;
        uint256 traits;
        bytes data;
    }

    function quote(
        Order calldata order,
        address tokenIn,
        address tokenOut,
        uint256 amount,
        bytes calldata takerTraitsAndData
    ) external view returns (uint256 amountIn, uint256 amountOut, bytes32 orderHash);

    function swap(
        Order calldata order,
        address tokenIn,
        address tokenOut,
        uint256 amount,
        bytes calldata takerTraitsAndData
    ) external returns (uint256 amountIn, uint256 amountOut, bytes32 orderHash);
}
