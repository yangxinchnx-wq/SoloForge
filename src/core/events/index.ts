// ─────────────────────────────────────────────────────────────────
// SoloForge Core Layer: Type-Safe Event Bus
// Path: src/core/events/index.ts
// ─────────────────────────────────────────────────────────────────

import { EventEmitter } from 'events';

export interface EventPayload {
  timestamp?: number;
  traceId?: string;
  [key: string]: any;
}

export class EventBus extends EventEmitter {
  emit(eventName: string | symbol, payload?: EventPayload): boolean {
    const enrichedPayload: EventPayload = {
      timestamp: Date.now(),
      traceId: (global as any).__CURRENT_TRACE_ID,
      ...payload
    };
    return super.emit(eventName, enrichedPayload);
  }

  // 类型安全监听（推荐使用）
  onTyped<T = EventPayload>(eventName: string, listener: (payload: T) => void): this {
    return super.on(eventName, listener);
  }

  onceTyped<T = EventPayload>(eventName: string, listener: (payload: T) => void): this {
    return super.once(eventName, listener);
  }
}

// 全局单例
export const eventBus = new EventBus();
export default eventBus;