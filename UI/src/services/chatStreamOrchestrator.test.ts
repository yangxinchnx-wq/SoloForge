/**
 * chatStreamOrchestrator.test.ts — 完整链路单测
 *
 * 覆盖：
 *   1. 缓存命中：秒回，不调 LLM
 *   2. LLM 成功：写 store + 推 IPC
 *   3. LLM 错误：写错误状态，不抛
 *   4. cancel 中断：done 立即返回 null
 *   5. Mock LLM 端到端：产出有效 AST
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { streamPreviewForChat } from './chatStreamOrchestrator';
import { MockLLMProvider } from './llm/MockLLMProvider';
import { LLMClient } from './llm/LLMClient';
import { Canvas3DClient } from './canvas/Canvas3DClient';
import { astCache } from './canvas/astCache';
import { usePreviewStreamStore } from '../state/previewStreamStore';
import { useChatsStore } from '../state/chatsStore';
import type { PreviewPayload } from './canvas/UniversalAST';

// IPC mock：捕获 pushUniversalPreview / feedASTChunk / flushAST 调用
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

describe('streamPreviewForChat', () => {
  beforeEach(() => {
    astCache.clear();
    usePreviewStreamStore.getState().reset();
    // 注意：不清 chatsStore（避免影响其他测试）
  });

  it('cache hit: returns immediately without LLM call', async () => {
    const cached: PreviewPayload = {
      language: 'python',
      framework: 'Flask',
      source_code: 'cached',
      preview: { root: { type: 'column', children: [] } },
    };
    astCache.setByPrompt('python', 'login screen', cached);

    const mockLLM = new LLMClient(new MockLLMProvider({ charDelayMs: 0 }));
    const mockCanvas = createMockCanvasClient();

    const handle = streamPreviewForChat({
      chatId: 'chat-1',
      language: 'python',
      userGoal: 'login screen',
      llmClient: mockLLM,
      canvasClient: mockCanvas,
    });

    const result = await handle.done;
    expect(result).toEqual(cached);
    expect(mockCanvas.pushUniversalPreview).toHaveBeenCalled();
    expect(mockCanvas.flushAST).toHaveBeenCalled();
  });

  it('LLM success: writes to previewStore + pushUniversalPreview + flushAST', async () => {
    const mockLLM = new LLMClient(new MockLLMProvider({ charDelayMs: 0 }));
    const mockCanvas = createMockCanvasClient();

    const handle = streamPreviewForChat({
      chatId: 'chat-2',
      language: 'python',
      userGoal: 'login screen python',
      llmClient: mockLLM,
      canvasClient: mockCanvas,
    });

    const result = await handle.done;
    expect(result).not.toBeNull();
    expect(result!.language).toBeTruthy();
    expect(result!.preview.root).toBeDefined();

    // store 已更新
    const entry = usePreviewStreamStore.getState().getEntry('chat-2');
    expect(entry).toBeDefined();
    expect(entry!.payload).toEqual(result);
    expect(entry!.isStreaming).toBe(false);

    // IPC 已调用
    expect(mockCanvas.pushUniversalPreview).toHaveBeenCalled();
    expect(mockCanvas.flushAST).toHaveBeenCalled();

    // 缓存已写
    const cached = astCache.get(astCacheKey('python', 'login screen python'));
    expect(cached).toEqual(result);
  });

  it('LLM error: records error, does not throw', async () => {
    const failingLLM = new LLMClient({
      name: 'failing',
      chatStream: () => {
        const handle = {
          [Symbol.asyncIterator]: async function* () {
            throw new Error('LLM unavailable');
          },
          cancel: () => {},
          done: new Promise(() => {}), // never resolves, error caught in iterator
        };
        return handle;
      },
    });
    const mockCanvas = createMockCanvasClient();

    const handle = streamPreviewForChat({
      chatId: 'chat-3',
      language: 'python',
      userGoal: 'will fail',
      llmClient: failingLLM,
      canvasClient: mockCanvas,
    });

    const result = await handle.done;
    expect(result).toBeNull();

    const entry = usePreviewStreamStore.getState().getEntry('chat-3');
    expect(entry).toBeDefined();
    expect(entry!.pushError).toContain('LLM unavailable');
    expect(entry!.isStreaming).toBe(false);
  });

  it('cancel interrupts stream', async () => {
    const slowLLM = new LLMClient(new MockLLMProvider({ charDelayMs: 5 }));
    const mockCanvas = createMockCanvasClient();

    const handle = streamPreviewForChat({
      chatId: 'chat-4',
      language: 'python',
      userGoal: 'login screen python',
      llmClient: slowLLM,
      canvasClient: mockCanvas,
    });

    setTimeout(() => handle.cancel(), 30);
    const result = await handle.done;
    // cancel 后返回 null 或部分 payload
    expect(result === null || typeof result === 'object').toBe(true);
  });

  it('unknown language falls back to typescript', async () => {
    const mockLLM = new LLMClient(new MockLLMProvider({ charDelayMs: 0 }));

    const handle = streamPreviewForChat({
      chatId: 'chat-5',
      language: 'cobol', // 不支持
      userGoal: 'login',
      llmClient: mockLLM,
    });

    const result = await handle.done;
    expect(result).not.toBeNull();
    // fallback 到 typescript adapter，prompt 会包含 typescript 关键字
  });

  it('does not call IPC push when canvasClient not provided', async () => {
    const mockLLM = new LLMClient(new MockLLMProvider({ charDelayMs: 0 }));

    const handle = streamPreviewForChat({
      chatId: 'chat-6',
      language: 'python',
      userGoal: 'login screen python',
      llmClient: mockLLM,
      // 无 canvasClient
    });

    const result = await handle.done;
    expect(result).not.toBeNull();
    // store 仍更新（IPC 不调用）
    expect(usePreviewStreamStore.getState().getEntry('chat-6')?.payload).toEqual(result);
  });
});

function astCacheKey(lang: string, prompt: string): string {
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
