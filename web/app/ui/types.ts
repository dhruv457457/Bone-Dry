export type MakerRow = {
  maker: string;
  strategyHash: string;
  virtual: string;
  wallet: string;
  allowance: string;
  depth: string;
  solvent: boolean;
  shortfall: string;
};

export type MakersResponse = {
  source: string;
  token: { address: string; symbol: string; decimals: number };
  indexed: number;
  solvent: number;
  totalDepth: string;
  makers: MakerRow[];
  error?: string;
};

export type RouteResponse = {
  source: string;
  tokenIn: { symbol?: string; decimals?: number; address: string };
  tokenOut: { symbol?: string; decimals?: number; address: string };
  amountIn: string;
  amountFilled: string;
  unfilled: string;
  clamped: { maker: string; from: string; to: string }[];
  makersConsidered: number;
  makersUsed: number;
  makersSkipped: string[];
  makersUnfillable: string[];
  slices: { maker: string; amountIn: string; depth: string; amountOut: string }[];
  amountOut: string;
  singleMakerAmountOut: string;
  improvementBps: string;
  hookData: string | null;
  reason?: string;
  error?: string;
};

export type PoolResponse = {
  poolManager: string;
  poolId: string;
  key: { currency0: string; currency1: string; fee: number; tickSpacing: number; hooks: string };
  initialized: boolean;
  liquidity: string;
  boneDry: boolean;
  state: "uninitialized" | "bone-dry" | "conventional";
  note: string;
  error?: string;
};
