// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test, console} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ISwapVM} from "@1inch/swap-vm/interfaces/ISwapVM.sol";
import {MakerTraitsLib} from "@1inch/swap-vm/libs/MakerTraits.sol";
import {Encumbrance, EncumbranceArgsBuilder} from "../src/vm/Encumbrance.sol";
import {Tap} from "../src/Tap.sol";
import {Wellhead} from "../src/Wellhead.sol";

/**
 * A swap through the LIVE Ethereum deployment, against the LIVE strategies.
 *
 * Nothing is deployed or shipped here: the hook, Wellhead, BoneDryRouter and both
 * strategies are the ones on Ethereum mainnet (deployments/ethereum.json). The only
 * simulated thing is the taker's USDC, because no wallet in this repo holds USDC on
 * Ethereum. Everything the swap touches after that is real mainnet state.
 *
 *   forge test --match-contract EthereumLive -vv      (forks Ethereum itself; ETHEREUM_RPC_URL overrides the RPC)
 */
contract EthereumLiveTest is Test {
    address constant AQUA = 0x1111113CCf1426A8E30e2bfF5E005d929bF6a90a;
    address constant ROUTER = 0xF3Da3145B208ebfA94fAd073Ba9C03d6e8746FFE;
    address constant TAP = 0xe64823e2298dFa1EF2C6652FaCBB301beE360088;
    address constant TAP_LEGACY = 0x3Bb143CD171A1959927C6cc201707E85d2b78088;
    address constant WELLHEAD = 0xE859BBaEd41d1c88C9BD6Da1104b16a46DD9a32D;
    address constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    address constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address constant MAKER = 0x60b9FcAFCdDeAEd79b5B5486c036Fe03BE8B075f;

    bytes32 constant A_HASH = 0xf45fd232d6e78e2ccffd1fde959ecadf9983eec7084f1662f2e48e640452ae11;
    bytes32 constant B_HASH = 0x0809ca840aba51ebffbdf80cdffb867b6beeecb91ac366e3fda5ef9a7abce3a5;
    uint256 constant WETH_EACH = 40_000_000_000_000;

    bytes takerTraits = hex"00000000000000000000000000000000000000000041";
    address taker = makeAddr("taker");

    function _order(uint64 salt, uint256 declared, bytes32[] memory sibs) internal pure returns (bytes memory) {
        bytes memory encArgs = EncumbranceArgsBuilder.build(declared, sibs, 8000, 500);
        bytes memory prog = abi.encodePacked(hex"1408", salt, hex"1100", uint8(35), uint8(encArgs.length), encArgs);
        return abi.encode(
            MakerTraitsLib.build(
                MakerTraitsLib.Args({
                    maker: MAKER,
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
                    program: prog
                })
            )
        );
    }

    function _key() internal pure returns (PoolKey memory) {
        return PoolKey({currency0: Currency.wrap(USDC), currency1: Currency.wrap(WETH), fee: 0, tickSpacing: 60, hooks: IHooks(TAP)});
    }

    function _strategies() internal pure returns (bytes[] memory strategies) {
        bytes32[] memory sibs = new bytes32[](1);
        sibs[0] = A_HASH;
        strategies = new bytes[](2);
        strategies[0] = _order(1_000_002, WETH_EACH, sibs); // B
        strategies[1] = _order(1_000_001, 0, new bytes32[](0)); // A
        require(keccak256(strategies[0]) == B_HASH && keccak256(strategies[1]) == A_HASH, "rebuilt orders do not match the live strategies");
    }

    function setUp() public {
        vm.createSelectFork(vm.envOr("ETHEREUM_RPC_URL", string("https://ethereum-rpc.publicnode.com")));
        require(TAP.code.length > 0 && ROUTER.code.length > 0, "live deployment not found");
    }

    function test_swapUsdcForWeth_throughLiveHook_fillsWithOpcode35() public {
        bytes[] memory strategies = _strategies();
        uint256 sell = 20_000; // 0.02 USDC
        deal(USDC, taker, sell);

        uint256 makerWethBefore = IERC20(WETH).balanceOf(MAKER);
        vm.recordLogs();
        vm.startPrank(taker);
        IERC20(USDC).approve(WELLHEAD, sell);
        uint256 got = Wellhead(WELLHEAD).swap(
            _key(), true, sell, 1, abi.encode(Tap.TapData({strategies: strategies, takerTraits: takerTraits}))
        );
        vm.stopPrank();

        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 appliedTopic =
            keccak256("EncumbranceApplied(address,bytes32,address,uint256,uint256,uint256,bool,uint256,uint256)");
        bytes32 filledTopic = keccak256("Filled(address,uint256,uint256)");
        uint256 applied;
        uint256 fills;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics.length == 0) continue;
            if (logs[i].emitter == ROUTER && logs[i].topics[0] == appliedTopic) {
                (uint256 encumbered, uint256 backing, uint256 utilBps,, uint256 from, uint256 to) =
                    abi.decode(logs[i].data, (uint256, uint256, uint256, bool, uint256, uint256));
                console.log("EncumbranceApplied util bps", utilBps);
                console.log("  encumbered / backing     ", encumbered, backing);
                console.log("  amountOut before / after ", from, to);
                ++applied;
            }
            if (logs[i].emitter == TAP && logs[i].topics[0] == filledTopic) ++fills;
        }

        console.log("sold USDC units", sell);
        console.log("got WETH wei   ", got);
        assertGt(got, 0, "taker received no WETH");
        assertEq(IERC20(USDC).balanceOf(taker), 0, "input not fully consumed");
        assertEq(makerWethBefore - IERC20(WETH).balanceOf(MAKER), got, "WETH did not come from the maker's wallet");
        assertGt(applied, 0, "opcode 35 did not run in the fill");
        assertGt(fills, 0, "hook recorded no fill");
    }

    function test_swapWethForUsdc_throughLiveHook_refusesZeroBacking() public {
        bytes[] memory strategies = _strategies();
        uint256 sell = 1_000_000_000; // 1 gwei of WETH
        deal(WETH, taker, sell);

        vm.recordLogs();
        vm.startPrank(taker);
        IERC20(WETH).approve(WELLHEAD, sell);
        // The maker holds no USDC, so opcode 35 refuses both strategies and the
        // hook has nobody left: the swap reverts instead of paying phantom USDC.
        vm.expectRevert();
        Wellhead(WELLHEAD).swap(
            _key(), false, sell, 1, abi.encode(Tap.TapData({strategies: strategies, takerTraits: takerTraits}))
        );
        vm.stopPrank();

        // And the refusal reason, read straight from the router.
        try ISwapVM(ROUTER).quote(abi.decode(strategies[0], (ISwapVM.Order)), WETH, USDC, sell, takerTraits) returns (
            uint256, uint256, bytes32
        ) {
            revert("quoted USDC the maker does not hold");
        } catch (bytes memory reason) {
            assertEq(bytes4(reason), Encumbrance.EncumbranceZeroBacking.selector, "wrong refusal reason");
        }
    }

    /// Replays a route the app's /api/route produced for Ethereum's 1inch book --
    /// real third-party makers -- through the live tapLegacy hook. Skipped unless
    /// ROUTE_HOOKDATA and ROUTE_AMOUNT are set, since the maker list is a snapshot.
    function test_replayAppRoute_throughLegacyHook() public {
        bytes memory hookData = vm.envOr("ROUTE_HOOKDATA", bytes(""));
        uint256 amount = vm.envOr("ROUTE_AMOUNT", uint256(0));
        if (hookData.length == 0 || amount == 0) {
            vm.skip(true);
            return;
        }
        deal(USDC, taker, amount);
        vm.startPrank(taker);
        IERC20(USDC).approve(WELLHEAD, amount);
        PoolKey memory key =
            PoolKey({currency0: Currency.wrap(USDC), currency1: Currency.wrap(WETH), fee: 0, tickSpacing: 60, hooks: IHooks(TAP_LEGACY)});
        uint256 got = Wellhead(WELLHEAD).swap(key, true, amount, 1, hookData);
        vm.stopPrank();
        console.log("1inch book on Ethereum: sold USDC units", amount);
        console.log("got WETH wei                           ", got);
        assertGt(got, 0);
    }
}
