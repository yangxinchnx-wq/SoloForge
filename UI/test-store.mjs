// 精确复制 SurrealStore.ts 的 init 流程
import path from 'path';

(async () => {
  const m = await import('@surrealdb/node');
  const sMod = await import('surrealdb');
  const Surreal = sMod.Surreal || sMod.default;

  const engines = m.createNodeEngines();
  console.log('engines keys:', Object.keys(engines));
  console.log('engines type:', typeof engines);
  console.log('engines.engines:', engines.engines ? Object.keys(engines.engines) : 'n/a');
  console.log('engines methods:');
  for (const k of Object.keys(engines)) {
    console.log('  ', k, typeof engines[k]);
  }

  const db = new Surreal({ engines: engines });
  console.log('db instance created');

  const dbPath = path.join(process.cwd(), 'data', 'canvas_sessions_db').replace(/\\/g, '/');
  console.log('cwd:', process.cwd());
  console.log('dbPath:', dbPath);
  console.log('connect URL:', `rocksdb://${dbPath}`);

  try {
    await db.connect(`rocksdb://${dbPath}`);
    console.log('CONNECTED!');
  } catch (e) {
    console.error('CONNECT FAIL:', e.message);
    console.error(e.stack);
  }
})();
