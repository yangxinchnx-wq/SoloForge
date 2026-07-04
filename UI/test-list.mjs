import path from 'path';
const start = Date.now();
(async () => {
  const m = await import('@surrealdb/node');
  const sMod = await import('surrealdb');
  const Surreal = sMod.Surreal || sMod.default;
  const db = new Surreal({ engines: m.createNodeEngines() });
  await db.connect(`rocksdb://data/canvas_sessions_db`);
  await db.use({ namespace: 'soloforge_core', database: 'canvas_state' });
  console.log('connected (', Date.now() - start, 'ms)');

  console.log('--- DELETE all rows first ---');
  await db.query('DELETE session_state');

  console.log('--- DEFINE unique index on sessionId ---');
  try {
    await db.query('DEFINE INDEX idx_session_id ON TABLE session_state COLUMNS sessionId UNIQUE');
    console.log('index defined');
  } catch (e) {
    console.log('index def err:', e.message);
  }

  console.log('--- INSERT sess-A 1st time ---');
  const r1 = await db.query('INSERT INTO session_state (sessionId, devices) VALUES ($sid, $dev)', { sid: 'sess-A', dev: [{ x: 1 }] });
  console.log(JSON.stringify(r1, null, 2).slice(0, 1000));

  console.log('--- INSERT sess-A 2nd time (should conflict) ---');
  try {
    const r2 = await db.query('INSERT INTO session_state (sessionId, devices) VALUES ($sid, $dev)', { sid: 'sess-A', dev: [{ x: 2 }] });
    console.log('2nd insert result:', JSON.stringify(r2, null, 2).slice(0, 1000));
  } catch (e) {
    console.log('2nd insert err:', e.message);
  }

  console.log('--- count ---');
  const cnt = await db.query('SELECT count() FROM session_state GROUP ALL');
  console.log(JSON.stringify(cnt, null, 2).slice(0, 500));

  console.log('--- UPDATE WHERE sessionId ---');
  const upd = await db.query('UPDATE session_state SET devices = $dev WHERE sessionId = $sid', { sid: 'sess-A', dev: [{ x: 99 }] });
  console.log('update:', JSON.stringify(upd, null, 2).slice(0, 1000));

  console.log('--- final SELECT ---');
  const all = await db.query('SELECT * FROM session_state');
  console.log(JSON.stringify(all, null, 2).slice(0, 1500));

  await db.close();
})();
