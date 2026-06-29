/**
 * metrics.ts — 轻量级 metrics 注册表（Counter / Gauge / Histogram）
 *
 * 设计动机：
 *   - 不引入 prom-client 等重型库（npm proxy 受限）
 *   - 自实现最小子集，覆盖 SoloForge 核心可观测需求
 *   - 兼容 Prometheus text format 输出
 *
 * 用法：
 *   const counter = new Counter({ name: 'llm_stream_total', help: 'Total LLM stream requests' });
 *   counter.inc({ provider: 'openai' });
 *   const gauge = new Gauge({ name: 'llm_active_streams', help: 'Active streams' });
 *   gauge.set(3, { provider: 'openai' });
 *   const hist = new Histogram({ name: 'llm_latency_ms', help: 'Latency', buckets: [50, 100, 500, 1000, 5000] });
 *   hist.observe(230, { provider: 'openai' });
 *
 *   // 输出 Prometheus 文本：
 *   const exporter = new PrometheusExporter(registry);
 *   exporter.render();
 */

export type LabelValues = Record<string, string>;

export interface MetricMeta {
  name: string;
  help: string;
  labelNames?: string[];
}

/** 标签序列化为 key（保证顺序一致） */
function labelKey(labels: LabelValues, names: string[]): string {
  if (!names.length) return '';
  return names.map(n => `${n}=${labels[n] ?? ''}`).join('|');
}

function escapeLabelValue(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

function escapeHelp(h: string): string {
  return h.replace(/\\/g, '\\\\').replace(/\n/g, '\\n');
}

abstract class BaseMetric {
  /** 子类可直接访问的桶数据 */
  values: Map<string, number> = new Map();
  constructor(public meta: MetricMeta) {}

  protected getKey(labels: LabelValues): string {
    return labelKey(labels, this.meta.labelNames ?? []);
  }
}

export class Counter extends BaseMetric {
  inc(labels: LabelValues = {}, n: number = 1): void {
    if (n < 0) throw new Error('Counter.inc: n must be >= 0');
    const k = this.getKey(labels);
    this.values.set(k, (this.values.get(k) ?? 0) + n);
  }
  reset(): void { this.values.clear(); }
  get(labels: LabelValues = {}): number {
    return this.values.get(this.getKey(labels)) ?? 0;
  }
}

export class Gauge extends BaseMetric {
  set(value: number, labels: LabelValues = {}): void {
    this.values.set(this.getKey(labels), value);
  }
  inc(labels: LabelValues = {}, n: number = 1): void {
    const k = this.getKey(labels);
    this.values.set(k, (this.values.get(k) ?? 0) + n);
  }
  dec(labels: LabelValues = {}, n: number = 1): void {
    const k = this.getKey(labels);
    this.values.set(k, (this.values.get(k) ?? 0) - n);
  }
  reset(): void { this.values.clear(); }
  get(labels: LabelValues = {}): number {
    return this.values.get(this.getKey(labels)) ?? 0;
  }
}

export class Histogram extends BaseMetric {
  private bucketCounts: Map<string, number[]> = new Map();
  private counts: Map<string, number> = new Map();
  private sums: Map<string, number> = new Map();

  constructor(public meta: MetricMeta & { buckets: number[] }) {
    super(meta);
    if (!Array.isArray(meta.buckets) || meta.buckets.length === 0) {
      throw new Error('Histogram: buckets must be a non-empty array');
    }
  }

  observe(value: number, labels: LabelValues = {}): void {
    const k = this.getKey(labels);
    if (!this.bucketCounts.has(k)) {
      this.bucketCounts.set(k, new Array(this.meta.buckets.length).fill(0));
    }
    for (let i = 0; i < this.meta.buckets.length; i++) {
      if (value <= this.meta.buckets[i]) {
        (this.bucketCounts.get(k) as number[])[i]++;
      }
    }
    this.counts.set(k, (this.counts.get(k) ?? 0) + 1);
    this.sums.set(k, (this.sums.get(k) ?? 0) + value);
  }

  /** 获取分布（测试用） */
  snapshot(labels: LabelValues = {}): { buckets: { le: number; count: number }[]; count: number; sum: number } {
    const k = this.getKey(labels);
    const b = this.bucketCounts.get(k) ?? [];
    const total = this.counts.get(k) ?? 0;
    const bucketList = this.meta.buckets.map((le, i) => ({ le, count: b[i] ?? 0 }));
    // Prometheus 规范要求包含 +Inf 桶，值等于 _count
    bucketList.push({ le: Number.POSITIVE_INFINITY, count: total });
    return {
      buckets: bucketList,
      count: this.counts.get(k) ?? 0,
      sum: this.sums.get(k) ?? 0,
    };
  }

  reset(): void {
    this.bucketCounts.clear();
    this.counts.clear();
    this.sums.clear();
  }
}

// ============================================================
// Registry
// ============================================================

export class MetricsRegistry {
  private metrics: Map<string, BaseMetric> = new Map();

  register(m: BaseMetric): void {
    if (this.metrics.has(m.meta.name)) {
      throw new Error(`MetricsRegistry: metric ${m.meta.name} already registered`);
    }
    this.metrics.set(m.meta.name, m);
  }

  get(name: string): BaseMetric | undefined {
    return this.metrics.get(name);
  }

  list(): BaseMetric[] {
    return Array.from(this.metrics.values());
  }

  resetAll(): void {
    for (const m of this.metrics.values()) {
      if (m instanceof Counter) (m as Counter).reset();
      else if (m instanceof Gauge) (m as Gauge).reset();
      else if (m instanceof Histogram) {
        (m as Histogram).reset();
      }
    }
  }
}

// ============================================================
// Prometheus 文本导出
// ============================================================

export class PrometheusExporter {
  constructor(public registry: MetricsRegistry) {}

  render(): string {
    const lines: string[] = [];
    for (const m of this.registry.list()) {
      lines.push(`# HELP ${m.meta.name} ${escapeHelp(m.meta.help)}`);
      if (m instanceof Counter) lines.push(`# TYPE ${m.meta.name} counter`);
      else if (m instanceof Gauge) lines.push(`# TYPE ${m.meta.name} gauge`);
      else if (m instanceof Histogram) lines.push(`# TYPE ${m.meta.name} histogram`);

      if (m instanceof Histogram) {
        this.renderHistogram(m, lines);
      } else {
        this.renderSimple(m, lines);
      }
    }
    return lines.join('\n') + '\n';
  }

  private renderSimple(m: BaseMetric, lines: string[]): void {
    const labelNames = m.meta.labelNames ?? [];
    if (m.values.size === 0 && labelNames.length === 0) {
      lines.push(`${m.meta.name} 0`);
      return;
    }
    if (m.values.size === 0) return;
    for (const [key, value] of m.values) {
      if (labelNames.length === 0) {
        lines.push(`${m.meta.name} ${value}`);
      } else {
        const labelStr = key.split('|').map((kv, i) => `${labelNames[i]}="${escapeLabelValue(kv.split('=')[1] ?? '')}"`).join(',');
        lines.push(`${m.meta.name}{${labelStr}} ${value}`);
      }
    }
  }

  private renderHistogram(m: Histogram, lines: string[]): void {
    const labelNames = m.meta.labelNames ?? [];
    // 遍历所有出现过的 labels
    const seen = new Set<string>();
    for (const k of m['bucketCounts'].keys()) seen.add(k);
    for (const k of m['counts'].keys()) seen.add(k);
    for (const k of m['sums'].keys()) seen.add(k);

    if (seen.size === 0) {
      // 没有任何观测过也输出空 bucket
      for (let i = 0; i < m.meta.buckets.length; i++) {
        lines.push(`${m.meta.name}_bucket{le="${m.meta.buckets[i]}"} 0`);
      }
      lines.push(`${m.meta.name}_bucket{le="+Inf"} 0`);
      lines.push(`${m.meta.name}_count 0`);
      lines.push(`${m.meta.name}_sum 0`);
      return;
    }

    for (const k of seen) {
      const baseLabels = labelNames.length === 0 ? '' : k.split('|').map((kv, i) => `${labelNames[i]}="${escapeLabelValue(kv.split('=')[1] ?? '')}"`).join(',');
      const labelPrefix = baseLabels ? `${baseLabels},` : '';
      const b = m['bucketCounts'].get(k) ?? [];
      let cumulative = 0;
      for (let i = 0; i < m.meta.buckets.length; i++) {
        cumulative = b[i] ?? 0;
        lines.push(`${m.meta.name}_bucket{${labelPrefix}le="${m.meta.buckets[i]}"} ${cumulative}`);
      }
      const total = m['counts'].get(k) ?? 0;
      lines.push(`${m.meta.name}_bucket{${labelPrefix}le="+Inf"} ${total}`);
      lines.push(`${m.meta.name}_count${baseLabels ? `{${baseLabels}}` : ''} ${total}`);
      lines.push(`${m.meta.name}_sum${baseLabels ? `{${baseLabels}}` : ''} ${m['sums'].get(k) ?? 0}`);
    }
  }
}

// ============================================================
// 全局默认注册表 + 预置 metrics
// ============================================================

export const defaultRegistry = new MetricsRegistry();

export const llmStreamTotal = new Counter({
  name: 'soloforge_llm_stream_total',
  help: 'Total LLM stream requests',
  labelNames: ['provider', 'result'],
});
defaultRegistry.register(llmStreamTotal);

export const llmStreamLatency = new Histogram({
  name: 'soloforge_llm_stream_duration_ms',
  help: 'LLM stream duration in milliseconds',
  labelNames: ['provider', 'result'],
  buckets: [100, 500, 1000, 2000, 5000, 10_000, 30_000, 60_000],
});
defaultRegistry.register(llmStreamLatency);

export const llmActiveStreams = new Gauge({
  name: 'soloforge_llm_active_streams',
  help: 'Currently active LLM streams',
  labelNames: ['provider'],
});
defaultRegistry.register(llmActiveStreams);

export const llmStreamChunks = new Counter({
  name: 'soloforge_llm_stream_chunks_total',
  help: 'Total SSE chunks forwarded through the proxy',
  labelNames: ['provider'],
});
defaultRegistry.register(llmStreamChunks);

export const llmStreamChars = new Counter({
  name: 'soloforge_llm_stream_chars_total',
  help: 'Total characters streamed through the proxy',
  labelNames: ['provider'],
});
defaultRegistry.register(llmStreamChars);

export const httpRequests = new Counter({
  name: 'soloforge_http_requests_total',
  help: 'Total HTTP requests handled',
  labelNames: ['method', 'path', 'status'],
});
defaultRegistry.register(httpRequests);

export const httpRequestLatency = new Histogram({
  name: 'soloforge_http_request_duration_ms',
  help: 'HTTP request duration in milliseconds',
  labelNames: ['method', 'path'],
  buckets: [1, 5, 10, 50, 100, 500, 1000, 5000],
});
defaultRegistry.register(httpRequestLatency);
