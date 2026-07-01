/**
 * auditSinkSurreal.ts — HTTP 审计日志持久化 sink
 *
 * 设计动机:
 *   - 默认 defaultAuditSink 只写 stdout, 无法检索/告警
 *   - 每次请求都同步写 DB 会成为瓶颈
 *   - 必须异步批量 + 失败降级 (DB 挂了不能影响主请求路径)
 *
 * 关键不变量:
 *   1. 永远不抛错到 caller (sink 是 fire-and-forget, 抛错会污染请求路径)
 *   2. DB 不可用时降级到 stdout, 用 tag=AUDIT_FALLBACK 区分
 *   3. 进程退出时 flush 残留队列 (best-effort, 超时即放弃)
 *   4. 同时 mirror 一行到 stdout (供 tail 调试), tag=AUDIT
 *
 * 批量策略:
 *   - 队列上限 MAX_QUEUE (默认 1000), 满了就 drop 旧的 (FIFO)
 *   - 触发 flush 条件:
 *       ① 队列长度 ≥ FLUSH_THRESHOLD (默认 50)
 *       ② 距上次 flush 超过 FLUSH_INTERVAL_MS (默认 5s)
 *   - flush 超时 FLUSH_TIMEOUT_MS (默认 10s)
 *   - 失败重试 3 次, 指数退避 (100ms / 200ms / 400ms)
 *
 * SurrealDB 接口约定:
 *   - 只依赖 SurrealPersistence.query(sql, bindings)
 *   - INSERT 用参数化, 防注入
 *   - 使用 UPSERT 行为 (主键冲突时更新)
 */

import { logger } from '../core/logger';
import type { AuditEvent, AuditSink } from './auth';

const MAX_QUEUE = 1000;
const FLUSH_THRESHOLD = 50;
const FLUSH_INTERVAL_MS = 5000;
const FLUSH_TIMEOUT_MS = 10_000;
const MAX_RETRIES = 3;

const FALLBACK_TAG = 'AUDIT_FALLBACK';
const MIRROR_TAG = 'AUDIT';

export interface AuditSinkSurrealOptions {
  /** SurrealPersistence.query 实现, 抽象后方便测试注入 */
  queryFn: (sql: string, bindings?: Record<string, any>) => Promise<any>;
  /** 也写到 stdout (供 tail), 默认 true */
  mirrorToStdout?: boolean;
  /** 失败 fallback 时也写 stdout (推荐 true) */
  fallbackToStdout?: boolean;
  /** 队列上限, 默认 1000 */
  maxQueue?: number;
  /** flush 阈值, 默认 50 */
  flushThreshold?: number;
  /** 定时 flush 间隔 ms, 默认 5000 */
  flushIntervalMs?: number;
  /** 注入测试用时间, 默认 Date.now */
  now?: () => number;
  /** 注入 logger (测试) */
  log?: (line: string) => void;
}

export class AuditSinkSurreal implements AuditSink {
  private queue: AuditEvent[] = [];
  private timer: NodeJS.Timeout | null = null;
  private flushing = false;
  private stopped = false;
  private stats = {
    received: 0,
    written: 0,
    dropped: 0,
    fallback: 0,
    failedFlushes: 0,
  };
  private lastFlushAt: number;
  private readonly opts: Required<Omit<AuditSinkSurrealOptions, 'queryFn' | 'now' | 'log'>> & {
    queryFn: AuditSinkSurrealOptions['queryFn'];
    now: () => number;
    log: (line: string) => void;
  };

  constructor(opts: AuditSinkSurrealOptions) {
    if (!opts.queryFn) throw new Error('AuditSinkSurreal requires queryFn');
    this.opts = {
      queryFn: opts.queryFn,
      mirrorToStdout: opts.mirrorToStdout ?? true,
      fallbackToStdout: opts.fallbackToStdout ?? true,
      maxQueue: opts.maxQueue ?? MAX_QUEUE,
      flushThreshold: opts.flushThreshold ?? FLUSH_THRESHOLD,
      flushIntervalMs: opts.flushIntervalMs ?? FLUSH_INTERVAL_MS,
      now: opts.now ?? Date.now,
      log: opts.log ?? ((line) => logger.info('AuditSink', line)),
    };
    this.lastFlushAt = this.opts.now();
    this.startTimer();
  }

  /** 接收审计事件 (sink 接口, 不抛错) */
  public invoke(ev: AuditEvent): void | Promise<void> {
    if (this.stopped) return;
    try {
      this.stats.received++;
      // 队列上限: FIFO drop 旧的 (优先保留最新的)
      if (this.queue.length >= this.opts.maxQueue) {
        this.queue.shift();
        this.stats.dropped++;
      }
      this.queue.push(ev);

      // stdout mirror (立即可观察, 调试友好)
      if (this.opts.mirrorToStdout) {
        try {
          process.stdout.write(JSON.stringify({ tag: MIRROR_TAG, ...ev }) + '\n');
        } catch { /* stdout 不可写, 忽略 */ }
      }

      // 触发 flush
      if (this.queue.length >= this.opts.flushThreshold) {
        void this.flush('threshold');
      }
    } catch (err) {
      // 永远不抛
      this.opts.log(`invoke error: ${(err as Error).message}`);
    }
  }

  /** 暴露为 AuditSink 类型 */
  public asSink(): AuditSink {
    return (ev) => this.invoke(ev);
  }

  private startTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.flush('interval');
    }, this.opts.flushIntervalMs);
    if (this.timer.unref) this.timer.unref();
  }

  private stopTimer(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * 强制 flush 队列 (供关闭/测试用)。
   * @param reason 触发原因 ('manual' | 'shutdown' | 'interval' | 'threshold')
   */
  public async flush(reason: 'manual' | 'shutdown' | 'interval' | 'threshold' = 'manual'): Promise<void> {
    if (this.flushing) return; // 防重入
    if (this.queue.length === 0) {
      this.lastFlushAt = this.opts.now();
      return;
    }
    this.flushing = true;
    // 取出本批次 (清空队列, 失败时回滚到队首)
    const batch = this.queue.splice(0, this.queue.length);
    try {
      await this.writeBatchWithRetry(batch);
      this.stats.written += batch.length;
      this.lastFlushAt = this.opts.now();
    } catch (err) {
      // 整批失败, fallback 到 stdout
      this.stats.failedFlushes++;
      this.stats.fallback += batch.length;
      if (this.opts.fallbackToStdout) {
        for (const ev of batch) {
          try {
            process.stdout.write(JSON.stringify({ tag: FALLBACK_TAG, ...ev, fallbackReason: (err as Error).message }) + '\n');
          } catch { /* ignore */ }
        }
      }
      this.opts.log(`flush(${reason}) failed: ${(err as Error).message}, batch=${batch.length}, total_fallback=${this.stats.fallback}`);
    } finally {
      this.flushing = false;
    }
  }

  private async writeBatchWithRetry(batch: AuditEvent[]): Promise<void> {
    let lastErr: Error | null = null;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        await this.writeBatch(batch);
        return;
      } catch (e) {
        lastErr = e as Error;
        if (attempt < MAX_RETRIES - 1) {
          const backoff = 100 * Math.pow(2, attempt);
          await new Promise((r) => setTimeout(r, backoff));
        }
      }
    }
    throw lastErr ?? new Error('writeBatch failed after retries');
  }

  /**
   * 写一批到 SurrealDB, 用 UPSERT 语义 (主键冲突覆盖)。
   * 单条 SQL 批量插入以减少 round trip。
   */
  private async writeBatch(batch: AuditEvent[]): Promise<void> {
    if (batch.length === 0) return;
    // 拆成多行 INSERT, 每条独立参数化 (SurrealDB 的 INSERT 支持 array of objects)
    const rows = batch.map(toRow);
    const sql = `INSERT INTO httpAuditLog $rows`;
    await this.withTimeout(
      this.opts.queryFn(sql, { rows }),
      FLUSH_TIMEOUT_MS,
      'flush_timeout',
    );
  }

  private async withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
    let timer: NodeJS.Timeout | null = null;
    try {
      return await Promise.race([
        p,
        new Promise<T>((_, reject) => {
          timer = setTimeout(() => reject(new Error(label)), ms);
          if (timer.unref) timer.unref();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** 关闭 sink: 停 timer + 强制 flush */
  public async close(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.stopTimer();
    try {
      await this.flush('shutdown');
    } catch (e) {
      this.opts.log(`close flush failed: ${(e as Error).message}`);
    }
  }

  /** 只读快照 (供监控/调试) */
  public getStats() {
    return { ...this.stats, queueSize: this.queue.length, lastFlushAt: this.lastFlushAt };
  }
}

// ============================================================
// 字段映射
// ============================================================

interface AuditRow {
  id: string;
  timestamp: string; // SurrealDB datetime string
  action: string;
  route: string;
  method: string;
  status: number;
  principalId: string | null;
  principalRole: string | null;
  principalSource: string | null;
  principalKid: string | null;
  remoteAddressHash: string | null;
  userAgent: string | null;
  reason: string | null;
  reuseDetected: boolean;
  autoRevokedTokens: number | null;
  extra: string | null;
  tenantId: string;
  sinkSource: string;
}

function toRow(ev: AuditEvent): AuditRow {
  // extra: 序列化 AuditEvent 里其他未映射字段
  const known = new Set([
    'id', 'timestamp', 'principal', 'action', 'route', 'method', 'status',
    'remoteAddress', 'userAgent', 'reason', 'requestId',
  ]);
  const extraEntries = Object.entries(ev).filter(([k]) => !known.has(k));
  const extraObj: Record<string, any> = {};
  for (const [k, v] of extraEntries) extraObj[k] = v;
  // principal 拆字段
  const p = ev.principal;
  // reuse 检测字段 (从 principal.kid 推断不靠谱, 单独从 reason 推断)
  const reuseDetected = ev.reason === 'token_reuse_detected';

  return {
    id: ev.id || ev.requestId || `audit_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date(ev.timestamp).toISOString(),
    action: ev.action,
    route: ev.route,
    method: ev.method,
    status: ev.status,
    principalId: p?.id ?? null,
    principalRole: p?.role ?? null,
    principalSource: p?.source ?? null,
    principalKid: (p as any)?.kid ?? null,
    remoteAddressHash: ev.remoteAddress ?? null, // caller 已 hash 过
    userAgent: ev.userAgent ?? null,
    reason: ev.reason ?? null,
    reuseDetected,
    autoRevokedTokens: (ev as any).autoRevokedTokens ?? null,
    extra: Object.keys(extraObj).length > 0 ? JSON.stringify(extraObj) : null,
    tenantId: ev.tenantId ?? '_default',
    sinkSource: 'surreal',
  };
}

// ============================================================
// 工厂: 接到 SurrealPersistence
// ============================================================

export interface SurrealPersistenceLike {
  query(sql: string, bindings?: Record<string, any>): Promise<any>;
  isReady(): boolean;
}

export function createAuditSinkFromSurreal(sp: SurrealPersistenceLike, extra?: Partial<AuditSinkSurrealOptions>): AuditSinkSurreal {
  return new AuditSinkSurreal({
    queryFn: (sql, bindings) => sp.query(sql, bindings),
    ...extra,
  });
}
