// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test, console} from "forge-std/Test.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {SwapParams} from "v4-core/types/PoolOperation.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";
import {PoolSwapTest} from "v4-core/test/PoolSwapTest.sol";

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
}

/**
 * Does the off-chain router agree with the on-chain hook?
 *
 * They no longer decide the same way. `/api/route` bisects each slice down to
 * what a maker can deliver, batching every candidate into one multicall. `Tap`
 * cannot afford that inside a swap, so it quotes each slice once and drops the
 * maker whose quote exceeds their depth. Two different algorithms, one answer
 * expected — and if they disagree, the number the interface shows a user is not
 * the number the chain will pay them.
 *
 * So this replays the real thing: the exact `hookData` the running API emitted,
 * executed against the real PoolManager on a fork of the chain the API is
 * reading, with the API's own quote as the expectation.
 *
 *   curl '<api>/api/route?amountIn=...' > fixtures/route.json
 *   forge test --match-path test/RouterAgreement.t.sol
 */
contract RouterAgreementTest is Test {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    IPoolManager constant PM = IPoolManager(0x498581fF718922c3f8e6A244956aF099B2652b2b);
    IERC20 constant USDC = IERC20(0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913);
    IERC20 constant WETH = IERC20(0x4200000000000000000000000000000000000006);
    address constant HOOK = 0x4444000000000000000000000000000000000088;
    uint160 constant MAX_SQRT = 1461446703485210103287273052203988822378723970341;

    function test_apiQuoteMatchesWhatTheChainPays() public {
        // The hook and the seeded makers only exist on the chain the API is
        // pointed at, so this forks that same node rather than public Base. When
        // nothing is running there the test has nothing to say — createSelectFork
        // throws on a refused connection, which reads as a failure rather than an
        // absent fixture, so the connection is tried before it is trusted.
        string memory rpc = vm.envOr("LOCAL_RPC_URL", string("http://127.0.0.1:8545"));
        try vm.createSelectFork(rpc) {
            // node is up; carry on
        } catch {
            vm.skip(true);
            return;
        }
        if (HOOK.code.length == 0) {
            // no Bone Dry pool deployed here; nothing to agree about
            vm.skip(true);
            return;
        }

        // Skip rather than fail when the fixture has not been captured: this test
        // documents agreement with a running service, not a property of the code.
        try vm.readFile("fixtures/route.json") returns (string memory blob) {
            uint256 amountIn = vm.parseJsonUint(blob, ".amountIn");
            uint256 quoted = vm.parseJsonUint(blob, ".quotedOut");
            bytes memory hookData = vm.parseJsonBytes(blob, ".hookData");

            PoolKey memory key = PoolKey({
                currency0: Currency.wrap(address(WETH)),
                currency1: Currency.wrap(address(USDC)),
                fee: 0,
                tickSpacing: 60,
                hooks: IHooks(HOOK)
            });

            PoolSwapTest swapRouter = new PoolSwapTest(PM);
            address swapper = address(0xA11CE);
            deal(address(USDC), swapper, amountIn);

            uint256 before = WETH.balanceOf(swapper);
            vm.startPrank(swapper, swapper);
            USDC.approve(address(swapRouter), type(uint256).max);
            swapRouter.swap(
                key,
                SwapParams({
                    zeroForOne: false,
                    amountSpecified: -int256(amountIn),
                    sqrtPriceLimitX96: MAX_SQRT
                }),
                PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
                hookData
            );
            vm.stopPrank();

            uint256 paid = WETH.balanceOf(swapper) - before;
            console.log("api quoted WETH :", quoted);
            console.log("chain paid WETH :", paid);

            assertEq(PM.getLiquidity(key.toId()), 0, "pool held liquidity");
            assertGt(paid, 0, "the API promised a fill and the chain delivered none");

            // The two run different selection algorithms over the same state, so
            // hold them to being within a basis point of each other rather than
            // bit-identical. A wider gap means one of them is choosing wrongly.
            uint256 diff = paid > quoted ? paid - quoted : quoted - paid;
            assertLt(diff * 10_000 / quoted, 1, "api quote and chain payout disagree by >1bp");
        } catch {
            vm.skip(true);
        }
    }
}
