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
import { parseCodeBlocks } from '../services/incrementalCanvasPusher';
import { translateCode } from '../translate';

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
  /** ★ FIX 2026-07-15: DSL 生成时的画布设计尺寸, 用于拖拽缩放比例计算 */
  designSize?: { width: number; height: number };
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
  /** ★ FIX 2026-07-15: 设置 DSL 设计尺寸 (LLM 生成新内容时调用) */
  setDesignSize: (chatId: string, size: { width: number; height: number }) => void;
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
      // ★ FIX #16: 将 fetch 移到 set 之外 — zustand set updater 应为纯函数
      //   原代码在 set updater 内部触发 fetch, 违反纯函数约定
      //   修复: 先用 set 计算并更新状态, 再在 set 之外触发异步写入
      let pendingFetch: (() => void) | null = null;

      set((s) => {
        const prev = s.entries[chatId];
        if (!prev) return s;
        const newAst = payload?.preview.root ?? prev.ast;
        const sessionId = prev.sessionId || `canvas-${chatId}`;
        // 准备 fetch 参数 (但不在此执行)
        if (payload && newAst) {
          pendingFetch = () => {
            fetch(`/api/canvas/sessions/${encodeURIComponent(sessionId)}/dsl`, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                dsl: newAst,
                language: payload.language || prev.language,
                sourceCode: payload.source_code || prev.sourceCode,
              }),
            }).catch(() => {}); // 火后即忘, 不阻塞 UI
          };
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

      // 在 set 之外执行副作用
      if (pendingFetch) pendingFetch();
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

    setDesignSize: (chatId, size) => {
      set((s) => {
        const prev = s.entries[chatId];
        if (!prev) return s;
        return {
          entries: { ...s.entries, [chatId]: { ...prev, designSize: size } },
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

/**
 * ★ 2026-07-13: 从聊天历史降级恢复画布 DSL
 *
 * 场景: GarnetStore 24h TTL 到期后热数据消失, 但聊天记录里的 rawContent (含代码块) 还在.
 * 从最后一条 assistant 消息的 rawContent 中提取最后的完整代码块,
 * 用 translateCode 翻译为 UniversalNode, 恢复到 previewStreamStore.
 *
 * @param messages 当前 chat 的消息列表
 * @returns 恢复的 DSL 数据, 或 null 表示无法恢复
 */
export function restoreDslFromChatHistory(
  messages: Array<{ sender: string; rawContent?: string; content: string }>,
): { dsl: any; language: string; sourceCode: string } | null {
  if (!messages || messages.length === 0) return null;

  // 从后往前找最后一条 assistant 消息
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.sender !== 'assistant') continue;

    // 优先用 rawContent (含原始代码块), 其次用 content
    const text = msg.rawContent || msg.content;
    if (!text) continue;

    // 用 parseCodeBlocks 提取代码块
    const blocks = parseCodeBlocks(text);
    // 找最后一个完整的、有 translatorLang 的代码块
    for (let j = blocks.length - 1; j >= 0; j--) {
      const block = blocks[j];
      if (!block.complete || !block.translatorLang) continue;
      if (!block.code.trim()) continue;

      try {
        if (block.translatorLang === '__json_dsl__') {
          // JSON DSL — 直接解析
          const dsl = JSON.parse(block.code);
          return {
            dsl,
            language: 'json',
            sourceCode: block.code,
          };
        } else {
          // 其他语言 — 走翻译器
          const ast = translateCode(block.code, block.translatorLang);
          return {
            dsl: ast,
            language: block.translatorLang,
            sourceCode: block.code,
          };
        }
      } catch (e) {
        console.warn(`[restoreDslFromChatHistory] translate failed for lang=${block.translatorLang}:`, (e as Error).message);
        continue; // 尝试前一个代码块
      }
    }
  }

  return null;
}

// ── HMR 边界:改 store 代码时热替换 store 实例,不触发 full page reload ──
// React 组件树保持挂载,entries 会重置为初始空值 (Preview AST 流状态,重新流送即可恢复)。
// 注意: subscribeWithSelector middleware 不注册模块级订阅,无需 dispose。
if (import.meta.hot) {
  import.meta.hot.accept((m) => {
    if (m) usePreviewStreamStore.setState(m.usePreviewStreamStore.getState(), true);
  });
}
