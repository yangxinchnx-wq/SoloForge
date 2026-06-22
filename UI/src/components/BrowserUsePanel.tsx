/**
 * BrowserUsePanel — Browser-Use 顶层面板 (任务列表 + 选中任务的实时轨迹)
 *
 * 设计:
 *  - 顶部: 任务列表 (含新建按钮)
 *  - 选中任务: 显示 BrowserTaskCard + 完整 ReAct 轨迹
 *  - 数据流: useBrowserUseStream (SSE) 实时更新
 *
 * 用法: 嵌入到 ChatPanel 侧栏 / Settings 面板 / 独立 tab
 */
import React, { useState, useEffect, useCallback } from 'react';
import {
  Plus, RefreshCw, Globe, ListChecks, ChevronRight, AlertCircle,
} from 'lucide-react';
import { useBrowserUseStream, BrowserUseApi } from '../hooks/useBrowserUseStream';
import { BrowserTaskCard, type BrowserTaskData } from './BrowserTaskCard';
import { ReactStepBubble, type ReactStepData } from './ReactStepBubble';

interface Props {
  onInsertPrompt?: (text: string) => void;
}

export function BrowserUsePanel({ onInsertPrompt }: Props): React.ReactElement {
  const [tasks, setTasks] = useState<BrowserTaskData[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [health, setHealth] = useState<{ ready: boolean; error?: string } | null>(null);
  const [showNewForm, setShowNewForm] = useState(false);
  const [newTask, setNewTask] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // 订阅选中任务的实时流
  const { steps, state: liveState, connected, error } = useBrowserUseStream(selectedId);

  // 初始加载
  useEffect(() => {
    refresh();
    BrowserUseApi.health().then(setHealth).catch(() => setHealth({ ready: false }));
  }, []);

  // 流式 state 变化时, 更新 tasks 列表中的对应项
  useEffect(() => {
    if (!liveState) return;
    setTasks((prev) => prev.map((t) => t.taskId === liveState.taskId ? { ...t, ...liveState } : t));
  }, [liveState]);

  const refresh = useCallback(async () => {
    try {
      const list = await BrowserUseApi.list();
      setTasks(list);
      if (!selectedId && list.length > 0) {
        const first = list.find((t) => t.status === 'running') ?? list[0];
        setSelectedId(first.taskId);
      }
    } catch {
      /* ignore */
    }
  }, [selectedId]);

  const handleSubmit = async () => {
    if (!newTask.trim() || submitting) return;
    setSubmitting(true);
    try {
      const rec = await BrowserUseApi.run(newTask.trim());
      setTasks((prev) => [rec, ...prev]);
      setSelectedId(rec.taskId);
      setNewTask('');
      setShowNewForm(false);
    } catch (e: any) {
      alert(`提交失败: ${e.message}`);
    } finally {
      setSubmitting(false);
    }
  };

  const handleAction = async (id: string, op: 'pause' | 'resume' | 'cancel') => {
    try {
      if (op === 'pause') await BrowserUseApi.pause(id);
      else if (op === 'resume') await BrowserUseApi.resume(id);
      else await BrowserUseApi.cancel(id);
      await refresh();
    } catch (e: any) {
      alert(`操作失败: ${e.message}`);
    }
  };

  const selectedTask = tasks.find((t) => t.taskId === selectedId);

  return (
    <div className="flex flex-col h-full font-sans text-[12px] bg-bg/40 text-on-surface">
      {/* Header */}
      <div className="px-3 py-2 border-b border-outline/20 flex items-center gap-2">
        <Globe className="w-4 h-4 text-blue-400" />
        <span className="font-semibold text-on-surface">Browser-Use</span>
        {health && (
          <span className={`text-[10px] px-1.5 py-0.5 rounded ${
            health.ready
              ? 'bg-green-500/20 text-green-300 border border-green-500/40'
              : 'bg-red-500/20 text-red-300 border border-red-500/40'
          }`}>
            {health.ready ? '就绪' : '未连接'}
          </span>
        )}
        <div className="flex-1" />
        <button
          onClick={refresh}
          className="p-1 hover:bg-on-surface/10 rounded text-on-surface/60"
          title="刷新"
        >
          <RefreshCw className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={() => setShowNewForm(!showNewForm)}
          className="p-1 hover:bg-on-surface/10 rounded text-blue-400"
          title="新建任务"
        >
          <Plus className="w-3.5 h-3.5" />
        </button>
      </div>

      {health && !health.ready && (
        <div className="px-3 py-2 bg-red-500/5 border-b border-red-500/20 text-[10px] text-red-300 flex items-start gap-1.5">
          <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          <div>
            <div className="font-semibold">Browser-Use Service 未就绪</div>
            <div className="text-red-300/80 mt-0.5">
              {health.error ?? '请检查 python/browser_use_service 是否安装且 LLM 凭据已配置'}
            </div>
          </div>
        </div>
      )}

      {/* 新建表单 */}
      {showNewForm && (
        <div className="px-3 py-2 border-b border-outline/20 bg-surface/40 space-y-1.5">
          <textarea
            value={newTask}
            onChange={(e) => setNewTask(e.target.value)}
            placeholder="描述一个浏览器任务, 例如: 在 Hacker News 找前 5 条新闻标题..."
            className="w-full px-2 py-1.5 text-[11px] bg-bg border border-outline/30 rounded resize-none h-16 focus:border-blue-500/50 outline-none"
            disabled={submitting}
          />
          <div className="flex justify-end gap-1.5">
            <button
              onClick={() => { setShowNewForm(false); setNewTask(''); }}
              className="px-2 py-0.5 text-[10px] hover:bg-on-surface/10 rounded text-on-surface/70"
              disabled={submitting}
            >
              取消
            </button>
            <button
              onClick={handleSubmit}
              className="px-2 py-0.5 text-[10px] bg-blue-500 hover:bg-blue-600 disabled:bg-blue-500/40 rounded text-white"
              disabled={!newTask.trim() || submitting}
            >
              {submitting ? '提交中…' : '运行'}
            </button>
          </div>
        </div>
      )}

      {/* 任务列表 + 详情 (双栏) */}
      <div className="flex-1 flex min-h-0">
        {/* 左侧: 任务列表 */}
        <div className="w-44 border-r border-outline/20 overflow-y-auto scrollbar-thin">
          {tasks.length === 0 ? (
            <div className="px-3 py-4 text-[10px] text-on-surface/50 text-center">
              暂无任务
            </div>
          ) : (
            tasks.map((t) => (
              <button
                key={t.taskId}
                onClick={() => setSelectedId(t.taskId)}
                className={`w-full text-left px-2 py-1.5 border-b border-outline/10 hover:bg-on-surface/5 transition-colors ${
                  selectedId === t.taskId ? 'bg-blue-500/10 border-l-2 border-l-blue-500' : ''
                }`}
              >
                <div className="flex items-center gap-1.5">
                  <span className={`text-[10px] ${
                    t.status === 'running' ? 'text-blue-400'
                    : t.status === 'success' ? 'text-green-400'
                    : t.status === 'error' ? 'text-red-400'
                    : t.status === 'paused' ? 'text-amber-400'
                    : 'text-on-surface/50'
                  }`}>●</span>
                  <span className="text-[10px] text-on-surface/80 truncate flex-1 min-w-0">
                    {t.task}
                  </span>
                  {selectedId === t.taskId && <ChevronRight className="w-3 h-3 text-blue-400 shrink-0" />}
                </div>
                <div className="text-[9px] text-on-surface/40 mt-0.5">
                  {t.taskId} · step {t.currentStep}
                </div>
              </button>
            ))
          )}
        </div>

        {/* 右侧: 任务详情 + ReAct 轨迹 */}
        <div className="flex-1 overflow-y-auto scrollbar-thin p-2">
          {!selectedTask ? (
            <div className="h-full flex items-center justify-center text-on-surface/40 text-[11px]">
              选择一个任务查看详情
            </div>
          ) : (
            <div className="space-y-2">
              <BrowserTaskCard
                task={selectedTask}
                steps={steps}
                onPause={(id) => handleAction(id, 'pause')}
                onResume={(id) => handleAction(id, 'resume')}
                onCancel={(id) => handleAction(id, 'cancel')}
              />
              {/* 流式区: 实时 ReAct step (默认展开) */}
              {connected && steps.length > 0 && (
                <div className="border border-cyan-500/20 rounded-lg p-2 bg-cyan-500/5">
                  <div className="flex items-center gap-1.5 mb-1.5 text-[10px] text-cyan-300 font-semibold">
                    <ListChecks className="w-3 h-3" />
                    实时推理轨迹 (SSE)
                  </div>
                  <div>
                    {steps.map((s, i) => (
                      <ReactStepBubble
                        key={`${s.timestamp_ms ?? i}-${i}`}
                        step={s}
                        defaultOpen={s.step_index === steps.length - 1}
                      />
                    ))}
                  </div>
                </div>
              )}
              {error && (
                <div className="text-[10px] bg-red-500/10 border border-red-500/30 rounded p-2 text-red-300">
                  {error}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default BrowserUsePanel;
