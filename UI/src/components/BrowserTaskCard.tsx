/**
 * BrowserTaskCard — 浏览器任务生命周期卡片 (主消息流, 非流式区)
 *
 * 状态机:
 *   queued / running / paused / success / error / cancelled
 *
 * 渲染:
 *   - 任务描述 + taskId
 *   - 当前 step 数 / 状态
 *   - 操作按钮 (暂停 / 恢复 / 取消 / 展开轨迹)
 *   - 折叠: 完整 ReAct 轨迹 (ReactStepBubble 列表)
 */
import React, { useState, useEffect } from 'react';
import {
  Globe, Loader2, CheckCircle2, XCircle, AlertCircle, Pause, Play, X,
  ChevronDown, ListOrdered,
} from 'lucide-react';
import { ReactStepBubble, type ReactStepData } from './ReactStepBubble';

export type BrowserTaskStatus = 'queued' | 'running' | 'paused' | 'success' | 'error' | 'cancelled';

export interface BrowserTaskData {
  taskId: string;
  task: string;
  status: BrowserTaskStatus;
  currentStep: number;
  result?: string;
  error?: string;
}

interface Props {
  task: BrowserTaskData;
  steps?: ReactStepData[];
  onPause?: (taskId: string) => void;
  onResume?: (taskId: string) => void;
  onCancel?: (taskId: string) => void;
  onFetchHistory?: (taskId: string) => Promise<ReactStepData[]>;
}

const STATUS_META: Record<BrowserTaskStatus, {
  icon: React.ReactElement;
  color: string;
  label: string;
  bg: string;
  border: string;
}> = {
  queued: {
    icon: <Loader2 className="w-3.5 h-3.5 animate-spin" />,
    color: 'text-blue-400',
    label: '排队中',
    bg: 'bg-blue-500/5',
    border: 'border-blue-500/30',
  },
  running: {
    icon: <Loader2 className="w-3.5 h-3.5 animate-spin" />,
    color: 'text-blue-400',
    label: '执行中',
    bg: 'bg-blue-500/5',
    border: 'border-blue-500/30',
  },
  paused: {
    icon: <Pause className="w-3.5 h-3.5" />,
    color: 'text-amber-400',
    label: '已暂停',
    bg: 'bg-amber-500/5',
    border: 'border-amber-500/30',
  },
  success: {
    icon: <CheckCircle2 className="w-3.5 h-3.5" />,
    color: 'text-green-400',
    label: '已完成',
    bg: 'bg-green-500/5',
    border: 'border-green-500/30',
  },
  error: {
    icon: <AlertCircle className="w-3.5 h-3.5" />,
    color: 'text-red-400',
    label: '失败',
    bg: 'bg-red-500/5',
    border: 'border-red-500/30',
  },
  cancelled: {
    icon: <XCircle className="w-3.5 h-3.5" />,
    color: 'text-on-surface/60',
    label: '已取消',
    bg: 'bg-on-surface/5',
    border: 'border-on-surface/20',
  },
};

export function BrowserTaskCard({
  task, steps = [], onPause, onResume, onCancel, onFetchHistory,
}: Props): React.ReactElement {
  const [open, setOpen] = useState(true);
  const [showSteps, setShowSteps] = useState(false);
  const [history, setHistory] = useState<ReactStepData[]>(steps);
  const [loadingHistory, setLoadingHistory] = useState(false);

  useEffect(() => {
    setHistory(steps);
  }, [steps]);

  const meta = STATUS_META[task.status];
  const isTerminal = ['success', 'error', 'cancelled'].includes(task.status);
  const taskIdShort = task.taskId.length > 16 ? task.taskId.slice(0, 12) + '…' : task.taskId;

  const handleShowHistory = async () => {
    setShowSteps(true);
    if (history.length === 0 && onFetchHistory) {
      setLoadingHistory(true);
      try {
        const fetched = await onFetchHistory(task.taskId);
        setHistory(fetched);
      } catch {
        /* ignore */
      } finally {
        setLoadingHistory(false);
      }
    }
  };

  return (
    <div
      data-testid={`browser-task-card-${task.taskId}`}
      className={`border ${meta.border} ${meta.bg} rounded-lg overflow-hidden font-sans text-[11px]`}
    >
      {/* Header */}
      <div
        onClick={() => setOpen(!open)}
        className={`px-2.5 py-1.5 ${meta.bg} border-b ${meta.border} flex items-center gap-1.5 cursor-pointer hover:opacity-90 transition-opacity`}
      >
        <ChevronDown
          className={`w-3 h-3 text-on-surface/50 transition-transform duration-200 shrink-0 ${
            open ? '' : '-rotate-90'
          }`}
        />
        <Globe className="w-3.5 h-3.5 shrink-0 text-on-surface/70" />
        <span className={`font-semibold shrink-0 ${meta.color}`}>{meta.label}</span>
        <span className="text-on-surface/40 text-[10px] shrink-0">·</span>
        <span className="font-mono text-[10px] text-on-surface/60 shrink-0">{taskIdShort}</span>
        <span className="text-on-surface/40 text-[10px] shrink-0">·</span>
        <span className="text-on-surface/80 truncate flex-1 min-w-0">{task.task}</span>
        {!isTerminal && (
          <span className="text-on-surface/50 text-[10px] shrink-0">step {task.currentStep}</span>
        )}
      </div>

      {open && (
        <div className="px-2.5 py-2 space-y-2">
          {/* Result / error */}
          {task.status === 'success' && task.result && (
            <div className="text-[10px] bg-green-500/10 border border-green-500/30 rounded p-2 max-h-40 overflow-y-auto scrollbar-thin">
              <div className="text-green-400 font-semibold mb-1">任务结果</div>
              <pre className="font-mono text-on-surface/80 whitespace-pre-wrap break-all">{task.result}</pre>
            </div>
          )}
          {task.status === 'error' && task.error && (
            <div className="text-[10px] bg-red-500/10 border border-red-500/30 rounded p-2 max-h-40 overflow-y-auto scrollbar-thin">
              <div className="text-red-400 font-semibold mb-1">错误信息</div>
              <pre className="font-mono text-red-300/80 whitespace-pre-wrap break-all">{task.error}</pre>
            </div>
          )}

          {/* Actions */}
          <div className="flex flex-wrap items-center gap-1.5">
            {task.status === 'running' && onPause && (
              <button
                onClick={(e) => { e.stopPropagation(); onPause(task.taskId); }}
                className="px-2 py-0.5 text-[10px] bg-amber-500/20 hover:bg-amber-500/30 border border-amber-500/40 rounded text-amber-300 flex items-center gap-1"
              >
                <Pause className="w-3 h-3" /> 暂停
              </button>
            )}
            {task.status === 'paused' && onResume && (
              <button
                onClick={(e) => { e.stopPropagation(); onResume(task.taskId); }}
                className="px-2 py-0.5 text-[10px] bg-green-500/20 hover:bg-green-500/30 border border-green-500/40 rounded text-green-300 flex items-center gap-1"
              >
                <Play className="w-3 h-3" /> 恢复
              </button>
            )}
            {!isTerminal && onCancel && (
              <button
                onClick={(e) => { e.stopPropagation(); onCancel(task.taskId); }}
                className="px-2 py-0.5 text-[10px] bg-red-500/20 hover:bg-red-500/30 border border-red-500/40 rounded text-red-300 flex items-center gap-1"
              >
                <X className="w-3 h-3" /> 取消
              </button>
            )}
            <button
              onClick={(e) => { e.stopPropagation(); handleShowHistory(); }}
              className="px-2 py-0.5 text-[10px] bg-on-surface/10 hover:bg-on-surface/20 border border-outline/30 rounded text-on-surface/80 flex items-center gap-1"
            >
              <ListOrdered className="w-3 h-3" /> {showSteps ? '隐藏' : '查看'}轨迹 ({history.length})
            </button>
          </div>

          {/* ReAct 轨迹 */}
          {showSteps && (
            <div className="mt-1">
              {loadingHistory && (
                <div className="text-[10px] text-on-surface/50 flex items-center gap-1">
                  <Loader2 className="w-3 h-3 animate-spin" /> 加载轨迹…
                </div>
              )}
              {!loadingHistory && history.length === 0 && (
                <div className="text-[10px] text-on-surface/50">暂无轨迹</div>
              )}
              {history.map((s, i) => (
                <ReactStepBubble key={`${s.timestamp_ms ?? i}-${i}`} step={s} defaultOpen={false} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
