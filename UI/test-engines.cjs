const m = require('@surrealdb/node');
console.log('=== @surrealdb/node exports ===');
console.log('keys:', Object.keys(m));
console.log('default keys:', m.default ? Object.keys(m.default) : 'no default');

const engines = m.createNodeEngines || (m.default && m.default.createNodeEngines);
console.log('engines fn:', typeof engines);
const e = engines();
console.log('=== engines instance ===');
console.log('type:', typeof e);
console.log('keys:', Object.keys(e));
for (const k of Object.keys(e)) {
  console.log('  ', k, '=>', typeof e[k]);
}
console.log('=== try to see if rocksdb is registered ===');
console.log('e.engines:', typeof e.engines);
if (e.engines) console.log('  e.engines keys:', Object.keys(e.engines));
