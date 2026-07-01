/**
 * auditSinkBase.ts — Sink 抽象 + Composite fan-out
 *
 * 设计动机:
 *   - 之前 AuditSinkSurreal 直接实现了 stdout mirror + DB 写, 职责不清
 *   - 需要支持多路 fan-out: 同一事件写多个目标 (DB + Kafka + file)
 *   - 需要让外部组件 (Kafka change feed) 也能 emit 事件
 *
 * 抽象层级:
 *   AuditSinkV2 (interface)  ── 基础契约
 *   AbstractAuditSink (class) ── 提供 stdout fallback, 子类实现 write() 即可
 *   CompositeAuditSink        ── fan-out 多路, 任一失败不影响其他
 *   FunctionAuditSink         ── 函数式包装 (兼容旧 AuditSink)
 *
 * 子类参考:
 *   - SurrealAuditSink    : 写 SurrealDB httpAuditLog (本期已实现, 后续可迁过来)
 *   - FileAuditSink       : 写 JSONL 文件 (本地备份)
 *   - KafkaAuditSink      : 推送到 Kafka topic (告警 / 大数据)
 *   - HttpAuditSink       : 推送到远端 HTTP endpoint (SIEM webhook)
 *   - StdoutAuditSink     : 调试用, tag=AUDIT
 *
 * 关键不变量 (跨所有 sink):
 *   1. invoke() 永不抛错 (内部 try/catch)
 *   2. 失败 → stdout tag=AUDIT_FALLBACK 兜底
 *   3. close() 尽力 flush, 超时即放弃
 *   4. queue 满 → FIFO drop 旧的, 永不 OOM
 */

import type { AuditEvent, AuditSinkV2, AuditSink } from './auth';

const FALLBACK_TAG = 'AUDIT_FALLBACK';
const MIRROR_TAG = 'AUDIT';

/**
 * 抽象基类: 提供 stdout fallback 与统计, 子类只需实现 write(events)
 */
export abstract class AbstractAuditSink implements AuditSinkV2 {
  public abstract readonly name: string;
  protected stats = {
    received: 0,
    written: 0,
    dropped: 0,
    failedWrites: 0,
    fallback: 0,
  };
  protected stopped = false;

  /** 子类实现: 同步/异步写一批 (失败抛错, 由基类处理 fallback) */
  protected abstract write(events: AuditEvent[]): Promise<void>;

  /** 是否在 invoke 期间 stdout mirror (默认 true, 调试友好) */
  protected mirrorToStdout = true;

  public invoke(ev: AuditEvent): void {
    if (this.stopped) return;
    try {
      this.stats.received++;
      if (this.mirrorToStdout) {
        try {
          process.stdout.write(JSON.stringify({ tag: MIRROR_TAG, ...ev, _sink: this.name }) + '\n');
        } catch { /* stdout 不可写 */ }
      }
      // 同步 write: 子类应自行实现批量/队列, 这里只调一次
      void this.writeBatch([ev]);
    } catch (err) {
      this.fallbackToStdout([ev], err as Error);
    }
  }

  protected async writeBatch(events: AuditEvent[]): Promise<void> {
    try {
      await this.write(events);
      this.stats.written += events.length;
    } catch (err) {
      this.stats.failedWrites++;
      this.fallbackToStdout(events, err as Error);
    }
  }

  protected fallbackToStdout(events: AuditEvent[], err: Error): void {
    this.stats.fallback += events.length;
    try {
      for (const ev of events) {
        process.stdout.write(JSON.stringify({
          tag: FALLBACK_TAG,
          ...ev,
          _sink: this.name,
          _fallbackReason: err.message,
        }) + '\n');
      }
    } catch { /* ignore */ }
  }

  public getStats(): Record<string, any> {
    return { ...this.stats };
  }

  public async close(): Promise<void> {
    this.stopped = true;
  }
}

/**
 * Composite Sink: 把 N 个 sink 串成 fan-out
 *
 * 行为:
 *   - invoke(ev) → 并行调用所有子 sink.invoke(ev)
 *   - 任一子 sink 抛错 → 不影响其他 (子 sink 自身已 try/catch)
 *   - 主 sink 自身 invoke 永不抛错 (兜底 fallback)
 *   - close() → 并行 close 所有子 sink
 *   - getStats() → 返回 { childStats: [...], aggregate: {...} }
 */
export class CompositeAuditSink implements AuditSinkV2 {
  public readonly name = 'composite';
  private children: AuditSinkV2[];
  private aggregate = {
    received: 0,
    fanoutToChildren: 0,
    failedFanout: 0,
  };
  private stopped = false;

  constructor(children: AuditSinkV2[]) {
    this.children = children;
  }

  public add(child: AuditSinkV2): void {
    this.children.push(child);
  }

  public remove(name: string): boolean {
    const idx = this.children.findIndex((c) => c.name === name);
    if (idx < 0) return false;
    this.children.splice(idx, 1);
    return true;
  }

  public list(): string[] {
    return this.children.map((c) => c.name ?? 'unnamed');
  }

  public invoke(ev: AuditEvent): void {
    if (this.stopped) return;
    try {
      this.aggregate.received++;
      for (const child of this.children) {
        try {
          this.aggregate.fanoutToChildren++;
          const r = child.invoke(ev);
          if (r && typeof (r as any).catch === 'function') {
            (r as Promise<any>).catch(() => {
              this.aggregate.failedFanout++;
            });
          }
        } catch (err) {
          this.aggregate.failedFanout++;
        }
      }
    } catch (err) {
      // composite 自身抛错 = 完全没救, fallback stdout
      try {
        process.stdout.write(JSON.stringify({
          tag: FALLBACK_TAG,
          ...ev,
          _sink: 'composite',
          _fallbackReason: (err as Error).message,
        }) + '\n');
      } catch { /* ignore */ }
    }
  }

  public async start(): Promise<void> {
    for (const child of this.children) {
      if (child.start) {
        try { await child.start(); } catch { /* ignore */ }
      }
    }
  }

  public async close(): Promise<void> {
    this.stopped = true;
    await Promise.allSettled(
      this.children.map(async (c) => {
        if (c.close) {
          try { await c.close(); } catch { /* ignore */ }
        }
      })
    );
  }

  public getStats(): Record<string, any> {
    return {
      name: this.name,
      childCount: this.children.length,
      children: this.children.map((c) => ({
        name: c.name ?? 'unnamed',
        stats: c.getStats?.() ?? null,
      })),
      aggregate: { ...this.aggregate },
    };
  }
}

/**
 * 把旧版函数式 sink 包成 V2 接口 (向后兼容)
 */
export class FunctionAuditSink implements AuditSinkV2 {
  constructor(public readonly name: string, private fn: AuditSink) {}
  public invoke(ev: AuditEvent): void {
    try {
      this.fn(ev);
    } catch (err) {
      try {
        process.stdout.write(JSON.stringify({
          tag: FALLBACK_TAG, ...ev, _sink: this.name, _fallbackReason: (err as Error).message,
        }) + '\n');
      } catch { /* ignore */ }
    }
  }
  public getStats(): Record<string, any> {
    return { name: this.name };
  }
}

/**
 * 工厂: 从配置构造 composite sink
 *
 * config 格式:
 *   {
 *     sinks: [
 *       { type: 'stdout', mirror: true },
 *       { type: 'surreal', queryFn: ... },
 *       { type: 'file', path: '/var/log/soloforge-audit.jsonl' },
 *       { type: 'kafka', brokers: ['localhost:9092'], topic: 'soloforge.audit' },
 *     ]
 *   }
 */
export type SinkConfigEntry =
  | { type: 'stdout'; mirror?: boolean }
  | { type: 'file'; path: string; rotateBytes?: number }
  | { type: 'kafka'; brokers: string[]; topic: string; clientId?: string }
  | { type: 'surreal'; queryFn: (sql: string, bindings?: any) => Promise<any> }
  | { type: 'http'; url: string; headers?: Record<string, string> }
  | { type: 'noop' };

// 重导出 AuditSinkV2, 让调用方 (auditSinkFactory) 不必依赖 auth.ts
export type { AuditSinkV2 } from './auth';

/**
 * 占位工厂 (避免循环依赖, 真实实现在 auditSinkFactory.ts)
 * 这里仅定义入口, 实际注册在 lazy 加载的模块里。
 */
export async function buildSinkFromConfig(_entry: SinkConfigEntry): Promise<AuditSinkV2> {
  // 实际实现见 ./auditSinkFactory.ts
  const mod = await import('./auditSinkFactory');
  return mod.buildSinkFromConfig(_entry);
}
