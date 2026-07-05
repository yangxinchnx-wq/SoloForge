/**
 * MockLLMProvider.ts — 测试用的 mock LLM provider
 *
 * 用途：
 *   - 单元测试（无需真实 API key）
 *   - e2e 测试复现
 *   - 离线开发
 *
 * 数据源：内置 default mock payload (生产安全, 无测试 fixture 依赖)
 *   - 测试时可通过构造函数 options.payload 覆盖
 *   - 原始 tests/fixtures/scenarios.ts 仍供 vitest 单测使用
 * 行为：按字符切分 + 可配置延迟，模拟真实 SSE 流
 */

import type { LLMProvider, LLMRequest, LLMStreamHandle } from './types';
import type { PreviewPayload } from '../canvas/UniversalAST';

// ── 内置默认 mock payload (生产安全) ──
const DEFAULT_MOCK_PAYLOAD: PreviewPayload = {
  language: 'typescript',
  framework: 'React',
  source_code: '// Mock preview\nexport default function App() {\n  return <div>Hello SoloForge</div>;\n}',
  preview: {
    root: {
      type: 'column',
      style: { padding: 16, gap: 12, background: '#f8fafc' },
      children: [
        { type: 'text', content: 'SoloForge Preview', style: { fontSize: 20, fontWeight: 700, color: '#1e293b' } },
        { type: 'text', content: 'Mock LLM provider active', style: { fontSize: 13, color: '#64748b' } },
        { type: 'input', placeholder: 'Enter text...', style: { radius: 8 } },
        { type: 'row', style: { gap: 8 }, children: [
          { type: 'button', label: 'Submit', variant: 'filled' },
          { type: 'button', label: 'Cancel', variant: 'outlined' },
        ]},
      ],
    },
  },
};

export interface MockLLMProviderOptions {
  /** 单字符延迟（默认 4ms — 模拟真实网络） */
  charDelayMs?: number;
  /** 最大字符数（截断 mock 响应，避免超长 fixture 超时） */
  maxChars?: number;
  /** 自定义 payload (测试时注入 scenarios fixture) */
  payload?: PreviewPayload;
}

export class MockLLMProvider implements LLMProvider {
  readonly name = 'mock';
  private charDelayMs: number;
  private maxChars: number;
  private payload: PreviewPayload;

  constructor(options: MockLLMProviderOptions = {}) {
    this.charDelayMs = options.charDelayMs ?? 4;
    this.maxChars = options.maxChars ?? 2000;
    this.payload = options.payload ?? DEFAULT_MOCK_PAYLOAD;
  }

  chatStream(req: LLMRequest): LLMStreamHandle {
    let text = JSON.stringify(this.payload);
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
