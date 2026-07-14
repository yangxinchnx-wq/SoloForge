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
import { OpenAICompatibleProvider } from '../services/llm/OpenAICompatibleProvider';
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
  /** LLM provider 配置 (从 useChatStore 传入, 避免走 backend proxy 503) */
  provider?: {
    baseUrl: string;
    apiKey: string;
    model: string;
  };
}

export const PREVIEW_TRIGGER_EVENT = 'soloforge-preview-trigger';

// ── Hook ──

export function usePreviewBridge(): void {
  const handleRef = useRef<StreamPreviewHandle | null>(null);
  const startDelayRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const onTrigger = (e: Event) => {
      const detail = (e as CustomEvent<PreviewTriggerDetail>).detail;
      if (!detail?.chatId || !detail?.message) return;

      // Cancel previous preview + pending delay
      if (startDelayRef.current) {
        clearTimeout(startDelayRef.current);
        startDelayRef.current = null;
      }
      if (handleRef.current) {
        handleRef.current.cancel();
        handleRef.current = null;
      }

      // 2026-07-07: 优先用事件携带的 provider 配置直连 LLM (避免 backend proxy 503)
      // 如果没有 provider 配置, 静默跳过预览 (不再走 fromEnv → backend proxy → 503)
      let llmClient: LLMClient | null = null;
      if (detail.provider?.apiKey && detail.provider?.baseUrl) {
        llmClient = new LLMClient(
          new OpenAICompatibleProvider('preview', {
            baseUrl: detail.provider.baseUrl,
            apiKey: detail.provider.apiKey,
            defaultModel: detail.provider.model || 'gpt-4o-mini',
          })
        );
      } else {
        // 降级: 尝试 fromEnv (可能在 Electron 环境有 IPC 可用)
        try {
          llmClient = LLMClient.fromEnv();
        } catch {
          // 静默跳过 — 预览是可选功能, 不应阻塞主聊天
          return;
        }
      }

      const language = detail.language || detectLanguage(detail.message);
      const userGoal = detail.message;

      // ★ 2026-07-14: 不再无条件 clearEntry — 如果增量翻译已写入数据, 保留它
      //   原代码 clearEntry 会清空 pushToCanvas 写入的 ast, 导致画布空白
      //   只有在 entry 不存在或已过期时才清理
      const existingEntry = usePreviewStreamStore.getState().getEntry(detail.chatId);
      if (existingEntry?.ast || existingEntry?.payload) {
        // 已有数据 — 增量翻译/本地翻译已处理, 不需要 LLM 预览流
        console.log('[usePreviewBridge] entry 已有数据, 跳过 LLM 预览流');
        return;
      }
      usePreviewStreamStore.getState().clearEntry(detail.chatId);

      // 延迟 1.5s 启动预览流, 避免与主聊天同时请求 LLM 导致 429 速率限制
      startDelayRef.current = setTimeout(() => {
        startDelayRef.current = null;
        try {
          const handle = streamPreviewForChat({
            chatId: detail.chatId,
            language,
            userGoal,
            deviceId: detail.deviceId,
            llmClient,
            // canvasClient: undefined → orchestrator will skip IPC pushes
            // (PreviewPanel subscribes to previewStreamStore directly)
          });

          handleRef.current = handle;

          // Clean up ref when done (静默处理错误, 不打印到控制台)
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
        } catch {
          // 预览失败不影响主聊天
        }
      }, 1500);
    };

    window.addEventListener(PREVIEW_TRIGGER_EVENT, onTrigger as EventListener);

    return () => {
      window.removeEventListener(PREVIEW_TRIGGER_EVENT, onTrigger as EventListener);
      if (startDelayRef.current) {
        clearTimeout(startDelayRef.current);
        startDelayRef.current = null;
      }
      if (handleRef.current) {
        handleRef.current.cancel();
        handleRef.current = null;
      }
    };
  }, []);
}
