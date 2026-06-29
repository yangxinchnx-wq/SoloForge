/**
 * retry + rateLimiter + errors 单测
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { retry, retryWithTimeout } from './retry';
import { RateLimiter, defaultLLMRateLimiter } from './rateLimiter';
import {
  ApiError,
  StreamError,
  isRetryable,
  handleError,
  onError,
  _resetErrorListeners,
} from './errors';

describe('errors', () => {
  beforeEach(() => _resetErrorListeners());

  it('ApiError carries statusCode', () => {
    const e = new ApiError(401, 'Unauthorized');
    expect(e.statusCode).toBe(401);
    expect(e.message).toBe('Unauthorized');
    expect(e.isOperational).toBe(true);
    expect(e.toJSON()).toEqual({ name: 'ApiError', statusCode: 401, message: 'Unauthorized' });
  });

  it('StreamError carries kind + metadata', () => {
    const e = new StreamError('parse-failed', 'bad json', { raw: '{' });
    expect(e.kind).toBe('parse-failed');
    expect(e.metadata).toEqual({ raw: '{' });
  });

  it('isRetryable identifies transient errors', () => {
    expect(isRetryable(new ApiError(429, 'rate limited'))).toBe(true);
    expect(isRetryable(new ApiError(500, 'server'))).toBe(true);
    expect(isRetryable(new ApiError(401, 'unauth'))).toBe(false);
    expect(isRetryable(new ApiError(400, 'bad'))).toBe(false);
    expect(isRetryable(new StreamError('timeout'))).toBe(true);
    expect(isRetryable(new StreamError('parse-failed'))).toBe(false);
    expect(isRetryable(new Error('connection timeout'))).toBe(true);
    expect(isRetryable(new Error('fatal'))).toBe(false);
  });

  it('handleError notifies listeners', () => {
    const listener = vi.fn();
    onError(listener);
    handleError(new Error('boom'), { context: 'test' });
    expect(listener).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ context: 'test' }),
    );
  });

  it('handleError logs ApiError 5xx as error', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    handleError(new ApiError(500, 'srv'), { context: 'ctx' });
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('handleError logs ApiError 4xx as error (operational)', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    handleError(new ApiError(401, 'unauth'), { context: 'ctx' });
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('handleError logs StreamError as warn', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    handleError(new StreamError('timeout'), { context: 'ctx' });
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('onError returns unsubscribe', () => {
    const listener = vi.fn();
    const unsub = onError(listener);
    handleError(new Error('first'), { context: 'ctx' });
    unsub();
    handleError(new Error('second'), { context: 'ctx' });
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe('retry', () => {
  it('returns immediately on success', async () => {
    const fn = vi.fn(async () => 'ok');
    const r = await retry(fn);
    expect(r).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries up to maxRetries then throws', async () => {
    const fn = vi.fn(async () => {
      throw new ApiError(500, 'fail');
    });
    await expect(retry(fn, { maxRetries: 2, baseDelayMs: 1 })).rejects.toThrow('fail');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('does not retry non-retryable errors', async () => {
    const fn = vi.fn(async () => {
      throw new ApiError(401, 'unauth');
    });
    await expect(retry(fn, { maxRetries: 3, baseDelayMs: 1 })).rejects.toThrow('unauth');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('calls onRetry with delay', async () => {
    let calls = 0;
    const fn = vi.fn(async () => {
      calls++;
      if (calls < 3) throw new ApiError(500, 'srv');
      return 'ok';
    });
    const onRetry = vi.fn();
    const r = await retry(fn, { maxRetries: 3, baseDelayMs: 5, onRetry });
    expect(r).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  it('retryWithTimeout throws on total timeout', async () => {
    const fn = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 100));
      throw new ApiError(500, 'slow');
    });
    await expect(retryWithTimeout(fn, { totalTimeoutMs: 50, baseDelayMs: 1 })).rejects.toThrow();
  });
});

describe('RateLimiter', () => {
  it('allows up to maxRequests within window', () => {
    const rl = new RateLimiter({ maxRequests: 3, windowMs: 1000 });
    expect(rl.check('k')).toBe(true);
    expect(rl.check('k')).toBe(true);
    expect(rl.check('k')).toBe(true);
    expect(rl.check('k')).toBe(false);
  });

  it('tracks different keys independently', () => {
    const rl = new RateLimiter({ maxRequests: 1, windowMs: 1000 });
    expect(rl.check('a')).toBe(true);
    expect(rl.check('b')).toBe(true);
    expect(rl.check('a')).toBe(false);
  });

  it('reset clears', () => {
    const rl = new RateLimiter({ maxRequests: 1, windowMs: 1000 });
    expect(rl.check('k')).toBe(true);
    rl.reset('k');
    expect(rl.check('k')).toBe(true);
  });

  it('waitForSlot blocks until window passes', async () => {
    const rl = new RateLimiter({ maxRequests: 1, windowMs: 50 });
    expect(rl.check('k')).toBe(true);
    const start = Date.now();
    const got = await rl.waitForSlot('k', { maxWaitMs: 200 });
    expect(got).toBe(true);
    expect(Date.now() - start).toBeGreaterThanOrEqual(40);
  });

  it('waitForSlot returns false on maxWaitMs', async () => {
    const rl = new RateLimiter({ maxRequests: 1, windowMs: 1000 });
    rl.check('k');
    const got = await rl.waitForSlot('k', { maxWaitMs: 100 });
    expect(got).toBe(false);
  });

  it('activeCount tracks current window', () => {
    const rl = new RateLimiter({ maxRequests: 5, windowMs: 1000 });
    rl.check('a');
    rl.check('a');
    expect(rl.activeCount('a')).toBe(2);
  });

  it('defaultLLMRateLimiter is configured', () => {
    expect(defaultLLMRateLimiter).toBeDefined();
  });

  it('validates options', () => {
    expect(() => new RateLimiter({ maxRequests: 0, windowMs: 1000 })).toThrow();
    expect(() => new RateLimiter({ maxRequests: 10, windowMs: 0 })).toThrow();
  });
});
