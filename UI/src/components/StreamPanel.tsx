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
import React, { useEffect, useMemo } from 'react';
import { Loader2, CheckCircle2, AlertCircle, Clock, Gauge } from '../utils/icons';
import type { PermissionMode } from '../types/streaming';
import type { UIUsagePart } from '../types/messages';
import { useStreamingStore } from '../state/streamingStore';
import { promptCardPool } from '../services/promptCardPool';
import { usePromptCards } from '../hooks/usePromptCards';
import { PromptCard } from './PromptCard';
import { useAutoPersist, clearChatAll } from '../services/actorIntegration';
import { useStreamSummary } from '../services/useStreamSummary';
import { useRootTaskFromParts } from '../services/usePartsDerived';
import { useLastAssistantMessage } from '../services/uiMessageStore';

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

  // ★ FIX 2026-07-14: 所有 Hook 必须在任何条件 return 之前调用 (Rules of Hooks)
  //   之前 useLastAssistantMessage + useMemo 放在了 if (isActive) return 之后,
  //   导致 isActive 切换时 Hook 数量变化 → "Rendered more hooks than during the previous render"
  const lastMsg = useLastAssistantMessage(chatId);
  const usageParts = useMemo(
    () => (lastMsg?.parts.filter(p => p.type === 'usage') as UIUsagePart[]) ?? [],
    [lastMsg],
  );

  if (!task && !summary.hasData) return null;

  const isDone = summary.isDone;
  const isError = summary.isError;
  const isActive = summary.isActive;
  const subCount = summary.subtaskCount;
  const doneCount = summary.doneCount;

  // ★ FIX 2026-07-14: 进行中也显示丰富信息, 不再只显示 spinner
  //   过程块由 UIMessagePartsRenderer 渲染, 这里显示:
  //   - 当前阶段 (phase)
  //   - 总进度条
  //   - 子任务完成数
  //   - 用户输入回显

  // 进行中: 显示进度面板 (不再是单一 spinner)
  if (isActive) {
    const phaseLabel = summary.phase || '执行中';
    const phaseColors: Record<string, string> = {
      CLARIFY: 'text-orange-400 bg-orange-500/10',
      PLANNING: 'text-violet-400 bg-violet-500/10',
      DECOMPOSING: 'text-blue-400 bg-blue-500/10',
      DISPATCHING: 'text-cyan-400 bg-cyan-500/10',
      EXECUTING: 'text-indigo-400 bg-indigo-500/10',
      REVIEWING: 'text-amber-400 bg-amber-500/10',
      AUDITING: 'text-purple-400 bg-purple-500/10',
      DELIVERING: 'text-teal-400 bg-teal-500/10',
      SINGLE_MODEL: 'text-blue-400 bg-blue-500/10',
    };
    const phaseClass = phaseColors[phaseLabel] ?? 'text-on-surface/60 bg-on-surface/5';

    return (
      <div className="w-full pl-[58px] pr-3">
        <div className="border border-outline/30 rounded-lg bg-bg/50 p-3 space-y-2">
          {/* 阶段 + 进度头 */}
          <div className="flex items-center gap-1.5">
            <Loader2 className="w-3 h-3 text-primary animate-spin shrink-0" />
            <span className={`px-1.5 py-0.5 rounded font-mono font-bold text-[10px] ${phaseClass}`}>
              {phaseLabel}
            </span>
            {subCount > 0 && (
              <span className="text-[10px] text-on-surface/40 font-mono ml-auto">
                {doneCount}/{subCount} 子任务完成
              </span>
            )}
          </div>

          {/* 总进度条 */}
          {subCount > 0 && (
            <div className="flex items-center gap-2">
              <div className="flex-1 h-1 rounded-full bg-on-surface/10 overflow-hidden">
                <div
                  className="h-full rounded-full bg-primary transition-all duration-300"
                  style={{ width: `${summary.progress}%` }}
                />
              </div>
              <span className="text-[10px] font-mono text-on-surface/40 tabular-nums w-8 text-right">
                {summary.progress}%
              </span>
            </div>
          )}

          {/* 用户输入回显 */}
          {userInput && (
            <div className="text-[10px] text-on-surface/40 truncate pl-1 border-l-2 border-primary/30">
              {userInput}
            </div>
          )}

          {/* 子任务列表 (进行中/已完成) */}
          {task?.subTasks && task.subTasks.length > 0 && (
            <div className="flex flex-col gap-0.5 pt-1">
              {task.subTasks.map(st => (
                <div key={st.id} className="flex items-start gap-1.5 text-[10px] py-0.5">
                  {st.status === 'done'
                    ? <CheckCircle2 className="w-2.5 h-2.5 text-green-400 shrink-0 mt-0.5" />
                    : st.status === 'error'
                    ? <AlertCircle className="w-2.5 h-2.5 text-red-400 shrink-0 mt-0.5" />
                    : <Loader2 className="w-2.5 h-2.5 text-primary animate-spin shrink-0 mt-0.5" />
                  }
                  <span className={`break-words [text-wrap:pretty] ${st.status === 'done' ? 'text-on-surface/40 line-through' : 'text-on-surface/70'}`}>
                    {st.description}
                  </span>
                  {st.source === 'browser-use' && (
                    <span className="text-[9px] text-indigo-400/60 font-mono shrink-0">[browser]</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  // 完成/错误: 显示总结块 + Token 统计
  if (!isDone && !isError) return null;

  const formatToken = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
  // 聚合多个 usage part (多模型场景各自一个 usage part)
  const totalPrompt = usageParts.reduce((s, p) => s + p.promptTokens, 0);
  const totalCompletion = usageParts.reduce((s, p) => s + p.completionTokens, 0);
  const totalTokens = usageParts.reduce((s, p) => s + p.totalTokens, 0);
  const totalCached = usageParts.reduce((s, p) => s + (p.cachedTokens ?? 0), 0);
  const cacheRate = totalPrompt > 0 ? Math.round((totalCached / totalPrompt) * 100) : 0;

  return (
    <div className="w-full pl-[58px] pr-3">
      {/* 总结气泡 */}
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

      {/* Token 统计 — 总结气泡下方 */}
      {usageParts.length > 0 && (
        <div className="flex items-center gap-2 px-1 py-1 text-[10px] font-mono text-on-surface/40">
          <Gauge className="w-3 h-3 text-on-surface/40 shrink-0" />
          <span className="shrink-0">Token</span>
          <span className="text-on-surface/50">
            {formatToken(totalPrompt)} + {formatToken(totalCompletion)}
          </span>
          <span className="text-on-surface/30">=</span>
          <span className="text-on-surface/70 font-bold">{formatToken(totalTokens)}</span>
          {totalCached > 0 && (
            <span className="text-emerald-400/60">
              (缓存命中 {formatToken(totalCached)} · {cacheRate}%)
            </span>
          )}
        </div>
      )}
    </div>
  );
}
