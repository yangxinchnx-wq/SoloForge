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

import { logger } from './logger';

export type ErrorSeverity = 'info' | 'warn' | 'error' | 'fatal';

/**
 * Sentry 上报钩子接口 — Task 5 会实现具体逻辑
 * 当前为空操作占位，handleError 会在 severity >= 'error' 时调用它
 */
export interface SentryReporter {
  captureException: (err: Error, ctx: ErrorContext & { severity: ErrorSeverity }) => void;
}

let _sentryReporter: SentryReporter | null = null;

/** 注册 Sentry 上报器（Task 5 实现） */
export function registerSentryReporter(reporter: SentryReporter): void {
  _sentryReporter = reporter;
}

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

  // 统一日志输出（通过 logger 通道）
  const tag = ctx.context ?? 'unknown';
  if (severity === 'fatal' || severity === 'error') {
    logger.error(tag, err, ctx.metadata ?? {});
  } else {
    logger.warn(tag, err, ctx.metadata ?? {});
  }

  // severity >= 'error' 时自动弹 toast 通知用户
  if (severity === 'error' || severity === 'fatal') {
    try {
      // 延迟导入避免循环依赖
      const { useAppStore } = require('../state/appStore');
      const errMsg = err instanceof Error ? err.message : String(err);
      useAppStore.getState().setToastMsg(`❌ ${ctx.context ? ctx.context + ': ' : ''}${errMsg}`);
    } catch {
      // appStore 不可用时静默忽略
    }
  }

  // Sentry 上报（severity >= 'error' 时触发）
  if (_sentryReporter && (severity === 'error' || severity === 'fatal')) {
    try {
      _sentryReporter.captureException(
        err instanceof Error ? err : new Error(String(err)),
        { ...ctx, severity },
      );
    } catch {
      // Sentry 上报失败不影响主流程
    }
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
