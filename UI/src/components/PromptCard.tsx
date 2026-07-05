/**
 * PromptCard — 通用交互模块
 * 统合追问、工具建议、浏览器启用、权限确认等所有交互卡片
 * 大模型可自由扩展 type='custom'
 */
import React from 'react';
import { MountTransition } from './MountTransition';
import { HelpCircle, Wrench, Shield, Zap, Globe, AlertTriangle, CheckCircle2, Clock, X } from '../utils/icons';
import { useCountdownTimer } from '../hooks/useCountdownTimer';
import type { PromptCardInstance, PromptCardType, PromptAction } from '../types/streaming';

interface PromptCardProps {
  instance: PromptCardInstance;
  onResolve: (action: PromptAction) => void;
  onTimeout: () => void;
  onDismiss?: () => void;
}

const TYPE_META: Record<PromptCardType, {
  icon: React.ReactElement;
  color: string;
  bg: string;
  border: string;
}> = {
  clarification: {
    icon: <HelpCircle className="w-4 h-4 shrink-0" />,
    color: 'text-amber-400',
    bg: 'bg-amber-500/5',
    border: 'border-amber-500/30',
  },
  tool_suggestion: {
    icon: <Wrench className="w-4 h-4 shrink-0" />,
    color: 'text-blue-400',
    bg: 'bg-blue-500/5',
    border: 'border-blue-500/30',
  },
  skill_suggestion: {
    icon: <Zap className="w-4 h-4 shrink-0" />,
    color: 'text-purple-400',
    bg: 'bg-purple-500/5',
    border: 'border-purple-500/30',
  },
  knowledge_suggestion: {
    icon: <Zap className="w-4 h-4 shrink-0" />,
    color: 'text-cyan-400',
    bg: 'bg-cyan-500/5',
    border: 'border-cyan-500/30',
  },
  model_suggestion: {
    icon: <Zap className="w-4 h-4 shrink-0" />,
    color: 'text-emerald-400',
    bg: 'bg-emerald-500/5',
    border: 'border-emerald-500/30',
  },
  permission_confirm: {
    icon: <Shield className="w-4 h-4 shrink-0" />,
    color: 'text-red-400',
    bg: 'bg-red-500/5',
    border: 'border-red-500/30',
  },
  browser_tool_enable: {
    icon: <Globe className="w-4 h-4 shrink-0" />,
    color: 'text-indigo-400',
    bg: 'bg-indigo-500/5',
    border: 'border-indigo-500/30',
  },
  custom: {
    icon: <AlertTriangle className="w-4 h-4 shrink-0" />,
    color: 'text-on-surface/60',
    bg: 'bg-on-surface/5',
    border: 'border-outline/30',
  },
};

const BORDER_COLOR_MAP: Record<string, string> = {
  'border-amber-500/30':   'rgba(245, 158, 11, 0.3)',
  'border-blue-500/30':    'rgba(59, 130, 246, 0.3)',
  'border-purple-500/30':  'rgba(168, 85, 247, 0.3)',
  'border-cyan-500/30':    'rgba(6, 182, 212, 0.3)',
  'border-emerald-500/30': 'rgba(16, 185, 129, 0.3)',
  'border-red-500/30':     'rgba(239, 68, 68, 0.3)',
  'border-indigo-500/30':  'rgba(99, 102, 241, 0.3)',
  'border-outline/30':     'rgba(228, 228, 231, 0.3)',
};

function borderClassToColor(cls: string): string {
  return BORDER_COLOR_MAP[cls] || 'rgba(255, 255, 255, 0.15)';
}

export function PromptCard({ instance, onResolve, onTimeout, onDismiss }: PromptCardProps) {
  const { spec, autoResolved } = instance;
  const meta = TYPE_META[spec.type];

  const { remaining } = useCountdownTimer(spec.countdown, onTimeout, spec.id);

  // 自动处理态：只显示一行提示
  if (autoResolved) {
    const actionLabel = spec.options.find(o => o.isRecommended)?.label ?? spec.options[0]?.label ?? '默认方案';
    return (
      <div
        className={`sf-anim sf-anim-slide-up flex items-center gap-2 px-3 py-1.5 rounded-lg border text-[11px] ${meta.bg} ${meta.border}`}
      >
        <CheckCircle2 className="w-3.5 h-3.5 text-green-400 shrink-0" />
        <span className="text-on-surface/60">全自动模式：已自动选择「{actionLabel}」</span>
        <span className="text-on-surface/30 ml-auto">→ 继续执行</span>
      </div>
    );
  }

  return (
    <MountTransition show={true} variant="slide-up" duration={180}>
      <div
        style={{ boxShadow: `-4px 0 0 0 ${borderClassToColor(meta.border)}` }}
        className={`sf-anim sf-anim-fade-scale rounded-lg overflow-hidden ${meta.bg}`}
      >
        {/* Header */}
        <div className="flex items-center gap-2 px-3 py-2 border-b border-outline/10">
          <span className={meta.color}>{meta.icon}</span>
          <span className={`text-[12px] font-bold ${meta.color}`}>{spec.title}</span>
          <span className="ml-auto flex items-center gap-1 text-[11px] font-mono text-on-surface/40">
            <Clock className="w-3 h-3" />
            {remaining}s
          </span>
          {onDismiss && (
            <button onClick={onDismiss} className="p-0.5 rounded hover:bg-on-surface/10 text-on-surface/30 hover:text-on-surface/60 transition-colors cursor-pointer">
              <X className="w-3 h-3" />
            </button>
          )}
        </div>

        {/* Body */}
        <div className="px-3 py-2 text-[11px] text-on-surface/70 leading-relaxed whitespace-pre-wrap">
          {spec.message}
        </div>

        {/* Options */}
        <div className="flex items-center gap-2 px-3 py-2 border-t border-outline/5">
          {spec.options.map(opt => (
            <button
              key={opt.id}
              onClick={() => onResolve(opt.action)}
              className={`px-3 py-1 rounded-md text-[11px] font-medium transition-all cursor-pointer ${
                opt.isRecommended
                  ? 'bg-primary/20 text-primary border border-primary/30 hover:bg-primary/30'
                  : 'bg-on-surface/5 text-on-surface/60 border border-transparent hover:bg-on-surface/10 hover:text-on-surface'
              }`}
            >
              {opt.label}
            </button>
          ))}
          {/* 超时提示 */}
          <span className="ml-auto text-[10px] text-on-surface/30">
            超时后自动{spec.options.find(o => o.isRecommended)?.label ?? spec.options[0]?.label ?? '跳过'}
          </span>
        </div>
      </div>
    </MountTransition>
  );
}