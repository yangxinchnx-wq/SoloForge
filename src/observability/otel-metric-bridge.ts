// ─────────────────────────────────────────────────────────────────
// SoloForge Observability: OTel Metric Bridge
// Path: src/observability/otel-metric-bridge.ts
//
// Phase 3: 将 OTel MeterProvider 的指标桥接到现有 Prometheus 端点
// 统一 MetricsRegistry + TelemetryMetricExporter + OTel Meter → 一个 /metrics 输出
//
// 设计原则:
//   - 现有 MetricsRegistry 和 TelemetryMetricExporter 不变
//   - OTel metrics 作为增量补充
//   - /metrics 端点合并三套数据源，统一输出 Prometheus text format
// ─────────────────────────────────────────────────────────────────

import { defaultRegistry, PrometheusExporter } from './metrics';
import type { TelemetryMetricExporter } from '../kernel/observability/telemetry-exporter';

let otelMeter: unknown = null;
let otelMetrics: Map<string, { type: 'counter' | 'gauge' | 'histogram'; instrument: unknown }> = new Map();
let telemetryExporter: TelemetryMetricExporter | null = null;
let initialized = false;

/**
 * 初始化 OTel Metric Bridge
 * @param exporter TelemetryMetricExporter 实例（来自 kernel）
 */
export async function initMetricBridge(exporter?: TelemetryMetricExporter): Promise<void> {
  // 允许后续注入 exporter（bootstrap 完成后补设）
  if (exporter) {
    telemetryExporter = exporter;
  }

  if (initialized) return;

  try {
    const { metrics } = await import('@opentelemetry/api');
    otelMeter = metrics.getMeter('soloforge-bridge', '1.0.0');
    initialized = true;
    console.log('[otel-metric-bridge] OTel Meter bridge initialized');
  } catch {
    console.log('[otel-metric-bridge] @opentelemetry/api not available, skipping metric bridge');
  }
}

/**
 * 创建或获取一个 OTel Counter
 */
export function getOtelCounter(name: string, description: string): {
  add: (value: number, attributes?: Record<string, string>) => void;
} | null {
  if (!otelMeter) return null;

  try {
    const meter = otelMeter as {
      createCounter: (name: string, opts: { description: string }) => {
        add: (value: number, attrs?: Record<string, string>) => void;
      };
    };

    let entry = otelMetrics.get(name);
    if (!entry) {
      const instrument = meter.createCounter(name, { description });
      entry = { type: 'counter', instrument };
      otelMetrics.set(name, entry);
    }
    return entry.instrument as { add: (value: number, attrs?: Record<string, string>) => void };
  } catch {
    return null;
  }
}

/**
 * 创建或获取一个 OTel Observable Gauge
 * (Observable Gauge 通过 callback 定期采集，适合对接现有 Gauge)
 */
export function createOtelObservableGauge(
  name: string,
  description: string,
  callback: () => number,
  attributes?: Record<string, string>,
): void {
  if (!otelMeter) return;

  try {
    const meter = otelMeter as {
      createObservableGauge: (
        name: string,
        opts: { description: string },
        cb: () => number,
      ) => void;
    };

    // OTel observable gauge — callback invoked on collection cycle
    meter.createObservableGauge(name, { description }, callback);
  } catch {
    // Silently skip
  }
}

/**
 * 创建或获取一个 OTel Histogram
 */
export function getOtelHistogram(name: string, description: string): {
  record: (value: number, attributes?: Record<string, string>) => void;
} | null {
  if (!otelMeter) return null;

  try {
    const meter = otelMeter as {
      createHistogram: (name: string, opts: { description: string }) => {
        record: (value: number, attrs?: Record<string, string>) => void;
      };
    };

    let entry = otelMetrics.get(name);
    if (!entry) {
      const instrument = meter.createHistogram(name, { description });
      entry = { type: 'histogram', instrument };
      otelMetrics.set(name, entry);
    }
    return entry.instrument as { record: (value: number, attrs?: Record<string, string>) => void };
  } catch {
    return null;
  }
}

/**
 * 生成合并的 Prometheus 文本格式
 *
 * 数据源:
 *   1. defaultRegistry (metrics.ts 中的 LLM / HTTP 指标)
 *   2. TelemetryMetricExporter (内核级治理/社会/共识指标)
 *   3. OTel Meter (可选，OTel 桥接指标 — 当前为增量补充)
 */
export function renderMergedPrometheusText(kernelUptime: number, eventCount: number, kernelVersion: number): string {
  const sections: string[] = [];

  // ── Section 1: 基础系统指标 ──
  sections.push(`# HELP soloforge_uptime_seconds Uptime in seconds
# TYPE soloforge_uptime_seconds gauge
soloforge_uptime_seconds ${(kernelUptime / 1000).toFixed(0)}

# HELP soloforge_events_total Total events processed
# TYPE soloforge_events_total counter
soloforge_events_total ${eventCount}

# HELP soloforge_kernel_version Kernel version
# TYPE soloforge_kernel_version gauge
soloforge_kernel_version ${kernelVersion || 1}
`);

  // ── Section 2: 自研 MetricsRegistry (LLM / HTTP 指标) ──
  try {
    const promExporter = new PrometheusExporter(defaultRegistry);
    const registryText = promExporter.render();
    if (registryText.trim()) {
      sections.push(registryText);
    }
  } catch {
    // MetricsRegistry not available
  }

  // ── Section 3: 内核级 TelemetryMetricExporter (治理/社会/共识指标) ──
  if (telemetryExporter) {
    try {
      const kernelText = telemetryExporter.compileStandardPrometheusTextBuffer();
      if (kernelText.trim()) {
        sections.push(kernelText);
      }
    } catch {
      // TelemetryExporter error
    }
  }

  return sections.join('\n');
}

/**
 * 检查 Metric Bridge 是否已初始化
 */
export function isMetricBridgeReady(): boolean {
  return initialized;
}
