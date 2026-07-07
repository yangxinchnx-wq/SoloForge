/**
 * chatStreamOrchestrator.ts — 把 LLM + Parser + Store + IPC 拼成一个完整链路
 *
 * 入口：streamPreviewForChat({ chatId, language, userGoal, deviceId })
 *
 * 链路：
 *   1. chatsStore.setLiveState(chatId, { isStreaming: true })
 *   2. previewStreamStore.initEntry(chatId, { language, sessionId })
 *   3. LLMClient.stream({ systemPrompt, userGoal }) → AsyncIterable<string>
 *   4. StreamingASTParser.feedChunk(state, chunk) → StreamState
 *      ↓ 每个 chunk
 *      previewStreamStore.updateStream(chatId, state)
 *      Canvas3DClient.feedASTChunk(sessionId, partialRoot)  ← 节流 50ms
 *   5. 流结束：
 *      previewStreamStore.confirmPayload(chatId, payload)
 *      Canvas3DClient.flushAST(sessionId)
 *      astCache.setByPrompt(lang, prompt, payload)
 *      chatsStore.setLiveState(chatId, { isStreaming: false })
 *
 * 调用方（如 ChatPanel）：
 *   const handle = streamPreviewForChat({
 *     chatId: chat.id,
 *     language: 'python',
 *     userGoal: 'login screen',
 *   });
 *   handle.cancel(); // 用户点取消
 *   await handle.done; // 等流结束
 *
 * 设计原则：
 *   - 非 hook（可在 React 组件外调用）
 *   - 返回 handle（cancel + done），调用方控制生命周期
 *   - 错误向上抛，由调用方决定是否重试
 */

import { LLMClient } from './llm/LLMClient';
import { ASTParser } from './canvas/ASTParser';
import { Canvas3DClient } from './canvas/Canvas3DClient';
import { astCache, astKeyFor } from './canvas/astCache';
import { getAdapter, isSupported } from './canvas/LanguageAdapters';
import { bestEffortRoot } from './canvas/StreamingASTParser';
import { usePreviewStreamStore } from '../state/previewStreamStore';
import { useChatsStore } from '../state/chatsStore';
import type { PreviewPayload, StreamState } from './canvas/UniversalAST';

export interface StreamPreviewOptions {
  chatId: string;
  language: string;
  userGoal: string;
  deviceId?: string;
  /** 自定义客户端（测试注入） */
  llmClient?: LLMClient;
  /** 自定义 IPC 客户端（测试注入） */
  canvasClient?: Canvas3DClient;
  /** 推送节流间隔（默认 50ms） */
  pushIntervalMs?: number;
  /** LLM 额外参数 */
  llmOptions?: {
    model?: string;
    temperature?: number;
    maxTokens?: number;
  };
}

export interface StreamPreviewHandle {
  cancel: () => void;
  done: Promise<PreviewPayload | null>;
  /** 当前 sessionId（推送给 Flutter 用） */
  sessionId: string;
}

const DEFAULT_PUSH_INTERVAL_MS = 50;

export function streamPreviewForChat(opts: StreamPreviewOptions): StreamPreviewHandle {
  const {
    chatId,
    language,
    userGoal,
    deviceId,
    llmClient = LLMClient.fromEnv(),
    canvasClient,
    pushIntervalMs = DEFAULT_PUSH_INTERVAL_MS,
    llmOptions,
  } = opts;

  const previewStore = usePreviewStreamStore.getState();
  const chatsStore = useChatsStore.getState();
  const parser = new ASTParser();
  const sessionId = `sess-${chatId}-${Date.now()}`;

  // 缓存检查（命中秒回）
  const safeLang = isSupported(language) ? language.toLowerCase() : 'typescript';
  const cacheKey = astKeyFor(safeLang, userGoal);
  const cached = astCache.get(cacheKey);
  if (cached) {
    // 命中缓存：直接写 store + 推 IPC + 结束
    previewStore.initEntry(chatId, { language: safeLang, sessionId, deviceId });
    previewStore.updateStream(chatId, {
      raw: JSON.stringify(cached),
      payload: cached,
      errors: [],
      done: true,
    });
    previewStore.confirmPayload(chatId, cached);
    chatsStore.setLiveState({
      chatId,
      isStreaming: false,
      lastActivityAt: Date.now(),
    });
    if (canvasClient) {
      canvasClient.pushUniversalPreview(sessionId, cached, deviceId).catch(() => {});
      canvasClient.flushAST(sessionId, deviceId).catch(() => {});
    }
    return {
      cancel: () => {},
      done: Promise.resolve(cached),
      sessionId,
    };
  }

  // 启动流
  previewStore.initEntry(chatId, { language: safeLang, sessionId, deviceId });
  chatsStore.setLiveState({
    chatId,
    isStreaming: true,
    phase: 'streaming',
    lastActivityAt: Date.now(),
  });

  let cancelled = false;
  let lastPushTs = 0;
  let lastPartialRootKey = '';

  const donePromise = (async (): Promise<PreviewPayload | null> => {
    try {
      const adapter = getAdapter(safeLang);
      const systemPrompt = adapter.buildSystemPrompt(userGoal);
      const handle = llmClient.stream({
        systemPrompt,
        userGoal,
        model: llmOptions?.model,
        temperature: llmOptions?.temperature,
        maxTokens: llmOptions?.maxTokens,
      });

      let state: StreamState = parser.createStream();

      for await (const chunk of handle) {
        if (cancelled) {
          handle.cancel();
          break;
        }
        state = parser.feedChunk(state, chunk);
        // 更新 store
        usePreviewStreamStore.getState().updateStream(chatId, state);

        // 节流推 IPC
        const now = Date.now();
        if (canvasClient && now - lastPushTs >= pushIntervalMs) {
          lastPushTs = now;
          const partialRoot = bestEffortRoot(state.payload);
          if (partialRoot) {
            const key = JSON.stringify(partialRoot).slice(0, 200);
            // 跳过重复推送（半成品 root 字符串前缀相同）
            if (key !== lastPartialRootKey) {
              lastPartialRootKey = key;
              canvasClient
                .feedASTChunk(sessionId, partialRoot, {
                  deviceId,
                  isPartial: true,
                  language: (state.payload as any)?.language,
                })
                .catch((err) => {
                  usePreviewStreamStore
                    .getState()
                    .recordPushError(chatId, String(err?.message ?? err));
                });
            }
          }
        }
      }

      // 流结束
      state = parser.endStream(state);
      const payload = state.payload as PreviewPayload | null;
      usePreviewStreamStore.getState().confirmPayload(chatId, payload);

      // 推最终态 + flush
      if (canvasClient && payload) {
        await canvasClient.pushUniversalPreview(sessionId, payload, deviceId);
        await canvasClient.flushAST(sessionId, deviceId);
      }

      // 写缓存
      if (payload) {
        astCache.setByPrompt(safeLang, userGoal, payload);
      }

      chatsStore.setLiveState({
        chatId,
        isStreaming: false,
        phase: payload ? 'complete' : 'error',
        lastActivityAt: Date.now(),
      });

      return payload;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // 更新 previewStore：标记 done + 记录错误 + 清流状态
      const cur = usePreviewStreamStore.getState().getEntry(chatId);
      if (cur) {
        usePreviewStreamStore.getState().updateStream(chatId, {
          ...cur.streamState,
          done: true,
          errors: [...(cur.streamState.errors ?? []), 'orchestrator-error'],
        });
        usePreviewStreamStore.getState().recordPushError(chatId, message);
      }
      chatsStore.setLiveState({
        chatId,
        isStreaming: false,
        phase: 'error',
        lastActivityAt: Date.now(),
      });
      // eslint-disable-next-line no-console
      // 2026-07-07: 预览流是可选功能, 429/503/网络错误静默处理
      const isExpectedError = message.includes('HTTP 429') || message.includes('HTTP 503') || message.includes('rate limit') || message.includes('Failed to fetch');
      if (!isExpectedError) {
        console.error('streamPreviewForChat error:', err);
      }
      return null;
    }
  })();

  return {
    cancel: () => {
      cancelled = true;
    },
    done: donePromise,
    sessionId,
  };
}

/**
 * 顶层便捷 hook 版本（自动管理 handle 生命周期）
 * 在 React 组件中使用：
 *   const { start, cancel, isStreaming } = useChatPreviewStream();
 *   start({ chatId, language: 'python', userGoal: '...' });
 */
export function useChatPreviewStream() {
  // 注：useRef 在 hook 中；handle 在组件卸载时自动取消
  // 这里只暴露最小 API：start() / cancel()
  // 因为完整 hook 需要 useRef/useCallback，简化版直接返回 start/cancel 函数
  return {
    start: streamPreviewForChat,
    cancel: (_handle: StreamPreviewHandle) => _handle.cancel(),
  };
}

// ==========================================
// 2026-07-03 阶段5.C: IPCAdapter 层级倒置修复
// 原 services/canvas/IPCAdapter.ts 是本文件的薄包装 (59 行), 反向 import
// 上层 service 造成层级倒置. 已删除该文件, preview() 入口合并到此处.
// 调用方 (usePreviewPipeline.ts) 直接 import { preview } from './chatStreamOrchestrator'
// ==========================================

import { pipelineConfig } from './canvas/pipelineConfig';

export interface PreviewOptions {
  sessionId: string;
  deviceId?: string;
  chatId: string;
  /** LLM pipeline 语言 */
  language: string;
  userGoal: string;
  /** 客户端注入（测试用） */
  canvasClient?: Canvas3DClient;
  llmClient?: LLMClient;
}

export type PreviewHandle = StreamPreviewHandle;

/**
 * 预览入口 (原 IPCAdapter.preview)
 * LLM streaming → parser → IPC → canvas
 */
export function preview(opts: PreviewOptions): PreviewHandle {
  if (!opts.language || !opts.userGoal) {
    throw new Error('preview: language + userGoal required');
  }
  if (!opts.chatId) {
    throw new Error('preview: chatId required');
  }
  return streamPreviewForChat({
    chatId: opts.chatId,
    language: opts.language,
    userGoal: opts.userGoal,
    deviceId: opts.deviceId,
    llmClient: opts.llmClient,
    canvasClient: opts.canvasClient,
    pushIntervalMs: pipelineConfig.pushIntervalMs,
  });
}
