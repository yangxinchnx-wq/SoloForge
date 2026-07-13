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
import React, { useEffect, useState } from 'react';
import { ChevronDown, Loader2, CheckCircle2, AlertCircle, Clock } from '../utils/icons';
import type { PermissionMode } from '../types/streaming';
import { useStreamingStore } from '../state/streamingStore';
import { promptCardPool } from '../services/promptCardPool';
import { usePromptCards } from '../hooks/usePromptCards';
import { TaskTree } from './TaskTree';
import { PromptCard } from './PromptCard';
// ModelIcon import removed — header avatar is rendered by ChatPanel, not StreamPanel
// P3 集成: 自动持久化 + clearChatAll (同时清理 Actor + uiMessageStore + persistence)
import { useAutoPersist, clearChatAll } from '../services/actorIntegration';
// ★ 2026-07-13: UIMessagePartsRenderer 已移至 ChatPanel map 内, 每轮独立渲染
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
  // ★ 用户手动展开开关: 折叠后用户可点击重新展开查看完整过程, 再次点击收起
  const [userExpanded, setUserExpanded] = useState(false);
  useEffect(() => {
    if (!summary.isDone && !summary.isError) {
      setCollapsed(false);
      setUserExpanded(false); // 新任务开始时重置用户展开状态
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
      {/* ★ FIX 2026-07-14: 移除重复的头像+模型名头部 — ChatPanel 已为每条消息渲染头像,
          TaskExecutionCard 只渲染过程块+总结块, 避免出现两个重复的模型头像 */}

      <div className="w-full pl-[58px] pr-3 space-y-3">
        {/* ★ 2026-07-13: 流送区只显示两个块 — 过程 + 总结, 等宽自适应, 同样式 */}

        {/* 块1: AI 执行流程 (过程) */}
        {/* ★ 2026-07-13: 折叠退出时加 stream-process-exit 类触发向上淡出动画 */}
        <div className={`border border-outline/30 rounded-lg overflow-hidden bg-bg/50 ${collapsed && !userExpanded ? 'stream-process-exit' : ''}`}>
          {/* 流程 Header */}
          <div
            onClick={() => setIsExpanded(!isExpanded)}
            className="p-2.5 bg-surface border-b border-outline/30 flex items-center justify-between text-[11px] cursor-pointer select-none"
          >
            <div className="flex items-center gap-1.5 text-on-surface/80">
              <ChevronDown className={`w-3.5 h-3.5 transition-transform duration-200 ${isExpanded ? 'rotate-0' : '-rotate-90'}`} />
              <span className="font-semibold">过程</span>
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

          {/* 流程内容 — 进行中跟随 isExpanded; 完成后自动折叠, 但用户可通过开关重新展开 */}
          <MountTransition show={isExpanded && (!collapsed || userExpanded)} variant="fade" duration={180}>
            <div className="p-3 space-y-2">
              {/* 用户展开后显示"收起"开关 */}
              {collapsed && userExpanded && (
                <button
                  onClick={() => setUserExpanded(false)}
                  className="w-full flex items-center justify-center gap-1.5 py-1 text-[10px] text-on-surface/50 hover:text-primary border border-outline/20 hover:border-primary/30 rounded-md transition-colors cursor-default"
                >
                  <ChevronDown className="w-3 h-3 rotate-[-90deg]" />
                  <span>收起完整过程</span>
                </button>
              )}
              <TaskTree
                task={task}
                mainModel={mainModel}
                modelCount={modelCount}
                mode={permissionMode}
                chatId={chatId}
              />
            </div>
          </MountTransition>
        </div>

        {/* 块2: 任务总结 — 与过程块同样式等宽; 折叠后淡入显示, 用户展开时隐藏
            ★ 2026-07-13: subCount === 0 且非错误时不显示, 避免空总结 */}
        {(subCount > 0 || isError) && (
        /* ★ 2026-07-13: 总结块进入时加 stream-summary-enter 类触发从下淡入动画 */
        <MountTransition show={collapsed && !userExpanded} variant="fade" duration={220}>
          <div className="border border-outline/30 rounded-lg bg-bg/50 p-3 space-y-1 stream-summary-enter">
            <div className="flex items-center gap-1.5 text-on-surface/80 mb-1.5">
              {isError
                ? <AlertCircle className="w-3.5 h-3.5 text-red-400" />
                : <CheckCircle2 className="w-3.5 h-3.5 text-green-400" />
              }
              <span className="font-semibold text-[11px]">总结</span>
              <span className="text-[10px] text-on-surface/40 ml-auto font-mono">
                {doneCount}/{subCount} 完成
              </span>
            </div>
            {task?.subTasks.map(st => (
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
            {/* ★ 开关: 点击展开查看完整过程 */}
            <button
              onClick={() => setUserExpanded(true)}
              className="w-full flex items-center justify-center gap-1.5 py-1 mt-1 text-[10px] text-on-surface/50 hover:text-primary border border-outline/20 hover:border-primary/30 rounded-md transition-colors cursor-default"
            >
              <ChevronDown className="w-3 h-3" />
              <span>查看完整过程</span>
            </button>
          </div>
        </MountTransition>
        )}
      </div>
    </>
  );
}
