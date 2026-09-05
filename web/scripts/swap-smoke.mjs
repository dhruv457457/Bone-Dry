/**
 * The Swap button, without a browser.
 *
 * Sends exactly what the UI sends — the hookData from /api/route, the same
 * argument order, the same 1% floor — from an anvil account that is not a maker
 * and has no special standing. If this lands, the button lands, and a reviewer
 * without a wallet extension can still see the whole path work.
 *
 *   WELLHEAD=0x... node scripts/swap-smoke.mjs 20000000000
 *
 * Check the pool afterwards: it held nothing before the swap and holds nothing
 * after, because the WETH came out of maker wallets and the USDC went into them.
 */
import {
  createWalletClient, createPublicClient, http, parseAbi, formatUnits,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";

const RPC = "http://127.0.0.1:8545";
const WELLHEAD = process.env.WELLHEAD;
const HOOK = "0x4444000000000000000000000000000000000088";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const WETH = "0x4200000000000000000000000000000000000006";

// anvil account 3 — not a maker, just a swapper with no special standing
const account = privateKeyToAccount(
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6"
);

const pub = createPublicClient({ chain: base, transport: http(RPC) });
const wal = createWalletClient({ account, chain: base, transport: http(RPC) });

const erc20 = parseAbi([
  "function approve(address,uint256) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
]);
const wellhead = parseAbi([
  "struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }",
  "function swap(PoolKey key, bool zeroForOne, uint256 amountIn, uint256 minOut, bytes hookData) returns (uint256)",
]);

const amountIn = process.argv[2] ?? "20000000000"; // 20k USDC
const r = await (await fetch(`http://localhost:3000/api/route?amountIn=${amountIn}`)).json();
if (!r.hookData) throw new Error(`no route: ${r.reason ?? r.error}`);

const amount = BigInt(r.amountFilled);
const minOut = (BigInt(r.amountOut) * 99n) / 100n;

console.log("quoted   :", formatUnits(BigInt(r.amountOut), 18), "WETH");
console.log("minOut   :", formatUnits(minOut, 18), "WETH");
console.log("makers   :", r.makersUsed, "of", r.makersConsidered);

// gas money; the USDC is seeded separately, see the README
await fetch(RPC, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "anvil_setBalance",
    params: [account.address, "0x56BC75E2D63100000"],
  }),
});

const before = await pub.readContract({ address: WETH, abi: erc20, functionName: "balanceOf", args: [account.address] });

const ah = await wal.writeContract({
  address: USDC, abi: erc20, functionName: "approve",
  args: [WELLHEAD, (1n << 256n) - 1n],
});
await pub.waitForTransactionReceipt({ hash: ah });

const hash = await wal.writeContract({
  address: WELLHEAD,
  abi: wellhead,
  functionName: "swap",
  args: [
    { currency0: WETH, currency1: USDC, fee: 0, tickSpacing: 60, hooks: HOOK },
    false, // USDC in, so currency1 -> currency0
    amount,
    minOut,
    r.hookData,
  ],
});
const receipt = await pub.waitForTransactionReceipt({ hash });
const after = await pub.readContract({ address: WETH, abi: erc20, functionName: "balanceOf", args: [account.address] });

console.log("status   :", receipt.status);
console.log("gas used :", receipt.gasUsed.toString());
console.log("received :", formatUnits(after - before, 18), "WETH");
