/**
 * StreamPanel — AI 行为流送区
 * 嵌入 ChatPanel 消息流中，替代原占位图片
 * 样式与消息卡片一致，无缝融入对话流
 */
import React, { useEffect, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import type { StreamEvent, PermissionMode } from '../types/streaming';
import { useStreamingStore } from '../state/streamingStore';
import { promptCardPool } from '../state/promptCardPool';
import { TaskTree } from './TaskTree';
import { PromptCard } from './PromptCard';
import { ModelIcon } from './ModelIcon';

interface StreamPanelProps {
  chatId: string;
  mainModel: string;
  modelCount: number;
  permissionMode: PermissionMode;
  // 任务级流送事件（由调用方从 streamingStore.eventBuffer[chatId] 注入）。
  // 实际数据源: streamingStore.applyEvent 入缓冲时已经驱动任务树状态机,
  // 这里传入的 events 用于在"新事件"到达时触发额外副作用 (例如: 滚动到底部 / 触发提示音)。
  // 不要再在此组件内再次 applyEvent, 避免双调度。
  // R1.3 fix: 删除 useStreamBuffer 死代码, events prop 仅作"事件到达通知"用
  events?: StreamEvent[];
}

export default function StreamPanel({ chatId, mainModel, modelCount, permissionMode, events = [] }: StreamPanelProps) {
  const task = useStreamingStore(s => s.tasks[chatId]);
  const [isExpanded, setIsExpanded] = useState(true);

  // R1.3 fix: Ctrl+L 清空 (直接调 store, 不再绕 useStreamBuffer)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === 'l') {
        e.preventDefault();
        useStreamingStore.getState().clearChat(chatId);
        promptCardPool.clearChat(chatId);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [chatId]);

  // R1.3 fix: 事件计数 (开发/调试用, 之前 useStreamBuffer 内部维护)
  // events prop 仍保留, 后续可在 effect 里挂"新事件到达"的通知副作用
  useEffect(() => {
    if (events.length === 0) return;
    // 当前无副作用, 留作未来扩展 (滚动/声音通知等)
  }, [events]);

  const activeCards = promptCardPool.getActive(chatId);
  const blockingCards = activeCards.filter(c => c.spec.priority === 'blocking');
  const nonBlockingCards = activeCards.filter(c => c.spec.priority === 'non_blocking');

  // 无任务时不显示
  if (!task && blockingCards.length === 0 && nonBlockingCards.length === 0) return null;

  const isDone = task?.phase === 'DONE';
  const isError = task?.phase === 'ERROR';
  const isActive = task && task.phase !== 'DONE' && task.phase !== 'ERROR';
  const subCount = task?.subTasks.length ?? 0;
  const doneCount = task?.subTasks.filter(s => s.status === 'done').length ?? 0;

  return (
    <div className="flex flex-col gap-2 mt-4 text-left">
      {/* 阻塞型 PromptCard（追问）*/}
      {blockingCards.map(card => (
        <PromptCard
          key={card.spec.id}
          instance={card}
          onResolve={action => promptCardPool.resolve(card.spec.id, action)}
          onTimeout={() => promptCardPool.expire(card.spec.id)}
        />
      ))}

      {/* 任务执行卡片 — 与消息卡片风格一致 */}
      {task && (
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
            <p className="text-on-surface/90">{task.userInput}</p>

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
                  {task.progress}%
                </span>
              </div>

              {/* 流程内容 */}
              {isExpanded && (
                <div className="p-3">
                  <TaskTree
                    task={task}
                    mainModel={mainModel}
                    modelCount={modelCount}
                    mode={permissionMode}
                  />
                </div>
              )}
            </div>
          </div>
        </div>
        </>
      )}

      {/* 非阻塞型 PromptCard（工具建议）*/}
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