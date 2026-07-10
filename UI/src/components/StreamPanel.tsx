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
import { ChevronDown } from '../utils/icons';
import type { StreamEvent, PermissionMode } from '../types/streaming';
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
// H-3 迁移: 从 uiMessageStore 派生摘要状态, 替代直接订阅 streamingStore.tasks[chatId]
import { useStreamSummary } from '../services/useStreamSummary';

interface StreamPanelProps {
  chatId: string;
  mainModel: string;
  modelCount: number;
  permissionMode: PermissionMode;
  events?: StreamEvent[];
}

export default function StreamPanel({ chatId, mainModel, modelCount, permissionMode, events = [] }: StreamPanelProps) {
  // Move State Down: 只订阅 hasTask (boolean), 不订阅完整 task 对象
  // task 字段变化 (subtask progress, phase 等) 不会触发 StreamPanel 重渲染
  const hasTask = useStreamingStore(s => !!s.tasks[chatId]);

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

  // 事件到达通知 (留作未来扩展: 滚动/声音通知等)
  useEffect(() => {
    if (events.length === 0) return;
  }, [events]);

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
  // H-3 迁移: 高频显示状态 (phase, progress, subtask counts) 从 uiMessageStore 派生
  // 旧路径: const task = useStreamingStore(s => s.tasks[chatId]);
  // 新路径: useStreamSummary 从 Data Parts 派生, 只在 part 变化时更新
  const summary = useStreamSummary(chatId);
  // userInput 仍从 streamingStore 读取 (原始 prompt 不在 parts 中, 低频)
  const userInput = useStreamingStore(s => s.tasks[chatId]?.userInput);
  const task = useStreamingStore(s => s.tasks[chatId]);
  const [isExpanded, setIsExpanded] = useState(true);

  if (!task && !summary.hasData) return null;

  const isDone = summary.isDone;
  const isError = summary.isError;
  const isActive = summary.isActive;
  const subCount = summary.subtaskCount;
  const doneCount = summary.doneCount;
  const progress = summary.progress;

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
              <span className="text-[10px] text-on-surface/40 font-mono">
                {progress}%
              </span>
            </div>

            {/* 流程内容 */}
            {isExpanded && (
              <div className="p-3 space-y-2">
                <TaskTree
                  task={task}
                  mainModel={mainModel}
                  modelCount={modelCount}
                  mode={permissionMode}
                />
                {/* P3: Data Parts 时间线 — 与 TaskTree 并行渲染
                    TaskTree 消费 streamingStore (旧路径), UIMessagePartsRenderer 消费 uiMessageStore (新路径)
                    双路径并行, 后续可逐步将 TaskTree 功能迁移到 parts 渲染器 */}
                <div className="border-t border-outline/15 pt-2">
                  <UIMessagePartsRenderer chatId={chatId} />
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
