const s = require('@1inch/swap-vm-sdk');
const { Address } = require('@1inch/sdk-core');

const strat = s.AquaXYCAmmStrategy.new();
const program = strat.build();
console.log('program type :', program.constructor.name);
console.log('program proto:', Object.getOwnPropertyNames(Object.getPrototypeOf(program)).join(', '));
try { console.log('program hex  :', String(program)); } catch(e){ console.log('toString err', e.message); }
console.log();
console.log('MakerTraits statics:', Object.getOwnPropertyNames(s.MakerTraits).filter(x=>!['length','name','prototype'].includes(x)).join(', '));
console.log('MakerTraits proto  :', Object.getOwnPropertyNames(s.MakerTraits.prototype).join(', '));
console.log();
console.log('Order statics:', Object.getOwnPropertyNames(s.Order).filter(x=>!['length','name','prototype'].includes(x)).join(', '));
console.log('Order proto  :', Object.getOwnPropertyNames(s.Order.prototype).join(', '));
