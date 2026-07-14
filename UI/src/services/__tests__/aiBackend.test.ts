/**
 * aiBackend unit tests
 *   验证 (Phase 3: Java Spring AI /api/java-agent/api/chat/send 路径):
 *     1. dev (无 window.soloforge.dispatchAgent) → 走 fetch
 *     2. 解析 JSON 响应 { success, content } → text + done 事件
 *     3. 处理 { success: false, error } → error 事件
 *     4. 处理 HTTP 错误状态 → error 事件
 *     5. abort() 取消 in-flight fetch
 *     6. isElectronIpcAvailable() 检测 dispatchAgent + onAgentEvent
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { startChat, isElectronIpcAvailable } from '../aiBackend';

describe('aiBackend — dev (fetch → Java Agent) path', () => {
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

  it('startChat fetches /api/java-agent/api/chat/send, parses { success, content } → text + done', async () => {
    const fetchSpy = vi.fn(async (_url: any, init: any) => {
      // 验证请求体映射为 Java DTO
      const body = JSON.parse(init.body);
      expect(body.message).toBe('hi');
      expect(body.stream).toBe(true);
      expect(body.settings.agentId).toBe('code_agent');
      return new Response(
        JSON.stringify({ success: true, content: 'Hello from Java', sessionId: 's1', agentId: 'code_agent' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    });
    globalThis.fetch = fetchSpy as any;

    const events: any[] = [];
    const handle = await startChat({ prompt: 'hi' }, (e) => events.push(e));

    await new Promise(r => setTimeout(r, 50));

    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(fetchSpy.mock.calls[0][0]).toBe('/api/java-agent/api/chat/stream');
    expect(events.map(e => e.kind)).toEqual(['text', 'done']);
    expect(events[0].text).toBe('Hello from Java');
    expect(handle.taskId).toMatch(/^java-/);
    expect(typeof handle.abort).toBe('function');
  });

  it('parses { success: false, error } → error event', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({ success: false, error: 'LLM provider not configured' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    ) as any;

    const events: any[] = [];
    await startChat({ prompt: 'hi' }, (e) => events.push(e));
    await new Promise(r => setTimeout(r, 50));

    expect(events.some(e => e.kind === 'error' && /LLM provider/.test(e.error))).toBe(true);
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

  it('maps mainProvider + activeSettings to Java DTO', async () => {
    let capturedBody: any;
    globalThis.fetch = vi.fn(async (_url: any, init: any) => {
      capturedBody = JSON.parse(init.body);
      return new Response(
        JSON.stringify({ success: true, content: 'ok' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }) as any;

    await startChat(
      {
        prompt: 'test',
        chatId: 'chat-123',
        mainProvider: { baseUrl: 'https://api.example.com', apiKey: 'sk-xxx', model: 'gpt-4o' },
        activeSettings: { personality: 'geek', tone: 'concise', emojiEnabled: true, emojiType: 'kaomoji' },
        activeSkills: ['skill-1'],
        activeKnowledge: ['kb-1'],
        workspaceFolder: '/tmp/work',
        agentId: 'plan_agent',
      },
      () => {}
    );
    await new Promise(r => setTimeout(r, 30));

    expect(capturedBody.message).toBe('test');
    expect(capturedBody.sessionId).toBe('chat-123');
    expect(capturedBody.provider).toEqual({ baseUrl: 'https://api.example.com', apiKey: 'sk-xxx', model: 'gpt-4o' });
    expect(capturedBody.settings.agentId).toBe('plan_agent');
    expect(capturedBody.settings.personality).toBe('geek');
    expect(capturedBody.settings.tone).toBe('concise');
    expect(capturedBody.settings.emojiMode).toBe('kaomoji');
    expect(capturedBody.settings.enabledSkills).toEqual(['skill-1']);
    expect(capturedBody.settings.enabledKnowledge).toEqual(['kb-1']);
    expect(capturedBody.settings.workspaceFolder).toBe('/tmp/work');
    expect(capturedBody.stream).toBe(true);
  });

  it('abort() cancels in-flight fetch', async () => {
    let abortSignal: AbortSignal | null = null;
    globalThis.fetch = vi.fn(async (_url: any, init: any) => {
      abortSignal = init.signal;
      // 模拟长时间挂起的请求
      return new Promise<Response>((_resolve, reject) => {
        const timer = setTimeout(() => {
          _resolve(new Response(JSON.stringify({ success: true, content: 'late' }), { status: 200 }));
        }, 5000);
        abortSignal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new DOMException('Aborted', 'AbortError'));
        });
      });
    }) as any;

    const events: any[] = [];
    const handle = await startChat({ prompt: 'hi' }, (e) => events.push(e));
    await new Promise(r => setTimeout(r, 10));
    handle.abort();
    await new Promise(r => setTimeout(r, 30));

    // abort 后不应有 done 事件 (只有 AbortError 被静默吞掉)
    expect(events.some(e => e.kind === 'done')).toBe(false);
    expect(abortSignal?.aborted).toBe(true);
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

  it('isElectronIpcAvailable() returns true when dispatchAgent + onAgentEvent exposed', () => {
    (globalThis as any).window = (globalThis as any).window || {};
    (globalThis as any).window.soloforge = {
      dispatchAgent: vi.fn(async () => ({ ok: true, body: { content: 'hi' } })),
      onAgentEvent: vi.fn(() => vi.fn()), // returns unsubscribe
    };

    expect(isElectronIpcAvailable()).toBe(true);
  });

  it('isElectronIpcAvailable() returns false when only dispatchAgent exposed (missing onAgentEvent)', () => {
    (globalThis as any).window = (globalThis as any).window || {};
    (globalThis as any).window.soloforge = {
      dispatchAgent: vi.fn(async () => ({ ok: true })),
      // onAgentEvent missing
    };

    expect(isElectronIpcAvailable()).toBe(false);
  });
});
