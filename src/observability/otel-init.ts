// ─────────────────────────────────────────────────────────────────
// SoloForge Observability Layer: OpenTelemetry SDK Bootstrap
// Path: src/observability/otel-init.ts
// Description: 初始化 OpenTelemetry SDK，配置 Traces/Metrics/Logs 三支柱
//              与现有 TelemetryMetricExporter 兼容，纯增量添加
//
// Phase 1 (✅): 初始化 SDK + Console exporter
// Phase 2 (✅): Logger bridge — 自动注入 traceId/spanId + 转发日志
// Phase 3 (✅): Metric bridge — 合并 Prometheus 输出
// Phase 4 (✅): OTLP exporter + 采样策略 + 关键操作 Span 埋点
//
// 环境变量:
// - OTEL_SERVICE_NAME: 服务名称（默认 soloforge）
// - OTEL_EXPORTER_OTLP_ENDPOINT: OTLP 端点（设置后自动切换为 OTLP 导出）
// - OTEL_TRACES_EXPORTER: traces 导出器类型（console | otlp，默认 console）
// - OTEL_LOGS_EXPORTER: logs 导出器类型（console | otlp | none，默认 console）
// - OTEL_METRICS_EXPORTER: metrics 导出器类型（none | console，默认 none）
// - OTEL_TRACES_SAMPLER: 采样器类型（always_on | parentbased_always_on | traceidratio, 默认 parentbased_always_on）
// - OTEL_TRACES_SAMPLER_ARG: 采样率参数（0-1，默认 1.0 = 100%，生产建议 0.1）
// ─────────────────────────────────────────────────────────────────

let initialized = false;
let sdkInstance: { shutdown: () => Promise<void> } | null = null;

/**
 * 初始化 OpenTelemetry SDK
 *
 * Phase 1-4 完整实现：
 *   1. Traces — ConsoleSpanExporter 或 OTLPTraceExporter + 采样策略
 *   2. Logs — ConsoleLogRecordExporter 或 OTLPLogExporter + LoggerBridge
 *   3. Metrics — 复用现有 Prometheus 端点，通过 MetricBridge 统一输出
 *   4. 生产化 — 支持 OTLP 导出 + 可配置采样率
 *
 * @param telemetryExporter 可选：传入 TelemetryMetricExporter 供 MetricBridge 使用
 */
export async function initOpenTelemetry(
  telemetryExporter?: unknown,
): Promise<void> {
  if (initialized) return;

  try {
    const { NodeSDK } = await import('@opentelemetry/sdk-node');
    const { Resource } = await import('@opentelemetry/resources');
    const { SEMATTRS_SERVICE_NAME, SEMATTRS_SERVICE_VERSION } =
      await import('@opentelemetry/semantic-conventions');

    const serviceName = process.env.OTEL_SERVICE_NAME || 'soloforge';
    const serviceVersion = process.env.OTEL_SERVICE_VERSION || '1.0.0';
    const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    const tracesExporterType = process.env.OTEL_TRACES_EXPORTER || 'console';
    const logsExporterType = process.env.OTEL_LOGS_EXPORTER || 'console';
    const metricsExporterType = process.env.OTEL_METRICS_EXPORTER || 'none';

    // ── Phase 4: 采样策略 ──
    const samplerType = process.env.OTEL_TRACES_SAMPLER || 'parentbased_always_on';
    const samplerArg = parseFloat(process.env.OTEL_TRACES_SAMPLER_ARG || '1.0');

    const resource = new Resource({
      [SEMATTRS_SERVICE_NAME]: serviceName,
      [SEMATTRS_SERVICE_VERSION]: serviceVersion,
      'deployment.environment': process.env.NODE_ENV || 'development',
    });

    // ── Traces exporter ──
    let traceExporter: unknown;
    if (tracesExporterType === 'otlp' && otlpEndpoint) {
      const { OTLPTraceExporter } = await import('@opentelemetry/exporter-trace-otlp-http');
      traceExporter = new OTLPTraceExporter({ url: `${otlpEndpoint}/v1/traces` });
      console.log(`[otel-init] Traces: OTLP -> ${otlpEndpoint}/v1/traces (sampling=${samplerType} ${samplerArg})`);
    } else {
      const { ConsoleSpanExporter } = await import('@opentelemetry/sdk-trace-node');
      traceExporter = new ConsoleSpanExporter();
      console.log(`[otel-init] Traces: Console (stdout, sampling=${samplerType} ${samplerArg})`);
    }

    // ── Logs exporter ──
    let logRecordExporter: unknown = undefined;
    if (logsExporterType === 'none') {
      // No log exporter
    } else if (logsExporterType === 'otlp' && otlpEndpoint) {
      const { OTLPLogExporter } = await import('@opentelemetry/exporter-logs-otlp-http');
      logRecordExporter = new OTLPLogExporter({ url: `${otlpEndpoint}/v1/logs` });
      console.log(`[otel-init] Logs: OTLP -> ${otlpEndpoint}/v1/logs`);
    } else {
      const { ConsoleLogRecordExporter } = await import('@opentelemetry/sdk-logs');
      logRecordExporter = new ConsoleLogRecordExporter();
      console.log('[otel-init] Logs: Console (stdout)');
    }

    // ── Span processor ──
    const { SimpleSpanProcessor } = await import('@opentelemetry/sdk-trace-node');
    const spanProcessors = [new SimpleSpanProcessor(traceExporter as ConstructorParameters<typeof SimpleSpanProcessor>[0])];

    // ── Phase 4: 采样器配置 ──
    // @opentelemetry/api 已在 tracing.ts 中通过 getTracer() 初始化
    // 此处 import 仅用于触发 API 注册
    await import('@opentelemetry/api');

    // 构建采样器 — 根据 OTEL_TRACES_SAMPLER 环境变量选择
    let samplerConfig: Record<string, unknown> | undefined;
    try {
      const { AlwaysOnSampler, ParentBasedSampler, TraceIdRatioBasedSampler } =
        await import('@opentelemetry/sdk-trace-base');

      if (samplerType === 'always_on') {
        samplerConfig = { sampler: new AlwaysOnSampler() };
      } else if (samplerType === 'traceidratio') {
        samplerConfig = { sampler: new TraceIdRatioBasedSampler(samplerArg) };
      } else {
        // parentbased_always_on (default) — 子 span 跟随父 span 决策
        samplerConfig = { sampler: new ParentBasedSampler({ rootSampler: new AlwaysOnSampler() }) };
        // 如果配置了采样率，使用 ratio 作为 root sampler
        if (samplerArg < 1.0) {
          samplerConfig = { sampler: new ParentBasedSampler({ rootSampler: new TraceIdRatioBasedSampler(samplerArg) }) };
        }
      }
    } catch {
      // Fallback: 使用 SDK 默认采样器
    }

    // ── Build SDK config ──
    const sdkConfig: Record<string, unknown> = {
      resource,
      spanProcessors,
      ...(samplerConfig || {}),
    };

    // ── Log processor ──
    if (logRecordExporter) {
      // NodeSDK accepts logRecordProcessor or logRecordProcessors
      sdkConfig.logRecordProcessor = logRecordExporter;
    }

    // ── Metrics (Phase 3: 复用现有 Prometheus, 不在 OTel SDK 中配置) ──
    // OTel metrics 通过 OTelMetricBridge 桥接到现有 9090 端点
    if (metricsExporterType !== 'none') {
      console.log(`[otel-init] Metrics: bridged to existing Prometheus endpoint (mode=${metricsExporterType})`);
    }

    const sdk = new NodeSDK(sdkConfig as ConstructorParameters<typeof NodeSDK>[0]);
    sdk.start();
    sdkInstance = sdk;
    initialized = true;
    console.log(`[otel-init] OpenTelemetry SDK started (service=${serviceName}, version=${serviceVersion})`);

    // ── Phase 2: 初始化 Logger Bridge ──
    try {
      const { initLoggerBridge } = await import('./otel-logger-bridge');
      await initLoggerBridge();
    } catch {
      // Logger bridge is optional
    }

    // ── Phase 2: 初始化 trace context 同步 ──
    try {
      const { syncOtelTraceContext } = await import('../core/logger');
      await syncOtelTraceContext();
    } catch {
      // Logger sync is optional
    }

    // ── Phase 3: 初始化 Metric Bridge ──
    try {
      const { initMetricBridge } = await import('./otel-metric-bridge');
      await initMetricBridge(telemetryExporter as never);
    } catch {
      // Metric bridge is optional
    }

    // ── Graceful shutdown ──
    process.on('SIGTERM', () => {
      sdk.shutdown().then(() => console.log('[otel-init] SDK shut down')).catch(console.error);
    });

  } catch (err: unknown) {
    const error = err as { code?: string; message?: string };
    // Packages not installed or initialization failed — skip silently
    if (error?.code === 'ERR_MODULE_NOT_FOUND' || error?.message?.includes('Cannot find module')) {
      console.log('[otel-init] OpenTelemetry packages not installed, skipping. Install with: npm install @opentelemetry/sdk-node @opentelemetry/api');
    } else {
      const msg = error?.message || String(err);
      console.warn('[otel-init] OpenTelemetry initialization failed:', msg);
    }
  }
}

/**
 * 检查 OTel SDK 是否已初始化
 */
export function isOtelInitialized(): boolean {
  return initialized;
}

/**
 * 获取 SDK 实例（用于测试）
 */
export function getSdkInstance(): { shutdown: () => Promise<void> } | null {
  return sdkInstance;
}
