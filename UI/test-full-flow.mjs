// 完整复制 SurrealStore init 流程 (但用 .mjs 直接跑)
import path from 'path';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

(async () => {
  const startMs = Date.now();
  console.log('1. importing surrealdb...');
  const sMod = await import('surrealdb');
  const Surreal = sMod.Surreal || sMod.default;
  console.log(`  done (${Date.now() - startMs}ms)`);

  console.log('2. importing @surrealdb/node...');
  const m = await import('@surrealdb/node');
  const createNodeEngines = m.createNodeEngines;
  console.log(`  done (${Date.now() - startMs}ms)`);

  console.log('3. calling createNodeEngines()...');
  const engines = createNodeEngines();
  console.log(`  done (${Date.now() - startMs}ms), keys:`, Object.keys(engines));

  console.log('4. new Surreal({engines})...');
  const db = new Surreal({ engines });
  console.log(`  done (${Date.now() - startMs}ms)`);

  const dbPath = path.join(process.cwd(), 'data', 'canvas_sessions_db').replace(/\\/g, '/');
  console.log(`5. db.connect('rocksdb://${dbPath}') ...`);
  await db.connect(`rocksdb://${dbPath}`);
  console.log(`  CONNECTED (${Date.now() - startMs}ms total)`);

  await db.use({ namespace: 'soloforge_core', database: 'canvas_state' });
  console.log(`  USE OK (${Date.now() - startMs}ms total)`);

  await db.close();
  console.log(`=== ALL OK in ${Date.now() - startMs}ms ===`);
})().catch((e) => {
  console.error('FAIL:', e.message);
  console.error(e.stack);
});
