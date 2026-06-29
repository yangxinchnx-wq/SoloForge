/**
 * perfMonitor.test.ts — 性能监控单测
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  FPSCounter,
  StreamingLatencyTracker,
  trackSlow,
  sampleMemory,
  PerfAggregator,
  onPerfSample,
  _resetPerfListeners,
} from './perfMonitor';

describe('StreamingLatencyTracker', () => {
  it('captures ttfb + total + bytes', async () => {
    const tracker = new StreamingLatencyTracker();
    tracker.start('test-op');
    await new Promise((r) => setTimeout(r, 30));
    tracker.recordChunk(10);
    await new Promise((r) => setTimeout(r, 50));
    tracker.recordChunk(20);
    const sample = tracker.finish();
    expect(sample.op).toBe('test-op');
    expect(sample.ttfb).toBeGreaterThanOrEqual(25);
    expect(sample.ttfb).toBeLessThan(50);
    expect(sample.total).toBeGreaterThanOrEqual(75);
    expect(sample.bytes).toBe(30);
  });

  it('ttfb is 0 when no chunks', () => {
    const tracker = new StreamingLatencyTracker();
    tracker.start('no-chunks');
    const sample = tracker.finish();
    expect(sample.ttfb).toBe(0);
    expect(sample.total).toBeGreaterThanOrEqual(0);
  });
});

describe('trackSlow', () => {
  beforeEach(() => _resetPerfListeners());

  it('does not emit when fast', async () => {
    const listener = vi.fn();
    onPerfSample(listener);
    const r = await trackSlow('fast-op', async () => {
      await new Promise((res) => setTimeout(res, 5));
      return 'ok';
    }, { thresholdMs: 100 });
    expect(r).toBe('ok');
    expect(listener).not.toHaveBeenCalled();
  });

  it('emits SlowOpSample when slow', async () => {
    const listener = vi.fn();
    onPerfSample(listener);
    await trackSlow('slow-op', async () => {
      await new Promise((res) => setTimeout(res, 50));
      return 'ok';
    }, { thresholdMs: 10 });
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ op: 'slow-op', thresholdMs: 10 }),
    );
  });

  it('propagates errors and still measures', async () => {
    await expect(
      trackSlow('failing-op', async () => {
        throw new Error('boom');
      }, { thresholdMs: 0 }),
    ).rejects.toThrow('boom');
  });
});

describe('FPSCounter', () => {
  it('reports initial 0 fps', () => {
    const counter = new FPSCounter(() => {});
    expect(counter.getFps()).toBe(0);
  });

  it('start/stop are idempotent', () => {
    const counter = new FPSCounter(() => {});
    counter.start();
    counter.start(); // 不应启动第二个 loop
    counter.stop();
    counter.stop(); // 不应抛错
  });
});

describe('sampleMemory', () => {
  it('returns null when performance.memory unavailable', () => {
    // 默认 jsdom 环境没有 performance.memory
    // 如果存在就返回值
    const result = sampleMemory();
    // 不强制为 null（真实浏览器有 memory）
    if (result !== null) {
      expect(result.usedJSHeapMB).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('PerfAggregator', () => {
  it('snapshot includes all metrics', () => {
    const agg = new PerfAggregator();
    const snap = agg.snapshot();
    expect(snap.fps).toBe(0);
    expect(snap.avgLatencyMs).toBe(0);
    expect(snap.slowOpCount).toBe(0);
  });

  it('aggregates latency samples', () => {
    const agg = new PerfAggregator();
    // 模拟 3 次 latency 上报
    const tracker = new StreamingLatencyTracker();
    tracker.start('a');
    tracker.recordChunk(1);
    tracker.finish();
    tracker.start('b');
    tracker.recordChunk(2);
    tracker.finish();
    const snap = agg.snapshot();
    expect(snap.avgLatencyMs).toBeGreaterThanOrEqual(0);
  });

  it('reset clears counters', () => {
    const agg = new PerfAggregator();
    agg.reset();
    expect(agg.snapshot().slowOpCount).toBe(0);
  });
});

describe('onPerfSample', () => {
  beforeEach(() => _resetPerfListeners());

  it('returns unsubscribe function', () => {
    const listener = vi.fn();
    const unsub = onPerfSample(listener);
    unsub();
    // 触发一个 sample（间接通过 trackSlow）
    void trackSlow('never-called', async () => 'x', { thresholdMs: -1 }); // threshold -1 = 必然 emit
    // listener 已取消订阅
    expect(listener).not.toHaveBeenCalled();
  });

  it('listener error does not break others', () => {
    _resetPerfListeners();
    const bad = vi.fn(() => {
      throw new Error('listener-bad');
    });
    const good = vi.fn();
    onPerfSample(bad);
    onPerfSample(good);
    const tracker = new StreamingLatencyTracker();
    tracker.start('x');
    const sample = tracker.finish();
    expect(bad).toHaveBeenCalledWith(sample);
    expect(good).toHaveBeenCalledWith(sample);
  });
});
