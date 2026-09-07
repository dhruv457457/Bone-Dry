// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { IAggregatorV3 } from "./Beacon.sol";
import { SwapQuery, SwapRegisters } from "./interfaces/IExtruction.sol";

/**
 * @title BeaconStrategy — an Aqua strategy priced off Chainlink directly,
 * via SwapVM's Extruction opcode (0x20), instead of a bonding curve.
 *
 * Every other strategy this project has shipped uses the router's built-in
 * XYCSwap opcode: price comes from a virtual reserve ratio. This one proves
 * SwapVM is extensible past that -- a maker can hand pricing to any external
 * contract, and the router will call it mid-swap. Extruction is the opcode
 * that makes that possible; this is a real, minimal, honest use of it: one
 * fixed token pair, priced at Chainlink oracle mid minus a fixed spread,
 * nothing configurable after deployment.
 *
 * Immutable and single-purpose on purpose. 1inch's own docs on Extruction
 * say a target "SHOULD be immutable" and must be deterministic between the
 * quote and swap paths -- there is no admin key, no setter, and every
 * function here is `view`, so both are true by construction, not by promise.
 *
 * @dev Duplicates Beacon.sol's price-normalization math rather than calling
 * the deployed Beacon contract. Beacon.sol is explicitly documented "Pure /
 * view only. Never in the settle path." -- and it has no other on-chain
 * caller today, only web/lib/oracle.ts via eth_call. A swap's non-static
 * Extruction call IS the settle path (it moves real value), so this
 * contract must not depend on Beacon rather than quietly becoming the thing
 * that puts it there. Kept numerically identical to Beacon.sol's
 * oraclePriceUsd() and web/lib/oracle.ts's oraclePriceUsd() -- this is the
 * one place across all three that also enforces staleness, because this is
 * the one place a stale price could actually misprice real money; Beacon.sol
 * is a display helper and deliberately does not gate on it.
 */
contract BeaconStrategy {
    error InvalidPrice(address feed);
    error StalePrice(address feed, uint256 updatedAt);
    error UnsupportedToken(address token);
    error IdenticalTokens(address token);
    error SpreadTooHigh(uint256 spreadBps);

    /// @dev Matches web/lib/oracle.ts's MAX_STALENESS_SECONDS exactly: 25h,
    /// enough for Chainlink's 24h stablecoin heartbeat plus network jitter.
    uint256 private constant MAX_STALENESS_SECONDS = 90_000;
    uint256 private constant BPS = 10_000;

    address public immutable tokenA;
    address public immutable feedA;
    uint8 public immutable decimalsA;

    address public immutable tokenB;
    address public immutable feedB;
    uint8 public immutable decimalsB;

    /// @notice Maker's margin below oracle mid, in bps. A maker quoting at
    /// raw oracle mid has zero edge and is arbed the instant Chainlink
    /// updates one block late -- the same reason every oracle-priced AMM
    /// design charges a spread instead of quoting fair value directly.
    uint256 public immutable spreadBps;

    constructor(
        address _tokenA,
        address _feedA,
        uint8 _decimalsA,
        address _tokenB,
        address _feedB,
        uint8 _decimalsB,
        uint256 _spreadBps
    ) {
        if (_tokenA == _tokenB) revert IdenticalTokens(_tokenA);
        // 1_000 bps (10%) is already an absurd spread for a priced pair;
        // this bounds a deploy-time typo, not a real economic ceiling.
        if (_spreadBps >= 1_000) revert SpreadTooHigh(_spreadBps);

        tokenA = _tokenA;
        feedA = _feedA;
        decimalsA = _decimalsA;
        tokenB = _tokenB;
        feedB = _feedB;
        decimalsB = _decimalsB;
        spreadBps = _spreadBps;
    }

    function _priceUsdE18(address feed) private view returns (uint256) {
        uint8 dec = IAggregatorV3(feed).decimals();
        (, int256 answer, , uint256 updatedAt, ) = IAggregatorV3(feed).latestRoundData();
        if (answer <= 0) revert InvalidPrice(feed);
        if (block.timestamp - updatedAt > MAX_STALENESS_SECONDS) revert StalePrice(feed, updatedAt);
        return (uint256(answer) * 1e18) / (10 ** dec);
    }

    function _legFor(address token) private view returns (address feed, uint8 decimals) {
        if (token == tokenA) return (feedA, decimalsA);
        if (token == tokenB) return (feedB, decimalsB);
        revert UnsupportedToken(token);
    }

    /**
     * @notice SwapVM Extruction entrypoint. Prices the requested direction at
     * Chainlink oracle mid minus `spreadBps`, leaving `balanceIn`/`balanceOut`
     * untouched -- this strategy prices trades, it does not gate fill size.
     * 1inch's own guidance is that a maker's spend limit belongs to the
     * existing StaticBalances/InvalidateTokenIn/InvalidateTokenOut opcodes
     * composed around Extruction in the maker's program, not to the
     * Extruction target itself.
     * @dev `isStaticContext` is accepted (both IExtruction and
     * IStaticExtruction require it in the signature) but unused: the whole
     * point of a `view`-only target is that quote and swap compute the
     * identical number, so there is nothing to branch on. `args` is unused
     * too -- the spread is fixed at deploy time, not per-call.
     */
    function extruction(
        bool, /* isStaticContext */
        uint256 nextPC,
        SwapQuery calldata query,
        SwapRegisters calldata swap,
        bytes calldata, /* args */
        bytes calldata /* takerData */
    ) external view returns (uint256 updatedNextPC, uint256 choppedLength, SwapRegisters memory updatedSwap) {
        if (query.tokenIn == query.tokenOut) revert IdenticalTokens(query.tokenIn);
        (address feedIn, uint8 decIn) = _legFor(query.tokenIn);
        (address feedOut, uint8 decOut) = _legFor(query.tokenOut);

        uint256 priceIn = _priceUsdE18(feedIn);
        uint256 priceOut = _priceUsdE18(feedOut);

        updatedSwap = swap;

        // Two sequential divisions rather than one combined fraction: the
        // combined numerator (amountIn * price * spread-factor * 10**dec)
        // can overflow uint256 for large amounts at high per-unit prices.
        // This costs a few wei of rounding, same trade-off any fixed-point
        // on-chain price math makes; it does not risk wrapping.
        if (query.isExactIn) {
            uint256 valueInUsdE18 = (swap.amountIn * priceIn) / (10 ** decIn);
            uint256 valueOutUsdE18 = (valueInUsdE18 * (BPS - spreadBps)) / BPS;
            updatedSwap.amountOut = (valueOutUsdE18 * (10 ** decOut)) / priceOut;
        } else {
            uint256 valueOutUsdE18 = (swap.amountOut * priceOut) / (10 ** decOut);
            uint256 valueInUsdE18 = (valueOutUsdE18 * BPS) / (BPS - spreadBps);
            updatedSwap.amountIn = (valueInUsdE18 * (10 ** decIn)) / priceIn;
        }

        updatedNextPC = nextPC;
        choppedLength = 0;
    }
}
