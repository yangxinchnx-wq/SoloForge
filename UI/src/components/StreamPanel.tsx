/**
 * StreamPanel — AI 行为流送区
 * 嵌入 ChatPanel 消息流中，替代原占位图片
 * 样式与消息卡片一致，无缝融入对话流
 *
 * 2026-07-10 性能优化 (Move State Down / Lift Content Up):
 *   - StreamPanel 只订阅 hasTask (boolean) + promptCards, 不订阅完整 task
 *   - TaskExecutionCard 独立订阅 task, 隔离高频更新
 *   - PromptCard 区不再因 task 变化而重渲染
 *   - usePromptCards 替代手动 promptCardPool.getActive 调用 (响应式)
 *
 * 参考: Dan Abramov "Before You memo()" — https://overreacted.io/before-you-memo/
 *
 * ★ 2026-07-13 增强: 过程↔总结 crossfade 过渡动画
 *   - 过程块退出时向上淡出 (stream-process-exit)
 *   - 总结块进入时从下淡入 (stream-summary-enter)
 *   - 消除 2 秒后折叠的视觉跳变感
 */
import React, { useEffect } from 'react';
import { Loader2, CheckCircle2, AlertCircle, Clock } from '../utils/icons';
import type { PermissionMode } from '../types/streaming';
import { useStreamingStore } from '../state/streamingStore';
import { promptCardPool } from '../services/promptCardPool';
import { usePromptCards } from '../hooks/usePromptCards';
import { PromptCard } from './PromptCard';
import { useAutoPersist, clearChatAll } from '../services/actorIntegration';
import { useStreamSummary } from '../services/useStreamSummary';
import { useRootTaskFromParts } from '../services/usePartsDerived';

interface StreamPanelProps {
  chatId: string;
  mainModel: string;
  modelCount: number;
  permissionMode: PermissionMode;
}

export default function StreamPanel({ chatId, mainModel, modelCount, permissionMode }: StreamPanelProps) {
  // P0: hasTask 从 uiMessageStore 派生 (替代 streamingStore.tasks[chatId])
  // useStreamSummary 只返回派生摘要, 不订阅完整 task 对象
  const summary = useStreamSummary(chatId);
  const hasTask = summary.hasData;

  // P3 集成: 自动持久化 streamingStore 状态 (每 10 次变化 + beforeunload)
  useAutoPersist(chatId);

  // useSyncExternalStore: 响应式订阅 promptCardPool
  const cards = usePromptCards(chatId);
  const blockingCards = cards.filter(c => c.spec.priority === 'blocking');
  const nonBlockingCards = cards.filter(c => c.spec.priority === 'non_blocking');

  // Ctrl+L 清空
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === 'l') {
        e.preventDefault();
        // P3 集成: clearChatAll 同时清理 streamingStore + Actor + uiMessageStore + persistence
        clearChatAll(chatId);
        promptCardPool.clearChat(chatId);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [chatId]);

  // 无任务且无卡片时不显示
  if (!hasTask && blockingCards.length === 0 && nonBlockingCards.length === 0) return null;

  return (
    <div className="flex flex-col gap-2 mt-4 text-left">
      {/* 阻塞型 PromptCard（追问）— 独立于 task, 不受 task 更新影响 */}
      {blockingCards.map(card => (
        <PromptCard
          key={card.spec.id}
          instance={card}
          onResolve={action => promptCardPool.resolve(card.spec.id, action)}
          onTimeout={() => promptCardPool.expire(card.spec.id)}
        />
      ))}

      {/* 任务执行卡片 — 独立组件, 内部订阅 task, 隔离高频更新 */}
      {hasTask && (
        <TaskExecutionCard
          chatId={chatId}
          mainModel={mainModel}
          modelCount={modelCount}
          permissionMode={permissionMode}
        />
      )}

      {/* 非阻塞型 PromptCard（工具建议）— 独立于 task */}
      {nonBlockingCards.map(card => (
        <PromptCard
          key={card.spec.id}
          instance={card}
          onResolve={action => promptCardPool.resolve(card.spec.id, action)}
          onTimeout={() => promptCardPool.expire(card.spec.id)}
        />
      ))}
    </div>
  );
}

// ==================== TaskExecutionCard — 隔离的任务执行区 ====================
// Move State Down: 把 task 订阅从 StreamPanel 下移到此处
// StreamPanel 只在 task 创建/删除时重渲染, 此组件在每个 task 事件时重渲染

interface TaskExecutionCardProps {
  chatId: string;
  mainModel: string;
  modelCount: number;
  permissionMode: PermissionMode;
}

function TaskExecutionCard({ chatId, mainModel, modelCount, permissionMode }: TaskExecutionCardProps) {
  // P0: 显示状态全部从 uiMessageStore (Data Parts) 派生
  const summary = useStreamSummary(chatId);
  const streamMeta = useStreamingStore(s => s.streamTaskMeta[chatId]);
  const userInput = streamMeta?.userInput;
  const rootTaskId = streamMeta?.rootTaskId;
  const task = useRootTaskFromParts(chatId, userInput, rootTaskId);

  if (!task && !summary.hasData) return null;

  const isDone = summary.isDone;
  const isError = summary.isError;
  const isActive = summary.isActive;
  const subCount = summary.subtaskCount;
  const doneCount = summary.doneCount;

  // ★ FIX 2026-07-14: 过程块已移至 UIMessagePartsRenderer (ChatPanel 统一渲染)
  //   TaskExecutionCard 只负责渲染总结块 + 进行中状态指示器
  //   修复: 1) 过程/总结互斥导致其中一个不显示  2) 无子任务时总结不显示  3) 过程信息缺失

  // 进行中: 显示进度指示器 (无总结块)
  if (isActive) {
    return (
      <div className="w-full pl-[58px] pr-3">
        <div className="flex items-center gap-1.5 px-2.5 py-1.5 text-[10px] text-on-surface/50 font-mono">
          <Loader2 className="w-3 h-3 text-primary animate-spin shrink-0" />
          <span>执行中 {subCount > 0 ? `(${doneCount}/${subCount})` : ''}</span>
        </div>
      </div>
    );
  }

  // 完成/错误: 显示总结块
  if (!isDone && !isError) return null;

  return (
    <div className="w-full pl-[58px] pr-3">
      <div className="border border-outline/30 rounded-lg bg-bg/50 p-3 space-y-1">
        <div className="flex items-center gap-1.5 text-on-surface/80 mb-1.5">
          {isError
            ? <AlertCircle className="w-3.5 h-3.5 text-red-400" />
            : <CheckCircle2 className="w-3.5 h-3.5 text-green-400" />
          }
          <span className="font-semibold text-[11px]">总结</span>
          {subCount > 0 && (
            <span className="text-[10px] text-on-surface/40 ml-auto font-mono">
              {doneCount}/{subCount} 完成
            </span>
          )}
        </div>
        {task?.subTasks.length > 0 && task.subTasks.map(st => (
          <div key={st.id} className="flex items-start gap-2 text-[11px] py-0.5">
            {st.status === 'done'
              ? <CheckCircle2 className="w-3 h-3 text-green-400 shrink-0 mt-0.5" />
              : st.status === 'error'
              ? <AlertCircle className="w-3 h-3 text-red-400 shrink-0 mt-0.5" />
              : <Clock className="w-3 h-3 text-on-surface/30 shrink-0 mt-0.5" />
            }
            <span className={`break-words [text-wrap:pretty] ${st.status === 'done' ? 'text-on-surface/50 line-through' : 'text-on-surface/80'}`}>
              {st.description}
            </span>
          </div>
        ))}
        {isError && !task?.subTasks?.length && (
          <div className="text-[11px] text-red-400/80 py-0.5">
            任务执行失败
          </div>
        )}
      </div>
    </div>
  );
}
