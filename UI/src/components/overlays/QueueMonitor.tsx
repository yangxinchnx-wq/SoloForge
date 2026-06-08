// ─────────────────────────────────────────────────────────────────
// 消息队列监控 — QueueMonitor
// - Kafka/RabbitMQ/SQS/Pulsar 队列监控
// - 消费者组与 Lag 追踪
// - 死信队列
// - 吞吐与延迟
// - 消息追踪
// ─────────────────────────────────────────────────────────────────

import { useEffect, useMemo, useState } from 'react';
import { Tooltip, IconButton, Badge, Button } from '../ui/Button';

interface Props { open: boolean; onClose: () => void; }

type QueueType = 'kafka' | 'rabbitmq' | 'sqs' | 'pulsar' | 'redis_stream';

interface Queue {
  id: string;
  name: string;
  type: QueueType;
  topic: string;
  partitions: number;
  messages: number;
  messagesPerSec: number;
  bytesPerSec: number;
  lag: number;
  consumers: number;
  retention: string;
  dlq: number;
  status: 'healthy' | 'lagging' | 'stalled' | 'down';
}

interface ConsumerGroup {
  id: string;
  group: string;
  members: number;
  lag: number;
  rate: number;
  lastCommit: number;
  status: 'healthy' | 'lagging' | 'rebalancing' | 'dead';
}

const QUEUES: Queue[] = [
  { id: 'q1', name: 'orders.created',     type: 'kafka',     topic: 'orders-events',    partitions: 12, messages: 1245678, messagesPerSec: 1245, bytesPerSec: 524288,   lag: 12,     consumers: 4, retention: '7d',  dlq: 23,  status: 'healthy' },
  { id: 'q2', name: 'payments.completed', type: 'kafka',     topic: 'payments-events',  partitions: 6,  messages: 234567,  messagesPerSec: 234,  bytesPerSec: 102400,   lag: 5,      consumers: 2, retention: '30d', dlq: 0,   status: 'healthy' },
  { id: 'q3', name: 'email.send',         type: 'rabbitmq',  topic: 'email',            partitions: 1,  messages: 892,     messagesPerSec: 89,   bytesPerSec: 25600,    lag: 0,      consumers: 8, retention: '1d',  dlq: 145, status: 'healthy' },
  { id: 'q4', name: 'analytics.events',   type: 'kafka',     topic: 'analytics',        partitions: 24, messages: 5678901, messagesPerSec: 5678, bytesPerSec: 2097152, lag: 4521,  consumers: 6, retention: '3d',  dlq: 0,   status: 'lagging' },
  { id: 'q5', name: 'webhook.delivery',   type: 'sqs',       topic: 'webhook',          partitions: 1,  messages: 234,     messagesPerSec: 12,   bytesPerSec: 8192,     lag: 0,      consumers: 2, retention: '4d',  dlq: 89,  status: 'healthy' },
  { id: 'q6', name: 'image.resize',       type: 'rabbitmq',  topic: 'image-jobs',       partitions: 1,  messages: 2345,    messagesPerSec: 156,  bytesPerSec: 1024000,  lag: 234,    consumers: 12,retention: '1d',  dlq: 23,  status: 'lagging' },
  { id: 'q7', name: 'audit.log',          type: 'kafka',     topic: 'audit',            partitions: 3,  messages: 8923456, messagesPerSec: 8901, bytesPerSec: 4194304, lag: 0,      consumers: 3, retention: '90d', dlq: 0,   status: 'healthy' },
  { id: 'q8', name: 'ml.predictions',     type: 'pulsar',    topic: 'ml-inference',     partitions: 8,  messages: 23456,   messagesPerSec: 45,   bytesPerSec: 81920,    lag: 12,     consumers: 4, retention: '7d',  dlq: 7,   status: 'healthy' },
  { id: 'q9', name: 'stale-events',       type: 'redis_stream', topic: 'stale',          partitions: 1,  messages: 12,      messagesPerSec: 0,    bytesPerSec: 0,        lag: 0,      consumers: 0, retention: '24h',dlq: 0,   status: 'stalled' },
];

const CONSUMER_GROUPS: ConsumerGroup[] = [
  { id: 'c1', group: 'order-processor',    members: 4, lag: 12,    rate: 1245, lastCommit: Date.now() - 1000,   status: 'healthy' },
  { id: 'c2', group: 'payment-reconciler', members: 2, lag: 5,     rate: 234,  lastCommit: Date.now() - 500,   status: 'healthy' },
  { id: 'c3', group: 'email-sender',       members: 8, lag: 0,     rate: 89,   lastCommit: Date.now() - 200,   status: 'healthy' },
  { id: 'c4', group: 'analytics-aggregator',members: 6, lag: 4521, rate: 5678, lastCommit: Date.now() - 60000, status: 'lagging' },
  { id: 'c5', group: 'webhook-sender',     members: 2, lag: 0,     rate: 12,   lastCommit: Date.now() - 5000,  status: 'healthy' },
  { id: 'c6', group: 'image-resizer',      members: 12,lag: 234,   rate: 156,  lastCommit: Date.now() - 30000, status: 'lagging' },
  { id: 'c7', group: 'ml-predictor',       members: 4, lag: 12,    rate: 45,   lastCommit: Date.now() - 2000,  status: 'healthy' },
  { id: 'c8', group: 'stale-cleaner',      members: 0, lag: 0,     rate: 0,    lastCommit: Date.now() - 86400000, status: 'dead' },
];

function queueStatus(s: Queue['status']): 'success' | 'warning' | 'danger' | 'default' {
  return s === 'healthy' ? 'success' : s === 'lagging' ? 'warning' : s === 'stalled' ? 'warning' : 'danger';
}

function formatNum(n: number): string {
  if (n < 1000) return n.toString();
  if (n < 1000000) return `${(n / 1000).toFixed(1)}K`;
  if (n < 1000000000) return `${(n / 1000000).toFixed(2)}M`;
  return `${(n / 1000000000).toFixed(2)}B`;
}
function formatBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1048576) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1073741824) return `${(b / 1048576).toFixed(2)} MB`;
  return `${(b / 1073741824).toFixed(2)} GB`;
}

export function QueueMonitor({ open, onClose }: Props) {
  const [tab, setTab] = useState<'queues' | 'consumers' | 'dlq' | 'trace'>('queues');
  const [activeQueueId, setActiveQueueId] = useState<string>(QUEUES[0].id);
  const activeQueue = QUEUES.find(q => q.id === activeQueueId) || QUEUES[0];

  const totalMessages = QUEUES.reduce((s, q) => s + q.messages, 0);
  const totalThroughput = QUEUES.reduce((s, q) => s + q.messagesPerSec, 0);
  const totalLag = QUEUES.reduce((s, q) => s + q.lag, 0);
  const totalDlq = QUEUES.reduce((s, q) => s + q.dlq, 0);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center p-6" onClick={onClose}>
      <div className="bg-surface border border-border rounded-xl shadow-2xl w-[1280px] max-w-[95vw] h-[85vh] flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border bg-surface-high shrink-0">
          <span className="material-symbols-outlined text-accent">view_list</span>
          <h2 className="text-sm font-semibold text-text">消息队列监控</h2>
          <Badge variant="info">{QUEUES.length} 队列</Badge>
          <Badge variant="success">{totalThroughput.toLocaleString()} msg/s</Badge>
          {totalLag > 1000 && <Badge variant="warning">Lag {formatNum(totalLag)}</Badge>}
          {totalDlq > 0 && <Badge variant="danger">DLQ {totalDlq}</Badge>}
          <div className="ml-auto flex items-center gap-1">
            <Button size="sm" icon="refresh">刷新</Button>
            <Button size="sm" icon="pause">暂停消费</Button>
            <IconButton icon="close" onClick={onClose} />
          </div>
        </div>

        <div className="px-3 py-1 border-b border-border bg-bg flex items-center gap-1">
          {([
            { k: 'queues',    l: `队列 (${QUEUES.length})` },
            { k: 'consumers', l: `消费者组 (${CONSUMER_GROUPS.length})` },
            { k: 'dlq',       l: '死信队列' },
            { k: 'trace',     l: '消息追踪' },
          ] as const).map(t => (
            <button key={t.k} onClick={() => setTab(t.k)} className={'px-3 h-6 rounded text-[10px] ' + (tab === t.k ? 'bg-accent/15 text-accent' : 'text-text-secondary hover:bg-surface-high')}>{t.l}</button>
          ))}
        </div>

        <div className="flex-1 flex overflow-hidden">
          <div className="w-72 border-r border-border bg-bg overflow-y-auto">
            {tab === 'queues' && QUEUES.map(q => (
              <div key={q.id} onClick={() => setActiveQueueId(q.id)}
                className={'px-3 py-2 border-b border-border-light cursor-pointer hover:bg-surface-high ' + (activeQueueId === q.id ? 'bg-accent/10 border-l-2 border-l-accent' : '')}>
                <div className="flex items-center gap-1 mb-1">
                  <Badge variant={queueStatus(q.status)}>{q.status}</Badge>
                  <Badge variant="info">{q.type}</Badge>
                </div>
                <code className="text-[11px] font-mono text-text font-medium">{q.name}</code>
                <div className="text-[10px] text-text-secondary mt-0.5 flex items-center gap-2">
                  <span>{q.messagesPerSec} msg/s</span>
                  {q.lag > 0 && <span className="text-warning">lag {q.lag}</span>}
                  {q.dlq > 0 && <span className="text-danger">DLQ {q.dlq}</span>}
                </div>
              </div>
            ))}
            {tab === 'consumers' && CONSUMER_GROUPS.map(c => (
              <div key={c.id} className="px-3 py-2 border-b border-border-light">
                <div className="flex items-center gap-1 mb-1">
                  <Badge variant={c.status === 'healthy' ? 'success' : c.status === 'lagging' ? 'warning' : c.status === 'rebalancing' ? 'info' : 'danger'}>{c.status}</Badge>
                </div>
                <code className="text-[11px] font-mono text-text font-medium">{c.group}</code>
                <div className="text-[10px] text-text-secondary mt-0.5">{c.members} 成员 · {c.rate} msg/s</div>
              </div>
            ))}
          </div>

          <div className="flex-1 overflow-auto p-3 space-y-3">
            {tab === 'queues' && (
              <>
                <div className="grid grid-cols-4 gap-3">
                  <div className="bg-bg border border-border-light rounded-lg p-3">
                    <p className="text-[10px] text-text-secondary">总消息数</p>
                    <p className="text-2xl font-bold text-text font-mono mt-1">{formatNum(totalMessages)}</p>
                  </div>
                  <div className="bg-bg border border-border-light rounded-lg p-3">
                    <p className="text-[10px] text-text-secondary">总吞吐</p>
                    <p className="text-2xl font-bold text-text font-mono mt-1">{totalThroughput.toLocaleString()}</p>
                    <p className="text-[10px] text-text-secondary">msg/s</p>
                  </div>
                  <div className="bg-bg border border-border-light rounded-lg p-3">
                    <p className="text-[10px] text-text-secondary">总 Lag</p>
                    <p className={'text-2xl font-bold font-mono mt-1 ' + (totalLag > 1000 ? 'text-warning' : 'text-text')}>{formatNum(totalLag)}</p>
                  </div>
                  <div className="bg-bg border border-border-light rounded-lg p-3">
                    <p className="text-[10px] text-text-secondary">死信队列</p>
                    <p className={'text-2xl font-bold font-mono mt-1 ' + (totalDlq > 0 ? 'text-danger' : 'text-text')}>{totalDlq}</p>
                  </div>
                </div>

                <div className="bg-bg border border-border-light rounded-lg p-3">
                  <h3 className="text-xs font-semibold text-text mb-2">{activeQueue.name} ({activeQueue.type})</h3>
                  <div className="grid grid-cols-4 gap-3 text-[11px]">
                    <div>
                      <p className="text-[10px] text-text-secondary">分区</p>
                      <p className="text-text font-mono">{activeQueue.partitions}</p>
                    </div>
                    <div>
                      <p className="text-[10px] text-text-secondary">消息数</p>
                      <p className="text-text font-mono">{formatNum(activeQueue.messages)}</p>
                    </div>
                    <div>
                      <p className="text-[10px] text-text-secondary">吞吐</p>
                      <p className="text-text font-mono">{activeQueue.messagesPerSec} msg/s</p>
                    </div>
                    <div>
                      <p className="text-[10px] text-text-secondary">带宽</p>
                      <p className="text-text font-mono">{formatBytes(activeQueue.bytesPerSec)}/s</p>
                    </div>
                    <div>
                      <p className="text-[10px] text-text-secondary">消费者数</p>
                      <p className="text-text font-mono">{activeQueue.consumers}</p>
                    </div>
                    <div>
                      <p className="text-[10px] text-text-secondary">Lag</p>
                      <p className={'text-text font-mono ' + (activeQueue.lag > 100 ? 'text-warning' : '')}>{formatNum(activeQueue.lag)}</p>
                    </div>
                    <div>
                      <p className="text-[10px] text-text-secondary">保留期</p>
                      <p className="text-text font-mono">{activeQueue.retention}</p>
                    </div>
                    <div>
                      <p className="text-[10px] text-text-secondary">DLQ</p>
                      <p className={'text-text font-mono ' + (activeQueue.dlq > 0 ? 'text-danger' : '')}>{activeQueue.dlq}</p>
                    </div>
                  </div>
                </div>
              </>
            )}

            {tab === 'consumers' && (
              <div className="bg-bg border border-border-light rounded-lg p-3">
                <h3 className="text-xs font-semibold text-text mb-2">消费者组状态</h3>
                <table className="w-full text-[11px]">
                  <thead className="text-text-secondary border-b border-border-light">
                    <tr>
                      <th className="text-left py-1.5">组</th>
                      <th className="text-right py-1.5">成员</th>
                      <th className="text-right py-1.5">消费速率</th>
                      <th className="text-right py-1.5">Lag</th>
                      <th className="text-right py-1.5">最后提交</th>
                      <th className="text-right py-1.5">状态</th>
                    </tr>
                  </thead>
                  <tbody>
                    {CONSUMER_GROUPS.map(c => (
                      <tr key={c.id} className="border-b border-border-light">
                        <td className="py-1.5"><code className="text-text font-mono text-[10px]">{c.group}</code></td>
                        <td className="py-1.5 text-right text-text font-mono">{c.members}</td>
                        <td className="py-1.5 text-right text-text font-mono">{c.rate}/s</td>
                        <td className={'py-1.5 text-right font-mono ' + (c.lag > 100 ? 'text-warning' : 'text-text')}>{c.lag}</td>
                        <td className="py-1.5 text-right text-text-secondary font-mono">{Math.round((Date.now() - c.lastCommit) / 1000)}s ago</td>
                        <td className="py-1.5 text-right">
                          <Badge variant={c.status === 'healthy' ? 'success' : c.status === 'lagging' ? 'warning' : c.status === 'rebalancing' ? 'info' : 'danger'}>{c.status}</Badge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {tab === 'dlq' && (
              <div className="bg-bg border border-border-light rounded-lg p-3">
                <h3 className="text-xs font-semibold text-text mb-2">死信队列</h3>
                <p className="text-[10px] text-text-secondary mb-3">处理失败超过最大重试次数的消息</p>
                <div className="space-y-1.5">
                  {[
                    { src: 'email.send', count: 145, reason: 'SMTP 421 临时不可用',  lastSeen: Date.now() - 600000 },
                    { src: 'webhook.delivery', count: 89,  reason: 'HTTP 5xx 错误',       lastSeen: Date.now() - 1800000 },
                    { src: 'image.resize',    count: 23,  reason: 'OOM 内存不足',         lastSeen: Date.now() - 3600000 },
                    { src: 'ml.predictions',  count: 7,   reason: '模型推理超时',         lastSeen: Date.now() - 7200000 },
                    { src: 'orders.created',  count: 23,  reason: 'Schema 校验失败',     lastSeen: Date.now() - 86400000 },
                  ].map((d, i) => (
                    <div key={i} className="bg-surface-high rounded p-2 flex items-center gap-2">
                      <Badge variant="danger">DLQ</Badge>
                      <code className="text-[11px] font-mono text-text">{d.src}</code>
                      <Badge variant="warning">{d.count}</Badge>
                      <span className="text-[10px] text-text-secondary flex-1">{d.reason}</span>
                      <span className="text-[10px] text-text-secondary">{Math.round((Date.now() - d.lastSeen) / 1000)}s ago</span>
                      <Button size="sm" icon="replay">重试</Button>
                      <Button size="sm" icon="delete" variant="danger">删除</Button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {tab === 'trace' && (
              <div className="bg-bg border border-border-light rounded-lg p-3">
                <h3 className="text-xs font-semibold text-text mb-2">消息追踪 (Trace ID: msg-7f3a9b)</h3>
                <div className="space-y-1.5">
                  {[
                    { stage: 'produce',   queue: 'orders.created',     time: Date.now() - 5000,   meta: 'producer: web-api-1' },
                    { stage: 'consume',   queue: 'orders.created',     time: Date.now() - 4000,   meta: 'consumer: order-processor-2' },
                    { stage: 'produce',   queue: 'payments.completed', time: Date.now() - 3500,   meta: 'producer: order-processor-2' },
                    { stage: 'consume',   queue: 'payments.completed', time: Date.now() - 3000,   meta: 'consumer: payment-reconciler-1' },
                    { stage: 'produce',   queue: 'email.send',         time: Date.now() - 2500,   meta: 'producer: payment-reconciler-1' },
                    { stage: 'consume',   queue: 'email.send',         time: Date.now() - 2000,   meta: 'consumer: email-sender-3' },
                    { stage: 'success',   queue: 'email.send',         time: Date.now() - 1500,   meta: 'SMTP 250 OK, latency 1.5s' },
                  ].map((t, i) => (
                    <div key={i} className="flex items-center gap-2 p-2 bg-surface-high rounded">
                      <Badge variant={t.stage === 'success' ? 'success' : t.stage === 'produce' ? 'info' : 'default'}>{t.stage}</Badge>
                      <code className="text-[10px] font-mono text-text">{t.queue}</code>
                      <span className="text-[10px] text-text-secondary flex-1">{t.meta}</span>
                      <span className="text-[10px] text-text-secondary font-mono">+{Date.now() - t.time}ms</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
