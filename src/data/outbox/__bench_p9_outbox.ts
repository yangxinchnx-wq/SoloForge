/**
 * P9 Outbox 模式 canary 测试
 * Path: src/data/outbox/__bench_p9_outbox.ts
 * Date: 2026-06-30
 *
 * 模拟:
 *   1. 30 条业务消息 enqueue 进 outbox_sync
 *   2. handler 故意失败 3 次 (网络抖动) 后恢复
 *   3. 1 条消息永远失败 → 验 DLQ
 *   4. 全程 0 丢失
 *
 * 用法:
 *   npx tsx src/data/outbox/__bench_p9_outbox.ts
 *   退出码: 0=PASS, 1=FAIL
 */

import {
  OutboxWorker,
  OutboxConfig,
  OutboxRecord,
  DEFAULT_OUTBOX_CONFIG,
} from './outbox';

// ── 内存版 SurrealClient mock ────────────────────────────────────

interface MockClient {
  query<T = any>(sql: string, vars?: Record<string, any>): Promise<T[]>;
  _tables: Map<string, Map<string, any>>;
  _sqlTrace: string[];
}

function createMockClient(): MockClient {
  const tables = new Map<string, Map<string, any>>();
  const sqlTrace: string[] = [];
  function getOrCreate(name: string) {
    if (!tables.has(name)) tables.set(name, new Map());
    return tables.get(name)!;
  }
  return {
    _tables: tables,
    _sqlTrace: sqlTrace,
    async query<T = any>(sql: string, vars: Record<string, any> = {}): Promise<T[]> {
      sqlTrace.push(sql.trim().split('\n')[0]);
      const trimmed = sql.trim();

      // DEFINE INDEX: 忽略
      if (/^DEFINE\s+INDEX/i.test(trimmed)) return [[]] as any;

      // INSERT INTO outbox_sync
      let m = /^INSERT\s+INTO\s+outbox_sync\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)/i.exec(trimmed);
      if (m) {
        const t = getOrCreate('outbox_sync');
        const id = vars.id as string;
        t.set(id, {
          id,
          kind: vars.kind,
          payload: vars.payload,
          status: 'pending',
          retry_count: 0,
          next_retry_at: vars.now ?? Date.now(),
          created_at: vars.now ?? Date.now(),
        });
        return [[{ id }]] as any;
      }

      // INSERT INTO outbox_dead
      m = /^INSERT\s+INTO\s+outbox_dead\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)/i.exec(trimmed);
      if (m) {
        const t = getOrCreate('outbox_dead');
        const id = vars.id as string;
        t.set(id, {
          id,
          kind: vars.kind,
          payload: vars.payload,
          retry_count: vars.retry,
          last_error: vars.err,
          created_at: vars.created,
          dead_at: vars.now,
        });
        return [[{ id }]] as any;
      }

      // UPDATE <id> SET ...
      m = /^UPDATE\s+\$id\s+SET\s+(.+)/i.exec(trimmed);
      if (m) {
        const id = vars.id as string;
        for (const tbl of tables.values()) {
          if (tbl.has(id)) {
            const row = tbl.get(id);
            const sets = m[1].split(/,(?![^']*')/).map((s) => s.trim());
            for (const s of sets) {
              // 字符串字面量 'literal'
              const smLit = /^(\w+)\s*=\s*'([^']*)'/.exec(s);
              if (smLit) {
                row[smLit[1]] = smLit[2];
                continue;
              }
              // 变量 $name
              const smVar = /^(\w+)\s*=\s*\$(\w+)/.exec(s);
              if (smVar) {
                row[smVar[1]] = vars[smVar[2]] ?? row[smVar[1]];
                continue;
              }
            }
            tbl.set(id, row);
            return [[row]] as any;
          }
        }
        return [[]] as any;
      }

      // SELECT * FROM outbox_sync WHERE status='pending' ...
      if (/SELECT\s+\*\s+FROM\s+outbox_sync/i.test(trimmed)) {
        const t = tables.get('outbox_sync') ?? new Map();
        const now = vars.now ?? Date.now();
        const batch = vars.batch ?? 100;
        const records: any[] = [];
        for (const r of t.values()) {
          if (r.status === 'pending' && (r.next_retry_at ?? 0) <= now) {
            records.push(r);
          }
        }
        records.sort((a, b) => (a.next_retry_at ?? 0) - (b.next_retry_at ?? 0));
        return [records.slice(0, batch)] as any;
      }

      // SELECT count() ...
      if (/SELECT\s+count\(\)/i.test(trimmed)) {
        const t = tables.get('outbox_sync') ?? new Map();
        let c = 0;
        for (const r of t.values()) if (r.status === 'pending') c++;
        return [[{ c }]] as any;
      }

      return [[]] as any;
    },
  };
}

// ── Canary 主体 ─────────────────────────────────────────────────

async function main() {
  console.log('=== P9 Outbox 模式 canary 测试 ===');

  const mock = createMockClient();
  const totalMessages = 30;
  const failFirstNAttempts = 3;  // 消息 0-2 前 3 次都失败 (模拟网络抖动)
  const alwaysFailId = `outbox_always_fail_xxx`;  // 永远失败 → DLQ

  // 初始化表 (用 INSERT 走 mock, 确保 _tables.get(...) 一定有 Map)
  // 入队
  for (let i = 0; i < totalMessages; i++) {
    const id = i === 7 ? alwaysFailId : `outbox_test_${i}`;
    await mock.query(
      `INSERT INTO outbox_sync (id, kind, payload, status, retry_count, next_retry_at, created_at) VALUES ($id, $kind, $payload, 'pending', 0, $now, $now)`,
      {
        id,
        kind: 'reputation.update',
        payload: { agentId: `agent_${i}`, value: 100 + i },
        now: Date.now(),
      },
    );
  }

  console.log(`[SETUP] enqueued ${totalMessages} messages, 1 configured to always-fail (id=${alwaysFailId})`);

  // 失败计数器
  const attemptCount = new Map<string, number>();
  let deliveredCount = 0;
  let lastDelivered: { id: string; payload: any } | null = null;

  // handler: 模拟业务回调
  const handler = async (rec: OutboxRecord) => {
    const n = (attemptCount.get(rec.id) ?? 0) + 1;
    attemptCount.set(rec.id, n);

    if (rec.id === alwaysFailId) {
      throw new Error('simulated permanent network failure');
    }
    // 消息 0-2 前 failFirstNAttempts 次失败
    if (rec.id.startsWith('outbox_test_')) {
      const idx = parseInt(rec.id.split('_').pop() ?? '0', 10);
      if (idx < failFirstNAttempts && n <= failFirstNAttempts) {
        throw new Error(`simulated transient failure (attempt ${n})`);
      }
    }
    // 成功
    deliveredCount++;
    lastDelivered = { id: rec.id, payload: rec.payload };
  };

  // 启动 worker (短轮询)
  const cfg: Partial<OutboxConfig> = {
    poll_interval_ms: 50,
    batch_size: 100,
    max_retries: 5,    // 5 次后转 DLQ
    backoff_base_ms: 20,
    backoff_max_ms: 200,
    enable_dlq: true,
  };
  const worker = new OutboxWorker(mock as any, handler, cfg);
  worker.start();

  // 等所有消息处理完
  const t0 = Date.now();
  const timeoutMs = 15_000;
  let ok = false;
  while (Date.now() - t0 < timeoutMs) {
    const pending = mock._tables.get('outbox_sync') ?? new Map();
    let stillPending = 0;
    for (const r of pending.values()) if (r.status === 'pending') stillPending++;
    const dead = mock._tables.get('outbox_dead') ?? new Map();
    const deadHasFail = dead.has(alwaysFailId);
    // 都完成条件: (delivered == totalMessages - 1) AND deadHasFail
    if (deliveredCount >= totalMessages - 1 && deadHasFail) {
      ok = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  worker.stop();
  const elapsed = Date.now() - t0;

  // 验收
  const sentRows = Array.from((mock._tables.get('outbox_sync') ?? new Map()).values());
  const sent = sentRows.filter((r) => r.status === 'sent').length;
  const dead = Array.from((mock._tables.get('outbox_dead') ?? new Map()).values());

  const summary = {
    elapsed_ms: elapsed,
    total_enqueued: totalMessages,
    delivered: deliveredCount,
    sent_status: sent,
    dead_lettered: dead.length,
    dead_id: dead[0]?.id ?? null,
    failed_attempts: worker.stats.failed_attempts,
    polled: worker.stats.polled,
    pending_now: worker.stats.pending_now,
    last_delivered: lastDelivered,
  };
  console.log('\n=== P9 Outbox Canary 结果 ===');
  console.log(JSON.stringify(summary, null, 2));

  const pass =
    deliveredCount === totalMessages - 1 && // 1 条 DLQ
    sent === totalMessages - 1 &&            // 同步表 29 条 sent
    dead.length === 1 &&                     // 1 条 dead
    dead[0]?.id === alwaysFailId;            // DLQ 是预配置的那条

  console.log(`\n[P9 验收] ${pass ? '✅ PASS' : '❌ FAIL'}  (0 丢失 + DLQ 正确)`);
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error('[FATAL]', e);
  process.exit(2);
});
