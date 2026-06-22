/**
 * useBrowserUseStream — React hook 订阅单个浏览器任务的 SSE 流
 *
 * 用法:
 *   const { steps, state, connected, error } = useBrowserUseStream(taskId);
 */
import { useEffect, useState, useRef } from 'react';
import type { ReactStepData } from './ReactStepBubble';
import type { BrowserTaskData } from './BrowserTaskCard';

interface UseBrowserUseStreamResult {
  steps: ReactStepData[];
  state: BrowserTaskData | null;
  connected: boolean;
  error: string | null;
}

export function useBrowserUseStream(taskId: string | null): UseBrowserUseStreamResult {
  const [steps, setSteps] = useState<ReactStepData[]>([]);
  const [state, setState] = useState<BrowserTaskData | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    if (!taskId) {
      setSteps([]);
      setState(null);
      setConnected(false);
      setError(null);
      return;
    }

    setSteps([]);
    setState(null);
    setError(null);
    setConnected(false);

    const url = `/api/browser-use/stream/${taskId}`;
    const es = new EventSource(url);
    esRef.current = es;

    es.onopen = () => {
      setConnected(true);
      setError(null);
    };
    es.onerror = () => {
      setConnected(false);
      setError('SSE connection lost');
    };

    es.addEventListener('state', (ev: MessageEvent) => {
      try {
        const data = JSON.parse(ev.data);
        setState((prev) => ({ ...(prev ?? {
          taskId, task: '', status: 'queued', currentStep: 0,
        }), ...data }));
      } catch {
        /* ignore */
      }
    });

    es.addEventListener('step', (ev: MessageEvent) => {
      try {
        const step: ReactStepData = JSON.parse(ev.data);
        setSteps((prev) => {
          // 去重: 同 task_id + step_index 只保留一条
          const idx = prev.findIndex(
            (s) => s.task_id === step.task_id && s.step_index === step.step_index,
          );
          if (idx >= 0) {
            const next = prev.slice();
            next[idx] = step;
            return next;
          }
          return [...prev, step];
        });
      } catch {
        /* ignore */
      }
    });

    return () => {
      es.close();
      esRef.current = null;
    };
  }, [taskId]);

  return { steps, state, connected, error };
}

/**
 * useBrowserUseClient — 直接调用 REST 端点 (非流式)
 */
export const BrowserUseApi = {
  async run(task: string): Promise<BrowserTaskData> {
    const r = await fetch('/api/browser-use/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task }),
    });
    const data = await r.json();
    if (!data.success) throw new Error(data.error ?? 'failed to run task');
    return data.task;
  },
  async list(): Promise<BrowserTaskData[]> {
    const r = await fetch('/api/browser-use/tasks');
    const data = await r.json();
    return data.tasks ?? [];
  },
  async getState(taskId: string): Promise<BrowserTaskData | null> {
    const r = await fetch(`/api/browser-use/state/${taskId}`);
    const data = await r.json();
    return data.task ?? null;
  },
  async pause(taskId: string): Promise<boolean> {
    const r = await fetch(`/api/browser-use/pause/${taskId}`, { method: 'POST' });
    const data = await r.json();
    return data.paused ?? false;
  },
  async resume(taskId: string): Promise<boolean> {
    const r = await fetch(`/api/browser-use/resume/${taskId}`, { method: 'POST' });
    const data = await r.json();
    return data.resumed ?? false;
  },
  async cancel(taskId: string): Promise<boolean> {
    const r = await fetch(`/api/browser-use/cancel/${taskId}`, { method: 'POST' });
    const data = await r.json();
    return data.cancelled ?? false;
  },
  async health(): Promise<{ ready: boolean; error?: string }> {
    const r = await fetch('/api/browser-use/health');
    return r.json();
  },
};
