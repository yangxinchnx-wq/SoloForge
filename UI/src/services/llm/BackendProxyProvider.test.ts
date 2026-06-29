/**
 * BackendProxyProvider.test.ts — 前端 BackendProxyProvider 单测
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BackendProxyProvider } from './BackendProxyProvider';
import { LLMClient } from './LLMClient';

describe('BackendProxyProvider', () => {
  const originalFetch = globalThis.fetch;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).fetch = fetchMock;
  });

  afterEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).fetch = originalFetch;
  });

  function makeSseBody(chunks: Array<{ delta?: string; done?: boolean; error?: string }>): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    const text = chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join('');
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(text));
        controller.close();
      },
    });
  }

  it('parses SSE deltas from backend', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      body: makeSseBody([
        { delta: 'hello' },
        { delta: ' ' },
        { delta: 'world' },
        { done: true },
      ]),
    });

    const provider = new BackendProxyProvider({ baseUrl: 'x', apiKey: 'k', apiBase: 'http://localhost:3001', defaultModel: 'gpt-x' });
    const handle = provider.chatStream({ userGoal: 'hi', systemPrompt: 'sys' });

    const deltas: string[] = [];
    for await (const c of handle) deltas.push(c);
    expect(deltas.join('')).toBe('hello world');
    await handle.done;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:3001/api/llm/stream');
    expect((init as any).method).toBe('POST');
  });

  it('sends X-SoloForge-Token when token configured', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      body: makeSseBody([{ done: true }]),
    });
    const provider = new BackendProxyProvider({ baseUrl: 'x', apiKey: 'k', apiBase: 'http://h:3001', defaultModel: 'm', token: 'secret' });
    const handle = provider.chatStream({ userGoal: 'x' });
    for await (const _ of handle) { /* drain */ }
    const [, init] = fetchMock.mock.calls[0];
    expect((init as any).headers['X-SoloForge-Token']).toBe('secret');
  });

  it('propagates error from SSE payload', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      body: makeSseBody([{ error: 'upstream exploded' }, { done: true }]),
    });
    const provider = new BackendProxyProvider({ baseUrl: 'x', apiKey: 'k', apiBase: 'http://h:3001', defaultModel: 'm' });
    const handle = provider.chatStream({ userGoal: 'x' });
    handle.done.catch(() => {}); // 抑制 unhandled rejection
    await expect(async () => { for await (const _ of handle) { /* drain */ } }).rejects.toThrow(/upstream exploded/);
  });

  it('propagates HTTP 5xx error', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 502, text: async () => 'bad gateway' });
    const provider = new BackendProxyProvider({ baseUrl: 'x', apiKey: 'k', apiBase: 'http://h:3001', defaultModel: 'm' });
    const handle = provider.chatStream({ userGoal: 'x' });
    handle.done.catch(() => {}); // 抑制 unhandled rejection
    await expect(async () => { for await (const _ of handle) { /* drain */ } }).rejects.toThrow(/HTTP 502/);
  });

  it('cancel() aborts in-flight request', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      body: makeSseBody([{ delta: 'A' }]),
    });
    const provider = new BackendProxyProvider({ baseUrl: 'x', apiKey: 'k', apiBase: 'http://h:3001', defaultModel: 'm' });
    const handle = provider.chatStream({ userGoal: 'x' });
    handle.cancel();
    expect(typeof handle.cancel).toBe('function');
  });
});

describe('LLMClient.fromBackend', () => {
  it('returns a client whose provider is BackendProxyProvider', () => {
    const c = LLMClient.fromBackend({ apiBase: 'http://localhost:3001' });
    expect(c.provider.name).toBe('backend-proxy');
  });

  it('fromEnv with provider=backend uses fromBackend', () => {
    process.env.LLM_PROVIDER = 'backend';
    const c = LLMClient.fromEnv();
    expect(c.provider.name).toBe('backend-proxy');
    delete process.env.LLM_PROVIDER;
  });

  it('fromEnv with no apiKey defaults to backend (auto)', () => {
    delete process.env.LLM_API_KEY;
    delete process.env.LLM_PROVIDER;
    process.env.LLM_PROVIDER = 'auto';
    const c = LLMClient.fromEnv();
    expect(c.provider.name).toBe('backend-proxy');
    delete process.env.LLM_PROVIDER;
  });
});
