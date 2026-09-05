// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice Minimal interface to the canonical Aqua deployment.
/// @dev Full source: https://github.com/1inch/aqua/blob/main/src/Aqua.sol
interface IAqua {
    function rawBalances(address maker, address app, bytes32 strategyHash, address token)
        external view returns (uint248 balance, uint8 tokensCount);

    function safeBalances(address maker, address app, bytes32 strategyHash, address token0, address token1)
        external view returns (uint256 balance0, uint256 balance1);

    function ship(address app, bytes calldata strategy, address[] calldata tokens, uint256[] calldata amounts)
        external returns (bytes32 strategyHash);

    function dock(address app, bytes32 strategyHash, address[] calldata tokens) external;
}
