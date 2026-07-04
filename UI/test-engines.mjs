// 完整流程 + 真正的列表查询
(async () => {
  try {
    const m = await import('@surrealdb/node');
    const sMod = await import('surrealdb');
    const Surreal = sMod.Surreal || sMod.default;
    const { RecordId, StringRecordId } = sMod;

    const engines = m.createNodeEngines();
    const db = new Surreal({ engines: engines });
    await db.connect('rocksdb://data/canvas_test_db3');
    await db.use({ namespace: 'soloforge_core', database: 'canvas_state' });

    // 写入 3 条
    for (let i = 1; i <= 3; i++) {
      const id = new RecordId('session_state', `test-${String(i).padStart(3, '0')}`);
      await db.upsert(id, {
        sessionId: `test-${String(i).padStart(3, '0')}`,
        devices: [{ id: i, name: `device-${i}` }],
        snapshotAt: Date.now(),
      });
    }
    console.log('3 records inserted');

    // 单条 select
    const r1 = await db.select(new RecordId('session_state', 'test-001'));
    console.log('SELECT one:', JSON.stringify(r1));

    // 列表 — 用 query 而非 select
    const allQuery = await db.query('SELECT id, sessionId FROM session_state');
    console.log('SELECT * via query:', JSON.stringify(allQuery));

    const allQuery2 = await db.query('SELECT id FROM session_state');
    console.log('SELECT id only:', JSON.stringify(allQuery2));

    // v2 兼容方式: select('table_name')
    const allSelect = await db.select('session_state');
    console.log('select(table):', JSON.stringify(allSelect));

    // 用 StringRecordId 直接列表
    const allSelect2 = await db.select(new StringRecordId('session_state'));
    console.log('select(StringRecordId(table)):', JSON.stringify(allSelect2));

    await db.close();
    console.log('=== ALL OK ===');
  } catch (err) {
    console.error('FAIL:', err.message);
    console.error(err.stack);
  }
})();
