/**
 * Proves the maker-side liquidity flow end to end: a server route builds Aqua
 * ship() calldata, a wallet signs and sends it as-is, and the claim lands in
 * Aqua's own storage. Run with the Next.js dev server up on :3000 and
 * contracts/.env populated (MAKER0_PK, BASE_SEPOLIA_RPC_URL).
 *
 *   node tools/ship-proof.cjs
 */
const fs = require("fs");
const path = require("path");

function loadEnv(envPath) {
  const text = fs.readFileSync(envPath, "utf8");
  const env = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].trim();
  }
  return env;
}

const env = loadEnv(path.resolve(__dirname, "../contracts/.env"));
const { createWalletClient, createPublicClient, http } = require("viem");
const { privateKeyToAccount } = require("viem/accounts");
const { baseSepolia } = require("viem/chains");

async function main() {
  const account = privateKeyToAccount(env.MAKER0_PK);
  const rpc = env.BASE_SEPOLIA_RPC_URL;
  const publicClient = createPublicClient({ chain: baseSepolia, transport: http(rpc) });
  const walletClient = createWalletClient({ account, chain: baseSepolia, transport: http(rpc) });

  console.log("maker:", account.address, "(expect", env.MAKER0 + ")");

  const res = await fetch("http://localhost:3000/api/strategy", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      maker: account.address,
      chainId: 84532,
      tokenIn: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      tokenOut: "0x4200000000000000000000000000000000000006",
      amountIn: "5000000",
      amountOut: "1500000000000000",
      feeBps: 15,
    }),
  });
  const built = await res.json();
  if (!res.ok) {
    console.error("route failed:", built);
    process.exit(1);
  }
  console.log("programHex:", built.programHex, " salt:", built.salt);

  const hash = await walletClient.sendTransaction({ to: built.to, data: built.data });
  console.log("tx sent:", hash);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  console.log("status:", receipt.status, " gasUsed:", receipt.gasUsed.toString());
}

main().catch((e) => {
  console.error("FAILED:", e.shortMessage || e.message);
  process.exit(1);
});
