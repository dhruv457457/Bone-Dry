// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console} from "forge-std/Script.sol";
import {IAqua} from "../src/interfaces/IAqua.sol";
import {EncumbranceArgsBuilder} from "../src/vm/Encumbrance.sol";
import {MakerTraitsLib} from "@1inch/swap-vm/libs/MakerTraits.sol";
import {ISwapVM} from "@1inch/swap-vm/interfaces/ISwapVM.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IWETH {
    function deposit() external payable;
    function approve(address, uint256) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

contract ShipEncumbrance is Script {
    address constant AQUA = 0x7a062f824FAbdf2360354Ad52B3752065150Da61;
    address constant BONE_DRY_ROUTER = 0x75E8971831675A3eF0CAbc4fd441dA7aeB481146;
    address constant WETH = 0x4200000000000000000000000000000000000006;
    address constant USDC = 0x036CbD53842c5426634e7929541eC2318f3dCF7e;

    uint16 constant MAX_UTIL_BPS = 8000; // 80%
    uint16 constant WIDEN_BPS = 500;     // 5%

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address maker = vm.addr(pk);

        console.log("Maker address   :", maker);
        console.log("Router address  :", BONE_DRY_ROUTER);

        vm.startBroadcast(pk);

        // Ensure approvals to Aqua
        IERC20(USDC).approve(AQUA, type(uint256).max);
        IWETH(WETH).approve(AQUA, type(uint256).max);

        address[] memory tokens = new address[](2);
        tokens[0] = USDC;
        tokens[1] = WETH;

        uint256[] memory amounts = new uint256[](2);
        amounts[0] = 5_000_000;              // 5 USDC
        amounts[1] = 1_500_000_000_000_000;  // 0.0015 WETH

        // 1. Sibling 1
        bytes memory prog1 = abi.encodePacked(
            hex"1408", uint64(8453201),
            hex"1100"
        );
        ISwapVM.Order memory order1 = MakerTraitsLib.build(MakerTraitsLib.Args({
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
            program: prog1
        }));
        bytes32 siblingHash1 = IAqua(AQUA).ship(BONE_DRY_ROUTER, abi.encode(order1), tokens, amounts);
        console.log("Sibling 1 Hash  :", vm.toString(siblingHash1));

        // 2. Sibling 2
        bytes memory prog2 = abi.encodePacked(
            hex"1408", uint64(8453202),
            hex"1100"
        );
        ISwapVM.Order memory order2 = MakerTraitsLib.build(MakerTraitsLib.Args({
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
            program: prog2
        }));
        bytes32 siblingHash2 = IAqua(AQUA).ship(BONE_DRY_ROUTER, abi.encode(order2), tokens, amounts);
        console.log("Sibling 2 Hash  :", vm.toString(siblingHash2));

        // 3. Encumbrance Strategy with 2 siblings
        bytes32[] memory siblingHashes = new bytes32[](2);
        siblingHashes[0] = siblingHash1;
        siblingHashes[1] = siblingHash2;

        uint256 declaredTotalEncumbrance = 3_000_000_000_000_000; // 0.003 WETH = 2 * 0.0015 WETH
        bytes memory encArgs = EncumbranceArgsBuilder.build(declaredTotalEncumbrance, siblingHashes, MAX_UTIL_BPS, WIDEN_BPS);
        bytes memory progEnc = abi.encodePacked(
            hex"1408", uint64(8453203),
            hex"1100",
            uint8(35), uint8(encArgs.length), encArgs
        );
        ISwapVM.Order memory orderEnc = MakerTraitsLib.build(MakerTraitsLib.Args({
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
            program: progEnc
        }));

        bytes32 encStrategyHash = IAqua(AQUA).ship(BONE_DRY_ROUTER, abi.encode(orderEnc), tokens, amounts);
        console.log("Enc Strategy Hash:", vm.toString(encStrategyHash));
        console.log("Declared Total   :", declaredTotalEncumbrance);
        console.log("Max Util Bps     :", MAX_UTIL_BPS);
        console.log("Widen Bps        :", WIDEN_BPS);

        vm.stopBroadcast();
    }
}
