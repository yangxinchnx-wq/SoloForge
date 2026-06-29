/**
 * parserWorkerClient.test.ts — Worker 客户端单测（强制 in-thread 模式）
 *
 * 在 Node 环境（无 Worker）下，client 必须 fallback 到 in-thread，
 * 所有 API 行为与直接 parser 一致。
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { parserWorkerClient, _resetParserWorkerClient } from './parserWorkerClient';
import { createStreamState, feedChunk as directFeed } from './StreamingASTParser';

describe('parserWorkerClient (in-thread fallback)', () => {
  beforeEach(() => {
    _resetParserWorkerClient();
    parserWorkerClient.mode = 'thread'; // 强制 fallback
  });

  it('mode=thread always uses fallback (isUsingWorker=false)', () => {
    expect(parserWorkerClient.isUsingWorker).toBe(false);
  });

  it('feedChunk returns same result as direct parser', async () => {
    const raw = '{"language":"python","preview":{"root":{"type":"column","children":[]}}}';
    const clientState = await parserWorkerClient.feedChunk(createStreamState(), raw);
    const directState = directFeed(createStreamState(), raw);
    expect(clientState.payload).toEqual(directState.payload);
    expect(clientState.errors).toEqual(directState.errors);
  });

  it('handles incremental chunks correctly', async () => {
    let state = createStreamState();
    const chunks = ['{"language":"py', 'thon","preview":{"root":', '{"type":"text","props":{}}}'];
    for (const c of chunks) {
      state = await parserWorkerClient.feedChunk(state, c);
    }
    expect(state.errors).toContain('repaired-truncation');
    expect((state.payload as any)?.preview?.root?.type).toBe('text');
  });

  it('end() marks state as done', async () => {
    let state = createStreamState();
    state = await parserWorkerClient.feedChunk(state, '{}');
    expect(state.done).toBe(false);
    state = await parserWorkerClient.end(state);
    expect(state.done).toBe(true);
  });

  it('reset() returns fresh state', async () => {
    let state = createStreamState();
    state = await parserWorkerClient.feedChunk(state, '{"language":"python"}');
    expect(state.raw.length).toBeGreaterThan(0);
    const fresh = await parserWorkerClient.reset();
    expect(fresh.raw).toBe('');
    expect(fresh.payload).toBeNull();
  });

  it('parseOnce() works for complete input', async () => {
    const raw = '{"language":"python","preview":{"root":{"type":"text","props":{}}}}';
    const r = await parserWorkerClient.parseOnce(raw);
    expect(r.errors).toHaveLength(0);
    expect(r.payload?.preview?.root?.type).toBe('text');
  });

  it('parseOnce() reports errors for invalid input', async () => {
    const r = await parserWorkerClient.parseOnce('not json at all');
    expect(r.errors.length).toBeGreaterThan(0);
    expect(r.payload).toBeNull();
  });
});

describe('parserWorkerClient (auto mode in Node)', () => {
  beforeEach(() => {
    _resetParserWorkerClient();
  });

  it('auto mode in Node falls back to in-thread (no Worker)', () => {
    // 实际环境是 Node，没有 Worker
    expect(parserWorkerClient.isUsingWorker).toBe(false);
  });

  it('feedChunk still works in auto mode (via fallback)', async () => {
    const raw = '{"language":"python","preview":{"root":{"type":"text","props":{}}}}';
    const state = await parserWorkerClient.feedChunk(createStreamState(), raw);
    expect(state.payload).toBeTruthy();
  });
});
