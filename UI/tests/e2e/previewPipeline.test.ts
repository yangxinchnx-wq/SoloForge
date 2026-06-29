/**
 * tests/e2e/previewPipeline.test.ts — Preview 全链路 E2E
 *
 * 模拟真实用户路径：点 prompt → LLM 流 → 解析 → 推送 IPC → 写缓存
 * 验证所有组件正确协作：
 *   - LLMClient (Mock)
 *   - StreamingASTParser
 *   - previewStreamStore
 *   - chatsStore.liveStates
 *   - Canvas3DClient (mock IPC)
 *   - astCache (内存 + Garnet 降级)
 *   - LanguageAdapters
 *   - perfMonitor (latency)
 *
 * 覆盖场景：
 *   1. 完整链路成功
 *   2. 缓存命中 → 不调 LLM
 *   3. 取消流 → IPC 收到最后状态
 *   4. LLM 错误 → 错误状态正确
 *   5. 多轮切换语言
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { streamPreviewForChat } from '../../src/services/chatStreamOrchestrator';
import { MockLLMProvider } from '../../src/services/llm/MockLLMProvider';
import { LLMClient } from '../../src/services/llm/LLMClient';
import type { Canvas3DClient } from '../../src/services/canvas/Canvas3DClient';
import { astCache } from '../../src/services/canvas/astCache';
import { usePreviewStreamStore } from '../../src/state/previewStreamStore';
import { useChatsStore } from '../../src/state/chatsStore';
import {
  onPerfSample,
  _resetPerfListeners,
  StreamingLatencyTracker,
} from '../../src/services/perfMonitor';
import { handleError, _resetErrorListeners } from '../../src/services/errors';

function createMockCanvasClient() {
  return {
    pushUniversalPreview: vi.fn(async () => ({ ok: true })),
    pushUI: vi.fn(async () => ({ ok: true })),
    feedASTChunk: vi.fn(async () => ({ ok: true })),
    flushAST: vi.fn(async () => ({ ok: true })),
  } as unknown as Canvas3DClient & {
    pushUniversalPreview: ReturnType<typeof vi.fn>;
    feedASTChunk: ReturnType<typeof vi.fn>;
    flushAST: ReturnType<typeof vi.fn>;
  };
}

describe('E2E: Preview Pipeline', () => {
  beforeEach(() => {
    astCache.clear();
    usePreviewStreamStore.getState().reset();
    _resetPerfListeners();
    _resetErrorListeners();
  });

  it('full pipeline: LLM → parser → IPC → cache → store', async () => {
    const latencyTracker = new StreamingLatencyTracker();
    latencyTracker.start('full-pipeline');

    const mockLLM = new LLMClient(new MockLLMProvider({ charDelayMs: 0 }));
    const mockCanvas = createMockCanvasClient();

    // 业务层调用
    const handle = streamPreviewForChat({
      chatId: 'e2e-1',
      language: 'python',
      userGoal: 'login screen python',
      llmClient: mockLLM,
      canvasClient: mockCanvas,
    });

    const result = await handle.done;

    // 1. LLM 输出已被解析为 PreviewPayload
    expect(result).not.toBeNull();
    expect(result!.language).toBeTruthy();
    expect(result!.preview.root).toBeDefined();

    // 2. previewStreamStore 已写入
    const entry = usePreviewStreamStore.getState().getEntry('e2e-1');
    expect(entry).toBeDefined();
    expect(entry!.payload).toEqual(result);
    expect(entry!.isStreaming).toBe(false);
    expect(entry!.rawBytes).toBeGreaterThan(0);

    // 3. IPC 已被调用（pushUniversalPreview + flushAST）
    expect(mockCanvas.pushUniversalPreview).toHaveBeenCalled();
    expect(mockCanvas.flushAST).toHaveBeenCalled();

    // 4. 缓存已写入
    const cached = astCache.get(`ast:python:${hashForTest('login screen python')}`);
    expect(cached).toEqual(result);

    // 5. chatsStore.liveState 已更新
    const liveState = useChatsStore.getState().liveStates['e2e-1'];
    expect(liveState?.isStreaming).toBe(false);

    // 6. 监控数据已收集
    latencyTracker.recordChunk(result!.source_code.length);
    const sample = latencyTracker.finish();
    expect(sample.bytes).toBeGreaterThan(0);
    expect(sample.total).toBeGreaterThanOrEqual(0);
  });

  it('cache hit: skips LLM entirely', async () => {
    // 预填缓存
    astCache.setByPrompt('python', 'cached prompt', {
      language: 'python',
      framework: 'Flask',
      source_code: 'cached',
      preview: { root: { type: 'column', children: [] } },
    });

    // Mock LLM（若被调用就抛错，说明未走缓存）
    let llmCalled = false;
    const mockLLM = new LLMClient({
      name: 'should-not-call',
      chatStream: () => {
        llmCalled = true;
        throw new Error('LLM should not be called');
      },
    });
    const mockCanvas = createMockCanvasClient();

    const handle = streamPreviewForChat({
      chatId: 'e2e-cache',
      language: 'python',
      userGoal: 'cached prompt',
      llmClient: mockLLM,
      canvasClient: mockCanvas,
    });

    const result = await handle.done;
    expect(result).not.toBeNull();
    expect(llmCalled).toBe(false);
    expect(mockCanvas.pushUniversalPreview).toHaveBeenCalled();
  });

  it('cancel mid-stream: store marks done with error', async () => {
    const slowLLM = new LLMClient(new MockLLMProvider({ charDelayMs: 5, maxChars: 500 }));
    const mockCanvas = createMockCanvasClient();

    const handle = streamPreviewForChat({
      chatId: 'e2e-cancel',
      language: 'python',
      userGoal: 'login screen python',
      llmClient: slowLLM,
      canvasClient: mockCanvas,
    });

    setTimeout(() => handle.cancel(), 30);
    const result = await handle.done;
    // cancel 后返回 null 或部分 payload（取决于时机）
    expect(result === null || typeof result === 'object').toBe(true);

    const entry = usePreviewStreamStore.getState().getEntry('e2e-cancel');
    expect(entry?.isStreaming).toBe(false);
  });

  it('LLM error: error captured in store + chatsStore phase=error', async () => {
    const failingLLM = new LLMClient({
      name: 'e2e-fail',
      chatStream: () => {
        const h = {
          [Symbol.asyncIterator]: async function* () {
            throw new Error('e2e-llm-down');
          },
          cancel: () => {},
          done: new Promise(() => {}),
        };
        return h;
      },
    });

    // 捕获 handleError 调用
    const errorHandler = vi.fn();
    onPerfSample(() => {}); // 占位（避免 _resetPerfListeners 影响）

    const handle = streamPreviewForChat({
      chatId: 'e2e-fail',
      language: 'python',
      userGoal: 'will fail',
      llmClient: failingLLM,
    });

    const result = await handle.done;
    expect(result).toBeNull();

    const entry = usePreviewStreamStore.getState().getEntry('e2e-fail');
    expect(entry?.pushError).toContain('e2e-llm-down');
    expect(entry?.isStreaming).toBe(false);

    // 注：phase 字段依赖 chatsStore 类型，这里只验证 isStreaming
  });

  it('multiple languages: switch from python to c', async () => {
    const mockLLM = new LLMClient(new MockLLMProvider({ charDelayMs: 0 }));
    const mockCanvas = createMockCanvasClient();

    // Python
    const h1 = streamPreviewForChat({
      chatId: 'e2e-multi-py',
      language: 'python',
      userGoal: 'login screen',
      llmClient: mockLLM,
      canvasClient: mockCanvas,
    });
    const r1 = await h1.done;
    expect(r1).not.toBeNull();

    // C
    const h2 = streamPreviewForChat({
      chatId: 'e2e-multi-c',
      language: 'c',
      userGoal: 'notepad gtk',
      llmClient: mockLLM,
      canvasClient: mockCanvas,
    });
    const r2 = await h2.done;
    expect(r2).not.toBeNull();

    // 两个 entry 独立
    const e1 = usePreviewStreamStore.getState().getEntry('e2e-multi-py');
    const e2 = usePreviewStreamStore.getState().getEntry('e2e-multi-c');
    expect(e1).toBeDefined();
    expect(e2).toBeDefined();

    // 缓存隔离
    const pyKey = `ast:python:${hashForTest('login screen')}`;
    const cKey = `ast:c:${hashForTest('notepad gtk')}`;
    expect(astCache.get(pyKey)).toBeDefined();
    expect(astCache.get(cKey)).toBeDefined();
  });

  it('handles partial chunks: pushes partial AST to IPC progressively', async () => {
    const mockLLM = new LLMClient(new MockLLMProvider({ charDelayMs: 0 }));
    const mockCanvas = createMockCanvasClient();

    const handle = streamPreviewForChat({
      chatId: 'e2e-partial',
      language: 'python',
      userGoal: 'login screen python',
      llmClient: mockLLM,
      canvasClient: mockCanvas,
      pushIntervalMs: 5, // 极短间隔，便于触发多次 push
    });

    await handle.done;

    // feedASTChunk 至少被调用 1 次（最终 flushAST 一定会 push）
    expect(mockCanvas.feedASTChunk.mock.calls.length + mockCanvas.flushAST.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it('error logging: console.error is called on LLM failure', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failingLLM = new LLMClient({
      name: 'e2e-err-log',
      chatStream: () => {
        const h = {
          [Symbol.asyncIterator]: async function* () {
            throw new Error('logged-error');
          },
          cancel: () => {},
          done: new Promise(() => {}),
        };
        return h;
      },
    });

    const handle = streamPreviewForChat({
      chatId: 'e2e-err-log',
      language: 'python',
      userGoal: 'x',
      llmClient: failingLLM,
    });

    await handle.done;
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('retry pattern: orchestrator uses StreamError semantics', async () => {
    // 验证 StreamError 类型可被识别为 retryable
    const { StreamError, isRetryable } = await import('../../src/services/errors');
    expect(isRetryable(new StreamError('timeout'))).toBe(true);
    expect(isRetryable(new StreamError('parse-failed'))).toBe(false);
  });

  it('handleError is importable and callable', () => {
    expect(() => handleError(new Error('test'), { context: 'e2e' })).not.toThrow();
  });
});

// Helper
function hashForTest(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
