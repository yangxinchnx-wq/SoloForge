/**
 * IPCAdapter.test.ts — IPC 适配器单测（仅 LLM pipeline）
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { preview, IPCAdapter, setDefaultCanvasClient } from './IPCAdapter';
import {
  pipelineConfig,
  resetPipelineConfig,
  setPipelineConfig,
  snapshotPipelineConfig,
} from './pipelineConfig';
import { LLMClient } from '../llm/LLMClient';
import { MockLLMProvider } from '../llm/MockLLMProvider';
import type { Canvas3DClient } from './Canvas3DClient';
import { astCache } from './astCache';
import { usePreviewStreamStore } from '../../state/previewStreamStore';

function createMockCanvasClient() {
  return {
    pushUI: vi.fn(async () => ({ ok: true })),
    pushUniversalPreview: vi.fn(async () => ({ ok: true })),
    feedASTChunk: vi.fn(async () => ({ ok: true })),
    flushAST: vi.fn(async () => ({ ok: true })),
  } as unknown as Canvas3DClient & {
    pushUI: ReturnType<typeof vi.fn>;
    pushUniversalPreview: ReturnType<typeof vi.fn>;
    feedASTChunk: ReturnType<typeof vi.fn>;
    flushAST: ReturnType<typeof vi.fn>;
  };
}

describe('pipelineConfig', () => {
  beforeEach(() => resetPipelineConfig());

  it('default config has pushIntervalMs=50', () => {
    expect(pipelineConfig.pushIntervalMs).toBe(50);
  });

  it('setPipelineConfig overrides', () => {
    setPipelineConfig({ pushIntervalMs: 100 });
    expect(pipelineConfig.pushIntervalMs).toBe(100);
  });

  it('snapshot returns config object', () => {
    const snap = snapshotPipelineConfig();
    expect(snap).toHaveProperty('pushIntervalMs');
  });
});

describe('IPCAdapter.preview (LLM pipeline)', () => {
  beforeEach(() => {
    resetPipelineConfig();
    astCache.clear();
    usePreviewStreamStore.getState().reset();
  });

  it('routes through LLM stream and returns StreamPreviewHandle', async () => {
    const mockLLM = new LLMClient(new MockLLMProvider({ charDelayMs: 0 }));
    const mockCanvas = createMockCanvasClient();

    const handle = preview({
      sessionId: 's1',
      deviceId: 'd1',
      chatId: 'chat-1',
      language: 'python',
      userGoal: 'login form',
      llmClient: mockLLM,
      canvasClient: mockCanvas,
    });

    expect(typeof handle.cancel).toBe('function');
    const result = await handle.done;
    expect(result).not.toBeNull();
  });

  it('throws when language is missing', () => {
    expect(() =>
      preview({
        sessionId: 's2',
        chatId: 'chat-2',
        // missing language
        userGoal: 'x',
      } as any),
    ).toThrow(/language/);
  });

  it('throws when userGoal is missing', () => {
    expect(() =>
      preview({
        sessionId: 's3',
        chatId: 'chat-3',
        language: 'python',
        // missing userGoal
      } as any),
    ).toThrow(/userGoal/);
  });

  it('throws when chatId is missing', () => {
    expect(() =>
      preview({
        sessionId: 's4',
        // missing chatId
        language: 'python',
        userGoal: 'x',
      } as any),
    ).toThrow(/chatId/);
  });
});
