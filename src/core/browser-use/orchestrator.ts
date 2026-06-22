// ============================================================
// Browser-Use Orchestrator — 整合 mcp-client + event-bus + task-store
// ============================================================
//
// 单一入口, 给 Express 路由用
//   const orch = new BrowserUseOrchestrator(repoRoot);
//   app.post('/api/browser-use/run', (req, res) => orch.run(req, res));
//   app.get('/api/browser-use/stream/:id', (req, res) => orch.stream(req, res));

import { resolve } from 'node:path';
import type { Request, Response } from 'express';
import { BrowserUseMcpClient } from './mcp-client';
import { bus, setupSseHeaders, sseSend, type ReactStepEvent } from './event-bus';
import {
  upsertTask, patchTask, getTask, listTasks,
  type TaskRecord, type TaskStatus,
} from './task-store';

const PYTHON_BIN = process.env.SOLOFORGE_PYTHON_BIN || 'python';

const STATUS_MAP: Record<string, TaskStatus> = {
  queued: 'queued', running: 'running', paused: 'paused',
  success: 'success', error: 'error', cancelled: 'cancelled',
};

export class BrowserUseOrchestrator {
  private client: BrowserUseMcpClient;
  private initPromise: Promise<void> | null = null;
  private initialized = false;

  constructor(repoRoot: string) {
    this.client = new BrowserUseMcpClient(PYTHON_BIN, resolve(repoRoot, 'python'));
    this._wireNotifications();
  }

  /**
   * 确保 MCP 已就绪, 幂等
   */
  async ensureReady(): Promise<void> {
    if (this.initialized) return;
    if (this.initPromise) return this.initPromise;
    this.initPromise = this._bootstrap();
    try {
      await this.initPromise;
      this.initialized = true;
    } catch (e) {
      this.initPromise = null;
      throw e;
    }
  }

  async shutdown(): Promise<void> {
    await this.client.stop();
  }

  // ------------------------------------------------------------------
  // Tool: 提交任务
  // ------------------------------------------------------------------
  async runTask(task: string): Promise<TaskRecord> {
    if (!task || !task.trim()) {
      throw new Error('task is required');
    }
    await this.ensureReady();
    const result = await this.client.callTool<{
      taskId: string; status: TaskStatus; currentStep: number; task: string;
    }>('browser_run_task', { task: task.trim() });
    const record = upsertTask({
      taskId: result.taskId,
      task: result.task,
      status: STATUS_MAP[result.status] ?? 'queued',
      currentStep: result.currentStep ?? 0,
    });
    return record;
  }

  // ------------------------------------------------------------------
  // Tool: 查询 / 列表
  // ------------------------------------------------------------------
  async getTaskState(taskId: string): Promise<TaskRecord | null> {
    const cached = getTask(taskId);
    if (cached && ['success', 'error', 'cancelled'].includes(cached.status)) {
      return cached;
    }
    try {
      await this.ensureReady();
      const fresh = await this.client.callTool<TaskRecord>('browser_get_task_state', { taskId });
      if (fresh) {
        return patchTask(taskId, {
          status: STATUS_MAP[fresh.status] ?? cached?.status ?? 'queued',
          currentStep: fresh.currentStep ?? 0,
          result: fresh.result ?? '',
          error: fresh.error ?? '',
        });
      }
    } catch (e) {
      // MCP 不可用时, 返回缓存
      console.warn('[bu-orch] getTaskState fallback to cache:', e);
    }
    return cached;
  }

  listLocalTasks(): TaskRecord[] {
    return listTasks();
  }

  // ------------------------------------------------------------------
  // Tool: 暂停 / 恢复 / 取消
  // ------------------------------------------------------------------
  async pauseTask(taskId: string): Promise<boolean> {
    await this.ensureReady();
    const r = await this.client.callTool<{ paused: boolean }>(
      'browser_pause_task', { taskId },
    );
    if (r?.paused) patchTask(taskId, { status: 'paused' });
    return r?.paused ?? false;
  }

  async resumeTask(taskId: string): Promise<boolean> {
    await this.ensureReady();
    const r = await this.client.callTool<{ resumed: boolean }>(
      'browser_resume_task', { taskId },
    );
    if (r?.resumed) patchTask(taskId, { status: 'running' });
    return r?.resumed ?? false;
  }

  async cancelTask(taskId: string): Promise<boolean> {
    await this.ensureReady();
    const r = await this.client.callTool<{ cancelled: boolean }>(
      'browser_cancel_task', { taskId },
    );
    if (r?.cancelled) patchTask(taskId, { status: 'cancelled', finishedAt: Date.now() });
    return r?.cancelled ?? false;
  }

  // ------------------------------------------------------------------
  // SSE: 流式 step / 状态
  // ------------------------------------------------------------------
  streamTask(taskId: string, req: Request, res: Response): void {
    setupSseHeaders(res);
    res.flushHeaders?.();

    const cached = getTask(taskId);
    if (cached) {
      sseSend(res, 'state', cached);
    }

    const unsubStep = bus.subscribeTask(taskId, (ev: ReactStepEvent) => {
      // task_state 来自 step.kind === 'final' / 'error'
      if (ev.step.kind === 'final') {
        patchTask(taskId, { status: 'success', result: ev.step.content, finishedAt: Date.now() });
        sseSend(res, 'state', getTask(taskId));
      } else if (ev.step.kind === 'error') {
        patchTask(taskId, { status: 'error', error: ev.step.content, finishedAt: Date.now() });
        sseSend(res, 'state', getTask(taskId));
      }
      // step index 推进
      if (ev.step.step_index > (getTask(taskId)?.currentStep ?? 0)) {
        patchTask(taskId, { currentStep: ev.step.step_index });
      }
      sseSend(res, 'step', ev.step);
    });

    // 心跳保活 (反代/nginx 不会断)
    const heartbeat = setInterval(() => {
      try {
        res.write(':heartbeat\n\n');
      } catch {
        /* ignore */
      }
    }, 15_000);

    const cleanup = () => {
      clearInterval(heartbeat);
      unsubStep();
    };
    req.on('close', cleanup);
    req.on('aborted', cleanup);
    res.on('close', cleanup);
  }

  // ------------------------------------------------------------------
  // 内部
  // ------------------------------------------------------------------
  private async _bootstrap(): Promise<void> {
    await this.client.start();
    await this.client.listTools();  // 触发 list
  }

  private _wireNotifications(): void {
    this.client.on('notification:notifications/progress', (params: any) => {
      // params: { progressToken: <taskId>, data: <ReactStep> }
      const taskId = params?.progressToken;
      const step = params?.data;
      if (!taskId || !step) return;
      const ev: ReactStepEvent = { taskId, step };
      bus.publishStep(ev);
    });
  }
}

// 全局单例 (进程内共享一个 MCP 客户端)
let orchestrator: BrowserUseOrchestrator | null = null;
export function getOrchestrator(repoRoot: string): BrowserUseOrchestrator {
  if (!orchestrator) {
    orchestrator = new BrowserUseOrchestrator(repoRoot);
  }
  return orchestrator;
}
