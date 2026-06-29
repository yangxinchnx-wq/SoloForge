/**
 * tests/fixtures/mockLLMStream.ts — 模拟 LLM 流式输出
 *
 * 把 PreviewPayload 切成字符级 chunks，模拟真实 LLM SSE 行为。
 * 用于：
 *   - vitest 单元测试（feedChunk 验证）
 *   - 手动测试时复现真实场景
 *
 * 用法：
 *   const handle = startMockStream(payload, (chunk) => parser.feedChunk(state, chunk));
 *   await handle.done;
 */

import type { PreviewPayload } from '../../src/services/canvas/UniversalAST';

export interface StreamHandle {
  cancel: () => void;
  done: Promise<void>;
}

export interface MockStreamOptions {
  /** 单字符延迟（默认 4ms） */
  charDelayMs?: number;
  /** 每个 chunk 之间的间隔（默认 30ms） */
  chunkDelayMs?: number;
  /** 自定义随机种子（测试时固定） */
  seed?: number;
}

function makeChunks(payload: PreviewPayload, seed?: number): string[] {
  const text = JSON.stringify(payload);
  const chunks: string[] = [];
  let i = 0;
  let s = seed ?? Math.floor(Math.random() * 1000);
  while (i < text.length) {
    // 用 mulberry32 简单 PRNG 替代 Math.random 让结果可复现
    s = (s + 0x6d2b79f5) | 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    const r = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    const size = 8 + Math.floor(r * 32);
    chunks.push(text.slice(i, i + size));
    i += size;
  }
  return chunks;
}

/**
 * 启动 mock 流（同步返回一个 handle）
 * @param payload 要流的 PreviewPayload
 * @param onChunk 每个字符到达时调用（粒度比 chunk 更细）
 * @param options 调速 / 种子
 */
export function startMockLLMStream(
  payload: PreviewPayload,
  onChunk: (chunk: string) => void,
  options: MockStreamOptions = {},
): StreamHandle {
  const charDelay = options.charDelayMs ?? 4;
  const chunkDelay = options.chunkDelayMs ?? 30;
  let cancelled = false;
  const timeouts: ReturnType<typeof setTimeout>[] = [];

  const donePromise = (async () => {
    const chunks = makeChunks(payload, options.seed);
    for (const chunk of chunks) {
      if (cancelled) return;
      for (const ch of chunk) {
        if (cancelled) return;
        await new Promise<void>((resolve) => {
          const id = setTimeout(() => {
            onChunk(ch);
            resolve();
          }, charDelay);
          timeouts.push(id);
        });
      }
      if (chunkDelay > 0) {
        await new Promise<void>((resolve) => {
          const id = setTimeout(resolve, chunkDelay);
          timeouts.push(id);
        });
      }
    }
  })();

  return {
    cancel: () => {
      cancelled = true;
      timeouts.forEach(clearTimeout);
    },
    done: donePromise,
  };
}

/**
 * 同步版本：一次性返回所有 chunks（用于单测）
 */
export function generateMockChunks(payload: PreviewPayload, options: { chunkSize?: number } = {}): string[] {
  const text = JSON.stringify(payload);
  const size = options.chunkSize ?? 16;
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += size) {
    chunks.push(text.slice(i, i + size));
  }
  return chunks;
}
