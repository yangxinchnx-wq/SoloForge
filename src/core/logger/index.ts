// ─────────────────────────────────────────────────────────────────
// SoloForge Core Layer: Unified Production-Grade Logger
// Path: src/core/logger/index.ts
// ─────────────────────────────────────────────────────────────────

export enum LogLevel {
  ERROR = 'ERROR',
  WARN = 'WARN',
  INFO = 'INFO',
  DEBUG = 'DEBUG',
  TRACE = 'TRACE'
}

interface LogMeta {
  [key: string]: any;
}

/** OTel trace context cache — 同步快速路径，避免每条日志都 await */
let _otelTraceId: string | undefined = undefined;
let _otelSpanId: string | undefined = undefined;
let _otelCtxChecked = false;

/**
 * 刷新 OTel trace context（在 otel-init.ts 启动后调用，之后每条日志自动携带）
 * 使用同步缓存 + 异步更新策略：
 *   - formatLog 走同步路径，直接读 _otelTraceId/_otelSpanId
 *   - withSpan 中的 OTel SDK 会通过 context.active() 更新这些值
 */
export function refreshOtelTraceContext(traceId?: string, spanId?: string): void {
  _otelTraceId = traceId;
  _otelSpanId = spanId;
  _otelCtxChecked = true;
}

/** 异步拉取一次 OTel context（用于非 withSpan 路径的日志） */
export async function syncOtelTraceContext(): Promise<void> {
  if (_otelCtxChecked) return; // 只拉取一次
  try {
    const { trace, context } = await import('@opentelemetry/api');
    const span = trace.getSpan(context.active());
    if (span) {
      const ctx = span.spanContext();
      refreshOtelTraceContext(ctx.traceId, ctx.spanId);
    } else {
      _otelCtxChecked = true;
    }
  } catch {
    _otelCtxChecked = true;
  }
}

class SoloForgeLogger {
  private minLevel: LogLevel = LogLevel.INFO;
  private levelOrder = {
    [LogLevel.TRACE]: 0,
    [LogLevel.DEBUG]: 1,
    [LogLevel.INFO]: 2,
    [LogLevel.WARN]: 3,
    [LogLevel.ERROR]: 4
  };

  public setMinLevel(level: LogLevel) { this.minLevel = level; }

  private shouldLog(level: LogLevel): boolean {
    return this.levelOrder[level] >= this.levelOrder[this.minLevel];
  }

  private formatLog(level: LogLevel, module: string, message: string, meta?: LogMeta) {
    // 🛡️ 极限硬化：如果传入的 meta 属于 Error 实体，强制提取其核心堆栈，彻底破除 "{}" 软吞噬黑洞
    let cleanMeta = meta;
    if (meta instanceof Error) {
      cleanMeta = { 
        errorMessage: meta.message, 
        errorStack: meta.stack,
        errorCode: (meta as any).code 
      };
    }

    const entry = {
      timestamp: new Date().toISOString(),
      level,
      module,
      message,
      // Phase 2: 优先使用 OTel context 注入的 traceId/spanId
      traceId: _otelTraceId || (global as any).__CURRENT_TRACE_ID || undefined,
      spanId: _otelSpanId || undefined,
      ...cleanMeta
    };

    const consoleStr = `[${level}] [${module}] ${message}`;
    // 规整控制台输出尾部载荷
    const metaStr = cleanMeta ? ` ${JSON.stringify(cleanMeta)}` : '';

    if (level === LogLevel.ERROR || level === LogLevel.WARN) {
      console.error(consoleStr + metaStr);
    } else {
      console.log(consoleStr + metaStr);
    }

    // Phase 2: 异步转发到 OTel Logs Pipeline（不阻塞主路径）
    if (_otelCtxChecked) {
      import('../../observability/otel-logger-bridge')
        .then(bridge => bridge.forwardLogToOtel(entry, level))
        .catch(() => { /* silent */ });
    }

    return entry;
  }

  public log(level: LogLevel, module: string, message: string, meta?: LogMeta) {
    if (!this.shouldLog(level)) return;
    return this.formatLog(level, module, message, meta);
  }

  public error(module: string, message: string, meta?: LogMeta) { return this.log(LogLevel.ERROR, module, message, meta); }
  public critical(module: string, message: string, meta?: LogMeta) { return this.log(LogLevel.ERROR, module, `[CRITICAL] ${message}`, meta); }
  public warn(module: string, message: string, meta?: LogMeta) { return this.log(LogLevel.WARN, module, message, meta); }
  public info(module: string, message: string, meta?: LogMeta) { return this.log(LogLevel.INFO, module, message, meta); }
  public debug(module: string, message: string, meta?: LogMeta) { return this.log(LogLevel.DEBUG, module, message, meta); }
  public trace(module: string, message: string, meta?: LogMeta) { return this.log(LogLevel.TRACE, module, message, meta); }
}

export const logger = new SoloForgeLogger();