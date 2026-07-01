/**
 * SoloForge Outbox 桥接 (ReputationIncrementRequested → outbox_sync)
 * Path: src/kernel/orchestration/reputation-outbox-bridge.ts
 * Date: 2026-06-30
 *
 * Plan §24 P9 接入:把 outbox 模式从 canary 接到真实 reputation sync 路径。
 *
 * 流程:
 *   runtime-kernel eventBus emit ReputationIncrementRequested
 *     ↓
 *   ReputationOutboxBridge.onCommand(cmd)
 *     ↓
 *   SurrealDB TX:
 *     BEGIN
 *     INSERT INTO outbox_sync (kind='reputation.increment', payload=cmd, ...)
 *     COMMIT
 *     ↓
 *   worker.notify() 触发立即 poll
 *     ↓
 *   OutboxWorker._tick()
 *     ↓
 *   handler(cmd) → POST http://127.0.0.1:8766/sync/reputation (AI Society 接收端)
 *     ↓ 失败
 *   重试 (指数退避) → 超 max_retries → outbox_dead DLQ
 *
 * 零破坏: 新模块, 不改现有 reputation-bridge.ts / eventBus 任何事件名。
 */

import { RuntimeEvent } from '../../core/events/runtime-events';
import type { SurrealDbDriverInterface as SurrealClient } from '../../data/surreal_persistence';
import { logger as rootLogger } from '../../core/logger';
import {
  OutboxWorker,
  startOutboxWorker,
  ensureOutboxSchema,
  DEFAULT_OUTBOX_CONFIG,
  type OutboxConfig,
  type OutboxRecord,
} from '../../data/outbox/outbox';
import { ReputationCommandPayload } from './reputation-bridge';

const log = {
  info: (msg: string, meta?: any) => rootLogger.info('RepOutbox', msg, meta),
  warn: (msg: string, meta?: any) => rootLogger.warn('RepOutbox', msg, meta),
  error: (msg: string, meta?: any) => rootLogger.error('RepOutbox', msg, meta),
  debug: (msg: string, meta?: any) => rootLogger.debug('RepOutbox', msg, meta),
};

export interface ReputationOutboxBridgeConfig {
  /** AI Society 接收端 URL (Python TCP/8766 HTTP 包装) */
  ai_society_url: string;
  /** worker 配置覆盖 */
  worker?: Partial<OutboxConfig>;
  /** HTTP 推送超时 */
  push_timeout_ms: number;
}

export const DEFAULT_REP_BRIDGE_CONFIG: ReputationOutboxBridgeConfig = {
  ai_society_url: process.env.AI_SOCIETY_REPUTATION_URL
    || 'http://127.0.0.1:8766/sync/reputation',
  worker: { ...DEFAULT_OUTBOX_CONFIG, worker_id: `rep-outbox-${process.pid}` },
  push_timeout_ms: 3000,
};

/**
 * 启动 ReputationOutboxBridge
 *
 * 用法:
 *   const bridge = new ReputationOutboxBridge(kernel, surrealClient);
 *   await bridge.start();
 *   // ... 主程序运行 ...
 *   await bridge.stop();
 *
 * 行为:
 *   - 启动时 ensureOutboxSchema (幂等, 建表 + 索引)
 *   - 启动 worker (100ms 轮询 + 指数退避 + DLQ)
 *   - 订阅 RuntimeEvent.ReputationIncrementRequested
 *   - 收到事件 → outbox enqueue (TX 边界由 caller 控制, 这里用独立 TX 简化)
 *   - worker 推送 → ai_society_url
 *
 * 失败语义:
 *   - 写 outbox 失败: 事件丢失 (会在日志告警, 业务可选择下次重发)
 *   - 推送失败: outbox 重试, 永远不丢
 */
export class ReputationOutboxBridge {
  private kernel: any;  // RuntimeKernel, 避免循环依赖
  private client: SurrealClient;
  private config: ReputationOutboxBridgeConfig;
  private worker: OutboxWorker | null = null;
  private started = false;
  private push_stats = { ok: 0, fail: 0, last_error: '' };
  private enqueue_stats = { called: 0, succeeded: 0, failed: 0, last_error: '' };

  constructor(kernel: any, surrealClient: SurrealClient, config?: Partial<ReputationOutboxBridgeConfig>) {
    this.kernel = kernel;
    this.client = surrealClient;
    this.config = { ...DEFAULT_REP_BRIDGE_CONFIG, ...config };
  }

  async start(): Promise<void> {
    if (this.started) {
      log.warn('bridge already started, ignoring duplicate start()');
      return;
    }
    // 1. ensure schema (幂等)
    await ensureOutboxSchema(this.client);
    log.info('outbox schema ensured');

    // 2. 启动 worker
    this.worker = startOutboxWorker(
      this.client,
      (rec) => this.handleOutboxRecord(rec),
      this.config.worker,
    );
    log.info(`worker started, target=${this.config.ai_society_url}`);

    // 3. 订阅事件
    this.kernel.eventBus.on(
      RuntimeEvent.ReputationIncrementRequested,
      (cmd: ReputationCommandPayload) => {
        this.enqueueCommand(cmd).catch((e) => {
          log.error('enqueueCommand failed', { cmd, error: e?.message });
        });
      },
    );

    this.started = true;
    log.info('ReputationOutboxBridge started');
  }

  async stop(): Promise<void> {
    if (this.worker) {
      this.worker.stop();
      this.worker = null;
    }
    this.started = false;
    log.info('ReputationOutboxBridge stopped');
  }

  /**
   * 把 reputation command 写入 outbox_sync
   *
   * 用独立 TX (单行 INSERT), 失败时事件丢失但会日志告警。
   * 业务侧如果要严格不丢, 应在自己 TX 内同时写业务表 + outbox。
   */
  private async enqueueCommand(cmd: ReputationCommandPayload): Promise<void> {
    this.enqueue_stats.called++;
    const id = `outbox_rep_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const now = Date.now();
    try {
      const r = await this.client.query(
        `INSERT INTO outbox_sync (id, kind, payload, status, retry_count, next_retry_at, created_at) VALUES (
          $id, $kind, $payload, 'pending', 0, $now, $now
        )`,
        {
          id,
          kind: 'reputation.increment',
          payload: cmd,
          now,
        },
      );
      this.enqueue_stats.succeeded++;
      log.debug(`enqueued outbox id=${id} commandId=${cmd.commandId}`);
      // 触发立即 poll
      this.worker?.notify();
    } catch (e: any) {
      this.enqueue_stats.failed++;
      this.enqueue_stats.last_error = e?.message ?? String(e);
      // 不抛, 不让 eventBus 链路挂掉
      log.error(`enqueue failed for commandId=${cmd.commandId}`, { error: e?.message });
    }
  }

  /**
   * worker 调用的 handler: 把 record payload POST 给 AI Society
   */
  private async handleOutboxRecord(rec: OutboxRecord): Promise<void> {
    if (rec.kind !== 'reputation.increment') {
      log.warn(`unknown outbox kind, skipping: ${rec.kind}`);
      return;
    }
    const payload = rec.payload as ReputationCommandPayload;

    // 用 fetch 推 (Node 18+ 内置)
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.config.push_timeout_ms);
    try {
      const resp = await fetch(this.config.ai_society_url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Outbox-Id': rec.id,
          'X-Command-Id': payload.commandId,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        throw new Error(`HTTP ${resp.status}: ${text.slice(0, 200)}`);
      }
      this.push_stats.ok++;
      log.debug(`pushed outbox id=${rec.id} commandId=${payload.commandId}`);
    } catch (e: any) {
      clearTimeout(timeoutId);
      this.push_stats.fail++;
      this.push_stats.last_error = e?.message ?? String(e);
      throw e;  // 让 worker 走重试/DLQ
    }
  }

  /**
   * 当前状态 (调试 / health endpoint)
   */
  getStatus() {
    return {
      started: this.started,
      target: this.config.ai_society_url,
      push_stats: this.push_stats,
      enqueue_stats: this.enqueue_stats,
      worker_stats: this.worker?.stats ?? null,
    };
  }
}