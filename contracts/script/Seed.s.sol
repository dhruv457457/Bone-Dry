// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console} from "forge-std/Script.sol";
import {Chains} from "./Chains.sol";
import {IAqua} from "../src/interfaces/IAqua.sol";

interface IWETH {
    function deposit() external payable;
    function approve(address, uint256) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

interface IERC20 {
    function approve(address, uint256) external returns (bool);
}

/**
 * Seeds three Aqua makers on a local Base fork so the router API has something
 * real to index. Maker 2 ships without ever funding its wallet — the phantom
 * liquidity case the Lens is built to see through.
 *
 *   forge script script/Seed.s.sol --rpc-url http://127.0.0.1:8545 --broadcast
 */
contract Seed is Script {
    address immutable USDC = Chains.usdc();
    address immutable WETH = Chains.weth();


    /// @dev Anvil's published accounts by default, which suits a local fork and
    ///      not a public chain: anyone holding those keys could dock these
    ///      strategies and kill a live demo. Override per network.
    function _keys() internal view returns (uint256[3] memory k) {
        k[0] = vm.envOr("MAKER0_PK", uint256(0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80));
        k[1] = vm.envOr("MAKER1_PK", uint256(0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d));
        k[2] = vm.envOr("MAKER2_PK", uint256(0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a));
    }

    /**
     * @dev What each maker actually holds, against a promise all three make in
     *      full. Maker 2 backs nothing at all — the phantom the router has to
     *      route around — and maker 1 backs two thirds, so its promise outruns
     *      its wallet. That asymmetry is the demonstration, not an accident.
     *
     *      SEED_SCALE divides it, because three ether of testnet WETH is more
     *      than a faucet will give you.
     */
    function _real() internal view returns (uint256[3] memory r) {
        uint256 d = vm.envOr("SEED_SCALE", uint256(1));
        r[0] = 3 ether / d;
        r[1] = 2 ether / d;
        r[2] = 0;
    }

    function _claim() internal view returns (uint256 weth, uint256 usdc) {
        uint256 d = vm.envOr("SEED_SCALE", uint256(1));
        return (3 ether / d, 10_000e6 / d);
    }

    function run() external {
        string memory j = vm.readFile(string.concat("fixtures/strategy.", vm.toString(block.chainid), ".json"));
        IAqua aqua = IAqua(vm.parseJsonAddress(j, ".aqua"));
        address router = vm.parseJsonAddress(j, ".router");

        uint256[3] memory keys = _keys();
        uint256[3] memory real = _real();
        (uint256 claimWeth, uint256 claimUsdc) = _claim();

        for (uint256 i; i < 3; ++i) {
            bytes memory strategy = vm.parseJsonBytes(j, string.concat(".strategies[", vm.toString(i), "]"));
            address maker = vm.addr(keys[i]);

            vm.startBroadcast(keys[i]);

            // Top up rather than wrap blindly: a maker re-seeded with a new
            // strategy already holds the inventory from the last one, and
            // wrapping again would ask for ether they have already spent.
            uint256 held = IWETH(WETH).balanceOf(maker);
            if (real[i] > held) IWETH(WETH).deposit{value: real[i] - held}();
            IWETH(WETH).approve(address(aqua), type(uint256).max);
            IERC20(USDC).approve(address(aqua), type(uint256).max);

            address[] memory tokens = new address[](2);
            tokens[0] = USDC;
            tokens[1] = WETH;
            uint256[] memory amounts = new uint256[](2);
            amounts[0] = claimUsdc;  // claimed
            amounts[1] = claimWeth;  // claimed by ALL THREE, backed by only two

            aqua.ship(router, strategy, tokens, amounts);
            vm.stopBroadcast();

            console.log("maker", i, maker);
            console.log("   real WETH in wallet:", IWETH(WETH).balanceOf(maker));
        }
    }
}
