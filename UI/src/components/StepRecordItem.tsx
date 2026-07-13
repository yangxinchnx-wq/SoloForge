/**
 * StepRecordItem — 单个步骤折叠
 * 显示子任务的一个步骤（READ_TASK/UNDERSTAND/DECIDE/EXECUTE/COMPLETE/SUBMIT_TO_JUDGE）
 *
 * ★ 2026-07-13 增强: 圆点节点 + 连接线 (替代原 0.5px 细线)
 *   - 每个步骤头部有圆点标记, 视觉层级清晰
 *   - 连接线使用 bg-outline/30 (原 20%), 更易见
 *   - 圆点颜色随状态变化: done=green, running=blue animate-pulse, default=gray
 */
import React, { useState, memo } from 'react';
import { ChevronDown, CheckCircle2, Loader2, Clock, AlertCircle } from '../utils/icons';
import type { StepRecord, SubTaskStep } from '../types/streaming';

interface StepRecordItemProps {
  step: StepRecord;
  isLast?: boolean;
}

const STEP_LABELS: Record<SubTaskStep, string> = {
  READ_TASK: '阅读任务',
  UNDERSTAND: '理解任务',
  DECIDE: '进行决定',
  EXECUTE: '开始任务',
  COMPLETE: '任务完成',
  SUBMIT_TO_JUDGE: '提交到裁判',
};

export const StepRecordItem = memo(function StepRecordItem({ step, isLast }: StepRecordItemProps) {
  const [open, setOpen] = useState(false);
  const isDone = step.status === 'done';
  const isRunning = step.status === 'running';
  const isError = step.status === 'error';

  const statusIcon = isDone
    ? <CheckCircle2 className="w-3 h-3 text-green-400 shrink-0" />
    : isError
    ? <AlertCircle className="w-3 h-3 text-red-400 shrink-0" />
    : isRunning
    ? <Loader2 className="w-3 h-3 text-blue-400 animate-spin shrink-0" />
    : <Clock className="w-3 h-3 text-on-surface/30 shrink-0" />;

  return (
    <div className="relative">
      {/* ★ 增强版连接线: 圆点 + 竖线 */}
      <div className="relative flex flex-col items-center mr-1 shrink-0 pt-[3px]">
        <div
          className={`w-[7px] h-[7px] rounded-full shrink-0 ring-[3px] ring-offset-1 ${
            isDone
              ? 'bg-green-500 ring-green-100'
              : isRunning
              ? 'bg-blue-500 ring-blue-100 animate-pulse'
              : 'bg-gray-300 ring-gray-100'
          }`}
        />
        {!isLast && (
          <div className="w-px flex-1 bg-outline/30 mt-1 min-h-[4px]" />
        )}
      </div>

      <div className="flex items-start gap-2 py-0.5">
        <div className="mt-0.5 shrink-0">{statusIcon}</div>

        <div className="flex-1 min-w-0">
          <div
            className="flex items-center gap-1.5 cursor-pointer select-none"
            onClick={() => setOpen(!open)}
          >
            <span className={`text-[11px] ${isDone ? 'text-on-surface/60' : isRunning ? 'text-on-surface font-bold' : 'text-on-surface/40'}`}>
              {STEP_LABELS[step.step] ?? step.step}
            </span>
            <span className={`text-[10px] font-mono ${isDone ? 'text-green-400' : isRunning ? 'text-blue-400' : 'text-on-surface/30'}`}>
              {step.progress}%
            </span>
            {step.detail && (
              <ChevronDown className={`w-3 h-3 text-on-surface/30 transition-transform ${open ? 'rotate-0' : '-rotate-90'}`} />
            )}
          </div>

          {/* 折叠详情 */}
          {open && step.detail && (
            <div className="mt-1 ml-1 pl-2 border-l border-outline/15 text-[10px] text-on-surface/50 leading-relaxed whitespace-pre-wrap">
              {step.detail}
            </div>
          )}
        </div>
      </div>
    </div>
  );
});
