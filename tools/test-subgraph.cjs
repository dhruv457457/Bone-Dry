const { createPublicClient, http, fallback, parseAbi } = require('viem');
const { base } = require('viem/chains');

const client = createPublicClient({
  chain: base,
  transport: fallback([
    http('https://developer-access-mainnet.base.org'),
    http('https://base-rpc.publicnode.com'),
    http('https://mainnet.base.org'),
  ]),
});

const erc20Abi = parseAbi([
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address account) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
]);
const aquaAbi = parseAbi([
  'function rawBalances(address maker, address app, bytes32 strategyHash, address token) view returns (uint256, uint8)',
]);

const AQUA = '0x1111113ccf1426a8e30e2bff5e005d929bf6a90a';
const ROUTER = '0x111111338c5091E8440b67B168bAe16a668AC0De';

const q = `{
  strategies(where: { active: true }, first: 1000) {
    strategyHash
    tokens
    maker { id }
  }
}`;

async function main() {
  const r = await fetch('https://api.studio.thegraph.com/query/1758723/aquifer/v0.0.3', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: q }),
  });
  const d = await r.json();
  const strategies = d.data.strategies;

  // Find all unique tokens
  const allTokenAddresses = [...new Set(strategies.flatMap((s) => s.tokens.map((t) => t.toLowerCase())))];
  
  // Resolve symbols
  const symCalls = allTokenAddresses.flatMap((t) => [
    { address: t, abi: erc20Abi, functionName: 'symbol' },
    { address: t, abi: erc20Abi, functionName: 'decimals' },
  ]);
  const symRes = await client.multicall({ contracts: symCalls, allowFailure: true });
  const tokenMeta = {};
  allTokenAddresses.forEach((t, i) => {
    const s = symRes[i * 2];
    const dec = symRes[i * 2 + 1];
    tokenMeta[t] = {
      address: t,
      symbol: s.status === 'success' ? s.result : t.slice(0, 8),
      decimals: dec.status === 'success' ? dec.result : 18,
    };
  });

  // Group strategies by pair
  const pairGroups = {};
  for (const s of strategies) {
    if (!s.tokens || s.tokens.length < 2) continue;
    const sorted = [...s.tokens].map((t) => t.toLowerCase()).sort();
    const key = `${tokenMeta[sorted[0]]?.symbol ?? sorted[0].slice(0, 6)} / ${tokenMeta[sorted[1]]?.symbol ?? sorted[1].slice(0, 6)}`;
    if (!pairGroups[key]) {
      pairGroups[key] = {
        token0: tokenMeta[sorted[0]],
        token1: tokenMeta[sorted[1]],
        strategies: [],
      };
    }
    pairGroups[key].strategies.push(s);
  }

  // Test solvent depth for top pairs
  const testPairs = [
    { name: 'USDC / USDT', t0: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', t1: '0xfde4c96c8593536e31f229ea8f37b2ada2699bb2' },
    { name: 'EURC / USDC', t0: '0x60a3e35cc302bfa44cb288bc5a4f316fdb1adb42', t1: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' },
    { name: 'WETH / USDT', t0: '0x4200000000000000000000000000000000000006', t1: '0xfde4c96c8593536e31f229ea8f37b2ada2699bb2' },
    { name: 'WETH / cbBTC', t0: '0x4200000000000000000000000000000000000006', t1: '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf' },
    { name: 'DAI / USDC', t0: '0x50c5725949a6f0c72e6c4a641f24049a917db0cb', t1: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' },
    { name: 'USDC / cbBTC', t0: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', t1: '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf' },
    { name: 'VIRTUAL / USDC', t0: '0x0b3e328455c4059eeb9e3f84b5543f74e24e7e1b', t1: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' },
    { name: 'cbETH / WETH', t0: '0x2ae3f1ec7f1f5012cfeab0185bfc7aa3cf0dec22', t1: '0x4200000000000000000000000000000000000006' },
  ];

  for (const p of testPairs) {
    const pairStrats = strategies.filter((s) => {
      const toks = s.tokens.map((t) => t.toLowerCase());
      return toks.includes(p.t0) && toks.includes(p.t1);
    });
    if (pairStrats.length === 0) continue;

    // Check depth for t0 and t1
    const calls0 = pairStrats.flatMap((s) => [
      { address: AQUA, abi: aquaAbi, functionName: 'rawBalances', args: [s.maker.id, ROUTER, s.strategyHash, p.t0] },
      { address: p.t0, abi: erc20Abi, functionName: 'balanceOf', args: [s.maker.id] },
      { address: p.t0, abi: erc20Abi, functionName: 'allowance', args: [s.maker.id, AQUA] },
    ]);
    const calls1 = pairStrats.flatMap((s) => [
      { address: AQUA, abi: aquaAbi, functionName: 'rawBalances', args: [s.maker.id, ROUTER, s.strategyHash, p.t1] },
      { address: p.t1, abi: erc20Abi, functionName: 'balanceOf', args: [s.maker.id] },
      { address: p.t1, abi: erc20Abi, functionName: 'allowance', args: [s.maker.id, AQUA] },
    ]);

    const [res0, res1] = await Promise.all([
      client.multicall({ contracts: calls0, allowFailure: true }),
      client.multicall({ contracts: calls1, allowFailure: true }),
    ]);

    let totalDepth0 = 0n;
    let solventMakers0 = 0;
    pairStrats.forEach((s, i) => {
      const raw = res0[i * 3];
      const bal = res0[i * 3 + 1];
      const allw = res0[i * 3 + 2];
      let v = 0n;
      if (raw.status === 'success') {
        const [amt, cnt] = raw.result;
        v = cnt === 0 || cnt === 0xff ? 0n : amt;
      }
      const w = bal.status === 'success' ? bal.result : 0n;
      const a = allw.status === 'success' ? allw.result : 0n;
      const d = v < w ? (v < a ? v : a) : (w < a ? w : a);
      if (d > 0n) {
        solventMakers0++;
        totalDepth0 += d;
      }
    });

    let totalDepth1 = 0n;
    let solventMakers1 = 0;
    pairStrats.forEach((s, i) => {
      const raw = res1[i * 3];
      const bal = res1[i * 3 + 1];
      const allw = res1[i * 3 + 2];
      let v = 0n;
      if (raw.status === 'success') {
        const [amt, cnt] = raw.result;
        v = cnt === 0 || cnt === 0xff ? 0n : amt;
      }
      const w = bal.status === 'success' ? bal.result : 0n;
      const a = allw.status === 'success' ? allw.result : 0n;
      const d = v < w ? (v < a ? v : a) : (w < a ? w : a);
      if (d > 0n) {
        solventMakers1++;
        totalDepth1 += d;
      }
    });

    const m0 = tokenMeta[p.t0];
    const m1 = tokenMeta[p.t1];
    const f0 = (Number(totalDepth0) / 10 ** m0.decimals).toFixed(2);
    const f1 = (Number(totalDepth1) / 10 ** m1.decimals).toFixed(2);

    console.log(`\n=== Pair: ${p.name} (${pairStrats.length} strats) ===`);
    console.log(`  ${m0.symbol} depth: ${f0} (${solventMakers0} solvent makers)`);
    console.log(`  ${m1.symbol} depth: ${f1} (${solventMakers1} solvent makers)`);
  }
}

main().catch(console.error);

