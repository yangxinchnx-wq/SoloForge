/**
 * TaskTree — 任务树容器
 * 展示根任务、子任务列表、审查区、进度条
 */
import React from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Layers, ChevronDown } from 'lucide-react';
import type { RootTask, PermissionMode } from '../types/streaming';
import type { ArbitrationResult } from '../types/streaming';
import { SubTaskNode } from './SubTaskNode';
import { AuditSection } from './AuditSection';

interface TaskTreeProps {
  task: RootTask;
  mainModel: string;
  modelCount: number;
  mode: PermissionMode;
  arbitrationResult?: ArbitrationResult;
}

const PHASE_LABELS: Record<string, string> = {
  CLARIFY: '追问用户',
  PLANNING: 'AI社会评判',
  DECOMPOSING: '任务分层',
  DISPATCHING: '分配任务',
  EXECUTING: '执行中',
  REVIEWING: '审查中',
  DELIVERING: '交付结果',
  DONE: '完成',
  ERROR: '错误',
};

export function TaskTree({ task, mainModel, modelCount, mode, arbitrationResult }: TaskTreeProps) {
  const isDone = task.phase === 'DONE';
  const isError = task.phase === 'ERROR';

  const progressColor = isError ? 'bg-red-500' : isDone ? 'bg-green-500' : 'bg-blue-500';

  return (
    <div className="flex flex-col gap-2">
      {/* 全局进度条 */}
      <div className="flex items-center gap-2 px-1">
        <div className="flex-1 h-2 rounded-full bg-on-surface/10 overflow-hidden">
          <motion.div
            className={`h-full rounded-full ${progressColor} transition-all duration-500`}
            initial={{ width: '0%' }}
            animate={{ width: `${task.progress}%` }}
          />
        </div>
        <span className="text-[11px] font-mono font-bold text-on-surface/60 w-8 text-right">
          {task.progress}%
        </span>
        <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
          isDone ? 'text-green-400 bg-green-500/10'
            : isError ? 'text-red-400 bg-red-500/10'
            : 'text-blue-400 bg-blue-500/10'
        }`}>
          {PHASE_LABELS[task.phase] ?? task.phase}
        </span>
      </div>

      {/* 用户输入 */}
      <div className="text-[11px] text-on-surface/50 px-1 leading-relaxed">
        <span className="text-on-surface/30">任务: </span>
        {task.userInput}
      </div>

      {/* 子任务列表 */}
      {task.subTasks.length > 0 && (
        <div className="space-y-1.5 mt-1">
          {task.subTasks.map(st => (
            <SubTaskNode
              key={st.id}
              subTask={st}
              mainModel={mainModel}
              defaultOpen={st.status === 'running'}
            />
          ))}
        </div>
      )}

      {/* 审查区 */}
      {task.auditTask && (
        <div className="mt-1">
          <AuditSection
            auditTask={task.auditTask}
            result={arbitrationResult}
            mode={mode}
            modelCount={modelCount}
          />
        </div>
      )}

      {/* 空态 */}
      {task.subTasks.length === 0 && !task.auditTask && (
        <div className="flex items-center gap-2 px-2 py-4 text-[11px] text-on-surface/30">
          <Layers className="w-3.5 h-3.5" />
          <span>等待任务分配...</span>
        </div>
      )}
    </div>
  );
}