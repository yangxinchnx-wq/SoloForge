// ─────────────────────────────────────────────────────────────────
// SoloForge Observability: OTel Logger Bridge
// Path: src/observability/otel-logger-bridge.ts
//
// Phase 2: 将 SoloForgeLogger 的日志同时发送到 OTel Logs Pipeline
// 自动注入 traceId / spanId，实现日志-追踪关联
//
// 使用动态 import：如果 @opentelemetry 包未安装，graceful skip
// ─────────────────────────────────────────────────────────────────

import type { LogLevel } from '../core/logger';

interface OtelLogEntry {
  timestamp: string;
  level: string;
  module: string;
  message: string;
  traceId?: string;
  spanId?: string;
  [key: string]: unknown;
}

let otelLogger: unknown = null;
let initialized = false;

/**
 * 初始化 OTel Logger Bridge
 * 在 otel-init.ts 中调用，确保 OTel SDK 已启动
 */
export async function initLoggerBridge(): Promise<void> {
  if (initialized) return;

  try {
    const { logs } = await import('@opentelemetry/api-logs');
    otelLogger = logs.getLogger('soloforge-logger');
    initialized = true;
    console.log('[otel-logger-bridge] OTel Logger bridge initialized');
  } catch {
    // @opentelemetry/api-logs not installed — skip gracefully
    console.log('[otel-logger-bridge] @opentelemetry/api-logs not installed, skipping logger bridge');
  }
}

/**
 * 获取当前活跃 span 的 traceId 和 spanId
 * 优先从 OTel context 获取，回退到全局 __CURRENT_TRACE_ID
 */
export async function getActiveTraceContext(): Promise<{ traceId?: string; spanId?: string }> {
  try {
    const { trace, context } = await import('@opentelemetry/api');
    const span = trace.getSpan(context.active());
    if (span) {
      const spanCtx = span.spanContext();
      return {
        traceId: spanCtx.traceId,
        spanId: spanCtx.spanId,
      };
    }
  } catch {
    // OTel API not available
  }

  // Fallback: global trace ID (legacy)
  const globalTraceId = (global as Record<string, unknown>).__CURRENT_TRACE_ID as string | undefined;
  if (globalTraceId) {
    return { traceId: globalTraceId };
  }

  return {};
}

/**
 * 将 SoloForgeLogger 的日志条目转发到 OTel Logs Pipeline
 *
 * @param entry 日志条目（由 SoloForgeLogger.formatLog 返回）
 * @param level 日志级别
 */
export async function forwardLogToOtel(entry: OtelLogEntry, level: LogLevel): Promise<void> {
  if (!initialized || !otelLogger) return;

  try {
    const { SeverityNumber, type } = await import('@opentelemetry/api-logs');

    // 映射 SoloForge 日志级别到 OTel SeverityNumber
    const severityMap: Record<string, number> = {
      [LogLevel.ERROR]: SeverityNumber.ERROR,
      [LogLevel.WARN]: SeverityNumber.WARN,
      [LogLevel.INFO]: SeverityNumber.INFO,
      [LogLevel.DEBUG]: SeverityNumber.DEBUG,
      [LogLevel.TRACE]: SeverityNumber.TRACE,
    };

    const severity = severityMap[level] ?? SeverityNumber.INFO;

    // 调用 logger.emit() 转发日志
    const logger = otelLogger as {
      emit: (record: Record<string, unknown>) => void;
    };

    logger.emit({
      severityNumber: severity,
      severityText: level,
      body: entry.message,
      attributes: {
        'soloforge.module': entry.module,
        'soloforge.level': level,
        'trace.id': entry.traceId ?? '',
        'span.id': entry.spanId ?? '',
      },
      timestamp: new Date(entry.timestamp).getTime(),
    });
  } catch {
    // Silently ignore — log forwarding must not break the main path
  }
}

/**
 * 检查 Logger Bridge 是否已初始化
 */
export function isLoggerBridgeReady(): boolean {
  return initialized;
}
