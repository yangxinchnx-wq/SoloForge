/**
 * observability.test.ts — metrics + Sentry 适配器单测
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  Counter,
  Gauge,
  Histogram,
  MetricsRegistry,
  PrometheusExporter,
  defaultRegistry,
} from './metrics';
import { SentryAdapter, getDefaultSentry, setDefaultSentry } from './sentryAdapter';

describe('Counter', () => {
  it('inc adds to label bucket', () => {
    const c = new Counter({ name: 'test_counter', help: 'test', labelNames: ['k'] });
    c.inc({ k: 'a' });
    c.inc({ k: 'a' }, 3);
    c.inc({ k: 'b' });
    expect(c.get({ k: 'a' })).toBe(4);
    expect(c.get({ k: 'b' })).toBe(1);
  });

  it('throws on negative inc', () => {
    const c = new Counter({ name: 'c', help: 'c' });
    expect(() => c.inc({}, -1)).toThrow();
  });

  it('reset clears all values', () => {
    const c = new Counter({ name: 'c', help: 'c', labelNames: ['k'] });
    c.inc({ k: 'a' });
    c.reset();
    expect(c.get({ k: 'a' })).toBe(0);
  });
});

describe('Gauge', () => {
  it('set/inc/dec work', () => {
    const g = new Gauge({ name: 'test_gauge', help: 'test', labelNames: ['k'] });
    g.set(5, { k: 'x' });
    expect(g.get({ k: 'x' })).toBe(5);
    g.inc({ k: 'x' }, 3);
    expect(g.get({ k: 'x' })).toBe(8);
    g.dec({ k: 'x' }, 2);
    expect(g.get({ k: 'x' })).toBe(6);
  });
});

describe('Histogram', () => {
  it('observe fills buckets', () => {
    const h = new Histogram({ name: 'test_hist', help: 'test', buckets: [10, 100, 1000] });
    h.observe(5);
    h.observe(50);
    h.observe(500);
    h.observe(5000); // 超过所有 bucket，count 仍增
    const snap = h.snapshot();
    expect(snap.count).toBe(4);
    expect(snap.sum).toBe(5 + 50 + 500 + 5000);
    expect(snap.buckets).toEqual([
      { le: 10, count: 1 },
      { le: 100, count: 2 },
      { le: 1000, count: 3 },
      { le: Infinity, count: 4 },
    ]);
  });

  it('requires non-empty buckets', () => {
    expect(() => new Histogram({ name: 'h', help: 'h', buckets: [] })).toThrow();
  });

  it('separates label buckets', () => {
    const h = new Histogram({ name: 'h', help: 'h', labelNames: ['k'], buckets: [10, 100] });
    h.observe(5, { k: 'a' });
    h.observe(50, { k: 'b' });
    expect(h.snapshot({ k: 'a' }).count).toBe(1);
    expect(h.snapshot({ k: 'b' }).count).toBe(1);
  });
});

describe('MetricsRegistry', () => {
  it('register/get/list', () => {
    const r = new MetricsRegistry();
    const c = new Counter({ name: 'x', help: 'x' });
    r.register(c);
    expect(r.get('x')).toBe(c);
    expect(r.list()).toHaveLength(1);
  });

  it('rejects duplicate name', () => {
    const r = new MetricsRegistry();
    r.register(new Counter({ name: 'x', help: 'x' }));
    expect(() => r.register(new Counter({ name: 'x', help: 'x' }))).toThrow();
  });
});

describe('PrometheusExporter', () => {
  it('renders counter with labels', () => {
    const r = new MetricsRegistry();
    const c = new Counter({ name: 'http_total', help: 'HTTP total', labelNames: ['method'] });
    c.inc({ method: 'GET' });
    c.inc({ method: 'POST' }, 3);
    r.register(c);
    const out = new PrometheusExporter(r).render();
    expect(out).toContain('# HELP http_total');
    expect(out).toContain('# TYPE http_total counter');
    expect(out).toMatch(/http_total\{method="GET"\} 1/);
    expect(out).toMatch(/http_total\{method="POST"\} 3/);
  });

  it('renders gauge with no labels', () => {
    const r = new MetricsRegistry();
    const g = new Gauge({ name: 'cpu_pct', help: 'CPU %' });
    g.set(42);
    r.register(g);
    const out = new PrometheusExporter(r).render();
    expect(out).toContain('cpu_pct 42');
  });

  it('renders histogram with buckets + count + sum', () => {
    const r = new MetricsRegistry();
    const h = new Histogram({ name: 'lat_ms', help: 'latency', buckets: [10, 100, 1000] });
    h.observe(5);
    h.observe(50);
    h.observe(5000);
    r.register(h);
    const out = new PrometheusExporter(r).render();
    expect(out).toMatch(/lat_ms_bucket\{le="10"\} 1/);
    expect(out).toMatch(/lat_ms_bucket\{le="100"\} 2/);
    expect(out).toMatch(/lat_ms_bucket\{le="1000"\} 2/);
    expect(out).toMatch(/lat_ms_bucket\{le="\+Inf"\} 3/);
    expect(out).toMatch(/lat_ms_count 3/);
    expect(out).toMatch(/lat_ms_sum 5055/);
  });

  it('renders empty histogram correctly', () => {
    const r = new MetricsRegistry();
    r.register(new Histogram({ name: 'empty', help: 'e', buckets: [10, 100] }));
    const out = new PrometheusExporter(r).render();
    expect(out).toMatch(/empty_bucket\{le="10"\} 0/);
    expect(out).toMatch(/empty_count 0/);
    expect(out).toMatch(/empty_sum 0/);
  });

  it('defaultRegistry contains pre-registered metrics', () => {
    const out = new PrometheusExporter(defaultRegistry).render();
    expect(out).toContain('soloforge_llm_stream_total');
    expect(out).toContain('soloforge_http_requests_total');
  });
});

describe('SentryAdapter', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).fetch = vi.fn();
  });
  afterEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).fetch = originalFetch;
  });

  it('disabled when no DSN', () => {
    const a = new SentryAdapter({ disabled: true });
    expect(a.isEnabled()).toBe(false);
    const id = a.captureException(new Error('x'));
    expect(id).toBe(''); // disabled returns empty eventId
  });

  it('parses DSN correctly', () => {
    const a = new SentryAdapter({ dsn: 'https://abc123@sentry.io/42' });
    expect(a.isEnabled()).toBe(true);
  });

  it('returns null/disabled on invalid DSN', () => {
    const a = new SentryAdapter({ dsn: 'invalid-dsn' });
    expect(a.isEnabled()).toBe(false);
  });

  it('sends envelope to correct URL', async () => {
    let capturedUrl = '';
    let capturedBody = '';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).fetch = vi.fn(async (url: string, init: any) => {
      capturedUrl = url;
      capturedBody = init.body;
      return { ok: true, status: 200, text: async () => '' };
    });
    const a = new SentryAdapter({ dsn: 'https://key@sentry.io/7' });
    const id = a.captureException(new Error('boom'), { chatId: 'c1' });
    // 等待 microtask
    await new Promise((r) => setTimeout(r, 10));
    expect(capturedUrl).toContain('sentry.io/api/7/store/');
    expect(capturedUrl).toContain('sentry_key=key');
    expect(capturedUrl).toContain('sentry_version=7');
    expect(capturedBody).toContain('"event_id":');
    expect(capturedBody).toContain('"boom"');
    expect(capturedBody).toContain('"chatId"');
    expect(id).toMatch(/^[0-9a-f]{32}$/);
  });

  it('buffers on network failure', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).fetch = vi.fn(async () => { throw new Error('net down'); });
    const a = new SentryAdapter({ dsn: 'https://key@sentry.io/7', maxBuffer: 10 });
    for (let i = 0; i < 3; i++) a.captureException(new Error(`e${i}`));
    await new Promise((r) => setTimeout(r, 50));
    expect(a.bufferSize()).toBe(3);
  });

  it('flush() drains buffer', async () => {
    const calls: string[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).fetch = vi.fn(async (url: string) => {
      calls.push(url);
      if (calls.length > 3) return { ok: true, status: 200, text: async () => '' };
      throw new Error('fail'); // 前几次失败
    });
    const a = new SentryAdapter({ dsn: 'https://key@sentry.io/7' });
    a.captureException(new Error('e1'));
    await new Promise((r) => setTimeout(r, 20));
    expect(a.bufferSize()).toBe(1);
    await a.flush();
    expect(a.bufferSize()).toBe(0);
  });

  it('getDefaultSentry returns same instance', () => {
    const a = getDefaultSentry();
    const b = getDefaultSentry();
    expect(a).toBe(b);
    setDefaultSentry(new SentryAdapter());
    const c = getDefaultSentry();
    expect(c).not.toBe(a);
  });
});
