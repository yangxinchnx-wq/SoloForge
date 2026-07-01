/**
 * tests/unit/audit-sink-kafka.test.ts
 *
 * 覆盖:
 *   - invoke: 入队 + queue 满 FIFO drop
 *   - 队列长度 ≤ maxQueue
 *   - getStats 包含 queueSize / topic / brokers
 *   - 关闭时不抛错
 *
 * 不连真 Kafka (依赖 broker), 测纯本地行为。
 */
import { describe, it, expect } from 'vitest';
import { KafkaAuditSink } from '../../src/security/auditSinkKafka';
import type { AuditEvent } from '../../src/security/auth';

function ev(over: Partial<AuditEvent> = {}): AuditEvent {
  return {
    id: 'ev-' + Math.random().toString(36).slice(2, 8),
    timestamp: Date.now(),
    action: 'auth.ok',
    route: '/api/agents',
    method: 'GET',
    status: 200,
    ...over,
  };
}

describe('KafkaAuditSink — queue behavior', () => {
  it('invoke 后 queue 增加, 收到统计 +1', () => {
    const sink = new KafkaAuditSink({
      brokers: ['localhost:9999'],
      topic: 'test',
      maxQueue: 100,
    });
    sink.invoke(ev({ id: 'k1' }));
    sink.invoke(ev({ id: 'k2' }));
    const s = sink.getStats();
    expect(s.received).toBe(2);
    expect(s.queueSize).toBe(2);
    expect(s.topic).toBe('test');
    expect(s.brokers).toEqual(['localhost:9999']);
  });

  it('queue 满 → FIFO drop 旧事件, dropped 计数 +1', () => {
    const sink = new KafkaAuditSink({
      brokers: ['localhost:9999'],
      topic: 'test',
      maxQueue: 3,
    });
    sink.invoke(ev({ id: 'a' }));
    sink.invoke(ev({ id: 'b' }));
    sink.invoke(ev({ id: 'c' }));
    sink.invoke(ev({ id: 'd' })); // 触发 drop 'a'
    sink.invoke(ev({ id: 'e' })); // 触发 drop 'b'
    const s = sink.getStats();
    expect(s.queueSize).toBe(3);
    expect(s.dropped).toBe(2);
    expect(s.additionalQueueDropped).toBe(2);
  });

  it('push() 在 broker 不可达时 → fallback, stats 记录失败', async () => {
    // 用不存在 broker 强制连接失败, 设置 Kafka client 自身的 connectionTimeout
    const sink = new KafkaAuditSink({
      brokers: ['127.0.0.1:1'], // 端口 1 不可能监听
      topic: 'test',
      closeTimeoutMs: 100,
    });
    // push() 应当不抛错, 内部 fallback
    await sink.push([ev({ id: 'fail-1' })]);
    const s = sink.getStats();
    expect(s.failedWrites).toBe(1);
    // 关闭不能挂死
    await sink.close();
  }, 15000); // 15s timeout: 给 Kafka 客户端时间连接失败

  it('close() 后 invoke 静默忽略', async () => {
    const sink = new KafkaAuditSink({
      brokers: ['localhost:9999'],
      topic: 'test',
    });
    await sink.close();
    sink.invoke(ev({ id: 'after-close' }));
    const s = sink.getStats();
    expect(s.received).toBe(0);
  });
});
