// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console} from "forge-std/Script.sol";
import {IAqua} from "../src/interfaces/IAqua.sol";
import {Encumbrance, EncumbranceArgsBuilder} from "../src/vm/Encumbrance.sol";
import {MakerTraitsLib} from "@1inch/swap-vm/libs/MakerTraits.sol";
import {ISwapVM} from "@1inch/swap-vm/interfaces/ISwapVM.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IWETH9 {
    function deposit() external payable;
}

interface IFeed {
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80);
}

/**
 * The first Bone Dry book on Ethereum, sized to what the maker actually holds there.
 *
 * The maker has a little ETH and no USDC on Ethereum. So it wraps 0.0001 ETH and
 * ships two strategies to BoneDryRouter, BOTH carrying opcode 35:
 *
 *   A  plain-priced, declared 0          -> fills at util 0, no haircut
 *   B  priced 5% tighter, declares A     -> fills at util 40% with a 2% haircut,
 *                                           and still beats A after it
 *
 * Why both carry opcode 35: each promises some USDC for its price, and this wallet
 * holds none. A plain strategy would advertise that USDC as liquidity it cannot
 * pay -- the phantom this project measures. With opcode 35 the USDC direction
 * refuses on chain with EncumbranceZeroBacking, and only the WETH it does hold is
 * offered. The book stays inside backing: A + B promise 0.00008 WETH against 0.0001.
 *
 * Prices come from Chainlink ETH/USD, so the strategies quote near market.
 * Checked before sending: both WETH quotes succeed, both USDC quotes refuse with
 * EncumbranceZeroBacking, B out-quotes A after its haircut.
 *
 *   forge script script/ShipEthereum.s.sol --rpc-url https://ethereum-rpc.publicnode.com --skip-simulation   # rehearse
 *   forge script script/ShipEthereum.s.sol --rpc-url https://ethereum-rpc.publicnode.com --broadcast --slow
 */
contract ShipEthereum is Script {
    address constant AQUA = 0x1111113CCf1426A8E30e2bfF5E005d929bF6a90a;
    address constant BONE_DRY_ROUTER = 0xF3Da3145B208ebfA94fAd073Ba9C03d6e8746FFE;
    address constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    address constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address constant ETH_USD = 0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419;

    uint256 constant WRAP = 100_000_000_000_000; // 0.0001 ETH
    uint256 constant WETH_EACH = 40_000_000_000_000; // 0.00004 WETH per strategy
    uint16 constant MAX_UTIL_BPS = 8000;
    uint16 constant WIDEN_BPS = 500;
    // Leave this much ETH for gas after wrapping.
    uint256 constant GAS_RESERVE = 50_000_000_000_000; // 0.00005 ETH

    bytes takerTraits = hex"00000000000000000000000000000000000000000041";

    function _order(address maker, uint64 salt, uint256 declared, bytes32[] memory sibs)
        internal
        pure
        returns (ISwapVM.Order memory)
    {
        bytes memory encArgs = EncumbranceArgsBuilder.build(declared, sibs, MAX_UTIL_BPS, WIDEN_BPS);
        bytes memory prog = abi.encodePacked(hex"1408", salt, hex"1100", uint8(35), uint8(encArgs.length), encArgs);
        return MakerTraitsLib.build(
            MakerTraitsLib.Args({
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
                program: prog
            })
        );
    }

    function _ship(bytes memory strategy, uint256 usdcAmt) internal returns (bytes32) {
        address[] memory tokens = new address[](2);
        tokens[0] = USDC;
        tokens[1] = WETH;
        uint256[] memory amounts = new uint256[](2);
        amounts[0] = usdcAmt;
        amounts[1] = WETH_EACH;
        return IAqua(AQUA).ship(BONE_DRY_ROUTER, strategy, tokens, amounts);
    }

    function run() external {
        require(block.chainid == 1, "Ethereum mainnet only");
        uint256 pk = vm.envUint("MAINNET_PRIVATE_KEY");
        address maker = vm.addr(pk);

        (, int256 answer,, uint256 updatedAt,) = IFeed(ETH_USD).latestRoundData();
        require(answer > 0 && block.timestamp - updatedAt < 6 hours, "stale ETH/USD feed");
        // USDC units for WETH_EACH wei at the oracle price: wei * price(8dp) * 1e6 / (1e18 * 1e8)
        uint256 usdcA = (WETH_EACH * uint256(answer)) / 1e20;
        uint256 usdcB = (usdcA * 95) / 100; // cheaper WETH, so B wins the pick after its haircut
        require(usdcB > 0, "sizes too small to price");

        uint256 heldWeth = IERC20(WETH).balanceOf(maker);
        uint256 wrap = heldWeth >= 2 * WETH_EACH ? 0 : WRAP;
        require(maker.balance >= wrap + GAS_RESERVE, "not enough ETH to wrap and still pay gas");

        console.log("maker        ", maker);
        console.log("ETH/USD      ", uint256(answer));
        console.log("USDC for A   ", usdcA);
        console.log("USDC for B   ", usdcB);

        bytes memory aBytes = abi.encode(_order(maker, 1_000_001, 0, new bytes32[](0)));
        bytes32 aHash = keccak256(aBytes);
        bytes32[] memory sibs = new bytes32[](1);
        sibs[0] = aHash;
        bytes memory bBytes = abi.encode(_order(maker, 1_000_002, WETH_EACH, sibs));

        vm.startBroadcast(pk);
        if (wrap > 0) IWETH9(WETH).deposit{value: wrap}();
        if (IERC20(WETH).allowance(maker, AQUA) < 2 * WETH_EACH) IERC20(WETH).approve(AQUA, WRAP);
        require(_ship(aBytes, usdcA) == aHash, "A hash mismatch");
        bytes32 bHash = _ship(bBytes, usdcB);
        vm.stopBroadcast();

        uint256 backing = IERC20(WETH).balanceOf(maker);
        uint256 allowance = IERC20(WETH).allowance(maker, AQUA);
        if (allowance < backing) backing = allowance;
        require(2 * WETH_EACH <= backing, "book would exceed backing");

        // --- what the chain will now say ---
        ISwapVM.Order memory a = abi.decode(aBytes, (ISwapVM.Order));
        ISwapVM.Order memory b = abi.decode(bBytes, (ISwapVM.Order));
        uint256 probe = usdcA / 10; // a tenth of A's reserve
        (, uint256 outA,) = ISwapVM(BONE_DRY_ROUTER).quote(a, USDC, WETH, probe, takerTraits);
        (, uint256 outB,) = ISwapVM(BONE_DRY_ROUTER).quote(b, USDC, WETH, probe, takerTraits);
        require(outA > 0 && outB > 0, "a WETH quote failed");
        require(outB > outA, "B does not beat A after its haircut");

        _expectZeroBacking(a);
        _expectZeroBacking(b);

        console.log("strategy A   ", vm.toString(aHash));
        console.log("strategy B   ", vm.toString(bHash));
        console.log("backing WETH ", backing);
        console.log("probe USDC   ", probe);
        console.log("A quotes WETH", outA);
        console.log("B quotes WETH", outB);
        console.log("B util bps   ", (WETH_EACH * 10_000) / backing);
    }

    function _expectZeroBacking(ISwapVM.Order memory o) internal view {
        try ISwapVM(BONE_DRY_ROUTER).quote(o, WETH, USDC, 1_000_000_000, takerTraits) returns (uint256, uint256, bytes32) {
            revert("USDC direction quoted, but this wallet holds no USDC");
        } catch (bytes memory reason) {
            require(
                reason.length >= 4 && bytes4(reason) == Encumbrance.EncumbranceZeroBacking.selector,
                "USDC direction refused for the wrong reason"
            );
        }
    }
}
