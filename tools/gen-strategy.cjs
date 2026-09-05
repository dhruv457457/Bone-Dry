/**
 * Builds an UNGATED Aqua XYC strategy and writes a fixture for the Foundry fork tests.
 *
 * "Ungated" = the program deliberately omits Controls.onlyTxOriginTokenBalanceNonZero,
 * which is the KycNFT check the 1inch dApp's assembler attaches to every strategy it
 * ships. Makers are permissionless, so a maker who builds their own program can leave
 * it out — and then any EOA can fill it. That is the whole basis of Bone Dry.
 */
const fs = require('fs');
const path = require('path');
const { AquaXYCAmmStrategy, Order, MakerTraits, TakerTraits, AQUA_SWAP_VM_CONTRACT_ADDRESSES } = require('@1inch/swap-vm-sdk');
const { AQUA_CONTRACT_ADDRESSES } = require('@1inch/aqua-sdk');
const { Address } = require('@1inch/sdk-core');
const { keccak256 } = require('viem');

const CHAIN = Number(process.env.CHAIN_ID || 8453);            // Base
const MAKER = process.env.MAKER || '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';

const router = String(AQUA_SWAP_VM_CONTRACT_ADDRESSES[CHAIN]);
const aqua   = String(AQUA_CONTRACT_ADDRESSES[CHAIN]);

const program = AquaXYCAmmStrategy.new().build();
const traits  = MakerTraits.default().with({ useAquaInsteadOfSignature: true });
const order   = Order.new({ maker: new Address(MAKER), traits, program });

const strategy     = String(order.encode());
const strategyHash = keccak256(strategy);

// Taker traits for a plain exact-in Aqua fill.
//  - shouldUnwrap MUST be false: unwrap is incompatible with Aqua
//  - useTransferFromAndAquaPush: router does transferFrom(taker) then AQUA.push(maker)
//  - threshold 0n: no slippage floor, fine for a fork test
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
  maker: MAKER,
  programHex: String(program),
  strategy,
  strategyHash,
  orderHashFromSdk: String(order.hash()),
  takerTraitsAndData: String(takerTraits.encode()),
  note: 'Ungated XYC strategy: no onlyTxOriginTokenBalanceNonZero, so no KycNFT is required to fill.'
};

const dir = path.resolve(__dirname, '../contracts/fixtures');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'strategy.json'), JSON.stringify(out, null, 2));

console.log('chain          :', CHAIN);
console.log('aqua           :', aqua);
console.log('router (app)   :', router);
console.log('maker          :', MAKER);
console.log('program        :', out.programHex, '   <- 2 bytes: opcode 0x11 (XYCSwap), 0 args');
console.log('strategy bytes :', strategy.length - 2, 'hex chars');
console.log('strategyHash   :', strategyHash);
console.log('sdk order.hash :', out.orderHashFromSdk, out.orderHashFromSdk === strategyHash ? '(matches keccak256(strategy))' : '(MISMATCH!)');
console.log('\nwrote contracts/fixtures/strategy.json');
