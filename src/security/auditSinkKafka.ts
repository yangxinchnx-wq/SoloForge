/**
 * auditSinkKafka.ts — Kafka 推送 sink
 *
 * 设计动机:
 *   - SurrealDB 是嵌入式, 适合本地审计存储
 *   - 真正需要告警时 (Slack / PagerDuty / SIEM) 用 Kafka 解耦
 *   - topic 默认 'soloforge.audit', key = tenantId (租户内保序)
 *   - SurrealDB Change Feed 不断把新行 poll 出来, 推到 Kafka
 *
 * 关键设计:
 *   - Kafka producer 是有状态长连接, 用 start()/close() 生命周期管理
 *   - 失败重试由 kafkajs 内部处理, 我们捕获并 fallback
 *   - 队列上限 10000, 满了 drop 旧 (FIFO)
 *   - 关闭时 flush + 断连, 超时 5s
 *
 * 注意: 本 sink 不继承 AbstractAuditSink, 因为它的模型是:
 *   invoke() → push 到内存队列 (非阻塞)
 *   drain timer → 批量 send 到 Kafka
 *   写失败 → fallback stdout
 * AbstractAuditSink 的 writeBatch 语义不匹配。
 *
 * 依赖:
 *   - kafkajs (>= 2.2.4) 已加入 dependencies
 */

import { Kafka, type Producer, type SASLOptions, logLevel } from 'kafkajs';
import type { AuditEvent, AuditSinkV2 } from './auth';

export interface KafkaAuditSinkOptions {
  brokers: string[];
  topic: string;
  clientId?: string;
  sasl?: SASLOptions;
  ssl?: boolean;
  /** 消息 flush 间隔 ms, 默认 1000 */
  flushIntervalMs?: number;
  /** 队列上限, 默认 10000 */
  maxQueue?: number;
  /** 关闭超时 ms, 默认 5000 */
  closeTimeoutMs?: number;
}

export class KafkaAuditSink implements AuditSinkV2 {
  public readonly name = 'kafka';
  private kafka: Kafka;
  private producer: Producer;
  private queue: AuditEvent[] = [];
  private timer: NodeJS.Timeout | null = null;
  private connected = false;
  private stopped = false;
  private readonly opts: Required<Omit<KafkaAuditSinkOptions, 'sasl' | 'ssl'>> & {
    sasl?: SASLOptions;
    ssl?: boolean;
  };
  private connectPromise: Promise<void> | null = null;
  private drainInFlight = false;
  private additionalQueueDropped = 0;
  private stats = {
    received: 0,
    written: 0,
    dropped: 0,
    failedWrites: 0,
    fallback: 0,
  };

  constructor(opts: KafkaAuditSinkOptions) {
    this.opts = {
      brokers: opts.brokers,
      topic: opts.topic,
      clientId: opts.clientId ?? 'soloforge-audit',
      flushIntervalMs: opts.flushIntervalMs ?? 1000,
      maxQueue: opts.maxQueue ?? 10000,
      closeTimeoutMs: opts.closeTimeoutMs ?? 5000,
      sasl: opts.sasl,
      ssl: opts.ssl,
    };
    this.kafka = new Kafka({
      clientId: this.opts.clientId,
      brokers: this.opts.brokers,
      ssl: this.opts.ssl,
      sasl: this.opts.sasl,
      logLevel: logLevel.NOTHING, // 不污染 stdout
    });
    this.producer = this.kafka.producer({ allowAutoTopicCreation: true });
  }

  /** 启动后台 drain timer (不立即连, 等 invoke 第一次来再连) */
  public start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.drain();
    }, this.opts.flushIntervalMs);
    if (this.timer.unref) this.timer.unref();
  }

  public async invoke(ev: AuditEvent): Promise<void> {
    if (this.stopped) return;
    try {
      this.stats.received++;
      // 队列上限
      if (this.queue.length >= this.opts.maxQueue) {
        this.queue.shift();
        this.additionalQueueDropped++;
        this.stats.dropped++;
      }
      this.queue.push(ev);
    } catch (err) {
      this.fallbackToStdout([ev], err as Error);
    }
  }

  /** 显式 push, 也供 Change Feed 复用同一 producer */
  public async push(events: AuditEvent[]): Promise<void> {
    if (events.length === 0) return;
    try {
      await this.ensureConnected();
      await this.producer.send({
        topic: this.opts.topic,
        messages: events.map((e) => ({
          key: e.tenantId ?? '_default',
          value: JSON.stringify({ ...e, _sink: this.name }),
        })),
      });
      this.stats.written += events.length;
    } catch (err) {
      this.stats.failedWrites++;
      this.fallbackToStdout(events, err as Error);
    }
  }

  /** 内部 drain: 队列里的 → push() */
  private async drain(): Promise<void> {
    if (this.drainInFlight) return;
    if (this.queue.length === 0) return;
    this.drainInFlight = true;
    try {
      const batch = this.queue.splice(0, this.queue.length);
      await this.push(batch);
    } finally {
      this.drainInFlight = false;
    }
  }

  private fallbackToStdout(events: AuditEvent[], err: Error): void {
    this.stats.fallback += events.length;
    try {
      for (const ev of events) {
        process.stdout.write(JSON.stringify({
          tag: 'AUDIT_FALLBACK',
          ...ev,
          _sink: this.name,
          _fallbackReason: err.message,
        }) + '\n');
      }
    } catch { /* ignore */ }
  }

  private async ensureConnected(): Promise<void> {
    if (this.connected) return;
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = (async () => {
      try {
        await this.producer.connect();
        this.connected = true;
      } catch (err) {
        this.connectPromise = null;
        throw err;
      }
    })();
    return this.connectPromise;
  }

  public async close(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // 排空剩余队列
    try {
      await Promise.race([
        this.drain(),
        new Promise((r) => setTimeout(r, this.opts.closeTimeoutMs)),
      ]);
    } catch { /* ignore */ }
    if (this.connected) {
      try {
        await Promise.race([
          this.producer.disconnect(),
          new Promise((r) => setTimeout(r, this.opts.closeTimeoutMs)),
        ]);
      } catch { /* ignore */ }
      this.connected = false;
    }
  }

  public getStats(): Record<string, any> {
    return {
      ...this.stats,
      name: this.name,
      topic: this.opts.topic,
      brokers: this.opts.brokers,
      queueSize: this.queue.length,
      connected: this.connected,
      additionalQueueDropped: this.additionalQueueDropped,
    };
  }
}
