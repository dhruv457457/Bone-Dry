// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console} from "forge-std/Script.sol";
import {IAqua} from "../src/interfaces/IAqua.sol";
import {EncumbranceArgsBuilder} from "../src/vm/Encumbrance.sol";
import {MakerTraitsLib} from "@1inch/swap-vm/libs/MakerTraits.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IAquaBalances {
    function rawBalances(address maker, address app, bytes32 strategyHash, address token)
        external view returns (uint248 balance, uint8 tokensCount);
}

/**
 * Makes our own Base maker honest again, and gives opcode 35 a strategy that can win.
 *
 * Two problems with the book after V2.
 *
 * 1. We were overpromised. V2 left the first set live "as evidence", so the maker
 *    carried six strategies promising 70.7e12 WETH against 38.5e12 held -- 1.83x.
 *    That is the phantom liquidity this project exists to measure, shipped by us.
 *    The V2 encumbrance strategy declared 23.4e12 of sibling commitments when the
 *    true figure was 59.0e12; at the real 153% utilisation it should refuse, and
 *    passed only because its sibling list was incomplete. This docks the three
 *    first-set strategies and the V2 encumbrance strategy.
 *
 * 2. The encumbrance strategy could never fill. It shared its siblings' reserves
 *    and then took its haircut (widenBps 500 x ~60% util = 3.0%), so it quoted 3%
 *    below them and lost every per-maker pick. The first signed fill through the
 *    Bone Dry book (0xba04ad84) pulled from a plain sibling as a result. This one
 *    is priced at 2,350 USDC/WETH against a ~2,521 market -- about 7% tighter --
 *    so it still beats its siblings after the haircut. A maker offering its best
 *    price on the one strategy that cannot overcommit is the economic case for
 *    the instruction; the cost is dust.
 *
 * declaredTotalEncumbrance is read from chain, not assumed: sibling 2 has already
 * been partially pulled, and under-declaring reverts EncumbranceUnderdeclared.
 *
 *   forge script script/ShipEncumbranceBaseV3.s.sol --rpc-url https://mainnet.base.org --broadcast --slow
 */
contract ShipEncumbranceBaseV3 is Script {
    address constant AQUA = 0x1111113CCf1426A8E30e2bfF5E005d929bF6a90a;
    address constant BONE_DRY_ROUTER = 0x74195573Fa9bC965667e03319F2C58567d4B96BE;
    address constant WETH = 0x4200000000000000000000000000000000000006;
    address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;

    uint16 constant MAX_UTIL_BPS = 8000;
    uint16 constant WIDEN_BPS = 500;

    // 0.027495 USDC : 0.0000117 WETH -> 2,350 USDC per WETH.
    uint256 constant USDC_ENC = 27_495;
    uint256 constant WETH_ENC = 11_700_000_000_000;

    bytes32 constant OLD_SIB1 = 0x4b476f3b2efe7896c254aa7f3e5a285c903f103658d45d58a338ba9f32653c8a;
    bytes32 constant OLD_SIB2 = 0x3f7bfe1603e96bece17802e9ab18a5a45f76fac118e96f4ad851ba5aac1f8c46;
    bytes32 constant OLD_ENC  = 0xf5c6d66978bda17d766226b1a7278b4e524bf9d20100901988a1c867945a7ae7;
    bytes32 constant V2_ENC   = 0xa330b560041689b2821313993310521e82ad5a54767d23756a2de9ae20766c64;

    bytes32 constant SIB1 = 0x77f372202e853d401b0af9c977881510f530ed68512594595179747e19964df4;
    bytes32 constant SIB2 = 0x931d3894767bfcc791e1195ea6b7fe358b9544a03a5be319e3b4fef03d7310c2;

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

    function _live(address maker, bytes32 h, address token) internal view returns (uint256) {
        (uint248 bal, uint8 tc) = IAquaBalances(AQUA).rawBalances(maker, BONE_DRY_ROUTER, h, token);
        return (tc == 0 || tc == 0xff) ? 0 : bal;
    }

    function run() external {
        uint256 pk = vm.envUint("MAINNET_PRIVATE_KEY");
        address maker = vm.addr(pk);

        address[] memory tokens = new address[](2);
        tokens[0] = USDC;
        tokens[1] = WETH;

        uint256 sibWeth = _live(maker, SIB1, WETH) + _live(maker, SIB2, WETH);
        uint256 sibUsdc = _live(maker, SIB1, USDC) + _live(maker, SIB2, USDC);

        uint256 heldWeth = IERC20(WETH).balanceOf(maker);
        uint256 heldUsdc = IERC20(USDC).balanceOf(maker);
        uint256 allowWeth = IERC20(WETH).allowance(maker, AQUA);
        uint256 allowUsdc = IERC20(USDC).allowance(maker, AQUA);
        uint256 backingWeth = allowWeth < heldWeth ? allowWeth : heldWeth;
        uint256 backingUsdc = allowUsdc < heldUsdc ? allowUsdc : heldUsdc;

        console.log("siblings WETH  :", sibWeth);
        console.log("backing  WETH  :", backingWeth);

        // After the docks the whole live book is the two siblings plus this one.
        // It must be covered in full -- this is the check V2 skipped by counting
        // only its own set.
        require(sibWeth + WETH_ENC <= backingWeth, "WETH book would exceed backing");
        require(sibUsdc + USDC_ENC <= backingUsdc, "USDC book would exceed backing");
        uint256 util = (sibWeth * 10_000) / backingWeth;
        require(util < MAX_UTIL_BPS, "would refuse at ship time");

        vm.startBroadcast(pk);

        IAqua(AQUA).dock(BONE_DRY_ROUTER, OLD_SIB1, tokens);
        IAqua(AQUA).dock(BONE_DRY_ROUTER, OLD_SIB2, tokens);
        IAqua(AQUA).dock(BONE_DRY_ROUTER, OLD_ENC, tokens);
        IAqua(AQUA).dock(BONE_DRY_ROUTER, V2_ENC, tokens);

        bytes32[] memory siblingHashes = new bytes32[](2);
        siblingHashes[0] = SIB1;
        siblingHashes[1] = SIB2;

        bytes memory encArgs = EncumbranceArgsBuilder.build(sibWeth, siblingHashes, MAX_UTIL_BPS, WIDEN_BPS);
        bytes memory progEnc =
            abi.encodePacked(hex"1408", uint64(8453501), hex"1100", uint8(35), uint8(encArgs.length), encArgs);

        uint256[] memory amounts = new uint256[](2);
        amounts[0] = USDC_ENC;
        amounts[1] = WETH_ENC;

        bytes32 encHash =
            IAqua(AQUA).ship(BONE_DRY_ROUTER, abi.encode(MakerTraitsLib.build(_args(maker, progEnc))), tokens, amounts);

        vm.stopBroadcast();

        console.log("encumbrance    :", vm.toString(encHash));
        console.log("declaredTotal  :", sibWeth);
        console.log("utilBps        :", util);
        console.log("book WETH      :", sibWeth + WETH_ENC);
    }
}
