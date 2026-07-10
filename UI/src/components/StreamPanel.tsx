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
 */
import React, { useEffect, useState } from 'react';
import { ChevronDown, Loader2, CheckCircle2, AlertCircle, Clock } from '../utils/icons';
import type { PermissionMode } from '../types/streaming';
import { useStreamingStore } from '../state/streamingStore';
import { promptCardPool } from '../services/promptCardPool';
import { usePromptCards } from '../hooks/usePromptCards';
import { TaskTree } from './TaskTree';
import { PromptCard } from './PromptCard';
import { ModelIcon } from './ModelIcon';
// P3 集成: 自动持久化 + clearChatAll (同时清理 Actor + uiMessageStore + persistence)
import { useAutoPersist, clearChatAll } from '../services/actorIntegration';
// P3 集成: Data Parts 模式渲染器 — 与 TaskTree 并行, 展示 UIMessage parts 时间线
import { UIMessagePartsRenderer } from './UIMessagePartsRenderer';
import { MountTransition } from './MountTransition';
// H-3 迁移: 从 uiMessageStore 派生摘要状态, 替代直接订阅 streamingStore.tasks[chatId]
import { useStreamSummary } from '../services/useStreamSummary';
// P0 迁移: 从 parts 派生完整 RootTask, 替代 streamingStore.tasks[chatId]
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
  // 旧路径: useStreamingStore(s => s.tasks[chatId]) — 高频全量更新
  // 新路径: useRootTaskFromParts — 从 parts 聚合, 只在 part 变化时更新
  const summary = useStreamSummary(chatId);
  // userInput / rootTaskId 从 streamTaskMeta 读取 (控制流字段, 不在 parts 中, 低频)
  const streamMeta = useStreamingStore(s => s.streamTaskMeta[chatId]);
  const userInput = streamMeta?.userInput;
  const rootTaskId = streamMeta?.rootTaskId;
  const task = useRootTaskFromParts(chatId, userInput, rootTaskId);
  const [isExpanded, setIsExpanded] = useState(true);

  // 任务完成后2秒自动折叠具体信息, 显示总结
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    if (!summary.isDone && !summary.isError) {
      setCollapsed(false);
      return;
    }
    const timer = window.setTimeout(() => setCollapsed(true), 2000);
    return () => window.clearTimeout(timer);
  }, [summary.isDone, summary.isError]);

  if (!task && !summary.hasData) return null;

  const isDone = summary.isDone;
  const isError = summary.isError;
  const isActive = summary.isActive;
  const subCount = summary.subtaskCount;
  const doneCount = summary.doneCount;

  return (
    <>
      <div className="flex gap-3.5 items-center mb-1">
        <div className="w-11 h-11 rounded-full bg-on-surface/5 border border-on-surface/10 flex items-center justify-center shrink-0">
          <ModelIcon modelName={mainModel} size={32} className="shrink-0" />
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-bold text-primary">{mainModel}</span>
          <span className="text-[9px] text-on-surface/30 font-mono">{new Date().toLocaleTimeString('zh-CN', { hour12: false })}</span>
        </div>
      </div>

      <div className="max-w-[90%] pl-[58px]">
        <div className="bg-surface border border-outline/30 p-3.5 rounded-xl text-on-surface text-[12px] leading-relaxed space-y-3">
          {/* 摘要 */}
          <p className="text-on-surface/90">{userInput}</p>

          {/* 可折叠执行流程 */}
          <div className="border border-outline/30 rounded-lg overflow-hidden bg-bg/50">
            {/* 流程 Header */}
            <div
              onClick={() => setIsExpanded(!isExpanded)}
              className="p-2.5 bg-surface border-b border-outline/30 flex items-center justify-between text-[11px] cursor-pointer select-none"
            >
              <div className="flex items-center gap-1.5 text-on-surface/80">
                <ChevronDown className={`w-3.5 h-3.5 transition-transform duration-200 ${isExpanded ? 'rotate-0' : '-rotate-90'}`} />
                <span className="font-semibold">AI 执行流程</span>
                {isActive && (
                  <span className="text-[10px] text-primary bg-primary/10 px-1.5 py-0.5 rounded font-mono font-bold">
                    进行中 ({doneCount}/{subCount})
                  </span>
                )}
                {isDone && (
                  <span className="text-[10px] text-green-400 bg-green-500/10 px-1.5 py-0.5 rounded font-mono font-bold">
                    已完成
                  </span>
                )}
                {isError && (
                  <span className="text-[10px] text-red-400 bg-red-500/10 px-1.5 py-0.5 rounded font-mono font-bold">
                    错误
                  </span>
                )}
              </div>
              {isActive && (
                <Loader2 className="w-3.5 h-3.5 text-primary animate-spin shrink-0" />
              )}
            </div>

            {/* 流程内容 — 任务完成后2秒自动淡出 */}
            <MountTransition show={isExpanded && !collapsed} variant="fade" duration={180}>
              <div className="p-3 space-y-2">
                <TaskTree
                  task={task}
                  mainModel={mainModel}
                  modelCount={modelCount}
                  mode={permissionMode}
                  chatId={chatId}
                />
                {/* P0: Data Parts 时间线 — TaskTree 和 UIMessagePartsRenderer 均从 uiMessageStore 派生 */}
                <div className="border-t border-outline/15 pt-2">
                  <UIMessagePartsRenderer chatId={chatId} />
                </div>
              </div>
            </MountTransition>

            {/* 任务总结 — 折叠后淡入显示 */}
            <MountTransition show={collapsed} variant="fade" duration={220}>
              <div className="p-3 space-y-1">
                <div className="flex items-center gap-1.5 text-on-surface/80 mb-1.5">
                  {isError
                    ? <AlertCircle className="w-3.5 h-3.5 text-red-400" />
                    : <CheckCircle2 className="w-3.5 h-3.5 text-green-400" />
                  }
                  <span className="font-semibold text-[11px]">任务总结</span>
                  <span className="text-[10px] text-on-surface/40 ml-auto font-mono">
                    {doneCount}/{subCount} 完成
                  </span>
                </div>
                {task?.subTasks.map(st => (
                  <div key={st.id} className="flex items-center gap-2 text-[11px] py-0.5">
                    {st.status === 'done'
                      ? <CheckCircle2 className="w-3 h-3 text-green-400 shrink-0" />
                      : st.status === 'error'
                      ? <AlertCircle className="w-3 h-3 text-red-400 shrink-0" />
                      : <Clock className="w-3 h-3 text-on-surface/30 shrink-0" />
                    }
                    <span className={`truncate ${st.status === 'done' ? 'text-on-surface/50 line-through' : 'text-on-surface/80'}`}>
                      {st.description}
                    </span>
                  </div>
                ))}
              </div>
            </MountTransition>
          </div>
        </div>
      </div>
    </>
  );
}
