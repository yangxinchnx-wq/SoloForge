/**
 * sseBackend.ts — SoloForge 事件总线 SSE 订阅层 (v3.2)
 *
 * 监听后端 /api/events/stream, 把 phase 事件 (phase0/1/2/3) 翻译成 ChatStreamEvent
 * 推到 ChatPanel 回调, 由 ChatPanel 进一步喂给 useStreamingStore。
 *
 * v3.1 设计:
 *   - 单例 EventSource, 整个 App 共享一个连接
 *   - 多 subscriber: 每个正在生成流送任务的 chat 单独 subscribe
 *   - subscribe(handler, chatId): 加入订阅列表
 *   - unsubscribe(chatId): 退出订阅 (clearChat 时调用)
 *   - chatId 匹配: 收到 phase 事件按 payload.chatId 路由到对应 subscriber
 *   - 自动重连 (EventSource 原生 + 退避)
 *
 * v3.2 修复: 将 model_action 加入 PHASE_EVENTS 白名单,
 *       使 LLM/Agent 思考/调用过程事件能穿透传输层到达 subscriber handler。
 *
 * 协议:
 *   data: {"event":"phase0_subtask","payload":{...},"timestamp":123}
 *   data: {"event":"phase1_worker_start","payload":{...},"timestamp":123}
 *   ...
 */

import type { ChatStreamEvent } from './aiBackend';
import { useTerminalLogStore } from '../components/terminal/store/terminalLogStore';

/** 关心的 phase 事件名 (跟后端 Orchestrator emit 对齐) */
const PHASE_EVENTS = new Set([
  'phase0_subtask',
  'phase0_skip',
  'phase1_worker_start',
  'phase1_worker_done',
  'phase1_worker_error',
  'phase2_judge',
  'phase2_judge_error',
  'phase3_deliver_start',
  'phase3_deliver_done',
  // 后端 runAgentLoop.onToolCall 在执行前后 emit
  // (需携带 subTaskId + chatId, 与 phase 事件同构)
  'tool_started',
  'tool_completed',
  // execute_cmd 流式事件 (用户主动命令 / AI agent 工具调用)
  // 由 sseBackend 直接桥接到 terminalLogStore, 不依赖 subscriber
  'tool_stdout',
  'tool_stderr',
  'tool_exit',
  // 模型推理动作事件 (LLM/Agent 思考/调用过程)
  // v3.2 补充: 使 model_action 能穿透 dispatchEvent 白名单过滤
  'model_action',
]);

export interface PhaseHandler {
  (evt: ChatStreamEvent): void;
}

interface Subscriber {
  chatId: string;
  handler: PhaseHandler;
}

class SseBackend {
  private es: EventSource | null = null;
  private subscribers: Subscriber[] = [];
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private maxReconnectDelay = 30_000;
  /** 常驻连接标记 — 终端模块用 enableKeepAlive() 开启, 即使没有 chat subscriber 也保持 SSE 连接 */
  private keepAlive = false;

  // 2026-07-02 性能优化:事件批处理
  // LLM 高频流会一次推上百个 phase 事件,如果直接同步分发,每个事件触发 1 次 store set
  // + 1 次 React 重渲染。改成 16ms (1 帧) rAF 合并:每帧最多 dispatch 1 次 batch,
  // 单批次串行调用 handler,React commit 后 update 集中、调度更稳。
  // 类型合集:batchQueue<{eventName,payload,timestamp}>
  private batchQueue: Array<{ eventName: string; payload: any; timestamp: number }> = [];
  private batchRafId: number | null = null;

  /**
   * 订阅本 chatId 的 phase 事件.
   * 多次调用同一 chatId 会覆盖 handler (新 task 替代旧 task).
   */
  subscribe(chatId: string, handler: PhaseHandler): void {
    this.removeSubscriber(chatId);
    this.subscribers.push({ chatId, handler });
    this.ensureConnected();
  }

  /**
   * 退出订阅 (clearChat / 切走时调用).
   * 当所有 subscriber 退出时, EventSource 也关闭释放资源.
   */
  unsubscribe(chatId: string): void {
    this.removeSubscriber(chatId);
    // removeSubscriber 内部已处理 keepAlive 逻辑
  }

  /** 强制断开 (整个 App 关闭时) */
  shutdown(): void {
    this.subscribers = [];
    this.batchQueue = [];
    if (this.batchRafId !== null) cancelAnimationFrame(this.batchRafId);
    this.batchRafId = null;
    this.disconnect();
  }

  private removeSubscriber(chatId: string): void {
    this.subscribers = this.subscribers.filter(s => s.chatId !== chatId);
    // 仍有 subscriber 或被标记为常驻连接 (终端用), 不关闭
    if (this.subscribers.length === 0 && !this.keepAlive) this.disconnect();
  }

  /**
   * 启用常驻 SSE 连接 (即使没有 subscriber 也保持连接).
   * 终端模块用此方法: 用户可随时主动执行命令, 需要持续监听 tool_* 事件
   * 桥接到 terminalLogStore.
   */
  enableKeepAlive(): void {
    this.keepAlive = true;
    this.ensureConnected();
  }

  private ensureConnected(): void {
    if (this.es) return;
    this.connect();
  }

  private connect(): void {
    try {
      this.es = new EventSource('/api/events/stream');
    } catch (err) {
      console.warn('[sseBackend] EventSource init failed, retry in', this.nextDelay(), 'ms', err);
      this.scheduleReconnect();
      return;
    }

    this.es.onopen = () => {
      this.reconnectAttempts = 0;
    };

    this.es.onmessage = (e: MessageEvent) => {
      let parsed: any;
      try { parsed = JSON.parse(e.data); } catch { return; }
      const { event, payload, timestamp } = parsed;
      if (!event || !payload) return;
      this.dispatchEvent(event, payload, timestamp);
    };

    this.es.onerror = () => {
      if (this.es?.readyState === EventSource.CLOSED) {
        this.scheduleReconnect();
      }
    };
  }

  private disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.es) {
      this.es.close();
      this.es = null;
    }
    this.reconnectAttempts = 0;
  }

  private nextDelay(): number {
    // 指数退避: 1s → 2s → 4s → ... → 30s
    const delay = Math.min(this.maxReconnectDelay, 1000 * 2 ** this.reconnectAttempts);
    this.reconnectAttempts++;
    return delay;
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.subscribers.length === 0) return;
    const delay = this.nextDelay();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  /**
   * 事件总线 → ChatStreamEvent 翻译 + chatId 路由
   * 命中规则: payload.chatId 匹配 subscriber.chatId
   *
   * v3.1 流程: 入队 batchQueue + schedule rAF 一次 drain
   * v3.2 性能: rAF 16ms 合并,避开 LLM 流式事件高峰导致 React 长任务
   */
  private dispatchEvent(eventName: string, payload: any, timestamp: number): void {
    // 1) 只关心 phase 事件 (含 model_action)
    if (!PHASE_EVENTS.has(eventName)) return;

    // 2) payload.chatId 必须存在
    const evtChatId = payload?.chatId;
    if (!evtChatId) return;

    // 2.5) tool_* 流式事件直接桥接到 terminalLogStore (不依赖 subscriber)
    //      — terminalLogStore 用 zustand 订阅, 状态变化自动触发 TerminalPanel 重渲染
    //      — tool_stdout/tool_stderr/tool_exit: 高频事件, 只路由到 terminalLogStore, 不入 batchQueue
    //      — tool_started/tool_completed: 低频事件, 路由到 terminalLogStore + 入 batchQueue
    //        (useChatStore 需要这两个事件更新 streamState.toolCalls, 驱动流送区 ToolCallCard 显示)
    if (eventName === 'tool_started' || eventName === 'tool_stdout' ||
        eventName === 'tool_stderr' || eventName === 'tool_exit' ||
        eventName === 'tool_completed') {
      try {
        this.routeToolEventToTerminalStore(eventName, payload);
      } catch (err) {
        console.error('[sseBackend] routeToolEventToTerminalStore threw', err);
      }
      // 高频 tool 事件 (stdout/stderr/exit) 不入队, 避免 LLM 流式高峰时长任务
      if (eventName === 'tool_stdout' || eventName === 'tool_stderr' || eventName === 'tool_exit') {
        return;
      }
      // tool_started / tool_completed 继续往下走入队逻辑, 让 useChatStore 更新 streamState.toolCalls
    }

    // 3) 入队批处理
    this.batchQueue.push({ eventName, payload, timestamp });
    this.scheduleDrain();
  }

  /** rAF 批量刷新: 每帧最多 drain 1 次 */
  private scheduleDrain(): void {
    if (this.batchRafId !== null) return;
    this.batchRafId = requestAnimationFrame(() => {
      this.batchRafId = null;
      this.drainBatch();
    });
  }

  /** 顺序消费队列, 单批次内串行调用所有 subscriber handler */
  private drainBatch(): void {
    const batch = this.batchQueue.splice(0);
    if (batch.length === 0) return;
    for (const { eventName, payload, timestamp } of batch) {
      const evtChatId = payload?.chatId;
      for (const sub of this.subscribers) {
        if (sub.chatId === evtChatId) {
          try {
            sub.handler({ event: eventName as any, payload, timestamp });
          } catch (err) {
            console.error('[sseBackend] subscriber handler threw', { eventName, evtChatId }, err);
          }
          break; // 每个 chatId 只匹配第一个 subscriber
        }
      }
    }
  }

  /**
   * tool_* 事件直通路由 → terminalLogStore
   *
   * 映射关系:
   *   - tool_started:     { chatId, toolCallId, tool, command?, ts }
   *   - tool_stdout:      { chatId, toolCallId, data (string), ts }
   *   - tool_stderr:      { chatId, toolCallId, data (string), ts }
   *   - tool_exit:         { chatId, toolCallId, tool, exitCode, durationMs?, ts }
   *   - tool_completed:    { chatId, toolCallId, success, durationMs?, ts }
   */
  private routeToolEventToTerminalStore(eventName: string, payload: any): void {
    const store = useTerminalLogStore.getState();
    const chatId = payload?.chatId;
    const toolCallId = payload?.toolCallId;
    if (!chatId || !toolCallId) return;

    switch (eventName) {
      case 'tool_started':
        store.appendLine(chatId, toolCallId, {
          type: 'start',
          tool: payload.tool ?? 'unknown',
          command: payload.command ?? '',
          timestamp: payload.ts ?? Date.now(),
        });
        break;
      case 'tool_stdout':
        store.appendLine(chatId, toolCallId, {
          type: 'stdout',
          data: String(payload.data ?? ''),
          timestamp: payload.ts ?? Date.now(),
        });
        break;
      case 'tool_stderr':
        store.appendLine(chatId, toolCallId, {
          type: 'stderr',
          data: String(payload.data ?? ''),
          timestamp: payload.ts ?? Date.now(),
        });
        break;
      case 'tool_exit':
        store.markCompleted(chatId, toolCallId, {
          exitCode: payload.exitCode ?? 1,
          durationMs: payload.durationMs,
          timestamp: payload.ts ?? Date.now(),
        });
        break;
      case 'tool_completed':
        store.markCompleted(chatId, toolCallId, {
          exitCode: payload.success ? 0 : 1,
          durationMs: payload.durationMs,
          timestamp: payload.ts ?? Date.now(),
        });
        break;
    }
  }
}

/** 全局单例 */
export const sseBackend = new SseBackend();
