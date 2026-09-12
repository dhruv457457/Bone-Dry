// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {Chains} from "../script/Chains.sol";

/**
 * Proofs for the liquidation-facility design, run against real Aqua on a Base
 * mainnet fork. Each test settles one claim the design rests on. Two of them
 * are claims we WANT to be true; one is a flaw we expect to confirm, because a
 * design that pretends `dock()` is not instant would be built on sand.
 *
 * Aqua source (four functions, no more): github.com/1inch/aqua/blob/main/src/Aqua.sol
 */
interface IAquaFull {
    function rawBalances(address maker, address app, bytes32 strategyHash, address token)
        external view returns (uint248 balance, uint8 tokensCount);
    function ship(address app, bytes calldata strategy, address[] calldata tokens, uint256[] calldata amounts)
        external returns (bytes32 strategyHash);
    function dock(address app, bytes32 strategyHash, address[] calldata tokens) external;
    function pull(address maker, bytes32 strategyHash, address token, uint256 amount, address to) external;
}

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
}

/// @dev The smallest possible Aqua app: it pulls a maker's tokens straight to a
///      third party. This is the whole mechanism a liquidation facility needs.
contract MinimalFacility {
    IAquaFull public immutable AQUA;

    constructor(IAquaFull aqua_) {
        AQUA = aqua_;
    }

    /// @notice Draw on a maker's facility, settling DIRECTLY to `to`.
    /// @dev Note what is absent: this contract never holds the tokens, never
    ///      takes custody, and needs no balance sheet of its own.
    function draw(address maker, bytes32 strategyHash, address token, uint256 amount, address to) external {
        AQUA.pull(maker, strategyHash, token, amount, to);
    }

    /// @notice Total this maker has promised THIS app across several strategies.
    function exposure(address maker, bytes32[] calldata hashes, address token) external view returns (uint256 total) {
        for (uint256 i; i < hashes.length; ++i) {
            (uint248 bal,) = AQUA.rawBalances(maker, address(this), hashes[i], token);
            total += bal;
        }
    }
}

contract FacilityProof is Test {
    IAquaFull aqua;
    IERC20 USDC;
    MinimalFacility facility;

    address maker = address(0xBEEF);
    address debtHolder; // stands in for a lending pool being repaid

    address[] tokens;
    uint256[] amounts;

    function setUp() public {
        vm.createSelectFork(vm.envOr("BASE_RPC_URL", string("https://mainnet.base.org")));
        string memory j = vm.readFile(string.concat("fixtures/strategy.", vm.toString(block.chainid), ".json"));
        aqua = IAquaFull(vm.parseJsonAddress(j, ".aqua"));
        USDC = IERC20(Chains.usdc());
        facility = new MinimalFacility(aqua);
        debtHolder = makeAddr("lendingPool"); // fresh - 0xDEAD really holds USDC on Base

        vm.label(address(aqua), "Aqua");
        vm.label(address(facility), "Facility");
        vm.label(maker, "maker");
        vm.label(debtHolder, "lendingPool");
    }

    function _ship(bytes memory strategy, uint256 amt) internal returns (bytes32 h) {
        deal(address(USDC), maker, amt);
        tokens = new address[](1);
        tokens[0] = address(USDC);
        amounts = new uint256[](1);
        amounts[0] = amt;

        vm.startPrank(maker);
        USDC.approve(address(aqua), type(uint256).max);
        h = aqua.ship(address(facility), strategy, tokens, amounts);
        vm.stopPrank();
    }

    /// PROOF 1 — maker capital settles straight to a third party. The facility
    /// never touches it. This is what lets a draw repay a debt atomically.
    function test_P1_pullSettlesDirectlyToThirdParty() public {
        bytes32 h = _ship(abi.encode("facility-p1"), 1_000e6);

        assertEq(USDC.balanceOf(maker), 1_000e6, "maker funded");
        assertEq(USDC.balanceOf(debtHolder), 0, "third party starts empty");

        facility.draw(maker, h, address(USDC), 400e6, debtHolder);

        assertEq(USDC.balanceOf(maker), 600e6, "maker paid out");
        assertEq(USDC.balanceOf(debtHolder), 400e6, "third party received directly");
        assertEq(USDC.balanceOf(address(facility)), 0, "facility held nothing at any point");

        (uint248 remaining,) = aqua.rawBalances(maker, address(facility), h, address(USDC));
        assertEq(remaining, 600e6, "virtual balance decremented by the draw");
    }

    /// PROOF 2 — a draw cannot exceed what was committed.
    function test_P2_drawIsCappedByCommitment() public {
        bytes32 h = _ship(abi.encode("facility-p2"), 1_000e6);
        deal(address(USDC), maker, 10_000e6); // wallet is rich; the COMMITMENT is the cap

        vm.expectRevert();
        facility.draw(maker, h, address(USDC), 1_001e6, debtHolder);
    }

    /// PROOF 3 — the flaw, confirmed. dock() is instant, free, unilateral, and
    /// kills a pending draw. No delay, no penalty, no notice. Any design that
    /// calls an Aqua commitment "binding" is wrong.
    function test_P3_dockIsInstantAndKillsTheDraw() public {
        bytes32 h = _ship(abi.encode("facility-p3"), 1_000e6);

        uint256 gasBefore = gasleft();
        vm.prank(maker);
        aqua.dock(address(facility), h, tokens);
        uint256 dockCost = gasBefore - gasleft();

        emit log_named_uint("gas the maker paid to revoke everything", dockCost);
        assertEq(USDC.balanceOf(maker), 1_000e6, "maker kept every token - no penalty");

        vm.expectRevert();
        facility.draw(maker, h, address(USDC), 1e6, debtHolder);
    }

    /// PROOF 4 — one wallet backing several strategies is readable on-chain, so
    /// true exposure can be enforced in-VM rather than filtered off-chain.
    function test_P4_crossStrategyExposureIsReadable() public {
        bytes32 h1 = _ship(abi.encode("facility-p4-a"), 1_000e6);
        bytes32 h2 = _ship(abi.encode("facility-p4-b"), 1_000e6);
        bytes32 h3 = _ship(abi.encode("facility-p4-c"), 1_000e6);

        // The wallet holds 1,000 - _ship deals exactly that each time, it does not accumulate.
        deal(address(USDC), maker, 1_000e6);

        bytes32[] memory hs = new bytes32[](3);
        (hs[0], hs[1], hs[2]) = (h1, h2, h3);

        uint256 promised = facility.exposure(maker, hs, address(USDC));
        uint256 held = USDC.balanceOf(maker);

        emit log_named_uint("promised across 3 strategies", promised);
        emit log_named_uint("actually held in the wallet", held);

        assertEq(promised, 3_000e6, "three strategies each promising 1,000");
        assertEq(held, 1_000e6, "backed by a single 1,000 balance");
        assertGt(promised, held, "overcommitted 3x - and provably so, on-chain");
    }
}
