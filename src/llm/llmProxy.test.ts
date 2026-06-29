/**
 * llmProxy.test.ts — 后端 LLM 代理模块单测
 *
 * 测试范围：
 *   - llmConfig 加载与脱敏
 *   - openaiStreamClient 在 fetch mock 下的行为
 *   - llmProxyHandler 的参数校验 / token 校验 / SSE 输出
 *
 * 运行：cd SoloForge && npx vitest run src/llm/llmProxy.test.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  getLLMProxyConfig,
  setLLMProxyConfig,
  resetLLMProxyConfig,
  isLLMProxyReady,
  describeLLMProxyConfig,
} from './llmConfig';
import { streamOpenAIChat } from './openaiStreamClient';
import { handleLLMStreamProxy, handleLLMConfigGet } from './llmProxyHandler';

describe('llmConfig', () => {
  beforeEach(() => resetLLMProxyConfig());

  it('default config: apiKey empty, ready=false', () => {
    const cfg = getLLMProxyConfig();
    expect(cfg.provider).toBeTruthy();
    expect(cfg.apiKey).toBe('');
    expect(isLLMProxyReady()).toBe(false);
  });

  it('setLLMProxyConfig marks ready when apiKey present', () => {
    setLLMProxyConfig({ apiKey: 'sk-test', baseUrl: 'https://x.com/v1', defaultModel: 'gpt-x' });
    expect(isLLMProxyReady()).toBe(true);
  });

  it('describeLLMProxyConfig redacts apiKey', () => {
    setLLMProxyConfig({ apiKey: 'sk-supersecret', baseUrl: 'https://x.com/v1', defaultModel: 'gpt-x' });
    const d = describeLLMProxyConfig();
    const serialized = JSON.stringify(d);
    expect(serialized).not.toContain('sk-supersecret');
    expect(d.provider).toBeTruthy();
    expect(d.ready).toBe(true);
  });

  it('apiToken empty -> tokenRequired=false', () => {
    setLLMProxyConfig({ apiKey: 'k', baseUrl: 'https://x.com/v1', defaultModel: 'm', apiToken: '' });
    expect(describeLLMProxyConfig().tokenRequired).toBe(false);
  });

  it('apiToken non-empty -> tokenRequired=true', () => {
    setLLMProxyConfig({ apiKey: 'k', baseUrl: 'https://x.com/v1', defaultModel: 'm', apiToken: 't' });
    expect(describeLLMProxyConfig().tokenRequired).toBe(true);
  });
});

describe('openaiStreamClient', () => {
  beforeEach(() => {
    setLLMProxyConfig({ apiKey: 'sk-test', baseUrl: 'https://api.example.com/v1', defaultModel: 'gpt-x' });
  });

  it('throws when apiKey is empty', async () => {
    setLLMProxyConfig({ apiKey: '' });
    const it1 = streamOpenAIChat({ messages: [{ role: 'user', content: 'hi' }] });
    await expect(it1.next()).rejects.toThrow(/apiKey/);
  });

  it('parses SSE chunks from fetch', async () => {
    const encoder = new TextEncoder();
    const sseBody =
      'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n' +
      'data: {"choices":[{"delta":{"content":" world"}}]}\n\n' +
      'data: [DONE]\n\n';
    const mockBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(sseBody));
        controller.close();
      },
    });
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      body: mockBody,
    })) as unknown as typeof fetch;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).fetch = fetchMock;

    const deltas: string[] = [];
    let doneSeen = false;
    for await (const chunk of streamOpenAIChat({ messages: [{ role: 'user', content: 'hi' }] })) {
      if (chunk.done) { doneSeen = true; break; }
      deltas.push(chunk.delta);
    }
    expect(deltas.join('')).toBe('hello world');
    expect(doneSeen).toBe(true);
  });

  it('propagates HTTP error', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 401,
      text: async () => 'unauthorized',
    })) as unknown as typeof fetch;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).fetch = fetchMock;
    const it1 = streamOpenAIChat({ messages: [{ role: 'user', content: 'hi' }] });
    await expect(it1.next()).rejects.toThrow(/HTTP 401/);
  });
});

describe('llmProxyHandler', () => {
  beforeEach(() => {
    setLLMProxyConfig({ apiKey: 'sk-test', baseUrl: 'https://api.example.com/v1', defaultModel: 'gpt-x', apiToken: '' });
  });

  function makeRes() {
    const events: string[] = [];
    const headers: Record<string, string | number> = {};
    const res = {
      writeHead: (s: number, h: Record<string, string | number>) => { headers.status = s; Object.assign(headers, h); },
      write: (chunk: string) => { events.push(chunk); return true; },
      end: () => { events.push('<<END>>'); },
      on: () => {},
      events,
      headers,
    };
    return res;
  }

  function makeReq(headers: Record<string, string> = {}) {
    return { headers, on: () => {} } as any;
  }

  it('returns 503 when not configured', async () => {
    setLLMProxyConfig({ apiKey: '' });
    const r = await handleLLMStreamProxy(makeReq(), makeRes() as any, { userGoal: 'hi' });
    expect(r.status).toBe(503);
  });

  it('returns 400 on missing userGoal', async () => {
    const r = await handleLLMStreamProxy(makeReq(), makeRes() as any, { foo: 'bar' });
    expect(r.status).toBe(400);
  });

  it('returns 401 when token mismatched', async () => {
    setLLMProxyConfig({ apiToken: 'secret' });
    const r = await handleLLMStreamProxy(makeReq({ 'x-soloforge-token': 'wrong' }), makeRes() as any, { userGoal: 'hi' });
    expect(r.status).toBe(401);
  });

  it('writes SSE chunks when configured + token ok', async () => {
    const encoder = new TextEncoder();
    const sseBody =
      'data: {"choices":[{"delta":{"content":"A"}}]}\n\n' +
      'data: [DONE]\n\n';
    const mockBody = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(encoder.encode(sseBody)); controller.close(); },
    });
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, body: mockBody })) as unknown as typeof fetch;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).fetch = fetchMock;

    const res = makeRes();
    const r = await handleLLMStreamProxy(makeReq(), res as any, { userGoal: 'hi' });
    expect(r.status).toBe(200);
    expect((r as any).stream).toBe(true);
    const joined = res.events.join('');
    expect(joined).toContain('"delta":"A"');
    expect(joined).toContain('"done":true');
  });

  it('handleLLMConfigGet returns descriptor', () => {
    const r = handleLLMConfigGet();
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.body)).not.toContain('sk-test');
  });
});
