// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

interface IAggregatorV3 {
    function decimals() external view returns (uint8);
    function latestRoundData()
        external
        view
        returns (
            uint80 roundId,
            int256 answer,
            uint256 startedAt,
            uint256 updatedAt,
            uint80 answeredInRound
        );
}

/**
 * @title Beacon — standalone on-chain oracle-deviation check.
 * @notice Pure / view only. Never in the settle path.
 * Immutable and stateless.
 *
 * Math and decimal normalization is kept strictly identical to web/lib/oracle.ts
 * so on-chain checks produce the exact same numbers as off-chain routing.
 */
contract Beacon {
    error InvalidPrice();

    /**
     * @notice A token's USD price from its configured Chainlink feed, normalized
     * to 18 decimals regardless of the feed's native decimals.
     * Cross-reference: oraclePriceUsd() in web/lib/oracle.ts.
     */
    function oraclePriceUsd(address feed) external view returns (uint256 priceUsdE18) {
        uint8 decimals = IAggregatorV3(feed).decimals();
        (, int256 answer, , , ) = IAggregatorV3(feed).latestRoundData();
        if (answer <= 0) revert InvalidPrice();

        return (uint256(answer) * 10 ** 18) / (10 ** decimals);
    }

    /**
     * @notice How far a quoted implied price sits from the oracle's, in basis points.
     * Positive means above oracle price, negative means below.
     * Cross-reference: deviationBps() in web/lib/oracle.ts.
     */
    function deviationBps(uint256 impliedUsdE18, uint256 oracleUsdE18) external pure returns (int256) {
        if (oracleUsdE18 == 0) return 0;
        return (int256(impliedUsdE18) - int256(oracleUsdE18)) * 10_000 / int256(oracleUsdE18);
    }
}
