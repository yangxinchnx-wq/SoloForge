/**
 * tests/unit/audit-sink-composite.test.ts
 *
 * 覆盖:
 *   - fan-out 到 N 个子 sink
 *   - 任一子 sink 抛错不影响其他
 *   - 统计聚合
 *   - add / remove / list
 */
import { describe, it, expect, vi } from 'vitest';
import {
  CompositeAuditSink,
  FunctionAuditSink,
} from '../../src/security/auditSinkBase';
import type { AuditEvent, AuditSinkV2 } from '../../src/security/auth';

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

/** 测试用 sink: 记录所有 invoke 过的 ev */
class CapturingSink implements AuditSinkV2 {
  public events: AuditEvent[] = [];
  constructor(public readonly name: string) {}
  invoke(e: AuditEvent): void { this.events.push(e); }
  getStats() { return { name: this.name, count: this.events.length }; }
}

/** 测试用 sink: invoke 必抛错, 验证 composite 兜底 */
class ThrowingSink implements AuditSinkV2 {
  constructor(public readonly name: string) {}
  invoke(_e: AuditEvent): void { throw new Error('boom'); }
  getStats() { return { name: this.name }; }
}

describe('CompositeAuditSink', () => {
  it('fan-out 到 N 个子 sink', () => {
    const a = new CapturingSink('a');
    const b = new CapturingSink('b');
    const c = new CapturingSink('c');
    const composite = new CompositeAuditSink([a, b, c]);
    composite.invoke(ev({ id: 'x1' }));
    composite.invoke(ev({ id: 'x2' }));
    expect(a.events.length).toBe(2);
    expect(b.events.length).toBe(2);
    expect(c.events.length).toBe(2);
  });

  it('任一子 sink 抛错, 不影响其他', () => {
    const a = new CapturingSink('a');
    const throwing = new ThrowingSink('boom');
    const c = new CapturingSink('c');
    const composite = new CompositeAuditSink([a, throwing, c]);
    expect(() => composite.invoke(ev({ id: 'safe' }))).not.toThrow();
    expect(a.events.length).toBe(1);
    expect(c.events.length).toBe(1);
    const stats = composite.getStats();
    expect(stats.aggregate.failedFanout).toBe(1);
  });

  it('add / remove / list 动态管理子 sink', () => {
    const a = new CapturingSink('a');
    const composite = new CompositeAuditSink([a]);
    const b = new CapturingSink('b');
    composite.add(b);
    expect(composite.list()).toEqual(['a', 'b']);
    expect(composite.remove('a')).toBe(true);
    expect(composite.list()).toEqual(['b']);
    expect(composite.remove('nonexistent')).toBe(false);
  });

  it('getStats 聚合 (childCount + per-child + aggregate)', () => {
    const a = new CapturingSink('a');
    const b = new CapturingSink('b');
    const composite = new CompositeAuditSink([a, b]);
    composite.invoke(ev({ id: 's1' }));
    composite.invoke(ev({ id: 's2' }));
    const stats = composite.getStats();
    expect(stats.name).toBe('composite');
    expect(stats.childCount).toBe(2);
    expect(stats.children.length).toBe(2);
    expect(stats.children[0].stats.count).toBe(2);
    expect(stats.aggregate.received).toBe(2);
    expect(stats.aggregate.fanoutToChildren).toBe(4); // 2 events × 2 children
  });

  it('close() 调用所有子 sink close (Promise.allSettled)', async () => {
    const closeA = vi.fn();
    const closeB = vi.fn();
    const a: AuditSinkV2 = { name: 'a', invoke: () => {}, close: closeA, getStats: () => ({}) };
    const b: AuditSinkV2 = { name: 'b', invoke: () => {}, close: closeB, getStats: () => ({}) };
    const composite = new CompositeAuditSink([a, b]);
    await composite.close();
    expect(closeA).toHaveBeenCalled();
    expect(closeB).toHaveBeenCalled();
  });
});

describe('FunctionAuditSink (向后兼容)', () => {
  it('包装函数式 sink, 仍可作 V2 用', () => {
    const calls: AuditEvent[] = [];
    const fn = (e: AuditEvent) => calls.push(e);
    const sink = new FunctionAuditSink('legacy', fn);
    sink.invoke(ev({ id: 'fn-1' }));
    expect(calls.length).toBe(1);
    expect(calls[0].id).toBe('fn-1');
    expect(sink.name).toBe('legacy');
  });

  it('函数抛错, sink 自身不抛 (内部 try/catch)', () => {
    const sink = new FunctionAuditSink('crashy', () => { throw new Error('oops'); });
    expect(() => sink.invoke(ev())).not.toThrow();
  });
});
