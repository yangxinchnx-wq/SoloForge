/**
 * SubTaskNode — 单个子任务节点
 * 显示模型分配、进度百分比、步骤折叠（source=llm 走 StepRecordItem，source=browser-use 走 ReactStepBubble）
 *
 * 2026-07-10 性能优化:
 *   - React.memo: 仅在 subTask prop 引用变化时重渲染
 *   - useTextBuffer + useDeferredValue: 高频 text_chunk 延迟渲染, 不阻塞主线程
 *   - 文本缓冲 UI: 展示流式 LLM 输出 (之前缺失)
 */
import React, { useState, useDeferredValue, memo } from 'react';
import { ChevronDown, Bot, Globe, Wrench, Zap, Loader2, CheckCircle2, AlertCircle, Clock } from '../utils/icons';
import { MountTransition } from './MountTransition';
import type { SubTask, SubTaskSource } from '../types/streaming';
import { StepRecordItem } from './StepRecordItem';
import { ModelDelegationTag } from './ModelDelegationTag';
// P0: 从 parts 派生文本, 替代 streamingStore.textBuffers
import { useTextFromParts } from '../services/usePartsDerived';
// 实时查询 agent 名字和头像 — agent 改名/改头像后自动响应式更新
import { useAgentName, useAgentAvatar } from '../state/streamingStore';

interface SubTaskNodeProps {
  subTask: SubTask;
  mainModel: string;
  chatId: string;
  defaultOpen?: boolean;
}

const SOURCE_ICONS: Record<SubTaskSource, React.ReactElement> = {
  'llm': <Bot className="w-3.5 h-3.5 text-blue-400" />,
  'browser-use': <Globe className="w-3.5 h-3.5 text-indigo-400" />,
  'tool': <Wrench className="w-3.5 h-3.5 text-amber-400" />,
  'skill': <Zap className="w-3.5 h-3.5 text-purple-400" />,
};

const SOURCE_LABELS: Record<SubTaskSource, string> = {
  'llm': 'LLM',
  'browser-use': '浏览器',
  'tool': '工具',
  'skill': '技能',
};

function SubTaskNodeImpl({ subTask, mainModel, chatId, defaultOpen = true }: SubTaskNodeProps) {
  const [open, setOpen] = useState(defaultOpen);
  const isDone = subTask.status === 'done';
  const isRunning = subTask.status === 'running';
  const isError = subTask.status === 'error';
  const isPending = subTask.status === 'pending';

  // P0: 从 parts 派生文本 (替代 streamingStore.textBuffers)
  // useDeferredValue: 高频 text_chunk 延迟到下一帧渲染, 自动合并
  const rawTextBuffer = useTextFromParts(chatId, subTask.id);
  const textBuffer = useDeferredValue(rawTextBuffer);
  const isTextStale = rawTextBuffer !== textBuffer;

  // 实时查询 agent 名字和头像 — agent 改名/改头像后自动响应式更新, 不缓存旧值
  const agentName = useAgentName(chatId, subTask.agentId);
  const agentAvatar = useAgentAvatar(chatId, subTask.agentId);

  const statusIcon = isDone
    ? <CheckCircle2 className="w-3.5 h-3.5 text-green-400 shrink-0" />
    : isError
    ? <AlertCircle className="w-3.5 h-3.5 text-red-400 shrink-0" />
    : isRunning
    ? <Loader2 className="w-3.5 h-3.5 text-blue-400 animate-spin shrink-0" />
    : <Clock className="w-3.5 h-3.5 text-on-surface/30 shrink-0" />;

  return (
    <div className="border border-outline/15 rounded-lg overflow-hidden bg-bg/30">
      {/* Header */}
      <div
        className="flex items-center gap-2 px-3 py-2 cursor-pointer select-none hover:bg-on-surface/[0.02] transition-colors"
        onClick={() => setOpen(!open)}
      >
        <ChevronDown className={`w-3.5 h-3.5 text-on-surface/40 transition-transform shrink-0 ${open ? 'rotate-0' : '-rotate-90'}`} />
        {statusIcon}
        <span className="text-[10px] font-mono text-on-surface/30 bg-on-surface/5 px-1 py-0.5 rounded shrink-0">
          {SOURCE_LABELS[subTask.source]}
        </span>
        <span className={`text-[11px] font-medium truncate ${isDone ? 'text-on-surface/50 line-through' : 'text-on-surface'}`}>
          {subTask.description}
        </span>
      </div>

      {/* 模型分配标签: 副模型 → agent → 任务 */}
      {subTask.assigneeModel && (
        <div className="px-3 pb-1">
          <ModelDelegationTag
            fromModel={subTask.assigneeModel || mainModel}
            task={subTask.description}
            agentName={agentName}
            agentAvatar={agentAvatar}
          />
        </div>
      )}

      {/* 展开：步骤列表 + 流式文本 */}
      <MountTransition show={open} variant="height" duration={200}>
        <div>
            <div className="px-3 pb-2 border-t border-outline/5">
              {subTask.stepHistory.length > 0 ? (
                <div className="pt-2 space-y-0.5">
                  {subTask.stepHistory.map((step, i) => (
                    <StepRecordItem
                      key={`${step.step}-${i}`}
                      step={step}
                      isLast={i === subTask.stepHistory.length - 1}
                    />
                  ))}
                </div>
              ) : (
                <div className="pt-2 text-[10px] text-on-surface/30">等待步骤信息...</div>
              )}
            </div>

            {/* 流式文本缓冲区 — LLM 逐字输出展示 */}
            {textBuffer && (
              <div className={`px-3 pb-2 border-t border-outline/5 transition-opacity duration-150 ${isTextStale ? 'opacity-60' : 'opacity-100'}`}>
                <div className="pt-2 text-[11px] text-on-surface/70 leading-relaxed whitespace-pre-wrap break-words font-mono">
                  {textBuffer}
                  {isRunning && !isDone && (
                    <span className="inline-block w-1.5 h-3 bg-blue-400 animate-pulse ml-0.5 align-middle" />
                  )}
                </div>
              </div>
            )}

            {/* browser-use 特有：URL 信息 */}
            {subTask.source === 'browser-use' && subTask.browserUrl && (
              <div className="px-3 pb-2">
                <span className="text-[10px] text-on-surface/40 font-mono">{subTask.browserUrl}</span>
              </div>
            )}
        </div>
      </MountTransition>
    </div>
  );
}

// React.memo: 仅在 subTask/mainModel/defaultOpen prop 变化时重渲染
// text_chunk 事件不再触发此组件重渲染 (通过 useTextBuffer 独立订阅)
export const SubTaskNode = memo(SubTaskNodeImpl);
