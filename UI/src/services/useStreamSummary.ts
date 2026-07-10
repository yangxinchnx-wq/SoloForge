/**
 * useStreamSummary — 从 uiMessageStore (Data Parts) 派生流送区摘要状态
 *
 * 迁移目标:
 *   旧路径: TaskExecutionCard 订阅 streamingStore.tasks[chatId] (高频全量更新)
 *   新路径: TaskExecutionCard 订阅 useStreamSummary(chatId) (从 parts 派生, 按需更新)
 *
 * 摘要字段:
 *   - phase: 最后一个 phase-change part 的目标 phase
 *   - progress: 从 subtask parts 派生 (doneCount / totalCount * 100)
 *   - subtaskCount: subtask-created parts 数量
 *   - doneCount: subtask-done parts (status=done) 数量
 *   - isDone / isError / isActive: 便捷布尔值
 *
 * 注: userInput (原始 prompt) 仍从 streamingStore 读取, 因为它不在 parts 中
 *
 * 2026-07-10: H-3 迁移层
 */

import { useMemo } from 'react';
import { useLastAssistantMessage } from './uiMessageStore';
import type { TaskPhase } from '../types/streaming';
import type {
  UIPhaseChangePart,
  UISubTaskCreatedPart,
  UISubTaskDonePart,
} from '../types/messages';

export interface StreamSummary {
  /** 当前 phase (从最后一个 phase-change part 派生) */
  phase: TaskPhase | null;
  /** 总进度 0-100 (从 subtask done 比例派生) */
  progress: number;
  /** 子任务总数 */
  subtaskCount: number;
  /** 已完成子任务数 */
  doneCount: number;
  /** 是否已完成 (phase === DONE) */
  isDone: boolean;
  /** 是否出错 (phase === ERROR) */
  isError: boolean;
  /** 是否进行中 (非 DONE 且非 ERROR) */
  isActive: boolean;
  /** 是否有数据 (至少 1 个 part) */
  hasData: boolean;
}

const EMPTY_SUMMARY: StreamSummary = {
  phase: null,
  progress: 0,
  subtaskCount: 0,
  doneCount: 0,
  isDone: false,
  isError: false,
  isActive: false,
  hasData: false,
};

/**
 * 从 uiMessageStore 的 parts 数组派生流送区摘要
 *
 * 用法:
 *   const summary = useStreamSummary(chatId);
 *   if (summary.isDone) showCompleteBanner();
 *   if (summary.isActive) showProgressBar(summary.progress);
 */
export function useStreamSummary(chatId: string | null | undefined): StreamSummary {
  const message = useLastAssistantMessage(chatId);

  return useMemo<StreamSummary>(() => {
    if (!message || message.parts.length === 0) return EMPTY_SUMMARY;

    let phase: TaskPhase | null = null;
    let subtaskCount = 0;
    let doneCount = 0;

    for (const part of message.parts) {
      switch (part.type) {
        case 'phase-change': {
          const p = part as UIPhaseChangePart;
          phase = p.to as TaskPhase;
          break;
        }
        case 'subtask-created': {
          subtaskCount++;
          break;
        }
        case 'subtask-done': {
          const p = part as UISubTaskDonePart;
          if (p.status === 'done') doneCount++;
          break;
        }
      }
    }

    const progress = subtaskCount > 0
      ? Math.round((doneCount / subtaskCount) * 100)
      : phase ? 100 : 0;

    const isDone = phase === 'DONE';
    const isError = phase === 'ERROR';
    const isActive = phase !== null && !isDone && !isError;

    return {
      phase,
      progress,
      subtaskCount,
      doneCount,
      isDone,
      isError,
      isActive,
      hasData: true,
    };
  }, [message]);
}
