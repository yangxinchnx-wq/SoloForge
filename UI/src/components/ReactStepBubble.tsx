/**
 * ReactStepBubble — 在 ChatPanel 流式区渲染 Browser-Use 的单步 ReAct
 *
 * 4 种 step kind:
 *   - thought     🤔  LLM 思考 (灰色斜体)
 *   - action      🖱️  动作 (单色等宽, 带语法高亮)
 *   - observation 👁️  观察结果 (普通文本, 可选缩略图)
 *   - error       ⚠️  错误 (红色边框)
 *   - final       ✅  任务结束
 */
import React, { useState } from 'react';
import { Brain, MousePointer, Eye, AlertTriangle, CheckCircle2, ChevronDown, Camera } from '../utils/icons';

export type ReactStepKind = 'thought' | 'action' | 'observation' | 'error' | 'final';

export interface ReactStepData {
  task_id: string;
  step_index: number;
  kind: ReactStepKind;
  content: string;
  url?: string;
  title?: string;
  screenshot_b64?: string;
  duration_ms?: number;
  timestamp_ms?: number;
}

interface Props {
  step: ReactStepData;
  defaultOpen?: boolean;
}

const KIND_META: Record<ReactStepKind, {
  icon: React.ReactElement;
  label: string;
  border: string;
  bg: string;
  text: string;
}> = {
  thought: {
    icon: <Brain className="w-3.5 h-3.5" />,
    label: '思考',
    border: 'border-purple-500/30',
    bg: 'bg-purple-500/5',
    text: 'text-purple-300/90',
  },
  action: {
    icon: <MousePointer className="w-3.5 h-3.5" />,
    label: '动作',
    border: 'border-blue-500/30',
    bg: 'bg-blue-500/5',
    text: 'text-blue-300/90',
  },
  observation: {
    icon: <Eye className="w-3.5 h-3.5" />,
    label: '观察',
    border: 'border-cyan-500/30',
    bg: 'bg-cyan-500/5',
    text: 'text-cyan-300/90',
  },
  error: {
    icon: <AlertTriangle className="w-3.5 h-3.5" />,
    label: '错误',
    border: 'border-red-500/40',
    bg: 'bg-red-500/10',
    text: 'text-red-300',
  },
  final: {
    icon: <CheckCircle2 className="w-3.5 h-3.5" />,
    label: '完成',
    border: 'border-green-500/40',
    bg: 'bg-green-500/10',
    text: 'text-green-300',
  },
};

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function highlightAction(action: string): React.ReactElement {
  // 简单语法高亮: 把 click( / type( / extract( 这种函数名染蓝, 选择器染绿
  const parts: React.ReactElement[] = [];
  const regex = /(click|type|fill|select|press|scroll|extract|navigate|wait|hover|screenshot|find)\s*\(([^)]*)\)/gi;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  while ((match = regex.exec(action)) !== null) {
    if (match.index > lastIndex) {
      parts.push(<span key={key++}>{action.slice(lastIndex, match.index)}</span>);
    }
    parts.push(
      <span key={key++} className="text-blue-300 font-semibold">{match[1]}</span>,
    );
    parts.push(<span key={key++}>(</span>);
    parts.push(
      <span key={key++} className="text-emerald-300/90 font-mono">{match[2]}</span>,
    );
    parts.push(<span key={key++}>)</span>);
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < action.length) {
    parts.push(<span key={key++}>{action.slice(lastIndex)}</span>);
  }
  return <>{parts}</>;
}

export function ReactStepBubble({ step, defaultOpen = true }: Props): React.ReactElement {
  const [open, setOpen] = useState(defaultOpen);
  const meta = KIND_META[step.kind];

  // 头部摘要
  const headSummary = (() => {
    if (step.kind === 'action') {
      return truncate(step.content, 80);
    }
    if (step.kind === 'thought') {
      return truncate(step.content, 80);
    }
    if (step.kind === 'observation') {
      return truncate(step.content, 100);
    }
    if (step.kind === 'final') {
      return `结果: ${truncate(step.content, 80)}`;
    }
    return truncate(step.content, 80);
  })();

  return (
    <div
      data-testid={`react-step-${step.kind}-${step.step_index}`}
      className={`border ${meta.border} ${meta.bg} rounded-lg overflow-hidden font-sans text-[11px] mb-1`}
    >
      <div
        onClick={() => setOpen(!open)}
        className={`px-2 py-1 ${meta.bg} border-b ${meta.border} flex items-center gap-1.5 cursor-pointer hover:opacity-90 transition-opacity`}
      >
        <ChevronDown
          className={`w-3 h-3 text-on-surface/50 transition-transform duration-200 shrink-0 ${
            open ? '' : '-rotate-90'
          }`}
        />
        <span className={meta.text}>{meta.icon}</span>
        <span className={`font-semibold ${meta.text} shrink-0`}>{meta.label}</span>
        <span className="text-on-surface/40 text-[10px] shrink-0">#{step.step_index}</span>
        <span className="text-on-surface/70 truncate flex-1 min-w-0">{headSummary}</span>
        {step.url && (
          <span className="text-on-surface/40 text-[9px] truncate max-w-[180px] shrink-0">
            {step.title || step.url}
          </span>
        )}
      </div>
      {open && (
        <div className="px-2.5 py-2 space-y-1.5">
          {/* URL / title 上下文 */}
          {step.url && (
            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-on-surface/60 font-mono">
              <span className="text-on-surface/40">url:</span>
              <span className="truncate break-all">{step.url}</span>
              {step.title && (
                <>
                  <span className="text-on-surface/40">·</span>
                  <span className="italic">{step.title}</span>
                </>
              )}
              {step.duration_ms !== undefined && step.duration_ms > 0 && (
                <>
                  <span className="text-on-surface/40">·</span>
                  <span className="text-on-surface/40">{step.duration_ms}ms</span>
                </>
              )}
            </div>
          )}

          {/* 内容 */}
          <pre className="font-mono text-[10.5px] leading-snug whitespace-pre-wrap break-all bg-bg/40 border border-outline/20 rounded p-2 max-h-40 overflow-y-auto scrollbar-thin">
            {step.kind === 'action' ? highlightAction(step.content) : step.content}
          </pre>

          {/* 截图 (observation 可能有) */}
          {step.screenshot_b64 && (
            <details className="text-[10px]">
              <summary className="cursor-pointer text-on-surface/60 hover:text-on-surface/90 select-none flex items-center gap-1">
                <Camera className="w-3 h-3" />
                查看截图
              </summary>
              <div className="mt-1">
                <img
                  src={`data:image/png;base64,${step.screenshot_b64}`}
                  alt="browser screenshot"
                  className="max-w-full rounded border border-outline/30"
                />
              </div>
            </details>
          )}
        </div>
      )}
    </div>
  );
}
