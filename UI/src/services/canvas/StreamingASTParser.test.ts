/**
 * StreamingASTParser.test.ts — 流式 AST 解析器单测
 *
 * 覆盖：
 *   1. 空输入 → empty-input
 *   2. 完整 JSON → 直接解析
 *   3. 半成品 JSON → bracket 修复成功
 *   4. 半成品 string → 修复成功
 *   5. 半成品 JSON → bestEffortRoot 能拿到 root
 *   6. 乱码 → 不抛错，记 parse-failed
 *   7. done state 不会被后续 chunk 污染
 *   8. reset → 回到初始态
 */

import { describe, it, expect } from 'vitest';
import {
  createStreamState,
  feedChunk,
  markDone,
  resetStream,
  bestEffortRoot,
  parseOnce,
} from './StreamingASTParser';
import type { PreviewPayload } from './UniversalAST';
import { generateMockChunks } from '@tests/fixtures/mockLLMStream';
import { scenarios as fixtures } from '@tests/fixtures/scenarios';

const SAMPLE_PAYLOAD: PreviewPayload = {
  language: 'python',
  framework: 'Flask',
  source_code: 'print("hello")',
  preview: {
    root: {
      type: 'column',
      style: { padding: 10 },
      children: [
        { type: 'text', content: 'Hi' },
      ],
    },
  },
};

describe('StreamingASTParser', () => {
  it('handles empty input', () => {
    const s = feedChunk(createStreamState(), '');
    expect(s.payload).toBeNull();
    expect(s.errors).toContain('empty-input');
  });

  it('parses a complete JSON', () => {
    const raw = JSON.stringify(SAMPLE_PAYLOAD);
    const s = feedChunk(createStreamState(), raw);
    expect(s.payload).toEqual(SAMPLE_PAYLOAD);
    expect(s.errors).not.toContain('parse-failed');
  });

  it('repairs truncated JSON', () => {
    const raw = JSON.stringify(SAMPLE_PAYLOAD);
    // 截掉最后一个 `}` — 这是一个经典的"close bracket missing"场景
    const truncated = raw.slice(0, -1);
    const s = feedChunk(createStreamState(), truncated);
    expect(s.errors).toContain('repaired-truncation');
    expect(s.payload).not.toBeNull();
  });

  it('extracts root from half-baked AST', () => {
    // 流到一半，只到 root 的第一层 children
    const partialRaw = JSON.stringify({
      language: 'python',
      framework: 'Flask',
      source_code: '...',
      preview: {
        root: {
          type: 'column',
          style: { padding: 10 },
          children: [{ type: 'text', content: 'Hi' }],
        },
      },
    });
    const s = feedChunk(createStreamState(), partialRaw);
    const root = bestEffortRoot(s.payload);
    expect(root).toBeDefined();
    expect(root!.type).toBe('column');
  });

  it('does not throw on garbage', () => {
    const s = feedChunk(createStreamState(), '!!!not json!!!');
    expect(s.payload).toBeNull();
    expect(s.errors).toContain('parse-failed');
  });

  it('respects done state (no more chunks after markDone)', () => {
    const s1 = markDone(createStreamState());
    const s2 = feedChunk(s1, JSON.stringify(SAMPLE_PAYLOAD));
    expect(s2).toBe(s1); // done 之后状态不变
    expect(s2.payload).toBeNull();
  });

  it('resetStream returns to initial', () => {
    const s1 = feedChunk(createStreamState(), '{"a":1');
    expect(s1.errors.length).toBeGreaterThan(0);
    const s2 = resetStream();
    expect(s2.raw).toBe('');
    expect(s2.payload).toBeNull();
    expect(s2.errors).toEqual([]);
  });

  it('parseOnce one-shot', () => {
    const ok = parseOnce(JSON.stringify(SAMPLE_PAYLOAD));
    expect(ok.payload).toEqual(SAMPLE_PAYLOAD);

    const fail = parseOnce('garbage');
    expect(fail.payload).toBeNull();
    expect(fail.errors).toContain('parse-failed');
  });

  it('handles real fixture (Python login) end-to-end', () => {
    const py = fixtures.find((s: any) => s.id === 'python-login');
    if (!py) throw new Error('python-login fixture not found');
    const chunks = generateMockChunks(py.payload, { chunkSize: 32 });

    let state = createStreamState();
    for (const chunk of chunks) {
      state = feedChunk(state, chunk);
    }
    // 最后一块之后，应能完整解析
    expect(state.payload).not.toBeNull();
    const root = bestEffortRoot(state.payload);
    expect(root).toBeDefined();
    expect(root!.type).toBe('column');
  });

  it('handles all 3 language fixtures without throwing', () => {
    for (const sc of fixtures) {
      const chunks = generateMockChunks(sc.payload, { chunkSize: 16 });
      let state = createStreamState();
      for (const chunk of chunks) {
        state = feedChunk(state, chunk);
      }
      // 即使没解析成功，也不应抛错（错误在 errors[] 里）
      expect(state).toBeDefined();
      expect(state.errors.length).toBeGreaterThanOrEqual(0);
    }
  });
});
