/**
 * Builds UNGATED Aqua XYC strategies for several makers and writes the fixture
 * the Foundry fork tests consume.
 *
 * "Ungated" = the program deliberately omits Controls.onlyTxOriginTokenBalanceNonZero,
 * the KycNFT check the 1inch dApp's assembler attaches to every strategy it ships.
 * Makers are permissionless, so a maker building their own program simply leaves it
 * out — and then any EOA can fill it. That is the basis of Bone Dry.
 */
const fs = require('fs');
const path = require('path');
const { AquaXYCAmmStrategy, Order, MakerTraits, TakerTraits, AQUA_SWAP_VM_CONTRACT_ADDRESSES } = require('@1inch/swap-vm-sdk');
const { AQUA_CONTRACT_ADDRESSES } = require('@1inch/aqua-sdk');
const { Address } = require('@1inch/sdk-core');
const { keccak256 } = require('viem');

const CHAIN = Number(process.env.CHAIN_ID || 8453); // Base

// Anvil's deterministic accounts 0..2 — three independent makers.
const MAKERS = [
  '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
  '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
  '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
];

// The SDK only knows mainnets — sixteen of them, no testnets. On a chain where
// we deployed Aqua ourselves the lookup returns undefined, which stringifies to
// "undefined" and produces strategies pointing at nothing, silently. So an
// override is required rather than optional on any chain the SDK does not know.
const known = (table, name) => {
  const found = table[CHAIN];
  if (found) return String(found);
  throw new Error(
    `no ${name} address for chain ${CHAIN} in the 1inch SDK (it ships mainnets only).
` +
    `Deploy it and pass the address: ${name.toUpperCase()}_ADDRESS=0x... node gen-strategy.cjs`
  );
};

const router = process.env.ROUTER_ADDRESS ?? known(AQUA_SWAP_VM_CONTRACT_ADDRESSES, 'router');
const aqua = process.env.AQUA_ADDRESS ?? known(AQUA_CONTRACT_ADDRESSES, 'aqua');

const program = AquaXYCAmmStrategy.new().build();
const traits = MakerTraits.default().with({ useAquaInsteadOfSignature: true });

const strategies = MAKERS.map((m) => {
  const order = Order.new({ maker: new Address(m), traits, program });
  const strategy = String(order.encode());
  return { maker: m, strategy, strategyHash: keccak256(strategy) };
});

// Plain exact-in Aqua fill.
//  - shouldUnwrap MUST be false: unwrap is incompatible with Aqua
//  - useTransferFromAndAquaPush: router does transferFrom(taker) then AQUA.push(maker)
const takerTraits = TakerTraits.new({
  exactIn: true,
  shouldUnwrap: false,
  strictThreshold: false,
  firstTransferFromTaker: false,
  useTransferFromAndAquaPush: true,
  threshold: 0n,
  deadline: 0n,
});

const out = {
  chainId: CHAIN,
  aqua,
  router,
  programHex: String(program),
  takerTraitsAndData: String(takerTraits.encode()),
  // flattened for Foundry's parseJson, which has no love for arrays of structs
  makers: strategies.map((s) => s.maker),
  strategies: strategies.map((s) => s.strategy),
  strategyHashes: strategies.map((s) => s.strategyHash),
  note: 'Ungated XYC strategies: no onlyTxOriginTokenBalanceNonZero, so no KycNFT is required to fill.',
};

const dir = path.resolve(__dirname, '../contracts/fixtures');
fs.mkdirSync(dir, { recursive: true });
// One fixture per chain. Aqua lives at a different address on every network we
// deploy it to, and a single strategy.json means regenerating for one chain
// silently repoints every test and script at the other one's contracts.
const file = `strategy.${CHAIN}.json`;
fs.writeFileSync(path.join(dir, file), JSON.stringify(out, null, 2));

console.log('chain        :', CHAIN);
console.log('aqua         :', aqua);
console.log('router (app) :', router);
console.log('program      :', out.programHex, '  <- 2 bytes: opcode 0x11 (XYCSwap), 0 args');
console.log('takerTraits  :', out.takerTraitsAndData);
strategies.forEach((s, i) => console.log(`maker[${i}]     : ${s.maker}  hash ${s.strategyHash.slice(0, 18)}...`));
console.log('\nwrote contracts/fixtures/strategy.json');
