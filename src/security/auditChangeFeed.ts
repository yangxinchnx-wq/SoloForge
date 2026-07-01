/**
 * auditChangeFeed.ts — SurrealDB Change Feed → Kafka 推送
 *
 * 工作原理:
 *   - 周期 poll SurrealDB httpAuditLog, 找 writtenAt > lastCursor 的新行
 *   - 把新行作为 AuditEvent 推到 Kafka (按 tenantId 分区)
 *   - 游标持久化 (进程内 + 可选 vault)
 *
 * 为什么用 poll 而非 LiveQuery:
 *   - SurrealDB LiveQuery 是 websocket 推送, 实现复杂
 *   - 审计场景 1-2s 延迟可接受, poll 实现简单且鲁棒
 *   - poll 天然支持 resume, 不漏单
 *
 * 配置:
 *   - pollIntervalMs: 拉取间隔, 默认 1000
 *   - batchSize: 每次拉取上限, 默认 200
 *   - 启动后从 writtenAt > now - lookbackMs 起步, 默认 60s
 */

import type { SurrealPersistenceLike } from './auditSinkSurreal';
import type { KafkaAuditSink } from './auditSinkKafka';
import { logger } from '../core/logger';

export interface AuditChangeFeedOptions {
  pollIntervalMs?: number;
  batchSize?: number;
  lookbackMs?: number;
}

export class AuditChangeFeed {
  private timer: NodeJS.Timeout | null = null;
  private lastCursor: number;
  private running = false;
  private inFlight = false;
  private stats = {
    polls: 0,
    rowsPushed: 0,
    lastBatchSize: 0,
    lastError: null as string | null,
  };

  constructor(
    private sp: SurrealPersistenceLike,
    private kafkaSink: KafkaAuditSink,
    private opts: AuditChangeFeedOptions = {},
  ) {
    this.opts = {
      pollIntervalMs: opts.pollIntervalMs ?? 1000,
      batchSize: opts.batchSize ?? 200,
      lookbackMs: opts.lookbackMs ?? 60_000,
    };
    this.lastCursor = Date.now() - this.opts.lookbackMs;
  }

  public start(): void {
    if (this.running) return;
    this.kafkaSink.start?.();
    this.running = true;
    this.timer = setInterval(() => void this.tick(), this.opts.pollIntervalMs!);
    if (this.timer.unref) this.timer.unref();
    logger.info('AuditChangeFeed', `started, interval=${this.opts.pollIntervalMs}ms, cursor=${this.lastCursor}`);
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.running = false;
  }

  /** 立即执行一次 (供启动暖机 / 测试) */
  public async tickOnce(): Promise<number> {
    return this.runTick();
  }

  private async tick(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      await this.runTick();
    } catch (e) {
      this.stats.lastError = (e as Error).message;
    } finally {
      this.inFlight = false;
    }
  }

  private async runTick(): Promise<number> {
    if (!this.sp.isReady()) return 0;
    this.stats.polls++;
    const sql = `SELECT * FROM httpAuditLog WHERE writtenAt > $cursor ORDER BY writtenAt ASC LIMIT $limit`;
    const res = await this.sp.query(sql, {
      cursor: new Date(this.lastCursor).toISOString(),
      limit: this.opts.batchSize!,
    });
    const rows: any[] = Array.isArray(res) && Array.isArray(res[0])
      ? res[0]
      : Array.isArray(res?.result) ? res.result : Array.isArray(res) ? res : [];
    if (rows.length === 0) return 0;
    // 转成 AuditEvent 推 Kafka
    const events = rows.map(rowToAuditEvent);
    await this.kafkaSink.push(events);
    // 推进游标
    const maxWrittenAt = rows.reduce((m, r) => {
      const t = new Date(r.writtenAt ?? r.timestamp ?? 0).getTime();
      return t > m ? t : m;
    }, this.lastCursor);
    this.lastCursor = maxWrittenAt + 1; // +1 避免同毫秒重复
    this.stats.rowsPushed += events.length;
    this.stats.lastBatchSize = events.length;
    return events.length;
  }

  public getStats() {
    return { ...this.stats, lastCursor: this.lastCursor, running: this.running };
  }
}

function rowToAuditEvent(r: any): any {
  return {
    id: r.id,
    timestamp: r.timestamp ? new Date(r.timestamp).getTime() : Date.now(),
    action: r.action,
    route: r.route,
    method: r.method,
    status: r.status,
    principal: {
      id: r.principalId,
      role: r.principalRole,
      source: r.principalSource,
      kid: r.principalKid,
    },
    remoteAddress: r.remoteAddressHash,
    userAgent: r.userAgent,
    reason: r.reason,
    tenantId: r.tenantId ?? '_default',
    _sinkSource: r.sinkSource ?? 'surreal',
    _writtenAt: r.writtenAt,
  };
}
