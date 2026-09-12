// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console} from "forge-std/Script.sol";
import {IAqua} from "../src/interfaces/IAqua.sol";
import {EncumbranceArgsBuilder} from "../src/vm/Encumbrance.sol";
import {MakerTraitsLib} from "@1inch/swap-vm/libs/MakerTraits.sol";
import {ISwapVM} from "@1inch/swap-vm/interfaces/ISwapVM.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * Re-ships the Base mainnet encumbrance set at a market price.
 *
 * The first set (ShipEncumbranceBase.s.sol) was backed honestly and priced
 * badly. For an XYC strategy the shipped amounts ARE the reserves, so they are
 * the price: 0.07 USDC against 0.000012 WETH implies 5,833 USDC per WETH, while
 * the Chainlink feed reads ~2,526. We were asking 2.3x market for our own WETH.
 *
 * That is not a cosmetic problem. The router ranks books by the rate a taker
 * actually gets, so it correctly refused to route to these at every size a real
 * wallet could afford -- which meant opcode 35, the whole point of the
 * deployment, could never execute through the product. The liquidity was priced
 * out of its own market.
 *
 * This set fixes the ratio and keeps the backing honest. Three strategies at
 * 0.029558 USDC and 0.0000117 WETH each come to 0.088674 USDC and 0.0000351
 * WETH against a wallet holding 0.2276 and 0.0000389.
 *
 * Not touched: the earlier strategies stay live. They are a real maker quoting
 * well above market, which is exactly the kind of position this project
 * measures, and docking them would delete evidence to flatter ourselves.
 *
 * No approve() calls. The maker already holds an unlimited Aqua allowance for
 * both tokens (verified on chain), so re-approving would only spend gas and
 * widen what this script touches.
 *
 * The price is hardcoded at ship time and will drift. For a demo set that is
 * the honest trade; an oracle-pegged shipper is a different piece of work.
 *
 *   forge script script/ShipEncumbranceBaseV2.s.sol --rpc-url <base> --broadcast
 */
contract ShipEncumbranceBaseV2 is Script {
    address constant AQUA = 0x1111113CCf1426A8E30e2bfF5E005d929bF6a90a;
    address constant BONE_DRY_ROUTER = 0x74195573Fa9bC965667e03319F2C58567d4B96BE;
    address constant WETH = 0x4200000000000000000000000000000000000006;
    address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;

    uint16 constant MAX_UTIL_BPS = 8000; // refuse once 80% of the wallet is spoken for
    uint16 constant WIDEN_BPS = 500;     // 5% haircut at full utilisation

    // 0.029558 USDC : 0.0000117 WETH  ->  2,526.32 USDC per WETH, against a
    // feed reading 2,526.33. Sized so the position is also CONSTRAINED rather
    // than idle: two siblings owe 0.0000234 WETH against 0.0000389 backing, so
    // utilisation lands at 6,011 bps -- under the 8,000 refusal line with the
    // widening curve already active. A correctly-priced but idle position would
    // run opcode 35 and demonstrate nothing.
    uint256 constant USDC_EACH = 29_558;              // 0.029558  USDC
    uint256 constant WETH_EACH = 11_700_000_000_000;  // 0.0000117 WETH

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
        uint256 allowUsdc = IERC20(USDC).allowance(maker, AQUA);
        uint256 allowWeth = IERC20(WETH).allowance(maker, AQUA);

        console.log("maker          :", maker);
        console.log("holds USDC     :", heldUsdc);
        console.log("holds WETH     :", heldWeth);
        console.log("allowance USDC :", allowUsdc);
        console.log("allowance WETH :", allowWeth);

        // Backing is min(balance, allowance) on the token being delivered --
        // Encumbrance.sol:193-195. A balance check alone would pass while the
        // position reverts EncumbranceZeroBacking on its first fill.
        uint256 backingUsdc = allowUsdc < heldUsdc ? allowUsdc : heldUsdc;
        uint256 backingWeth = allowWeth < heldWeth ? allowWeth : heldWeth;

        require(backingUsdc >= USDC_EACH * 3, "USDC backing cannot cover three strategies");
        require(backingWeth >= WETH_EACH * 3, "WETH backing cannot cover three strategies");

        address[] memory tokens = new address[](2);
        tokens[0] = USDC;
        tokens[1] = WETH;

        uint256[] memory amounts = new uint256[](2);
        amounts[0] = USDC_EACH;
        amounts[1] = WETH_EACH;

        vm.startBroadcast(pk);

        // New salts: ship() rejects a repeat strategyHash (StrategiesMustBeImmutable),
        // so a re-price is a new strategy, never an edit.
        bytes memory prog1 = abi.encodePacked(hex"1408", uint64(8453401), hex"1100");
        bytes32 siblingHash1 =
            IAqua(AQUA).ship(BONE_DRY_ROUTER, abi.encode(MakerTraitsLib.build(_args(maker, prog1))), tokens, amounts);
        console.log("sibling 1      :", vm.toString(siblingHash1));

        bytes memory prog2 = abi.encodePacked(hex"1408", uint64(8453402), hex"1100");
        bytes32 siblingHash2 =
            IAqua(AQUA).ship(BONE_DRY_ROUTER, abi.encode(MakerTraitsLib.build(_args(maker, prog2))), tokens, amounts);
        console.log("sibling 2      :", vm.toString(siblingHash2));

        bytes32[] memory siblingHashes = new bytes32[](2);
        siblingHashes[0] = siblingHash1;
        siblingHashes[1] = siblingHash2;

        uint256 declaredTotalEncumbrance = WETH_EACH * 2; // what the two siblings really owe
        bytes memory encArgs =
            EncumbranceArgsBuilder.build(declaredTotalEncumbrance, siblingHashes, MAX_UTIL_BPS, WIDEN_BPS);
        bytes memory progEnc =
            abi.encodePacked(hex"1408", uint64(8453403), hex"1100", uint8(35), uint8(encArgs.length), encArgs);

        bytes32 encStrategyHash =
            IAqua(AQUA).ship(BONE_DRY_ROUTER, abi.encode(MakerTraitsLib.build(_args(maker, progEnc))), tokens, amounts);

        vm.stopBroadcast();

        console.log("encumbrance    :", vm.toString(encStrategyHash));
        console.log("declaredTotal  :", declaredTotalEncumbrance);
        console.log("maxUtilBps     :", MAX_UTIL_BPS);
        console.log("widenBps       :", WIDEN_BPS);
        console.log("utilBps (now)  :", (declaredTotalEncumbrance * 10_000) / backingWeth);
        console.log("implied price  :", (USDC_EACH * 1e18) / WETH_EACH, "USDC per WETH (6dp)");
    }
}
