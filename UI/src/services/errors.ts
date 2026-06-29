/**
 * errors.ts — 集中错误处理（backend-patterns: Centralized Error Handler）
 *
 * 设计动机：
 *   - 业务代码到处 try/catch 会变成噪音
 *   - 统一错误类 + 统一 handler → 调用方只需要 throw / catch 一次
 *
 * 用法：
 *   throw new ApiError(401, 'Unauthorized');
 *   throw new StreamError('parse-failed', { raw: '...' });
 *
 *   try {
 *     ...
 *   } catch (e) {
 *     handleError(e, { context: 'useUniversalPreview.send' });
 *   }
 */

export type ErrorSeverity = 'info' | 'warn' | 'error' | 'fatal';

export interface ErrorContext {
  /** 错误来源（函数名 / 模块名） */
  context?: string;
  /** 额外元数据 */
  metadata?: Record<string, unknown>;
}

export class ApiError extends Error {
  readonly statusCode: number;
  readonly isOperational: boolean;

  constructor(statusCode: number, message: string, isOperational = true) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.isOperational = isOperational;
    Object.setPrototypeOf(this, ApiError.prototype);
  }

  toJSON() {
    return { name: this.name, statusCode: this.statusCode, message: this.message };
  }
}

export class StreamError extends Error {
  readonly kind:
    | 'parse-failed'
    | 'repaired-truncation'
    | 'empty-input'
    | 'timeout'
    | 'cancelled'
    | 'llm-unavailable'
    | 'ipc-failed'
    | 'unknown';
  readonly metadata?: Record<string, unknown>;

  constructor(
    kind: StreamError['kind'],
    message?: string,
    metadata?: Record<string, unknown>,
  ) {
    super(message ?? `Stream error: ${kind}`);
    this.name = 'StreamError';
    this.kind = kind;
    this.metadata = metadata;
    Object.setPrototypeOf(this, StreamError.prototype);
  }
}

export class ValidationError extends Error {
  readonly issues: Array<{ path: string; message: string }>;

  constructor(issues: Array<{ path: string; message: string }>, message?: string) {
    super(message ?? `Validation failed: ${issues.length} issue(s)`);
    this.name = 'ValidationError';
    this.issues = issues;
    Object.setPrototypeOf(this, ValidationError.prototype);
  }
}

/** 错误是否可重试（瞬时错误） */
export function isRetryable(err: unknown): boolean {
  if (err instanceof ApiError) {
    return err.statusCode === 408 || err.statusCode === 429 || (err.statusCode >= 500 && err.statusCode < 600);
  }
  if (err instanceof StreamError) {
    return err.kind === 'timeout' || err.kind === 'llm-unavailable';
  }
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    return msg.includes('timeout') || msg.includes('aborted') || msg.includes('network');
  }
  return false;
}

/** 统一 handler：打印 + 触发订阅 */
type ErrorListener = (err: Error, ctx: ErrorContext & { severity: ErrorSeverity }) => void;
const listeners = new Set<ErrorListener>();

export function onError(listener: ErrorListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function handleError(err: unknown, ctx: ErrorContext = {}): void {
  const severity: ErrorSeverity =
    err instanceof ApiError && err.statusCode >= 500
      ? 'error'
      : err instanceof StreamError
        ? 'warn'
        : 'error';

  // 控制台输出（开发期）
  const tag = `[${ctx.context ?? 'unknown'}]`;
  if (severity === 'fatal' || severity === 'error') {
    // eslint-disable-next-line no-console
    console.error(tag, err, ctx.metadata ?? {});
  } else {
    // eslint-disable-next-line no-console
    console.warn(tag, err, ctx.metadata ?? {});
  }

  // 通知订阅者
  for (const l of listeners) {
    try {
      l(err instanceof Error ? err : new Error(String(err)), { ...ctx, severity });
    } catch {
      /* ignore listener error */
    }
  }
}

/** 测试用：清空订阅 */
export function _resetErrorListeners(): void {
  listeners.clear();
}
