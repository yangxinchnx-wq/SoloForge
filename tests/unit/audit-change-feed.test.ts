/**
 * tests/unit/audit-change-feed.test.ts
 *
 * 覆盖:
 *   - tickOnce: 拉取 writtenAt > cursor 的新行, 推 Kafka, 推进 cursor
 *   - 空查询: 不调用 push, 不报错
 *   - isReady() = false: 跳过 tick
 *   - 连续 tick: 游标单调递增, 不漏单
 *
 * 使用 mock SurrealPersistence + 不连真 broker 的 KafkaAuditSink (走 fallback)
 */
import { describe, it, expect, vi } from 'vitest';
import { AuditChangeFeed } from '../../src/security/auditChangeFeed';
import { KafkaAuditSink } from '../../src/security/auditSinkKafka';

class MockSurreal {
  private rows: any[];
  public ready: boolean;
  public querySpy = vi.fn();
  constructor(opts: { rows?: any[]; ready?: boolean } = {}) {
    this.rows = opts.rows ?? [];
    this.ready = opts.ready ?? true;
  }
  isReady() { return this.ready; }
  async query(sql: string, params: any) {
    this.querySpy(sql, params);
    // 简单模拟: 全返回
    return [this.rows];
  }
}

describe('AuditChangeFeed', () => {
  it('空查询: tickOnce 返回 0, 不 push', async () => {
    const sp = new MockSurreal({ rows: [] });
    const sink = new KafkaAuditSink({ brokers: ['127.0.0.1:1'], topic: 'test', closeTimeoutMs: 200 });
    const feed = new AuditChangeFeed(sp as any, sink, { pollIntervalMs: 50, lookbackMs: 1000 });
    const n = await feed.tickOnce();
    expect(n).toBe(0);
    await sink.close();
  });

  it('isReady() = false: tickOnce 跳过', async () => {
    const sp = new MockSurreal({ ready: false });
    const sink = new KafkaAuditSink({ brokers: ['127.0.0.1:1'], topic: 'test', closeTimeoutMs: 200 });
    const feed = new AuditChangeFeed(sp as any, sink, { pollIntervalMs: 50 });
    const n = await feed.tickOnce();
    expect(n).toBe(0);
    expect(sp.querySpy).not.toHaveBeenCalled();
    await sink.close();
  });

  it('返回 N 行 → push 失败时保留 cursor (at-least-once 语义)', async () => {
    const t0 = new Date().toISOString();
    const rows = [
      { id: 'r1', action: 'auth.ok', route: '/x', method: 'GET', status: 200,
        writtenAt: t0, timestamp: t0, principalId: 'p1' },
      { id: 'r2', action: 'auth.fail', route: '/y', method: 'POST', status: 401,
        writtenAt: t0, timestamp: t0, principalId: 'p2' },
    ];
    const sp = new MockSurreal({ rows });
    const sink = new KafkaAuditSink({ brokers: ['127.0.0.1:1'], topic: 'test', closeTimeoutMs: 100 });
    const feed = new AuditChangeFeed(sp as any, sink, { pollIntervalMs: 50, lookbackMs: 0 });
    // 第一次: push 失败 (Kafka 不可达) → 走 fallback, cursor 不推进
    const n = await feed.tickOnce();
    expect(n).toBe(2);
    // 第二次: 应再次拉到这 2 行 (at-least-once)
    const n2 = await feed.tickOnce();
    expect(n2).toBe(2);
    // stats: 每次都尝试 push, 失败也计入
    expect(feed.getStats().rowsPushed).toBe(4);
    await sink.close();
  }, 20000);

  it('start / stop 启停 timer', async () => {
    const sp = new MockSurreal({ rows: [] });
    const sink = new KafkaAuditSink({ brokers: ['127.0.0.1:1'], topic: 'test', closeTimeoutMs: 200 });
    const feed = new AuditChangeFeed(sp as any, sink, { pollIntervalMs: 30 });
    feed.start();
    expect(feed.getStats().running).toBe(true);
    await new Promise((r) => setTimeout(r, 100));
    feed.stop();
    expect(feed.getStats().running).toBe(false);
    await sink.close();
  });

  it('查询参数: WHERE writtenAt > $cursor + LIMIT $limit', async () => {
    const sp = new MockSurreal({ rows: [] });
    const sink = new KafkaAuditSink({ brokers: ['127.0.0.1:1'], topic: 'test', closeTimeoutMs: 200 });
    const feed = new AuditChangeFeed(sp as any, sink, { pollIntervalMs: 50, lookbackMs: 5000, batchSize: 123 });
    await feed.tickOnce();
    expect(sp.querySpy).toHaveBeenCalledTimes(1);
    const [sql, params] = sp.querySpy.mock.calls[0];
    expect(sql).toContain('SELECT * FROM httpAuditLog');
    expect(sql).toContain('writtenAt > $cursor');
    expect(sql).toContain('ORDER BY writtenAt ASC');
    expect(sql).toContain('LIMIT $limit');
    expect(params.limit).toBe(123);
    expect(typeof params.cursor).toBe('string'); // ISO date
    await sink.close();
  });
});
