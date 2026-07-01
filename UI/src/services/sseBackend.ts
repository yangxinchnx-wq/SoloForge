/**
 * sseBackend.ts — SoloForge 事件总线 SSE 订阅层 (v3.1)
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
 * 协议:
 *   data: {"event":"phase0_subtask","payload":{...},"timestamp":123}\n\n
 *   data: {"event":"phase1_worker_start","payload":{...},"timestamp":123}\n\n
 *   ...
 */

import type { ChatStreamEvent } from './aiBackend';

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
    if (this.subscribers.length === 0) this.disconnect();
  }

  /** 强制断开 (整个 App 关闭时) */
  shutdown(): void {
    this.subscribers = [];
    this.disconnect();
  }

  private removeSubscriber(chatId: string): void {
    this.subscribers = this.subscribers.filter(s => s.chatId !== chatId);
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
   */
  private dispatchEvent(eventName: string, payload: any, timestamp: number): void {
    // 1) 只关心 phase 事件
    if (!PHASE_EVENTS.has(eventName)) return;

    // 2) payload.chatId 必须存在
    const evtChatId = payload?.chatId;
    if (!evtChatId) return;

    // 3) 找到订阅本 chatId 的 subscriber, 转交事件
    for (const sub of this.subscribers) {
      if (sub.chatId !== evtChatId) continue;
      const taskId = payload.packetUuid ?? `phase-${timestamp}`;
      sub.handler({
        kind: 'phase',
        phase: eventName,
        taskId,
        ...payload,
        // 不暴露 chatId 给 handler (handler 不需要关心)
        chatId: undefined,
      });
    }
  }
}

/** 全局单例 */
export const sseBackend = new SseBackend();
