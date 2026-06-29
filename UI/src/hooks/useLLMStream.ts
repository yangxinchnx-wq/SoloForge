/**
 * useLLMStream.ts — 消费 LLM 流的 React hook
 *
 * 职责：
 *   1. 调用 LLMClient.stream({ systemPrompt, userGoal })
 *   2. 逐 chunk 调用 onChunk 回调（接 AST parser）
 *   3. 暴露 isStreaming / error / cancel / retry
 *   4. 组件卸载时自动取消（避免泄漏）
 *
 * 不依赖 TanStack Query（独立可用，Cut 11 才升级到 useMutation）
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { LLMClient } from '../services/llm/LLMClient';
import type { LLMRequest, LLMStreamHandle } from '../services/llm/types';

export interface UseLLMStreamOptions {
  /** 自定义客户端（默认用 LLMClient.fromEnv） */
  client?: LLMClient;
  /** 系统提示词 */
  systemPrompt?: string;
  /** 用户目标 */
  userGoal: string;
  /** 历史消息 */
  history?: LLMRequest['history'];
  /** 每次 chunk 到达的回调 */
  onChunk: (chunk: string) => void;
  /** 流结束回调（成功 / 失败都触发） */
  onDone?: (info: { success: boolean; error?: Error }) => void;
  /** 自动开始 */
  autoStart?: boolean;
}

export interface UseLLMStreamReturn {
  isStreaming: boolean;
  error: Error | null;
  start: () => void;
  cancel: () => void;
  retry: () => void;
  /** 已接收字节数 */
  bytesReceived: number;
}

export function useLLMStream(opts: UseLLMStreamOptions): UseLLMStreamReturn {
  const {
    client = LLMClient.fromEnv(),
    systemPrompt,
    userGoal,
    history,
    onChunk,
    onDone,
    autoStart = false,
  } = opts;

  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [bytesReceived, setBytesReceived] = useState(0);

  const handleRef = useRef<LLMStreamHandle | null>(null);
  const onChunkRef = useRef(onChunk);
  const onDoneRef = useRef(onDone);
  onChunkRef.current = onChunk;
  onDoneRef.current = onDone;

  const cancel = useCallback(() => {
    if (handleRef.current) {
      handleRef.current.cancel();
      handleRef.current = null;
    }
    setIsStreaming(false);
  }, []);

  const start = useCallback(() => {
    cancel();
    setError(null);
    setBytesReceived(0);

    const handle = client.stream({ systemPrompt, userGoal, history });
    handleRef.current = handle;
    setIsStreaming(true);

    (async () => {
      try {
        for await (const chunk of handle) {
          onChunkRef.current(chunk);
          setBytesReceived((b) => b + chunk.length);
        }
        onDoneRef.current?.({ success: true });
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        setError(err);
        onDoneRef.current?.({ success: false, error: err });
      } finally {
        setIsStreaming(false);
        handleRef.current = null;
      }
    })();
  }, [client, systemPrompt, userGoal, history, cancel]);

  const retry = useCallback(() => start(), [start]);

  // autoStart
  useEffect(() => {
    if (autoStart) start();
    return () => cancel();
  }, [autoStart, start, cancel]);

  return { isStreaming, error, start, cancel, retry, bytesReceived };
}
