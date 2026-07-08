// ─────────────────────────────────────────────────────────────────
// SoloForge Observability Layer: OpenTelemetry SDK Bootstrap
// Path: src/observability/otel-init.ts
// Description: 初始化 OpenTelemetry SDK，配置 Traces/Metrics/Logs 三支柱
//              与现有 TelemetryMetricExporter 兼容，纯增量添加
//
// 使用动态 import：如果 @opentelemetry 包未安装，graceful skip
// ─────────────────────────────────────────────────────────────────

let initialized = false;

/**
 * 初始化 OpenTelemetry SDK（动态导入，依赖未安装时 graceful skip）
 *
 * 环境变量:
 * - OTEL_SERVICE_NAME: 服务名称（默认 soloforge）
 * - OTEL_EXPORTER_OTLP_ENDPOINT: OTLP 端点（设置后自动切换为 OTLP 导出）
 * - OTEL_TRACES_EXPORTER: traces 导出器类型（console | otlp，默认 console）
 * - OTEL_LOGS_EXPORTER: logs 导出器类型（console | otlp | none，默认 console）
 * - OTEL_METRICS_EXPORTER: metrics 导出器类型（none | console，默认 none）
 */
export async function initOpenTelemetry(): Promise<void> {
  if (initialized) return;

  try {
    // Dynamic import: skip gracefully if packages not installed
    const { NodeSDK } = await import('@opentelemetry/sdk-node');
    const { Resource } = await import('@opentelemetry/resources');
    const otelApi = await import('@opentelemetry/api');

    const serviceName = process.env.OTEL_SERVICE_NAME || 'soloforge';
    const serviceVersion = process.env.OTEL_SERVICE_VERSION || '1.0.0';
    const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    const tracesExporterType = process.env.OTEL_TRACES_EXPORTER || 'console';
    const logsExporterType = process.env.OTEL_LOGS_EXPORTER || 'console';

    const resource = new Resource({
      'service.name': serviceName,
      'service.version': serviceVersion,
      'deployment.environment': process.env.NODE_ENV || 'development',
    });

    // Traces exporter
    let traceExporter;
    if (tracesExporterType === 'otlp' && otlpEndpoint) {
      const { OTLPTraceExporter } = await import('@opentelemetry/exporter-trace-otlp-http');
      traceExporter = new OTLPTraceExporter({ url: `${otlpEndpoint}/v1/traces` });
      console.log(`[otel-init] Traces: OTLP -> ${otlpEndpoint}/v1/traces`);
    } else {
      const { ConsoleSpanExporter } = await import('@opentelemetry/sdk-trace-node');
      traceExporter = new ConsoleSpanExporter();
      console.log('[otel-init] Traces: Console (stdout)');
    }

    // Logs exporter
    let logRecordExporter;
    if (logsExporterType === 'none') {
      logRecordExporter = undefined;
    } else if (logsExporterType === 'otlp' && otlpEndpoint) {
      const { OTLPLogExporter } = await import('@opentelemetry/exporter-logs-otlp-http');
      logRecordExporter = new OTLPLogExporter({ url: `${otlpEndpoint}/v1/logs` });
      console.log(`[otel-init] Logs: OTLP -> ${otlpEndpoint}/v1/logs`);
    } else {
      const { ConsoleLogRecordExporter } = await import('@opentelemetry/sdk-logs');
      logRecordExporter = new ConsoleLogRecordExporter();
      console.log('[otel-init] Logs: Console (stdout)');
    }

    // Build SDK config
    const sdkConfig: any = {
      resource,
      spanProcessors: undefined, // will be set below
    };

    // Span processor
    const { SimpleSpanProcessor } = await import('@opentelemetry/sdk-trace-node');
    sdkConfig.spanProcessors = [new SimpleSpanProcessor(traceExporter)];

    // Log processor
    if (logRecordExporter) {
      sdkConfig.logRecordProcessor = logRecordExporter;
    }

    const sdk = new NodeSDK(sdkConfig);
    sdk.start();
    initialized = true;
    console.log(`[otel-init] OpenTelemetry SDK started (service=${serviceName}, version=${serviceVersion})`);

    // Graceful shutdown
    process.on('SIGTERM', () => {
      sdk.shutdown().then(() => console.log('[otel-init] SDK shut down')).catch(console.error);
    });

  } catch (err: any) {
    // Packages not installed or initialization failed — skip silently
    if (err.code === 'ERR_MODULE_NOT_FOUND' || err.message?.includes('Cannot find module')) {
      console.log('[otel-init] OpenTelemetry packages not installed, skipping. Install with: npm install @opentelemetry/sdk-node @opentelemetry/api');
    } else {
      console.warn('[otel-init] OpenTelemetry initialization failed:', err.message);
    }
  }
}
