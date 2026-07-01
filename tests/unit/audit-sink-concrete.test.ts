/**
 * tests/unit/audit-sink-concrete.test.ts
 *
 * 覆盖:
 *   - FileAuditSink: 写入 + 轮转 (gzip 压缩)
 *   - HttpAuditSink: 成功 + 失败重试 + 终极失败 fallback
 *   - StdoutAuditSink: mirror 行为
 *   - NoopAuditSink: noop
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as zlib from 'zlib';
import {
  FileAuditSink,
  HttpAuditSink,
  StdoutAuditSink,
  NoopAuditSink,
} from '../../src/security/auditSinkConcrete';
import type { AuditEvent } from '../../src/security/auth';

let tmpDir: string;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-test-'));
});
afterEach(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

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

describe('FileAuditSink', () => {
  it('writes one JSONL line per event', async () => {
    const file = path.join(tmpDir, 'audit.jsonl');
    const sink = new FileAuditSink({ path: file, rotateBytes: 10 * 1024 * 1024 });
    sink.invoke(ev({ id: 'a1' }));
    sink.invoke(ev({ id: 'a2' }));
    await new Promise((r) => setTimeout(r, 50));
    const text = fs.readFileSync(file, 'utf8').trim().split('\n');
    expect(text.length).toBe(2);
    expect(JSON.parse(text[0]).id).toBe('a1');
    expect(JSON.parse(text[1]).id).toBe('a2');
    await sink.close();
  });

  it('rotates to .gz when file exceeds rotateBytes', async () => {
    const file = path.join(tmpDir, 'audit.jsonl');
    // 单条事件 ~120B, rotateBytes=300, 写 6 条 → 720B → 至少轮转 2 次
    const sink = new FileAuditSink({ path: file, rotateBytes: 300, maxRotatedFiles: 5, compressRotated: true });
    for (let i = 0; i < 6; i++) sink.invoke(ev({ id: 'r-' + i }));
    // 等异步 write 全部完成
    await new Promise((r) => setTimeout(r, 200));
    await sink.close();
    const files = fs.readdirSync(tmpDir);
    const gzs = files.filter((f) => f.endsWith('.gz'));
    expect(gzs.length).toBeGreaterThanOrEqual(1);
    if (gzs[0]) {
      const compressed = fs.readFileSync(path.join(tmpDir, gzs[0]));
      const decompressed = zlib.gunzipSync(compressed).toString('utf8');
      expect(decompressed.split('\n').filter(Boolean).length).toBeGreaterThan(0);
    }
  });

  it('close() 幂等, 不抛错', async () => {
    const file = path.join(tmpDir, 'audit.jsonl');
    const sink = new FileAuditSink({ path: file });
    sink.invoke(ev());
    await new Promise((r) => setTimeout(r, 30));
    await sink.close();
    await sink.close(); // 双 close 不应炸
  });
});

describe('HttpAuditSink', () => {
  it('成功: 200 OK, 不会重试', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    globalThis.fetch = fetchMock as any;
    const sink = new HttpAuditSink({ url: 'http://localhost:9999/audit', timeoutMs: 100, maxRetries: 3 });
    sink.invoke(ev({ id: 'http-1' }));
    await new Promise((r) => setTimeout(r, 100));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).id).toBe('http-1');
  });

  it('失败重试 3 次后 fallback, 不抛错', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 500 }));
    globalThis.fetch = fetchMock as any;
    const sink = new HttpAuditSink({ url: 'http://localhost:9999/audit', timeoutMs: 50, maxRetries: 3 });
    sink.invoke(ev({ id: 'http-fail' }));
    // 退避: 100 + 200 = 300ms, 加 50ms 缓冲
    await new Promise((r) => setTimeout(r, 500));
    expect(fetchMock).toHaveBeenCalledTimes(3);
    // stats 记录失败
    const s = sink.getStats();
    expect(s.failedWrites).toBe(1);
  });
});

describe('StdoutAuditSink', () => {
  it('invoke 后 getStats received 计数 +1', () => {
    const sink = new StdoutAuditSink(true);
    sink.invoke(ev({ id: 's1' }));
    sink.invoke(ev({ id: 's2' }));
    expect(sink.getStats().received).toBe(2);
  });
});

describe('NoopAuditSink', () => {
  it('不做任何事, stats 全 0', () => {
    const sink = new NoopAuditSink();
    sink.invoke(ev());
    sink.invoke(ev());
    const s = sink.getStats();
    expect(s.received).toBe(2);
    expect(s.written).toBe(0); // write 是 noop
  });
});
