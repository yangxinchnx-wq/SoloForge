/**
 * MockLLMProvider.ts — 测试用的 mock LLM provider
 *
 * 用途：
 *   - 单元测试（无需真实 API key）
 *   - e2e 测试复现
 *   - 离线开发
 *
 * 数据源：tests/fixtures/scenarios.ts
 * 行为：按字符切分 + 可配置延迟，模拟真实 SSE 流
 */

import { scenarios } from '@tests/fixtures/scenarios';
import type { LLMProvider, LLMRequest, LLMStreamHandle } from './types';

export interface MockLLMProviderOptions {
  /** 单字符延迟（默认 4ms — 模拟真实网络） */
  charDelayMs?: number;
  /** 最大字符数（截断 mock 响应，避免超长 fixture 超时） */
  maxChars?: number;
}

export class MockLLMProvider implements LLMProvider {
  readonly name = 'mock';
  private charDelayMs: number;
  private maxChars: number;

  constructor(options: MockLLMProviderOptions = {}) {
    this.charDelayMs = options.charDelayMs ?? 4;
    this.maxChars = options.maxChars ?? 2000;
  }

  chatStream(req: LLMRequest): LLMStreamHandle {
    const prompt = (req.systemPrompt ?? '') + req.userGoal;
    const matched =
      scenarios.find((s) => prompt.includes(s.language)) ??
      scenarios.find((s) => prompt.toLowerCase().includes('login')) ??
      scenarios[0];

    let text = JSON.stringify(matched.payload);
    if (text.length > this.maxChars) {
      text = text.slice(0, this.maxChars);
    }
    const charDelay = this.charDelayMs;
    let cancelled = false;
    let resolveDone: () => void = () => {};
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });

    const iterator = (async function* () {
      try {
        for (const ch of text) {
          if (cancelled) return;
          if (charDelay > 0) {
            await new Promise<void>((resolve) => setTimeout(resolve, charDelay));
          }
          yield ch;
        }
      } finally {
        resolveDone();
      }
    })();

    return {
      cancel() {
        cancelled = true;
        resolveDone();
      },
      done,
      [Symbol.asyncIterator]() {
        return iterator[Symbol.asyncIterator]();
      },
    };
  }
}
