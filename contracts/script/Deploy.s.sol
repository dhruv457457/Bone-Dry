// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console} from "forge-std/Script.sol";
import {Chains} from "./Chains.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {IAqua} from "../src/interfaces/IAqua.sol";
import {ISwapVM} from "../src/interfaces/ISwapVM.sol";
import {Lens} from "../src/Lens.sol";
import {Tap} from "../src/Tap.sol";
import {Wellhead} from "../src/Wellhead.sol";

/**
 * Puts a live Bone Dry pool on the chain the RPC points at.
 *
 * A v4 hook's permissions live in its address, so Tap has to end up at an
 * address whose low bits are BEFORE_SWAP | BEFORE_SWAP_RETURNS_DELTA. On a local
 * fork we get there by deploying once and etching the runtime code — immutables
 * are baked into runtime code, so the etched copy is the same contract. On a
 * real chain this step is replaced by CREATE2 address mining.
 *
 *   forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:8545 --broadcast
 */
interface IExtsload {
    function extsload(bytes32 slot) external view returns (bytes32);
}

contract Deploy is Script {
    address immutable PM = Chains.poolManager();
    address immutable USDC = Chains.usdc();
    address immutable WETH = Chains.weth();


    uint160 constant FLAGS = 0x88; // BEFORE_SWAP | BEFORE_SWAP_RETURNS_DELTA
    // No fixed hook address: it is mined per chain, because the init code
    // embeds the PoolManager and router, which differ between them.

    /// @dev PoolManager._pools lives at slot 6; slot0 is the first word of the state.
    uint256 constant POOLS_SLOT = 6;

    // Nominal. A Bone Dry pool never prices anything — the hook consumes the whole
    // swap and the makers' own curves set the rate — so this only has to be a
    // valid, non-extreme starting point. What is NOT cosmetic is the direction:
    // sqrtPrice is currency1/currency0, and the two chains order those oppositely,
    // so the value has to be inverted on whichever chain puts USDC first.
    uint160 constant SQRT_PRICE = 4543168963294864840402813952; // ~ sqrt(3300e6/1e18) << 96

    /**
     * @dev forge's `new C{salt:}` goes through the deterministic CREATE2 factory
     *      that ships on every OP-stack chain, so the address depends only on the
     *      init code and the salt. Fourteen permission bits means one address in
     *      16,384 fits; a few hundred thousand candidates is plenty of headroom
     *      and costs nothing, because none of this touches the chain.
     */
    uint160 constant FLAG_MASK = 0x3FFF;

    function _mine(bytes memory initCode) internal pure returns (address addr, bytes32 salt) {
        bytes32 initHash = keccak256(initCode);
        for (uint256 i; i < 500_000; ++i) {
            salt = bytes32(i);
            addr = address(
                uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), CREATE2_FACTORY, salt, initHash))))
            );
            if (uint160(addr) & FLAG_MASK == FLAGS) return (addr, salt);
        }
        revert("no salt found");
    }

    function run() external {
        string memory jsonBlob = vm.readFile(string.concat("fixtures/strategy.", vm.toString(block.chainid), ".json"));
        IAqua aqua = IAqua(vm.parseJsonAddress(jsonBlob, ".aqua"));
        ISwapVM router = ISwapVM(vm.parseJsonAddress(jsonBlob, ".router"));

        // Falls back to anvil account 0 — a published test fixture, not a secret.
        uint256 pk = vm.envOr("PRIVATE_KEY", uint256(0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80));

        vm.startBroadcast(pk);
        Lens lens = new Lens(aqua);
        Wellhead wellhead = new Wellhead(IPoolManager(PM));
        vm.stopBroadcast();

        // A v4 hook advertises its permissions through its own address: the low
        // fourteen bits ARE the flag set, so the address cannot be chosen, only
        // mined. Grind a CREATE2 salt until the resulting address carries exactly
        // BEFORE_SWAP | BEFORE_SWAP_RETURNS_DELTA and nothing else — any stray bit
        // would promise the PoolManager a callback this hook does not implement.
        bytes memory initCode =
            abi.encodePacked(type(Tap).creationCode, abi.encode(IPoolManager(PM), router, lens));
        (address hookAddr, bytes32 salt) = _mine(initCode);

        if (hookAddr.code.length == 0) {
            vm.startBroadcast(pk);
            Tap deployed = new Tap{salt: salt}(IPoolManager(PM), router, lens);
            vm.stopBroadcast();
            require(address(deployed) == hookAddr, "mined address did not match");
        }
        address HOOK_ADDR = hookAddr;

        (address c0, address c1) = Chains.currencies();
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(c0),
            currency1: Currency.wrap(c1),
            fee: 0,
            tickSpacing: 60,
            hooks: IHooks(HOOK_ADDR)
        });

        // Re-running this script is normal — the hook changes far more often than
        // the pool does — so initialize only when the pool is not there yet.
        bytes32 poolId = keccak256(abi.encode(key));
        bytes32 stateSlot = keccak256(abi.encode(poolId, uint256(POOLS_SLOT)));
        uint160 sqrtPrice = uint160(uint256(IExtsload(PM).extsload(stateSlot)));

        // 2**192 / p inverts a sqrtX96 price, because (2**96)**2 == 2**192.
        uint160 startPrice =
            Chains.wethIsCurrency0() ? SQRT_PRICE : uint160((1 << 192) / uint256(SQRT_PRICE));

        if (sqrtPrice == 0) {
            vm.startBroadcast(pk);
            IPoolManager(PM).initialize(key, startPrice);
            vm.stopBroadcast();
            console.log("pool initialized");
        } else {
            console.log("pool already live, left alone");
        }

        console.log("lens     ", address(lens));
        console.log("tap      ", HOOK_ADDR);
        console.log("wellhead ", address(wellhead));
    }
}
