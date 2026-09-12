// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console} from "forge-std/Script.sol";
import {IAqua} from "../src/interfaces/IAqua.sol";
import {EncumbranceArgsBuilder} from "../src/vm/Encumbrance.sol";
import {MakerTraitsLib} from "@1inch/swap-vm/libs/MakerTraits.sol";
import {ISwapVM} from "@1inch/swap-vm/interfaces/ISwapVM.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * The Base mainnet twin of ShipEncumbrance.s.sol.
 *
 * Two differences that matter. Aqua here is 1inch's own canonical deployment,
 * not one of ours, so these strategies sit in the same registry every other Aqua
 * maker uses. And the amounts are sized to what the maker actually holds rather
 * than copied from the testnet script: three strategies at 0.07 USDC and
 * 0.000012 WETH each come to 0.21 USDC and 0.000036 WETH against a wallet
 * holding 0.2276 and 0.0000389.
 *
 * That arithmetic is the point. ship() transfers nothing, so we could promise
 * any number here for free -- and an unbacked strategy of our own would be the
 * exact phantom liquidity this project exists to measure. Every promise below is
 * covered.
 *
 * Sibling encumbrance lands at 24/38.9 of backing, about 6,166 bps, which sits
 * under the 8,000 refusal line with the widening curve already active. An idle
 * position would demonstrate nothing.
 *
 *   forge script script/ShipEncumbranceBase.s.sol --rpc-url <base> --broadcast
 */
contract ShipEncumbranceBase is Script {
    address constant AQUA = 0x1111113CCf1426A8E30e2bfF5E005d929bF6a90a;
    address constant BONE_DRY_ROUTER = 0x74195573Fa9bC965667e03319F2C58567d4B96BE;
    address constant WETH = 0x4200000000000000000000000000000000000006;
    address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;

    uint16 constant MAX_UTIL_BPS = 8000; // refuse once 80% of the wallet is spoken for
    uint16 constant WIDEN_BPS = 500;     // 5% haircut at full utilisation

    uint256 constant USDC_EACH = 70_000;             // 0.07 USDC
    uint256 constant WETH_EACH = 12_000_000_000_000; // 0.000012 WETH

    function _args(address maker, bytes memory program) internal pure returns (MakerTraitsLib.Args memory) {
        return MakerTraitsLib.Args({
            maker: maker,
            receiver: address(0),
            shouldUnwrapWeth: false,
            useAquaInsteadOfSignature: true,
            allowZeroAmountIn: false,
            hasPreTransferInHook: false,
            hasPostTransferInHook: false,
            hasPreTransferOutHook: false,
            hasPostTransferOutHook: false,
            preTransferInTarget: address(0),
            preTransferInData: "",
            postTransferInTarget: address(0),
            postTransferInData: "",
            preTransferOutTarget: address(0),
            preTransferOutData: "",
            postTransferOutTarget: address(0),
            postTransferOutData: "",
            program: program
        });
    }

    function run() external {
        uint256 pk = vm.envUint("MAINNET_PRIVATE_KEY");
        address maker = vm.addr(pk);

        uint256 heldUsdc = IERC20(USDC).balanceOf(maker);
        uint256 heldWeth = IERC20(WETH).balanceOf(maker);
        console.log("maker        :", maker);
        console.log("holds USDC   :", heldUsdc);
        console.log("holds WETH   :", heldWeth);

        // Refuse to ship a position this wallet cannot cover. The whole claim is
        // that a promise should be checkable before it is made.
        require(heldUsdc >= USDC_EACH * 3, "not enough USDC to back three strategies");
        require(heldWeth >= WETH_EACH * 3, "not enough WETH to back three strategies");

        address[] memory tokens = new address[](2);
        tokens[0] = USDC;
        tokens[1] = WETH;

        uint256[] memory amounts = new uint256[](2);
        amounts[0] = USDC_EACH;
        amounts[1] = WETH_EACH;

        vm.startBroadcast(pk);

        IERC20(USDC).approve(AQUA, type(uint256).max);
        IERC20(WETH).approve(AQUA, type(uint256).max);

        bytes memory prog1 = abi.encodePacked(hex"1408", uint64(8453301), hex"1100");
        bytes32 siblingHash1 =
            IAqua(AQUA).ship(BONE_DRY_ROUTER, abi.encode(MakerTraitsLib.build(_args(maker, prog1))), tokens, amounts);
        console.log("sibling 1    :", vm.toString(siblingHash1));

        bytes memory prog2 = abi.encodePacked(hex"1408", uint64(8453302), hex"1100");
        bytes32 siblingHash2 =
            IAqua(AQUA).ship(BONE_DRY_ROUTER, abi.encode(MakerTraitsLib.build(_args(maker, prog2))), tokens, amounts);
        console.log("sibling 2    :", vm.toString(siblingHash2));

        bytes32[] memory siblingHashes = new bytes32[](2);
        siblingHashes[0] = siblingHash1;
        siblingHashes[1] = siblingHash2;

        uint256 declaredTotalEncumbrance = WETH_EACH * 2; // what the two siblings really owe
        bytes memory encArgs =
            EncumbranceArgsBuilder.build(declaredTotalEncumbrance, siblingHashes, MAX_UTIL_BPS, WIDEN_BPS);
        bytes memory progEnc =
            abi.encodePacked(hex"1408", uint64(8453303), hex"1100", uint8(35), uint8(encArgs.length), encArgs);

        bytes32 encStrategyHash =
            IAqua(AQUA).ship(BONE_DRY_ROUTER, abi.encode(MakerTraitsLib.build(_args(maker, progEnc))), tokens, amounts);

        vm.stopBroadcast();

        console.log("encumbrance  :", vm.toString(encStrategyHash));
        console.log("declaredTotal:", declaredTotalEncumbrance);
        console.log("maxUtilBps   :", MAX_UTIL_BPS);
        console.log("widenBps     :", WIDEN_BPS);
        console.log("utilBps (now):", (declaredTotalEncumbrance * 10_000) / heldWeth);
    }
}
