// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IAqua} from "./interfaces/IAqua.sol";

interface IERC20View {
    function balanceOf(address) external view returns (uint256);
    function allowance(address owner, address spender) external view returns (uint256);
}

/**
 * @title Lens — how much water a well can actually yield.
 * @notice View-only. Never in the settle path.
 *
 * A strategy's virtual balance is a promise, not a guarantee. 1inch document the
 * gap themselves: `safeBalances` "can report room the wallet no longer backs",
 * because sibling strategies share one wallet and `pull()` settles with
 * `transferFrom(maker, ...)` — which needs real balance AND allowance.
 *
 * So quotable depth is the floor of three numbers, not one.
 */
contract Lens {
    IAqua public immutable aqua;

    constructor(IAqua _aqua) {
        aqua = _aqua;
    }

    /// @return depth the largest amount of `token` this strategy can actually deliver right now
    function quotableDepth(address maker, address app, bytes32 strategyHash, address token)
        public
        view
        returns (uint256 depth)
    {
        (uint248 virtualBal, uint8 tokensCount) = aqua.rawBalances(maker, app, strategyHash, token);
        // tokensCount 0 = never shipped, 0xff = docked
        if (tokensCount == 0 || tokensCount == 0xff) return 0;

        uint256 wallet = IERC20View(token).balanceOf(maker);
        uint256 allowed = IERC20View(token).allowance(maker, address(aqua));

        depth = virtualBal;
        if (wallet < depth) depth = wallet;
        if (allowed < depth) depth = allowed;
    }

    /// @notice The maker's own health signal: is the whole book still backed?
    /// @param strategyHashes every live strategy this maker has shipped under `app`
    function coverage(address maker, address app, bytes32[] calldata strategyHashes, address token)
        external
        view
        returns (uint256 committed, uint256 backing, uint256 coverageBps)
    {
        for (uint256 i; i < strategyHashes.length; ++i) {
            (uint248 bal, uint8 cnt) = aqua.rawBalances(maker, app, strategyHashes[i], token);
            if (cnt == 0 || cnt == 0xff) continue;
            committed += bal;
        }
        uint256 wallet = IERC20View(token).balanceOf(maker);
        uint256 allowed = IERC20View(token).allowance(maker, address(aqua));
        backing = wallet < allowed ? wallet : allowed;

        coverageBps = committed == 0 ? 10_000 : (backing * 10_000) / committed;
        if (coverageBps > 10_000) coverageBps = 10_000;
    }

    function quotableDepthBatch(
        address[] calldata makers,
        address app,
        bytes32[] calldata strategyHashes,
        address token
    ) external view returns (uint256[] memory depths) {
        depths = new uint256[](makers.length);
        for (uint256 i; i < makers.length; ++i) {
            depths[i] = quotableDepth(makers[i], app, strategyHashes[i], token);
        }
    }
}
