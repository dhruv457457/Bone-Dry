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
  index: { state: string; head: string; behind: string; ready: boolean } | null;
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
  slices: { maker: string; amountIn: string; depth: string; amountOut: string; oracleDeviationBps: string | null }[];
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

export type CoverageRow = {
  known: boolean;
  maker: string;
  token: string;
  decimals: number;
  activeStrategies: number;
  committed: string;
  wallet: string;
  allowance: string;
  backed: string;
  coverageBps: string;
  shortfall: string;
};

export type CoverageResponse = {
  source: string;
  available?: boolean;
  reason?: string;
  note: string;
  positions: number;
  underCollateralised: number;
  unknown: number;
  onchainCrossCheck: {
    checked: number;
    agreed: number;
    disagreements: number;
    inconclusive: number;
    indexBlock: string;
    chainBlock: string;
    blockSkew: string;
  } | null;
  rows: CoverageRow[];
  error?: string;
};

export type AppRow = {
  app: string;
  isOurs: boolean;
  activeStrategies: number;
  distinctMakers: number;
};

export type AppsResponse = {
  available: boolean;
  reason?: string;
  apps: AppRow[];
  error?: string;
};

export type ExposureSources = {
  commitments: string;
  balances: "token-api" | "rpc" | "none";
  allowances: string;
};

export type ExposurePosition = {
  token: `0x${string}`;
  symbol: string;
  decimals: number;
  claimed: string;
  held: string;
  backed?: string;
  covered: boolean;
};

export type ExposureResponse = {
  available: boolean;
  reason?: string;
  maker: `0x${string}`;
  positions: ExposurePosition[];
  fullyCoveredCount: number;
  totalPositions: number;
  sources?: ExposureSources;
  error?: string;
};

