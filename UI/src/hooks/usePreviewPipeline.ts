/**
 * usePreviewPipeline.ts — React hook 包装 IPCAdapter
 *
 * 用法：
 *   const pipeline = usePreviewPipeline({ sessionId, deviceId, chatId });
 *   pipeline.run({ language, userGoal });
 *   pipeline.cancel();
 *   pipeline.isStreaming; pipeline.error;
 */

import { useCallback, useEffect, useRef, useState } from 'react';
// 2026-07-03 阶段5.C: IPCAdapter.ts 已删除 (层级倒置), preview() 入口合并到 chatStreamOrchestrator
import { preview as adapterPreview, type PreviewHandle } from '../services/chatStreamOrchestrator';
import { snapshotPipelineConfig } from '../services/canvas/pipelineConfig';
import { usePreviewStreamStore } from '../state/previewStreamStore';

export interface UsePreviewPipelineOptions {
  sessionId: string;
  deviceId?: string;
  chatId: string;
}

export interface RunOptions {
  language: string;
  userGoal: string;
}

export interface UsePreviewPipelineReturn {
  run: (opts: RunOptions) => Promise<void>;
  cancel: () => void;
  isStreaming: boolean;
  error: string | null;
  config: ReturnType<typeof snapshotPipelineConfig>;
}

export function usePreviewPipeline(opts: UsePreviewPipelineOptions): UsePreviewPipelineReturn {
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const handleRef = useRef<PreviewHandle | null>(null);
  const optsRef = useRef(opts);
  optsRef.current = opts;

  const cancel = useCallback(() => {
    if (handleRef.current && typeof handleRef.current.cancel === 'function') {
      handleRef.current.cancel();
    }
    handleRef.current = null;
    setIsStreaming(false);
  }, []);

  const run = useCallback(async (runOpts: RunOptions) => {
    cancel();
    setError(null);

    try {
      const handle = adapterPreview({
        ...optsRef.current,
        language: runOpts.language,
        userGoal: runOpts.userGoal,
      });
      handleRef.current = handle;
      setIsStreaming(true);
      const result = await handle.done;
      setIsStreaming(false);
      // payload 已在 orchestrator 写入 previewStreamStore
      // 这里只检查是否成功
      if (!result) {
        const chatId = optsRef.current.chatId;
        const entry = usePreviewStreamStore.getState().getEntry(chatId);
        if (entry?.pushError) setError(entry.pushError);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setIsStreaming(false);
    }
  }, [cancel]);

  // 组件卸载自动取消
  useEffect(() => cancel, [cancel]);

  return {
    run,
    cancel,
    isStreaming,
    error,
    config: snapshotPipelineConfig(),
  };
}

/** 只读 hook：订阅当前 pipeline config */
export function usePipelineConfig() {
  const [config, setConfig] = useState(snapshotPipelineConfig);
  useEffect(() => {
    const id = setInterval(() => setConfig(snapshotPipelineConfig()), 1000);
    return () => clearInterval(id);
  }, []);
  return config;
}
