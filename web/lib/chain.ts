/**
 * ABIs only.
 *
 * Every address, RPC client and pool key used to live here as a module constant,
 * which was correct while Bone Dry spoke to one chain. They are in networks.ts
 * now, keyed by network — and they are not re-exported from here, because a
 * single POOL_KEY or CHAIN_ID left lying about is how the currency ordering and
 * the wrong-chain check silently went back to assuming Base.
 */
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
    name: "symbol",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "string" }],
  },
  {
    type: "function",
    name: "name",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "string" }],
  },
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint8" }],
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
export const wellheadAbi = [
  {
    type: "function",
    name: "swap",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "key",
        type: "tuple",
        components: [
          { name: "currency0", type: "address" },
          { name: "currency1", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "tickSpacing", type: "int24" },
          { name: "hooks", type: "address" },
        ],
      },
      { name: "zeroForOne", type: "bool" },
      { name: "amountIn", type: "uint256" },
      { name: "minOut", type: "uint256" },
      { name: "hookData", type: "bytes" },
    ],
    outputs: [{ name: "amountOut", type: "uint256" }],
  },
  {
    type: "event",
    name: "Swapped",
    inputs: [
      { name: "swapper", type: "address", indexed: true },
      { name: "tokenIn", type: "address", indexed: true },
      { name: "tokenOut", type: "address", indexed: true },
      { name: "amountIn", type: "uint256", indexed: false },
      { name: "amountOut", type: "uint256", indexed: false },
    ],
  },
] as const;
export const erc20WriteAbi = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
] as const;
export const lensAbi = [
  {
    type: "function",
    name: "coverage",
    stateMutability: "view",
    inputs: [
      { name: "maker", type: "address" },
      { name: "app", type: "address" },
      { name: "strategyHashes", type: "bytes32[]" },
      { name: "token", type: "address" },
    ],
    outputs: [
      { name: "committed", type: "uint256" },
      { name: "backing", type: "uint256" },
      { name: "coverageBps", type: "uint256" },
    ],
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

/** Just the one immutable getter the UI needs to display, rather than trust
 *  a copy of it typed into a component. */
export const beaconStrategyAbi = [
  {
    type: "function",
    name: "spreadBps",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
] as const;
