// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console} from "forge-std/Script.sol";
import {Vm, VmSafe} from "forge-std/Vm.sol";
import {StdCheats} from "forge-std/StdCheats.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {IAqua} from "../src/interfaces/IAqua.sol";
import {Encumbrance, EncumbranceArgsBuilder} from "../src/vm/Encumbrance.sol";
import {MakerTraitsLib} from "@1inch/swap-vm/libs/MakerTraits.sol";
import {ISwapVM} from "@1inch/swap-vm/interfaces/ISwapVM.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Chains} from "./Chains.sol";
import {Tap} from "../src/Tap.sol";
import {Wellhead} from "../src/Wellhead.sol";

interface IAquaBalances {
    function rawBalances(address maker, address app, bytes32 strategyHash, address token)
        external view returns (uint248 balance, uint8 tokensCount);
}

/**
 * The first refusal on mainnet: one swap in which opcode 35 turns a maker away
 * and the Tap hook fills from someone else instead.
 *
 * Until now no MakerSkipped had ever been emitted on Base. That was partly by
 * design -- the app drops any maker whose quote would revert before it builds
 * the transaction, so the hook never meets a refusing strategy through the UI.
 * This script hands the hook one on purpose.
 *
 * The refusing strategy is not rigged. It declares the maker's real live WETH
 * book -- the two plain siblings plus the V3 opcode-35 strategy, read from
 * chain and sampled on-chain, so it cannot under-declare -- against the real
 * min(balance, allowance). That book is ~90% of backing, and the strategy's
 * ceiling is 80%, so it refuses: this wallet is already too committed for it to
 * promise more. It is also small enough that shipping it keeps the whole book
 * inside backing. Nothing here is overpromised; the refusal is the policy, not
 * insolvency.
 *
 * One transaction then routes a USDC -> WETH swap through Wellhead with both
 * strategies in hookData:
 *
 *   refusing strategy  -> router.quote reverts EncumbranceExceeded (0x831f3352)
 *                      -> Tap emits MakerSkipped(maker, hash, WETH, slice, 0x831f3352)
 *   V3 strategy        -> fills its own slice, then sweeps the skipped one
 *                      -> EncumbranceApplied + Filled
 *
 * Everything is checked in simulation before anything is sent: the V3 order is
 * rebuilt and must hash to the live strategy, the new strategy's quote must
 * revert with exactly that selector, and the swap's logs must contain the
 * MakerSkipped. If any check fails the script reverts and broadcasts nothing.
 *
 * The taker defaults to the maker wallet, the only funded mainnet key here, which
 * makes the swap a self-trade: the WETH the hook pulls from the maker is paid
 * straight back to it. That changes nothing about the path under test -- the
 * hook, the router, opcode 35 and every event run exactly as for a stranger, and
 * Wellhead's Swapped event still reports the fill from the pool delta -- but
 * Wellhead's minOut is measured as the swapper's balance delta, which nets to
 * zero, so a self-trade has to pass minOut = 0. Nothing is at risk in doing so:
 * both sides of the trade are the same wallet. Set TAKER_PRIVATE_KEY to take from
 * a different wallet, and minOut goes back to 90% of the quote.
 *
 *   forge script script/RefusalBase.s.sol --rpc-url https://mainnet.base.org --skip-simulation   # rehearse
 *   forge script script/RefusalBase.s.sol --rpc-url https://mainnet.base.org --broadcast --slow
 */
contract RefusalBase is Script, StdCheats {
    address constant AQUA = 0x1111113CCf1426A8E30e2bfF5E005d929bF6a90a;
    address constant BONE_DRY_ROUTER = 0x74195573Fa9bC965667e03319F2C58567d4B96BE;
    address constant TAP = 0xaC7bCA41EA8Fce76651684943Db2c38003c98088;
    address payable constant WELLHEAD = payable(0xae0188F3b68804847a740C0F7016e1A4E0bB4E64);

    bytes32 constant SIB1 = 0x77f372202e853d401b0af9c977881510f530ed68512594595179747e19964df4;
    bytes32 constant SIB2 = 0x931d3894767bfcc791e1195ea6b7fe358b9544a03a5be319e3b4fef03d7310c2;
    bytes32 constant V3_ENC = 0x8442bb0dca83e43a6d0a4cfa12d98454673b8e692bc1557e58fc232ee296c33e;

    // The V3 strategy exactly as ShipEncumbranceBaseV3 shipped it.
    uint256 constant V3_DECLARED = 23_017_121_539_368;
    uint256 constant V3_USDC = 27_495;
    uint256 constant V3_WETH = 11_700_000_000_000;

    uint16 constant REFUSE_MAX_UTIL_BPS = 8000;
    uint16 constant REFUSE_WIDEN_BPS = 500;
    // 0.0047 USDC : 0.000002 WETH, the same 2,350 price as V3. Small on purpose:
    // the live book plus this must still fit inside backing.
    uint256 constant REFUSE_USDC = 4_700;
    uint256 constant REFUSE_WETH = 2_000_000_000_000;
    uint64 constant REFUSE_SALT = 8453601;

    bytes takerTraits = hex"00000000000000000000000000000000000000000041";

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

    function _order(address maker, uint64 salt, uint256 declared, bytes32[] memory sibs, uint16 maxUtil, uint16 widen)
        internal
        pure
        returns (ISwapVM.Order memory)
    {
        bytes memory encArgs = EncumbranceArgsBuilder.build(declared, sibs, maxUtil, widen);
        bytes memory prog =
            abi.encodePacked(hex"1408", salt, hex"1100", uint8(35), uint8(encArgs.length), encArgs);
        return MakerTraitsLib.build(_args(maker, prog));
    }

    function _live(address maker, bytes32 h, address token) internal view returns (uint256) {
        (uint248 bal, uint8 tc) = IAquaBalances(AQUA).rawBalances(maker, BONE_DRY_ROUTER, h, token);
        return (tc == 0 || tc == 0xff) ? 0 : bal;
    }

    function run() external {
        uint256 makerPk = vm.envUint("MAINNET_PRIVATE_KEY");
        uint256 takerPk = vm.envOr("TAKER_PRIVATE_KEY", makerPk);
        uint256 sell = vm.envOr("SELL", uint256(2_000)); // 0.002 USDC
        address maker = vm.addr(makerPk);
        address taker = vm.addr(takerPk);
        bool selfTrade = taker == maker;
        address usdc = Chains.usdc();
        address weth = Chains.weth();

        // Rehearsal only: funds the taker in the local fork. Refused when broadcasting,
        // so a dealt balance can never stand in for a real one on chain.
        if (vm.envOr("SIM_FUND", false)) {
            require(!vm.isContext(VmSafe.ForgeContext.ScriptBroadcast), "SIM_FUND is for simulation only");
            vm.deal(taker, 0.001 ether);
            deal(usdc, taker, sell);
        }

        // --- the healthy side: rebuild V3 and prove it is the live strategy ---
        bytes32[] memory v3Sibs = new bytes32[](2);
        v3Sibs[0] = SIB1;
        v3Sibs[1] = SIB2;
        bytes memory v3Bytes = abi.encode(_order(maker, 8453501, V3_DECLARED, v3Sibs, 8000, 500));
        require(keccak256(v3Bytes) == V3_ENC, "rebuilt V3 order does not hash to the live strategy");
        require(_live(maker, V3_ENC, weth) > 0, "V3 strategy is not live");

        // --- the refusing side: declare the real book, sampled on chain ---
        bytes32[] memory book = new bytes32[](3);
        book[0] = SIB1;
        book[1] = SIB2;
        book[2] = V3_ENC;
        uint256 declared = _live(maker, SIB1, weth) + _live(maker, SIB2, weth) + _live(maker, V3_ENC, weth);

        uint256 held = IERC20(weth).balanceOf(maker);
        uint256 allowed = IERC20(weth).allowance(maker, AQUA);
        uint256 backing = allowed < held ? allowed : held;
        uint256 util = (declared * 10_000) / backing;

        console.log("maker            :", maker);
        console.log("taker            :", taker);
        console.log("live book WETH   :", declared);
        console.log("backing WETH     :", backing);
        console.log("util bps         :", util);
        console.log("ceiling bps      :", uint256(REFUSE_MAX_UTIL_BPS));

        require(util >= REFUSE_MAX_UTIL_BPS, "book is under the ceiling: the strategy would not refuse");
        require(declared + REFUSE_WETH <= backing, "shipping would overpromise the maker");

        bytes memory refuseBytes =
            abi.encode(_order(maker, REFUSE_SALT, declared, book, REFUSE_MAX_UTIL_BPS, REFUSE_WIDEN_BPS));
        bytes32 refuseHash = keccak256(refuseBytes);
        bool alreadyShipped = _live(maker, refuseHash, weth) > 0;

        (address c0, address c1) = Chains.currencies();
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(c0),
            currency1: Currency.wrap(c1),
            fee: 0,
            tickSpacing: 60,
            hooks: IHooks(TAP)
        });
        bool zeroForOne = !Chains.wethIsCurrency0(); // selling USDC

        // Refusing strategy first, so its refusal leads the log.
        bytes[] memory strategies = new bytes[](2);
        strategies[0] = refuseBytes;
        strategies[1] = v3Bytes;
        bytes memory hookData = abi.encode(Tap.TapData({strategies: strategies, takerTraits: takerTraits}));

        // --- 1. ship (maker) ---
        if (!alreadyShipped) {
            address[] memory tokens = new address[](2);
            tokens[0] = usdc;
            tokens[1] = weth;
            uint256[] memory amounts = new uint256[](2);
            amounts[0] = REFUSE_USDC;
            amounts[1] = REFUSE_WETH;

            vm.startBroadcast(makerPk);
            bytes32 shipped = IAqua(AQUA).ship(BONE_DRY_ROUTER, refuseBytes, tokens, amounts);
            vm.stopBroadcast();
            require(shipped == refuseHash, "shipped hash mismatch");
        } else {
            console.log("refusing strategy already live, not re-shipping");
        }

        // The refusal, observed before any swap is sent.
        try ISwapVM(BONE_DRY_ROUTER).quote(abi.decode(refuseBytes, (ISwapVM.Order)), usdc, weth, sell / 2, takerTraits)
        returns (uint256, uint256, bytes32) {
            revert("refusing strategy quoted instead of refusing");
        } catch (bytes memory reason) {
            require(reason.length >= 4 && bytes4(reason) == Encumbrance.EncumbranceExceeded.selector, "wrong refusal reason");
        }

        (, uint256 v3Out,) = ISwapVM(BONE_DRY_ROUTER).quote(abi.decode(v3Bytes, (ISwapVM.Order)), usdc, weth, sell, takerTraits);
        require(v3Out > 0, "V3 quotes zero for this size");
        // A self-trade nets to zero in the swapper's balance, which is what minOut is checked against.
        uint256 minOut = selfTrade ? 0 : (v3Out * 90) / 100;

        // --- 2. swap (taker) ---
        uint256 before = IERC20(weth).balanceOf(taker);
        vm.recordLogs();
        vm.startBroadcast(takerPk);
        if (IERC20(usdc).allowance(taker, WELLHEAD) < sell) IERC20(usdc).approve(WELLHEAD, sell);
        uint256 got = Wellhead(WELLHEAD).swap(key, zeroForOne, sell, minOut, hookData);
        vm.stopBroadcast();

        // --- 3. the logs must say what we claim ---
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 skippedTopic = keccak256("MakerSkipped(address,bytes32,address,uint256,bytes4)");
        bytes32 filledTopic = keccak256("Filled(address,uint256,uint256)");
        bytes32 appliedTopic =
            keccak256("EncumbranceApplied(address,bytes32,address,uint256,uint256,uint256,bool,uint256,uint256)");
        bytes32 swappedTopic = keccak256("Swapped(address,address,address,uint256,uint256)");
        uint256 swappedOut;
        bool skipped;
        bool applied;
        uint256 fills;
        for (uint256 i; i < logs.length; ++i) {
            Vm.Log memory l = logs[i];
            if (l.topics.length == 0) continue;
            if (l.emitter == TAP && l.topics[0] == skippedTopic && l.topics[2] == refuseHash) {
                (uint256 wanted, bytes4 reason) = abi.decode(l.data, (uint256, bytes4));
                console.log("MakerSkipped wanted :", wanted);
                console.logBytes4(reason);
                if (reason == Encumbrance.EncumbranceExceeded.selector) skipped = true;
            }
            if (l.emitter == TAP && l.topics[0] == filledTopic) ++fills;
            if (l.emitter == WELLHEAD && l.topics[0] == swappedTopic) (, swappedOut) = abi.decode(l.data, (uint256, uint256));
            if (l.emitter == BONE_DRY_ROUTER && l.topics[0] == appliedTopic && l.topics[2] == V3_ENC) applied = true;
        }
        require(skipped, "no MakerSkipped with EncumbranceExceeded in the swap");
        require(fills > 0, "no Filled in the swap");

        console.log("refusing strategy:", vm.toString(refuseHash));
        console.log("sold USDC        :", sell);
        console.log("self-trade       :", selfTrade);
        console.log("Swapped amountOut:", swappedOut);
        console.log("balance delta    :", got);
        require(swappedOut > 0, "Swapped reported no output");
        before;
        console.log("Filled events    :", fills);
        console.log("V3 EncumbranceApplied:", applied);
    }
}
