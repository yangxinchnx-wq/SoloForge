/**
 * auditSinkFactory.ts — 从配置构建 sink 树
 *
 * 解决循环依赖: auditSinkBase 引用了本文件, 本文件引用具体 sink
 */

import type { AuditSinkV2 } from './auditSinkBase';
import type { SinkConfigEntry } from './auditSinkBase';
import {
  StdoutAuditSink,
  FileAuditSink,
  HttpAuditSink,
  NoopAuditSink,
} from './auditSinkConcrete';

export async function buildSinkFromConfig(entry: SinkConfigEntry): Promise<AuditSinkV2> {
  switch (entry.type) {
    case 'stdout':
      return new StdoutAuditSink(entry.mirror ?? true);
    case 'file':
      return new FileAuditSink({ path: entry.path, rotateBytes: entry.rotateBytes });
    case 'http': {
      return new HttpAuditSink({ url: entry.url, headers: entry.headers });
    }
    case 'noop':
      return new NoopAuditSink();
    case 'kafka': {
      // kafkajs 是可选依赖, 动态 import 避免冷启动开销
      const mod = await import('./auditSinkKafka');
      return new mod.KafkaAuditSink({
        brokers: entry.brokers,
        topic: entry.topic,
        clientId: entry.clientId,
      });
    }
    case 'surreal': {
      // 包装: 这里返回 FunctionAuditSink 包一层, 真实用法是用 SurrealAuditSink (本期未实现)
      // 由调用方直接用 createAuditSinkFromSurreal()
      const { FunctionAuditSink } = await import('./auditSinkBase');
      const sink = new FunctionAuditSink('surreal', async () => { /* 写由调用方注入 */ });
      // 实际写入通过 queryFn 调用, 这里仅占位
      void entry;
      return sink;
    }
    default:
      throw new Error(`unknown sink type: ${(entry as any).type}`);
  }
}

export function buildCompositeFromConfig(entries: SinkConfigEntry[]): Promise<AuditSinkV2[]> {
  return Promise.all(entries.map(buildSinkFromConfig));
}
