/**
 * ModelDelegationTag — 模型分配标签
 * 显示「GPT-4 被 Xiaomi 分配了 XXX 任务」
 */
import React from 'react';
import { ArrowRight, Bot } from '../utils/icons';

interface ModelDelegationTagProps {
  fromModel: string;
  toModel: string;
  task: string;
  className?: string;
}

export function ModelDelegationTag({ fromModel, toModel, task, className = '' }: ModelDelegationTagProps) {
  return (
    <div className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-primary/5 border border-primary/15 text-[10px] ${className}`}>
      <span className="text-primary font-bold">{fromModel}</span>
      <ArrowRight className="w-3 h-3 text-on-surface/30" />
      <Bot className="w-3 h-3 text-primary/60" />
      <span className="text-primary font-bold">{toModel}</span>
      <span className="text-on-surface/50">被分配了</span>
      <span className="text-on-surface/70 font-medium truncate max-w-[120px]">{task}</span>
    </div>
  );
}