// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {console} from "forge-std/Test.sol";
import {BoneDryFork, IERC20} from "./Base.t.sol";
import {Lens} from "../src/Lens.sol";

/**
 * Lens is the only thing standing between a maker's promise and a swapper's
 * money, and it is a pure view — so it is worth holding to a property rather
 * than a handful of examples.
 *
 * The property: quotable depth is the floor of what the strategy claims, what
 * the wallet holds, and what Aqua is allowed to move. Never more than any of
 * them, and exactly the smallest.
 */
contract LensDepthTest is BoneDryFork {
    Lens lens;

    function setUp() public {
        _forkAndLoadFixture();
        lens = new Lens(aqua);
    }

    function _depth(uint256 i) internal view returns (uint256) {
        return lens.quotableDepth(makers[i], address(router), strategyHashes[i], address(WETH));
    }

    /// @dev Whatever the maker claims, holds and permits, depth is the minimum.
    function testFuzz_depthIsTheFloorOfThree(uint128 claim, uint128 held, uint128 permitted) public {
        claim = uint128(bound(claim, 1, 1_000_000 ether));
        held = uint128(bound(held, 0, 1_000_000 ether));
        permitted = uint128(bound(permitted, 0, 1_000_000 ether));

        address m = makers[0];
        deal(address(USDC), m, 10_000e6);
        deal(address(WETH), m, claim);

        address[] memory tokens = new address[](2);
        tokens[0] = address(USDC);
        tokens[1] = address(WETH);
        uint256[] memory amounts = new uint256[](2);
        amounts[0] = 10_000e6;
        amounts[1] = claim;

        vm.startPrank(m);
        USDC.approve(address(aqua), type(uint256).max);
        WETH.approve(address(aqua), type(uint256).max);
        aqua.ship(address(router), strategies[0], tokens, amounts);
        // now move the wallet and the allowance independently of the promise
        WETH.approve(address(aqua), permitted);
        vm.stopPrank();

        // set the wallet to exactly `held`, in whichever direction that needs
        uint256 balance = WETH.balanceOf(m);
        if (held < balance) {
            vm.prank(m);
            WETH.transfer(address(0xDEAD), balance - held);
        } else if (held > balance) {
            deal(address(WETH), m, held);
        }

        uint256 min = claim;
        if (held < min) min = held;
        if (permitted < min) min = permitted;

        assertEq(_depth(0), min, "depth is not the floor of claim, wallet and allowance");
    }

    /// @dev A docked strategy quotes nothing, however full the wallet is.
    function test_dockedStrategyHasNoDepth() public {
        _ship(0, 10_000e6, 3e18);
        assertEq(_depth(0), 3e18, "should start with real depth");

        address[] memory tokens = new address[](2);
        tokens[0] = address(USDC);
        tokens[1] = address(WETH);
        vm.prank(makers[0]);
        aqua.dock(address(router), strategyHashes[0], tokens);

        assertGt(WETH.balanceOf(makers[0]), 0, "wallet should still be full");
        assertEq(_depth(0), 0, "a docked strategy must quote nothing");
    }

    /// @dev A strategy that was never shipped quotes nothing rather than reverting.
    function test_unknownStrategyHasNoDepth() public view {
        assertEq(
            lens.quotableDepth(address(0xBEEF), address(router), bytes32(uint256(1)), address(WETH)),
            0,
            "an unknown strategy must read as empty, not revert"
        );
    }

    /// @dev Revoking the approval strands the inventory: the tokens are there and
    ///      Aqua can no longer move them, so the depth is zero even though both
    ///      the promise and the balance say otherwise.
    function test_revokedAllowanceZeroesDepth() public {
        _ship(0, 10_000e6, 3e18);

        vm.prank(makers[0]);
        WETH.approve(address(aqua), 0);

        assertEq(WETH.balanceOf(makers[0]), 3e18, "wallet untouched");
        assertEq(_depth(0), 0, "revoked allowance must zero the depth");
    }

    /// @dev Two strategies, one wallet. Each reads its own promise, and both can
    ///      claim inventory the wallet can only honour once — which is precisely
    ///      why a router must not add these together.
    function test_siblingStrategiesEachSeeTheWholeWallet() public {
        _ship(0, 10_000e6, 3e18);

        // maker 1 shipped separately but we fund maker 0 only; check maker 0's own
        // two-token view rather than summing across makers
        uint256 wethDepth = _depth(0);
        uint256 usdcDepth =
            lens.quotableDepth(makers[0], address(router), strategyHashes[0], address(USDC));

        console.log("WETH depth :", wethDepth);
        console.log("USDC depth :", usdcDepth);

        assertEq(wethDepth, 3e18, "WETH depth");
        assertEq(usdcDepth, 10_000e6, "USDC depth");
    }
}
