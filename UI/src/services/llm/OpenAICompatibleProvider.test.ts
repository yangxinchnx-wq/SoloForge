/**
 * OpenAICompatibleProvider.test.ts — OpenAI 兼容客户端单测
 *
 * 用 stub fetch 验证：
 *   1. 构造正确的请求 URL/headers/body
 *   2. 解析 SSE 格式（data: {...} / data: [DONE]）
 *   3. 取消时触发 abort
 *   4. 网络错误抛出
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OpenAICompatibleProvider } from './OpenAICompatibleProvider';

function makeSSEStream(lines: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const data = lines.map((l) => `data: ${l}\n\n`).join('') + 'data: [DONE]\n\n';
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(data));
      controller.close();
    },
  });
}

function makeFetchOk(body: ReadableStream<Uint8Array>) {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    body,
    text: async () => '',
  }));
}

describe('OpenAICompatibleProvider', () => {
  let originalFetch: typeof fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  it('parses SSE chunks', async () => {
    const stream = makeSSEStream([
      JSON.stringify({ choices: [{ delta: { content: 'hello' } }] }),
      JSON.stringify({ choices: [{ delta: { content: ' ' } }] }),
      JSON.stringify({ choices: [{ delta: { content: 'world' } }] }),
    ]);
    globalThis.fetch = makeFetchOk(stream);

    const provider = new OpenAICompatibleProvider('test', {
      baseUrl: 'https://example.com/v1',
      defaultModel: 'test-model',
      apiKey: 'sk-test',
    });

    const handle = provider.chatStream({ userGoal: 'hi' });
    let received = '';
    for await (const chunk of handle) {
      received += chunk;
    }
    expect(received).toBe('hello world');
    await handle.done;
  });

  it('sends correct request shape', async () => {
    let capturedUrl = '';
    let capturedInit: any = null;
    const stream = makeSSEStream([JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })]);
    globalThis.fetch = vi.fn(async (url: any, init: any) => {
      capturedUrl = url;
      capturedInit = init;
      return { ok: true, status: 200, body: stream, text: async () => '' };
    });

    const provider = new OpenAICompatibleProvider('test', {
      baseUrl: 'https://example.com/v1',
      defaultModel: 'm1',
      apiKey: 'k',
    });

    const handle = provider.chatStream({
      systemPrompt: 'sys',
      userGoal: 'goal',
      temperature: 0.5,
      maxTokens: 100,
    });
    let received = '';
    for await (const chunk of handle) received += chunk;

    expect(capturedUrl).toBe('https://example.com/v1/chat/completions');
    expect(capturedInit.method).toBe('POST');
    expect(capturedInit.headers.Authorization).toBe('Bearer k');
    expect(capturedInit.headers['Content-Type']).toBe('application/json');
    const body = JSON.parse(capturedInit.body);
    expect(body.model).toBe('m1');
    expect(body.stream).toBe(true);
    expect(body.messages[0]).toEqual({ role: 'system', content: 'sys' });
    expect(body.messages[1]).toEqual({ role: 'user', content: 'goal' });
  });

  it('cancel triggers abort', async () => {
    let aborted = false;
    const stream = new ReadableStream({
      async start(controller) {
        await new Promise((r) => setTimeout(r, 50));
        try {
          controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"x"}}]}\n\n'));
        } catch {
          /* ignore */
        }
      },
    });
    globalThis.fetch = vi.fn(async (_url: any, init: any) => {
      init.signal.addEventListener('abort', () => {
        aborted = true;
      });
      return { ok: true, status: 200, body: stream, text: async () => '' };
    });

    const provider = new OpenAICompatibleProvider('test', {
      baseUrl: 'https://example.com/v1',
      defaultModel: 'm1',
    });

    const handle = provider.chatStream({ userGoal: 'x' });
    // 必须先开始迭代，fetch 才会被调用，abort listener 才会注册
    const iterPromise = (async () => {
      for await (const _ of handle) { /* no-op */ }
    })();
    handle.cancel();
    await iterPromise.catch(() => {});
    expect(aborted).toBe(true);
  });

  it('throws on non-ok response', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      status: 401,
      body: null,
      text: async () => 'Unauthorized',
    })) as any;

    const provider = new OpenAICompatibleProvider('test', {
      baseUrl: 'https://example.com/v1',
      defaultModel: 'm1',
      apiKey: 'k',
    });

    const handle = provider.chatStream({ userGoal: 'x' });
    let error: Error | null = null;
    try {
      for await (const _ of handle) { /* no-op */ }
    } catch (e) {
      error = e as Error;
    }
    // 也检查 done Promise 的 reject
    try {
      await handle.done;
    } catch (e) {
      if (!error) error = e as Error;
    }
    expect(error).not.toBeNull();
    expect(error!.message).toContain('401');
  });

  it('trims trailing slash from baseUrl', async () => {
    let capturedUrl = '';
    const stream = makeSSEStream([JSON.stringify({ choices: [{ delta: { content: 'x' } }] })]);
    globalThis.fetch = vi.fn(async (url: any) => {
      capturedUrl = url;
      return { ok: true, status: 200, body: stream, text: async () => '' };
    });

    const provider = new OpenAICompatibleProvider('test', {
      baseUrl: 'https://example.com/v1/', // 末尾斜杠
      defaultModel: 'm1',
    });

    const handle = provider.chatStream({ userGoal: 'x' });
    for await (const _ of handle) { /* no-op */ }
    expect(capturedUrl).toBe('https://example.com/v1/chat/completions');
  });

  // 恢复
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });
});
