import { createPublicClient, http, type Address } from "viem";
import { base } from "viem/chains";

/**
 * Bone Dry reads chain state directly. Everything here works unchanged against
 * Base mainnet or a local anvil fork of it — only RPC_URL changes.
 */
export const RPC_URL = process.env.RPC_URL ?? "https://mainnet.base.org";

export const client = createPublicClient({ chain: base, transport: http(RPC_URL) });

export const AQUA: Address = "0x1111113ccf1426a8e30e2bff5e005d929bf6a90a";
export const ROUTER: Address = "0x111111338c5091E8440b67B168bAe16a668AC0De";
export const POOL_MANAGER: Address = "0x498581fF718922c3f8e6A244956aF099B2652b2b";

export const USDC: Address = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
export const WETH: Address = "0x4200000000000000000000000000000000000006";

export const TOKENS: Record<string, { address: Address; symbol: string; decimals: number }> = {
  [USDC.toLowerCase()]: { address: USDC, symbol: "USDC", decimals: 6 },
  [WETH.toLowerCase()]: { address: WETH, symbol: "WETH", decimals: 18 },
};

export const aquaAbi = [
  {
    type: "event",
    name: "Shipped",
    inputs: [
      { name: "maker", type: "address" },
      { name: "app", type: "address" },
      { name: "strategyHash", type: "bytes32" },
      { name: "strategy", type: "bytes" },
    ],
  },
  {
    type: "event",
    name: "Docked",
    inputs: [
      { name: "maker", type: "address" },
      { name: "app", type: "address" },
      { name: "strategyHash", type: "bytes32" },
    ],
  },
  {
    type: "function",
    name: "rawBalances",
    stateMutability: "view",
    inputs: [
      { name: "maker", type: "address" },
      { name: "app", type: "address" },
      { name: "strategyHash", type: "bytes32" },
      { name: "token", type: "address" },
    ],
    outputs: [
      { name: "balance", type: "uint248" },
      { name: "tokensCount", type: "uint8" },
    ],
  },
] as const;

export const erc20Abi = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "a", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "o", type: "address" },
      { name: "s", type: "address" },
    ],
    outputs: [{ type: "uint256" }],
  },
] as const;

export const poolManagerAbi = [
  {
    type: "function",
    name: "extsload",
    stateMutability: "view",
    inputs: [{ name: "slot", type: "bytes32" }],
    outputs: [{ type: "bytes32" }],
  },
] as const;
