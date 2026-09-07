// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console} from "forge-std/Script.sol";
import {Chains} from "./Chains.sol";
import {BeaconStrategy} from "../src/BeaconStrategy.sol";

/**
 * Deploys BeaconStrategy for the WETH/USDC pair, using the same Chainlink
 * feeds web/lib/networks.ts already quotes for the oracle-deviation display.
 *
 * Immutable and single-purpose by design (see BeaconStrategy.sol's own
 * docs) -- a new deployment is the only way to change the pair, the feeds,
 * or the spread. That is the point, not a limitation to work around.
 *
 *   forge script script/DeployBeaconStrategy.s.sol --rpc-url base_sepolia --broadcast
 */
contract DeployBeaconStrategy is Script {
    uint256 constant SPREAD_BPS = 20; // 0.20% below oracle mid

    function _feeds() internal view returns (address wethFeed, address usdcFeed) {
        if (block.chainid == Chains.BASE) {
            return (0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70, 0x7e860098F58bBFC8648a4311b374B1D669a2bc6B);
        }
        if (block.chainid == Chains.BASE_SEPOLIA) {
            return (0x4aDC67696bA383F43DD60A9e78F2C97Fbbfc7cb1, 0xd30e2101a97dcbAeBCBC04F14C3f624E67A35165);
        }
        revert Chains.UnsupportedChain(block.chainid);
    }

    function run() external {
        (address wethFeed, address usdcFeed) = _feeds();
        address weth = Chains.weth();
        address usdc = Chains.usdc();

        uint256 pk = vm.envUint("PRIVATE_KEY");

        vm.startBroadcast(pk);
        BeaconStrategy strategy = new BeaconStrategy(weth, wethFeed, 18, usdc, usdcFeed, 6, SPREAD_BPS);
        vm.stopBroadcast();

        console.log("chain           ", Chains.name());
        console.log("BeaconStrategy  ", address(strategy));
        console.log("tokenA (WETH)   ", weth, "feed", wethFeed);
        console.log("tokenB (USDC)   ", usdc, "feed", usdcFeed);
        console.log("spreadBps       ", SPREAD_BPS);
    }
}
