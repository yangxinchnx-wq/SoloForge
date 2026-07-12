/**
 * previewStreamStore — Preview AST 流式状态（Universal AST 输出侧）
 *
 * 设计原则（与 streamingStore 互补）：
 *   - streamingStore：管 RootTask / 子任务 / 阶段机（旧逻辑，不动）
 *   - previewStreamStore：管 Preview AST 流（新增，独立）
 *
 * 状态分层：
 *   - confirmed : PreviewPayload（流结束、校验通过，可推 Flutter）
 *   - streaming : StreamState（流中、半成品 AST 也保留）
 *   - errors    : 解析错误累积
 *
 * 选 Zustand 而非独立 useState：组件树共享流状态，
 * 多个面板（ChatPanel / CodePanel / StatusBar）都订阅同一份。
 */

import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import type { PreviewPayload, StreamState, UniversalNode } from '../services/canvas/UniversalAST';

export interface PreviewStreamEntry {
  /** AST 流状态（流中持续更新） */
  streamState: StreamState;
  /** 已确认的 payload（流结束后稳定） */
  payload: PreviewPayload | null;
  /** 当前最佳 root（半成品也行） */
  ast: UniversalNode | undefined;
  /** 是否流中 */
  isStreaming: boolean;
  /** 当前 language */
  language: string;
  /** 当前 source_code（按比例估算 / 最终） */
  sourceCode: string;
  /** 当前原始字节数 */
  rawBytes: number;
  /** 最近一次推送的错误（IPC 推送失败时） */
  pushError: string | null;
  /** 关联的 sessionId（可选，便于 IPC 推送） */
  sessionId?: string;
  /** 关联的 deviceId（可选） */
  deviceId?: string;
}

interface PreviewStreamState {
  /** chatId → PreviewStreamEntry */
  entries: Record<string, PreviewStreamEntry>;

  // ── Actions ──
  /** 初始化一个 entry（开始流时调用） */
  initEntry: (chatId: string, opts: { language: string; sessionId?: string; deviceId?: string }) => void;
  /** 更新流状态（每次 parser.feedChunk 后调用） */
  updateStream: (chatId: string, streamState: StreamState) => void;
  /** 标记流结束 + 写 confirmed payload */
  confirmPayload: (chatId: string, payload: PreviewPayload | null) => void;
  /** 记录推送错误 */
  recordPushError: (chatId: string, error: string) => void;
  /** 清空某个 chat 的 entry */
  clearEntry: (chatId: string) => void;
  /** 清空全部 */
  reset: () => void;

  // ── Selectors (函数，避免 useStore 引用变化导致无限渲染) ──
  getEntry: (chatId: string) => PreviewStreamEntry | undefined;
  getAst: (chatId: string) => UniversalNode | undefined;
  getPayload: (chatId: string) => PreviewPayload | null;
  isStreaming: (chatId: string) => boolean;
}

function emptyEntry(): PreviewStreamEntry {
  return {
    streamState: { raw: '', payload: null, errors: [], done: false },
    payload: null,
    ast: undefined,
    isStreaming: false,
    language: 'typescript',
    sourceCode: '',
    rawBytes: 0,
    pushError: null,
  };
}

export const usePreviewStreamStore = create<PreviewStreamState>()(
  subscribeWithSelector((set, get) => ({
    entries: {},

    initEntry: (chatId, opts) => {
      set((s) => ({
        entries: {
          ...s.entries,
          [chatId]: {
            ...emptyEntry(),
            language: opts.language,
            sessionId: opts.sessionId,
            deviceId: opts.deviceId,
            isStreaming: true,
          },
        },
      }));
    },

    updateStream: (chatId, streamState) => {
      set((s) => {
        const prev = s.entries[chatId] ?? emptyEntry();
        const ast = streamState.payload?.preview?.root as UniversalNode | undefined;
        const language = (streamState.payload as any)?.language ?? prev.language;
        const sourceCode =
          (streamState.payload as PreviewPayload | null)?.source_code ??
          streamState.raw.slice(0, Math.floor(streamState.raw.length * 0.6));

        return {
          entries: {
            ...s.entries,
            [chatId]: {
              ...prev,
              streamState,
              ast,
              language,
              sourceCode,
              rawBytes: streamState.raw.length,
              isStreaming: !streamState.done,
            },
          },
        };
      });
    },

    confirmPayload: (chatId, payload) => {
      set((s) => {
        const prev = s.entries[chatId];
        if (!prev) return s;
        const newAst = payload?.preview.root ?? prev.ast;
        // ★ 2026-07-13: confirmPayload 时异步写入 Garnet 热存储
        if (payload && newAst) {
          const sessionId = prev.sessionId || `canvas-${chatId}`;
          fetch(`/api/canvas/sessions/${encodeURIComponent(sessionId)}/dsl`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              dsl: newAst,
              language: payload.language || prev.language,
              sourceCode: payload.source_code || prev.sourceCode,
            }),
          }).catch(() => {}); // 火后即忘, 不阻塞 UI
        }
        return {
          entries: {
            ...s.entries,
            [chatId]: {
              ...prev,
              payload,
              ast: newAst,
              isStreaming: false,
              sourceCode: payload?.source_code ?? prev.sourceCode,
            },
          },
        };
      });
    },

    recordPushError: (chatId, error) => {
      set((s) => {
        const prev = s.entries[chatId];
        if (!prev) return s;
        return {
          entries: { ...s.entries, [chatId]: { ...prev, pushError: error } },
        };
      });
    },

    clearEntry: (chatId) => {
      set((s) => {
        const { [chatId]: _, ...rest } = s.entries;
        return { entries: rest };
      });
    },

    reset: () => set({ entries: {} }),

    // ── Selectors ──
    getEntry: (chatId) => get().entries[chatId],
    getAst: (chatId) => get().entries[chatId]?.ast,
    getPayload: (chatId) => get().entries[chatId]?.payload ?? null,
    isStreaming: (chatId) => get().entries[chatId]?.isStreaming ?? false,
  })),
);

/** 便捷 hook：订阅某个 chat 的 AST 流 */
export function usePreviewAst(chatId: string) {
  return usePreviewStreamStore((s) => s.entries[chatId]);
}

/**
 * ★ 2026-07-13: 从 Garnet 热存储恢复画布 DSL
 * 在 PreviewPanel 挂载时调用, 异步拉取上次保存的 DSL
 */
export async function restoreDslFromHotStore(chatId: string, sessionId?: string): Promise<{
  dsl: any;
  language: string;
  sourceCode: string;
} | null> {
  const sid = sessionId || `canvas-${chatId}`;
  try {
    const resp = await fetch(`/api/canvas/sessions/${encodeURIComponent(sid)}/dsl`);
    if (!resp.ok) return null;
    const json = await resp.json();
    if (!json?.success || !json?.payload?.dsl) return null;
    return {
      dsl: json.payload.dsl,
      language: json.payload.language || 'json',
      sourceCode: json.payload.sourceCode || '',
    };
  } catch {
    return null;
  }
}
