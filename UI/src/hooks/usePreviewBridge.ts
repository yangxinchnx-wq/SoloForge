/**
 * usePreviewBridge.ts — 连接「聊天发送」与「AST 预览流」的桥梁
 *
 * 工作原理：
 *   1. 监听 window 上的 `soloforge-preview-trigger` 自定义事件
 *   2. 事件携带 { chatId, message, language? }
 *   3. 调用 streamPreviewForChat() 启动 AST 预览流 (并行于主聊天 SSE)
 *   4. previewStreamStore 自动更新 (orchestrator 内部已处理)
 *   5. PreviewPanel 订阅 previewStreamStore 即可展示流式状态
 *
 * 事件来源：
 *   - useChatStore.handleSend() 在发送消息后 dispatch 此事件
 *
 * 语言检测：
 *   - 事件携带 language → 直接用
 *   - 否则从消息内容启发式检测 (python/ts/go/rust/c/java 关键词)
 *   - 最终 fallback → 'typescript'
 *
 * 生命周期：
 *   - 新消息发送 → cancel 旧的 preview → 启动新的
 *   - 组件卸载 → cancel 当前 preview
 */

import { useEffect, useRef } from 'react';
import { streamPreviewForChat, type StreamPreviewHandle } from '../services/chatStreamOrchestrator';
import { LLMClient } from '../services/llm/LLMClient';
import { usePreviewStreamStore } from '../state/previewStreamStore';

// ── 语言检测 ──

const LANG_HINTS: Array<{ lang: string; patterns: RegExp[] }> = [
  { lang: 'python', patterns: [/python/i, /flask/i, /django/i, /streamlit/i, /fastapi/i, /\.py\b/i] },
  { lang: 'typescript', patterns: [/typescript/i, /\btsx?\b/i, /react/i, /vue/i, /angular/i, /\.ts\b/i] },
  { lang: 'go', patterns: [/\bgo(lang)?\b/i, /gin/i, /echo/i, /\.go\b/i] },
  { lang: 'rust', patterns: [/rust/i, /cargo/i, /tokio/i, /\.rs\b/i] },
  { lang: 'c', patterns: [/\bc\b/i, /gtk/i, /win32/i, /\.c\b/i, /\.h\b/i] },
  { lang: 'java', patterns: [/java/i, /spring/i, /swing/i, /javafx/i, /\.java\b/i] },
];

function detectLanguage(message: string): string {
  for (const { lang, patterns } of LANG_HINTS) {
    for (const p of patterns) {
      if (p.test(message)) return lang;
    }
  }
  return 'typescript';
}

// ── 事件类型 ──

export interface PreviewTriggerDetail {
  chatId: string;
  message: string;
  language?: string;
  deviceId?: string;
}

export const PREVIEW_TRIGGER_EVENT = 'soloforge-preview-trigger';

// ── Hook ──

export function usePreviewBridge(): void {
  const handleRef = useRef<StreamPreviewHandle | null>(null);
  const llmClientRef = useRef<LLMClient | null>(null);

  useEffect(() => {
    const onTrigger = (e: Event) => {
      const detail = (e as CustomEvent<PreviewTriggerDetail>).detail;
      if (!detail?.chatId || !detail?.message) return;

      // Cancel previous preview
      if (handleRef.current) {
        handleRef.current.cancel();
        handleRef.current = null;
      }

      // Lazy-init LLM client (backend proxy, relative URL through 3000)
      if (!llmClientRef.current) {
        try {
          llmClientRef.current = LLMClient.fromEnv();
        } catch {
          console.warn('[previewBridge] LLMClient init failed, skipping preview');
          return;
        }
      }

      const language = detail.language || detectLanguage(detail.message);
      const userGoal = detail.message;

      // Clear old entry for this chat
      usePreviewStreamStore.getState().clearEntry(detail.chatId);

      // Fire and forget — orchestrator handles all state updates
      try {
        const handle = streamPreviewForChat({
          chatId: detail.chatId,
          language,
          userGoal,
          deviceId: detail.deviceId,
          llmClient: llmClientRef.current,
          // canvasClient: undefined → orchestrator will skip IPC pushes
          // (PreviewPanel subscribes to previewStreamStore directly)
        });

        handleRef.current = handle;

        // Clean up ref when done
        handle.done
          .then(() => {
            if (handleRef.current === handle) {
              handleRef.current = null;
            }
          })
          .catch(() => {
            if (handleRef.current === handle) {
              handleRef.current = null;
            }
          });
      } catch (err) {
        console.error('[previewBridge] streamPreviewForChat failed:', err);
      }
    };

    window.addEventListener(PREVIEW_TRIGGER_EVENT, onTrigger as EventListener);

    return () => {
      window.removeEventListener(PREVIEW_TRIGGER_EVENT, onTrigger as EventListener);
      if (handleRef.current) {
        handleRef.current.cancel();
        handleRef.current = null;
      }
    };
  }, []);
}
