/**
 * retry.ts — 指数退避重试（backend-patterns: Retry with Exponential Backoff）
 *
 * 用法：
 *   const data = await retry(() => fetch(url), { maxRetries: 3, baseDelayMs: 500 });
 *
 *   // 只重试瞬时错误
 *   const data = await retry(() => risky(), {
 *     shouldRetry: (err) => isRetryable(err),
 *   });
 *
 *   // 监听每次重试
 *   await retry(fn, {
 *     onRetry: (attempt, err, delay) => log(`retry ${attempt} after ${delay}ms`, err),
 *   });
 */

import { isRetryable } from './errors';

export interface RetryOptions {
  /** 最多重试几次（不含首次），默认 3 */
  maxRetries?: number;
  /** 第一次重试延迟（ms），默认 500 */
  baseDelayMs?: number;
  /** 最大单次延迟（ms），默认 5000 */
  maxDelayMs?: number;
  /** 抖动比例 0~1，默认 0.1（±10%） */
  jitter?: number;
  /** 自定义是否重试 */
  shouldRetry?: (err: unknown, attempt: number) => boolean;
  /** 每次重试回调 */
  onRetry?: (attempt: number, err: unknown, delayMs: number) => void;
}

export async function retry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const {
    maxRetries = 3,
    baseDelayMs = 500,
    maxDelayMs = 5000,
    jitter = 0.1,
    shouldRetry = isRetryable,
    onRetry,
  } = opts;

  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt >= maxRetries) break;
      if (!shouldRetry(err, attempt)) break;

      // 指数退避：baseDelay * 2^attempt + 抖动
      const expDelay = baseDelayMs * Math.pow(2, attempt);
      const capped = Math.min(expDelay, maxDelayMs);
      const jitterMs = capped * jitter * (Math.random() * 2 - 1);
      const delay = Math.max(0, Math.round(capped + jitterMs));

      onRetry?.(attempt + 1, err, delay);
      await new Promise<void>((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

/**
 * 重试 + 超时（组合）
 * 适用于 LLM 请求：既要重试，又要总超时
 */
export async function retryWithTimeout<T>(
  fn: () => Promise<T>,
  opts: RetryOptions & { totalTimeoutMs?: number } = {},
): Promise<T> {
  const { totalTimeoutMs = 60_000, ...retryOpts } = opts;
  return Promise.race([
    retry(fn, retryOpts),
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error(`retryWithTimeout: exceeded ${totalTimeoutMs}ms`)), totalTimeoutMs);
    }),
  ]);
}
