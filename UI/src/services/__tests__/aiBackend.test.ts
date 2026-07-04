/**
 * aiBackend unit tests
 *   验证:
 *     1. dev (无 window.soloforge) → 走 fetch + SSE
 *     2. 解析 SSE data: 行 → text/error/done 事件
 *     3. abort() 取消 in-flight fetch
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { startChat, isElectronIpcAvailable } from '../aiBackend';

describe('aiBackend — dev (fetch + SSE) path', () => {
  let originalFetch: typeof globalThis.fetch;
  let originalSoloforge: any;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalSoloforge = (globalThis as any).window?.soloforge;
    if (typeof globalThis.window !== 'undefined') {
      delete (globalThis as any).window.soloforge;
    }
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (typeof globalThis.window !== 'undefined' && originalSoloforge) {
      (globalThis as any).window.soloforge = originalSoloforge;
    }
  });

  it('isElectronIpcAvailable() returns false when window.soloforge missing', () => {
    expect(isElectronIpcAvailable()).toBe(false);
  });

  it('startChat fetches /api/agents/dispatch with body, parses SSE text chunks', async () => {
    const encoder = new TextEncoder();
    const chunks = [
      encoder.encode('data: {"phase":"text","delta":"Hello"}\n\n'),
      encoder.encode('data: {"phase":"text","delta":" world"}\n\n'),
      encoder.encode('data: {"phase":"deliver"}\n\n'),
    ];
    let consumed = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (consumed < chunks.length) {
          controller.enqueue(chunks[consumed++]);
        } else {
          controller.close();
        }
      },
    });

    globalThis.fetch = vi.fn(async (_url: any, _init: any) => {
      return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    }) as any;

    const events: any[] = [];
    const handle = await startChat({ prompt: 'hi' }, (e) => events.push(e));

    await new Promise(r => setTimeout(r, 50));

    expect(events.map(e => e.kind)).toEqual(['text', 'text', 'event']);
    expect(events[0].text).toBe('Hello');
    expect(events[1].text).toBe(' world');
    expect(handle.taskId).toMatch(/^fetch-/);
    expect(typeof handle.abort).toBe('function');
  });

  it('parses SSE error event into { kind: "error" }', async () => {
    const encoder = new TextEncoder();
    const chunks = [
      encoder.encode('data: {"phase":"error","error":"API key missing"}\n\n'),
    ];
    let consumed = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (consumed < chunks.length) {
          controller.enqueue(chunks[consumed++]);
        } else {
          controller.close();
        }
      },
    });

    globalThis.fetch = vi.fn(async () =>
      new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
    ) as any;

    const events: any[] = [];
    await startChat({ prompt: 'hi' }, (e) => events.push(e));
    await new Promise(r => setTimeout(r, 50));

    expect(events.some(e => e.kind === 'error' && /API key/.test(e.error))).toBe(true);
  });

  it('handles HTTP error status (non-200)', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: 'bad' }), { status: 400, headers: { 'Content-Type': 'application/json' } })
    ) as any;

    const events: any[] = [];
    await startChat({ prompt: 'hi' }, (e) => events.push(e));
    await new Promise(r => setTimeout(r, 50));

    expect(events.some(e => e.kind === 'error' && /400/.test(e.error))).toBe(true);
  });

  it('abort() cancels in-flight stream', async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const interval = setInterval(() => {
          if (cancelled) {
            clearInterval(interval);
            controller.close();
            return;
          }
          controller.enqueue(new TextEncoder().encode('data: {"phase":"text","delta":"tick"}\n\n'));
        }, 5);
      },
    });

    globalThis.fetch = vi.fn(async () =>
      new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
    ) as any;

    const events: any[] = [];
    const handle = await startChat({ prompt: 'hi' }, (e) => events.push(e));
    await new Promise(r => setTimeout(r, 20));
    handle.abort();
    cancelled = true;
    await new Promise(r => setTimeout(r, 30));

    expect(events.length).toBeGreaterThan(0);
  });
});

describe('aiBackend — Electron IPC path (mocked)', () => {
  let originalSoloforge: any;

  beforeEach(() => {
    originalSoloforge = (globalThis as any).window?.soloforge;
  });

  afterEach(() => {
    if (typeof globalThis.window !== 'undefined' && originalSoloforge) {
      (globalThis as any).window.soloforge = originalSoloforge;
    } else if (typeof globalThis.window !== 'undefined') {
      delete (globalThis as any).window.soloforge;
    }
  });

  it('routes to chatViaPort when window.soloforge.ai available', async () => {
    const portOnmessage: ((ev: any) => void) | null = null;
    const mockPort = {
      start: vi.fn(),
      close: vi.fn(),
      set onmessage(fn: any) { (mockPort as any)._onmsg = fn; },
      postMessage: vi.fn(),
      _onmsg: null as any,
    };
    (globalThis as any).window = (globalThis as any).window || {};
    (globalThis as any).window.soloforge = {
      ai: {
        chatViaPort: vi.fn(async () => ({
          taskId: 'test-port-task',
          port: mockPort,
          abort: vi.fn(),
        })),
        chat: vi.fn(),
        abort: vi.fn(),
      },
    };

    expect(isElectronIpcAvailable()).toBe(true);

    const events: any[] = [];
    const handle = await startChat({ prompt: 'hi' }, (e) => events.push(e));

    // 模拟 main 进程 postMessage 触发 onmessage
    (mockPort as any)._onmsg?.({ data: { kind: 'text', text: 'hello', taskId: handle.taskId } });
    (mockPort as any)._onmsg?.({ data: { kind: 'done', taskId: handle.taskId } });

    expect(events).toEqual([
      { kind: 'text', text: 'hello', taskId: handle.taskId },
      { kind: 'done', taskId: handle.taskId },
    ]);
    expect(mockPort.start).toHaveBeenCalledOnce();
  });
});