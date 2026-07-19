/**
 * SoloForge Outbox 模式 (P9 — 最终一致性)
 * Path: src/data/outbox/outbox.ts
 * Date: 2026-06-30
 *
 * Plan §24 P9: Node.js push 同步消息到 AI Society, 单点失败就丢。
 * 改造: 业务写 + outbox_sync 表写 同一 TX, 后台 worker 100ms 轮询推送。
 * 零丢失 + 重试对业务无感。
 *
 * 架构:
 *
 *   业务代码
 *     1. BEGIN TX
 *     2. INSERT domain_row (本地)
 *     3. INSERT outbox_sync (待推送)   ← 关键: 同一 TX
 *     4. COMMIT
 *     5. 触发 worker.notify()
 *
 *   后台 worker (OutboxWorker)
 *     1. SELECT * FROM outbox_sync WHERE status='pending' ORDER BY created_at LIMIT batch_size
 *     2. handler(payload)                ← 业务回调 (e.g. pushReputation)
 *     3. UPDATE outbox_sync SET status='sent', sent_at=now
 *     → 失败: status='pending', retry_count++ (指数退避)
 *     → retry_count > max_retries: status='dead', 转入 outbox_dead (DLQ)
 *
 * 零破坏: 新模块, 不改任何现有代码。
 * 提供 canary 测试模拟网络失败验证 0 丢失。
 */

import type { SurrealDbDriverInterface as SurrealClient } from '../data/surreal_persistence';
import { logger as rootLogger } from '../../core/logger';

const logger = {
  info: (msg: string, meta?: any) => rootLogger.info('outbox', msg, meta),
  warn: (msg: string, meta?: any) => rootLogger.warn('outbox', msg, meta),
  error: (msg: string, meta?: any) => rootLogger.error('outbox', msg, meta),
  debug: (msg: string, meta?: any) => rootLogger.debug('outbox', msg, meta),
};

// ── 配置 ──────────────────────────────────────────────────────────

export interface OutboxConfig {
  poll_interval_ms: number;       // 轮询间隔 (默认 100ms)
  batch_size: number;             // 每轮取多少条 (默认 100)
  max_concurrency: number;        // 单 tick 内 handler 并行上限 (M3 修复, 默认 8)
  max_retries: number;            // 超过此次数转 DLQ (默认 10)
  backoff_base_ms: number;        // 指数退避基数 (默认 500ms)
  backoff_max_ms: number;         // 指数退避上限 (默认 60s)
  worker_id: string;              // worker 标识, 便于日志追踪
  enable_dlq: boolean;            // 是否启用 DLQ
}

export const DEFAULT_OUTBOX_CONFIG: OutboxConfig = {
  poll_interval_ms: 100,
  batch_size: 100,
  max_concurrency: 8,             // M3 修复: 并行处理避免单 tick 阻塞 (audit 2026-06-30)
  max_retries: 10,
  backoff_base_ms: 500,
  backoff_max_ms: 60_000,
  worker_id: `outbox-${process.pid}`,
  enable_dlq: true,
};

// ── 消息 / 表 ─────────────────────────────────────────────────────

export type OutboxStatus = 'pending' | 'sent' | 'dead';
export type OutboxKind = string;       // 业务自定义, e.g. "reputation.update"

export interface OutboxRecord {
  id: string;
  kind: OutboxKind;
  payload: any;             // 业务负载
  status: OutboxStatus;
  retry_count: number;
  next_retry_at: number;    // epoch ms
  last_error?: string;
  created_at: number;
  sent_at?: number;
}

export interface OutboxEnqueueOptions {
  /** 同一 TX 内的 client (有 BEGIN 上下文), 业务层负责 BEGIN/COMMIT */
  txClient: SurrealClient;
  kind: OutboxKind;
  payload: any;
}

// ── Outbox 表操作 (SurrealDB) ─────────────────────────────────────

/**
 * 在 SurrealDB 中定义 outbox_sync / outbox_dead 表 + 索引。
 * 建议在 schema init 时调用一次, 幂等。
 */
export async function ensureOutboxSchema(client: SurrealClient): Promise<void> {
  // SurrealQL: SCHEMALESS 模式, 表自动建, 这里只建索引
  await client.query(`
    DEFINE INDEX IF NOT EXISTS idx_outbox_status_created
    ON TABLE outbox_sync
    COLUMNS status, next_retry_at
  `);
  await client.query(`
    DEFINE INDEX IF NOT EXISTS idx_outbox_kind
    ON TABLE outbox_sync
    COLUMNS kind
  `);
  await client.query(`
    DEFINE INDEX IF NOT EXISTS idx_outbox_dead_created
    ON TABLE outbox_dead
    COLUMNS created_at
  `);
  logger.info('outbox schema ensured (outbox_sync + outbox_dead)');
}

/**
 * 在业务 TX 内插入一条 outbox 记录。
 * 业务方必须保证传入的 txClient 处于 BEGIN 状态。
 */
export async function enqueueInTx(opts: OutboxEnqueueOptions): Promise<string> {
  const id = `outbox_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  const now = Date.now();
  await opts.txClient.query(
    `INSERT INTO outbox_sync (id, kind, payload, status, retry_count, next_retry_at, created_at) VALUES (
      $id, $kind, $payload, 'pending', 0, $now, $now
    )`,
    {
      id,
      kind: opts.kind,
      payload: opts.payload,
      now,
    },
  );
  logger.debug(`enqueued outbox id=${id} kind=${opts.kind}`);
  return id;
}

// ── Worker ────────────────────────────────────────────────────────

export type OutboxHandler = (record: OutboxRecord) => Promise<void>;

export interface OutboxWorkerStats {
  polled: number;
  sent: number;
  failed_attempts: number;
  dead_lettered: number;
  last_poll_at: number | null;
  last_sent_at: number | null;
  pending_now: number;
}

export class OutboxWorker {
  private client: SurrealClient;
  private config: OutboxConfig;
  private handler: OutboxHandler;
  private running = false;
  private _thread: ReturnType<typeof setTimeout> | null = null;
  private _stopped = false;

  public stats: OutboxWorkerStats = {
    polled: 0,
    sent: 0,
    failed_attempts: 0,
    dead_lettered: 0,
    last_poll_at: null,
    last_sent_at: null,
    pending_now: 0,
  };

  constructor(client: SurrealClient, handler: OutboxHandler, config?: Partial<OutboxConfig>) {
    this.client = client;
    this.handler = handler;
    this.config = { ...DEFAULT_OUTBOX_CONFIG, ...config };
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this._stopped = false;
    this._scheduleNext(0);
    logger.info(`OutboxWorker started (id=${this.config.worker_id}, poll=${this.config.poll_interval_ms}ms)`);
  }

  stop(): void {
    this._stopped = true;
    if (this._thread) {
      clearTimeout(this._thread);
      this._thread = null;
    }
    this.running = false;
    logger.info('OutboxWorker stopped');
  }

  notify(): void {
    // 业务 enqueue 后调用, 立即触发一次 poll
    if (this._thread) {
      clearTimeout(this._thread);
      this._thread = null;
    }
    this._scheduleNext(0);
  }

  private _scheduleNext(delay: number): void {
    if (this._stopped) return;
    this._thread = setTimeout(() => this._tick().catch((e) => {
      logger.error('outbox tick error', e);
      this._scheduleNext(this.config.poll_interval_ms);
    }), delay);
  }

  private async _tick(): Promise<void> {
    if (this._stopped) return;
    this.stats.polled++;
    this.stats.last_poll_at = Date.now();

    try {
      // 取一批 pending (next_retry_at <= now)
      const now = Date.now();
      const result = await this.client.query<OutboxRecord[]>(
        `SELECT * FROM outbox_sync
         WHERE status = 'pending' AND next_retry_at <= $now
         ORDER BY next_retry_at ASC
         LIMIT $batch`,
        { now, batch: this.config.batch_size },
      );
      // SurrealDB returns any[][]: [rows[]]
      const records: OutboxRecord[] = Array.isArray(result) && Array.isArray(result[0])
        ? result[0]
        : (Array.isArray(result) ? (result as any) : []);
      // M3 修复: 并行处理 records, 限流 max_concurrency (默认 8)
      // 原版: for (const r of records) { await this._processOne(r); }
      // 问题: handler 慢 (e.g. fetch 3s) + 100 条 = 300s 阻塞, 期间新 tick 不 fire
      // 修法: 池化并发, 单 tick 最多同时跑 N 个 _processOne
      await this._processBatch(records);
      // 更新待发计数
      const pending = await this.client.query<any[]>(
        `SELECT count() AS c FROM outbox_sync WHERE status='pending' GROUP ALL`,
      );
      const pendingCount = Array.isArray(pending) && pending[0]?.c !== undefined
        ? pending[0].c
        : 0;
      this.stats.pending_now = pendingCount;
    } catch (e: any) {
      logger.error('outbox poll error', e);
    } finally {
      this._scheduleNext(this.config.poll_interval_ms);
    }
  }

  private async _processBatch(records: OutboxRecord[]): Promise<void> {
    // M3 修复: 并发限流 (audit 2026-06-30)
    // 池化处理: 每次最多 N 个并发, 池里空位补下一个
    // P1.1 修复 (2026-07-01): records 可能被嵌套一层 (driver 返回 [[row]] 而非 [row]),
    // 这里 flatten 一次保险。诊断: log 显示 handler 收 [{...}] 而非 {...}, 是嵌套 bug。
    const flat: OutboxRecord[] = [];
    for (const item of records) {
      if (Array.isArray(item)) {
        for (const sub of item) flat.push(sub as OutboxRecord);
      } else if (item) {
        flat.push(item as OutboxRecord);
      }
    }
    const conc = Math.max(1, this.config.max_concurrency);
    let cursor = 0;
    const runNext = async (): Promise<void> => {
      const idx = cursor++;
      if (idx >= flat.length) return;
      const r = flat[idx];
      if (!r) return runNext();
      try {
        await this._processOne(r);
      } finally {
        await runNext();
      }
    };
    const workers: Promise<void>[] = [];
    for (let i = 0; i < Math.min(conc, records.length); i++) {
      workers.push(runNext());
    }
    await Promise.allSettled(workers);
  }

  private async _processOne(r: OutboxRecord): Promise<void> {
    try {
      await this.handler(r);
      // 成功: 标记 sent
      await this.client.query(
        `UPDATE $id SET status='sent', sent_at=$now`,
        { id: r.id, now: Date.now() },
      );
      this.stats.sent++;
      this.stats.last_sent_at = Date.now();
      logger.debug(`outbox sent id=${r.id} kind=${r.kind}`);
    } catch (e: any) {
      const errMsg = e?.message ?? String(e);
      const newRetry = r.retry_count + 1;
      if (newRetry >= this.config.max_retries) {
        // 超过重试, 转 DLQ
        if (this.config.enable_dlq) {
          await this.client.query(
            `INSERT INTO outbox_dead (id, kind, payload, retry_count, last_error, created_at, dead_at) VALUES (
              $id, $kind, $payload, $retry, $err, $created, $now
            )`,
            {
              id: r.id,
              kind: r.kind,
              payload: r.payload,
              retry: newRetry,
              err: errMsg,
              created: r.created_at,
              now: Date.now(),
            },
          );
        }
        await this.client.query(
          `UPDATE $id SET status='dead', retry_count=$retry, last_error=$err`,
          { id: r.id, retry: newRetry, err: errMsg },
        );
        this.stats.dead_lettered++;
        logger.warn(`outbox DEAD id=${r.id} kind=${r.kind} retries=${newRetry} err=${errMsg}`);
      } else {
        // 退避
        const delay = Math.min(
          this.config.backoff_base_ms * Math.pow(2, newRetry),
          this.config.backoff_max_ms,
        );
        await this.client.query(
          `UPDATE $id SET retry_count=$retry, last_error=$err, next_retry_at=$next`,
          { id: r.id, retry: newRetry, err: errMsg, next: Date.now() + delay },
        );
        this.stats.failed_attempts++;
        logger.debug(`outbox retry id=${r.id} kind=${r.kind} retry=${newRetry} delay=${delay}ms err=${errMsg}`);
      }
    }
  }
}

// ── 顶层便捷入口 ──────────────────────────────────────────────────

/**
 * 启动 outbox worker, 一行调用。
 *
 * 用法:
 *   import { startOutboxWorker } from './data/outbox/outbox';
 *   const worker = startOutboxWorker(client, async (rec) => {
 *     if (rec.kind === 'reputation.update') {
 *       await aiSocietyClient.pushReputation(rec.payload);
 *     }
 *   });
 */
export function startOutboxWorker(
  client: SurrealClient,
  handler: OutboxHandler,
  config?: Partial<OutboxConfig>,
): OutboxWorker {
  const w = new OutboxWorker(client, handler, config);
  w.start();
  return w;
}
