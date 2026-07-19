// ─────────────────────────────────────────────────────────────────
// SoloForge Garnet Bridge: EventBus ↔ Garnet Streams Gateway
// Path: src/data/garnet/garnet-bridge.ts
//
// 职责：
// 1. 监听内核 EventBus 事件，将关键领域事件写入 Garnet Redis Streams
// 2. 消费者可通过 Garnet Streams 订阅事件，减轻 SurrealDB 压力
// 3. 允许最终一致：事件在 Garnet 中有 TTL，过期后统一持久化到 SurrealDB
// ─────────────────────────────────────────────────────────────────

import type Redis from 'ioredis';
import type { EventBusInterface } from '../../kernel/runtime-kernel';
import { getClient } from './client';

// 需桥接到 Garnet Stream 的关键事件类型
const BRIDGE_EVENTS = [
  'sys.heartbeat',
  'governor.reputation.increment.requested',
  'society.agent.role.evolved',
  'transaction.committed',
  'audit.recorded',
  'system.log',
  'ai.runtime.tick',
];

// Garnet Stream Key 常量
const EVENT_STREAM_KEY = 'stream:events';
const GOVERNOR_DECISION_STREAM = 'stream:gov_decisions';
const REPUTATION_EVENT_STREAM = 'stream:reputation';

export class GarnetEventBridge {
  public readonly name = 'garnet-bridge';
  private eventBus: EventBusInterface;
  private client: Redis;
  private handlers: Array<{ event: string; handler: (payload: any) => void }> = [];

  constructor(
    kernel: { eventBus: EventBusInterface; getGarnetClient(): Redis | null }
  ) {
    this.eventBus = kernel.eventBus;
    this.client = kernel.getGarnetClient() ?? getClient();
  }

  async start(): Promise<void> {
    for (const eventName of BRIDGE_EVENTS) {
      const handler = (payload: any) => {
        this.client.xadd(EVENT_STREAM_KEY, '*', 'event', eventName, 'data', JSON.stringify({
          eventName,
          payload,
          bridgedAt: Date.now(),
        })).catch(() => {});
      };
      this.eventBus.on(eventName, handler);
      this.handlers.push({ event: eventName, handler });
    }
    console.log('[GarnetBridge] ✓ Listening on', BRIDGE_EVENTS.length, 'events for Garnet Stream bridge');
  }

  async stop(): Promise<void> {
    this.handlers = [];
    console.log('[GarnetBridge] Bridge stopped');
  }

  async healthCheck(): Promise<boolean> {
    try {
      const pong = await this.client.ping();
      return pong === 'PONG';
    } catch {
      return false;
    }
  }

  getSubscribedEvents(): string[] {
    return [...BRIDGE_EVENTS];
  }
}
