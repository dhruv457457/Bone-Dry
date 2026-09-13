// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/**
 * Where things live, per chain.
 *
 * Bone Dry runs on two networks that do different jobs. Base mainnet is where
 * the evidence is — real makers, real commitments, and the coverage gap between
 * what they promise and what they hold. Base Sepolia is where anyone can try it,
 * because Aqua has never been deployed to a testnet and we deploy our own.
 *
 * Addresses that differ between them belong here rather than as constants in
 * five scripts, which is how a deploy ends up quoting one chain's pool and
 * settling against another's token.
 */
library Chains {
    uint256 internal constant ETHEREUM = 1;
    uint256 internal constant BASE = 8453;
    uint256 internal constant BASE_SEPOLIA = 84532;

    error UnsupportedChain(uint256 chainId);

    function poolManager() internal view returns (address) {
        if (block.chainid == ETHEREUM) return 0x000000000004444c5dc75cB358380D2e3dE08A90;
        if (block.chainid == BASE) return 0x498581fF718922c3f8e6A244956aF099B2652b2b;
        if (block.chainid == BASE_SEPOLIA) return 0x05E73354cFDd6745C338b50BcFDfA3Aa6fA03408;
        revert UnsupportedChain(block.chainid);
    }

    /// @dev The OP-stack predeploy on Base and Base Sepolia; the original WETH9 on Ethereum.
    function weth() internal view returns (address) {
        if (block.chainid == ETHEREUM) return 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
        return 0x4200000000000000000000000000000000000006;
    }

    /// @dev Circle's USDC. A different deployment on the testnet, not a bridge.
    function usdc() internal view returns (address) {
        if (block.chainid == ETHEREUM) return 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
        if (block.chainid == BASE) return 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
        if (block.chainid == BASE_SEPOLIA) return 0x036CbD53842c5426634e7929541eC2318f3dCF7e;
        revert UnsupportedChain(block.chainid);
    }

    function name() internal view returns (string memory) {
        if (block.chainid == ETHEREUM) return "ethereum";
        if (block.chainid == BASE) return "base";
        if (block.chainid == BASE_SEPOLIA) return "base-sepolia";
        revert UnsupportedChain(block.chainid);
    }

    /**
     * @dev The ordering FLIPS between these two chains, and nothing warns you.
     *
     *      Base mainnet   WETH 0x4200.. < USDC 0x8335..   so WETH is currency0
     *      Base Sepolia   USDC 0x036C.. < WETH 0x4200..   so USDC is currency0
     *      Ethereum       USDC 0xA0b8.. < WETH 0xC02a..   so USDC is currency0
     *
     *      Circle's testnet USDC is a separate deployment at a lower address, so
     *      a pool key written for mainnet is rejected on Sepolia with
     *      CurrenciesOutOfOrderOrEqual — and, worse, `zeroForOne` inverts, so a
     *      hardcoded direction would sell the wrong token. Always sort.
     */
    function currencies() internal view returns (address currency0, address currency1) {
        (address a, address b) = (weth(), usdc());
        return a < b ? (a, b) : (b, a);
    }

    function wethIsCurrency0() internal view returns (bool) {
        return weth() < usdc();
    }
}
