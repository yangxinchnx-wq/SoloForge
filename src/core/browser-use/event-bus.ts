// ============================================================
// Browser-Use event bus — 把 Python MCP notification 路由到 SSE
// ============================================================
//
// 流程:
//   1. Python 端每次推 ReAct step → MCP notification (progressToken=taskId)
//   2. mcp-client.ts 收到 → emit('notification:notifications/progress', params)
//   3. event-bus.ts 订阅 → 按 taskId 路由到对应 SSE 客户端
//   4. SSE 客户端 (UI) 收到 step → 渲染 ReactStepBubble

import { EventEmitter } from 'node:events';
import type { Response } from 'express';

export interface ReactStepEvent {
  taskId: string;
  step: {
    task_id: string;
    step_index: number;
    kind: 'thought' | 'action' | 'observation' | 'error' | 'final';
    content: string;
    url: string;
    title: string;
    screenshot_b64: string;
    duration_ms: number;
    timestamp_ms: number;
  };
}

class BrowserUseEventBus extends EventEmitter {
  /**
   * 订阅某个任务的事件 (供 SSE 端点用)
   */
  subscribeTask(taskId: string, listener: (ev: ReactStepEvent) => void): () => void {
    const channel = `task:${taskId}`;
    this.on(channel, listener);
    return () => this.off(channel, listener);
  }

  /**
   * 发布 step 事件 (由 mcp-client 调用)
   */
  publishStep(ev: ReactStepEvent): void {
    this.emit('step', ev);
    this.emit(`task:${ev.taskId}`, ev);
  }

  /**
   * 通用事件: task 状态变化 (e.g. success / error)
   */
  publishTaskState(taskId: string, state: Record<string, any>): void {
    this.emit('task-state', { taskId, state });
    this.emit(`task-state:${taskId}`, state);
  }
}

export const bus = new BrowserUseEventBus();
bus.setMaxListeners(100);  // 多个 SSE 客户端同时订阅

// ============================================================
// SSE 工具
// ============================================================

export function setupSseHeaders(res: Response): void {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
}

export function sseSend(res: Response, event: string, data: any): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}
