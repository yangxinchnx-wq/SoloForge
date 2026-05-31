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
      traceId: (global as any).__CURRENT_TRACE_ID || undefined,
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