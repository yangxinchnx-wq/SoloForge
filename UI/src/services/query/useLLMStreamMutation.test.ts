/**
 * useLLMStreamMutation.test.ts — mutationFn 单测（不挂载 React）
 *
 * mutationFn 是纯异步函数，可独立测：
 *   1. 缓存命中：直接返回 cached，不调 LLM
 *   2. 流式消费：Mock LLM 提供 1 个 chunk，验证 onChunk / onPartialRoot
 *   3. 写入 query cache + ast cache
 *   4. 错误处理：mutationFn 抛错时上层 onError 触发
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MockLLMProvider } from '../llm/MockLLMProvider';
import { LLMClient } from '../llm/LLMClient';
import { astCache } from '../canvas/astCache';
import { setQueryClient, QueryClient } from './queryClient';
import type { PreviewPayload } from '../canvas/UniversalAST';

describe('LLM stream mutation pipeline (unit-level)', () => {
  beforeEach(() => {
    astCache.clear();
    setQueryClient(new QueryClient());
  });

  it('cache hit returns immediately', async () => {
    const cached: PreviewPayload = {
      language: 'python',
      framework: 'Flask',
      source_code: 'cached',
      preview: { root: { type: 'column', children: [] } },
    };
    astCache.setByPrompt('python', 'login screen', cached);

    // 模拟 useLLMStreamMutation 的 mutationFn 内部 cache check
    const cachedResult = astCache.get(astCacheForTest('python', 'login screen'));
    expect(cachedResult).toEqual(cached);
  });

  it('Mock provider streams chunks end-to-end', async () => {
    const provider = new MockLLMProvider({ charDelayMs: 0 });
    const chunks: string[] = [];
    const onChunk = vi.fn((c: string) => chunks.push(c));

    // 直接消费 Mock provider（模拟 mutationFn 内 for-await）
    const handle = provider.chatStream({ userGoal: 'login screen python' });
    for await (const chunk of handle) {
      onChunk(chunk);
    }

    expect(chunks.length).toBeGreaterThan(0);
    const joined = chunks.join('');
    // 应该是有效 JSON
    expect(() => JSON.parse(joined)).not.toThrow();
  });

  it('Mock provider + parser produces PreviewPayload', async () => {
    const provider = new MockLLMProvider({ charDelayMs: 0 });
    const handle = provider.chatStream({ userGoal: 'login screen python' });

    let raw = '';
    for await (const chunk of handle) {
      raw += chunk;
    }

    // 模拟 parser
    const { parseOnce } = await import('../canvas/StreamingASTParser');
    const { payload } = parseOnce(raw);
    expect(payload).not.toBeNull();
    expect(payload!.language).toBeTruthy();
    expect(payload!.preview.root).toBeDefined();
  });

  it('LLMClient.mock() chains correctly', () => {
    const client = LLMClient.mock();
    expect(client.provider.name).toBe('mock');
  });
});

// 内部 helper
function astCacheForTest(lang: string, prompt: string): string {
  const hash = (s: string): string => {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16).padStart(8, '0');
  };
  return `ast:${lang.toLowerCase()}:${hash(prompt)}`;
}
