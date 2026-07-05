/**
 * SubTaskNode — 单个子任务节点
 * 显示模型分配、进度百分比、步骤折叠（source=llm 走 StepRecordItem，source=browser-use 走 ReactStepBubble）
 */
import React, { useState } from 'react';
import { ChevronDown, Bot, Globe, Wrench, Zap, Loader2, CheckCircle2, AlertCircle, Clock } from '../utils/icons';
import { MountTransition } from './MountTransition';
import type { SubTask, SubTaskSource } from '../types/streaming';
import { StepRecordItem } from './StepRecordItem';
import { ModelDelegationTag } from './ModelDelegationTag';

interface SubTaskNodeProps {
  subTask: SubTask;
  mainModel: string;
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

export function SubTaskNode({ subTask, mainModel, defaultOpen = true }: SubTaskNodeProps) {
  const [open, setOpen] = useState(defaultOpen);
  const isDone = subTask.status === 'done';
  const isRunning = subTask.status === 'running';
  const isError = subTask.status === 'error';
  const isPending = subTask.status === 'pending';

  const statusIcon = isDone
    ? <CheckCircle2 className="w-3.5 h-3.5 text-green-400 shrink-0" />
    : isError
    ? <AlertCircle className="w-3.5 h-3.5 text-red-400 shrink-0" />
    : isRunning
    ? <Loader2 className="w-3.5 h-3.5 text-blue-400 animate-spin shrink-0" />
    : <Clock className="w-3.5 h-3.5 text-on-surface/30 shrink-0" />;

  const progressColor = isRunning ? 'bg-blue-500' : isDone ? 'bg-green-500' : isError ? 'bg-red-500' : 'bg-on-surface/20';

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

        {/* 进度条 */}
        <div className="flex items-center gap-2 ml-auto shrink-0">
          <div className="w-16 h-1.5 rounded-full bg-on-surface/10 overflow-hidden">
            <div
              className={`h-full rounded-full transition-all duration-300 ${progressColor}`}
              style={{ width: `${subTask.progress}%` }}
            />
          </div>
          <span className={`text-[11px] font-mono font-bold w-8 text-right ${isRunning ? 'text-blue-400' : isDone ? 'text-green-400' : 'text-on-surface/40'}`}>
            {subTask.progress}%
          </span>
        </div>
      </div>

      {/* 模型分配标签 */}
      {subTask.assigneeModel && (
        <div className="px-3 pb-1">
          <ModelDelegationTag
            fromModel={mainModel}
            toModel={subTask.assigneeModel}
            task={subTask.description}
          />
        </div>
      )}

      {/* 展开：步骤列表 */}
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