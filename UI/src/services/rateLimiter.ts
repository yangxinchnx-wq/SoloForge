/**
 * rateLimiter.ts — 简易 in-memory rate limiter（backend-patterns）
 *
 * 用法：
 *   const limiter = new RateLimiter({ maxRequests: 60, windowMs: 60_000 });
 *   if (!limiter.check('user-1')) throw new Error('Too many requests');
 *   ...
 *
 *   // await 版本（自动 sleep）
 *   await limiter.waitForSlot('user-1');
 */

export interface RateLimiterOptions {
  /** 时间窗内最大请求数 */
  maxRequests: number;
  /** 时间窗长度（ms） */
  windowMs: number;
}

interface Bucket {
  timestamps: number[];
}

export class RateLimiter {
  private buckets = new Map<string, Bucket>();

  constructor(private options: RateLimiterOptions) {
    if (options.maxRequests <= 0) throw new Error('maxRequests must be > 0');
    if (options.windowMs <= 0) throw new Error('windowMs must be > 0');
  }

  /** 检查是否可发起请求（不修改状态） */
  canRequest(key: string): boolean {
    const bucket = this.buckets.get(key);
    if (!bucket) return true;
    const now = Date.now();
    const recent = bucket.timestamps.filter((t) => now - t < this.options.windowMs);
    return recent.length < this.options.maxRequests;
  }

  /** 检查并占用一个名额（同步） */
  check(key: string): boolean {
    const allowed = this.canRequest(key);
    if (allowed) this.record(key);
    return allowed;
  }

  /** 记录一次请求（不检查） */
  record(key: string): void {
    const now = Date.now();
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { timestamps: [] };
      this.buckets.set(key, bucket);
    }
    // 清理过期
    bucket.timestamps = bucket.timestamps.filter((t) => now - t < this.options.windowMs);
    bucket.timestamps.push(now);
  }

  /** 等待直到有可用名额（异步） */
  async waitForSlot(key: string, options: { maxWaitMs?: number } = {}): Promise<boolean> {
    const { maxWaitMs = 30_000 } = options;
    const start = Date.now();
    while (!this.canRequest(key)) {
      if (Date.now() - start > maxWaitMs) return false;
      // 简单轮询（生产建议用 LRU 或链表优化）
      await new Promise((r) => setTimeout(r, 100));
    }
    this.record(key);
    return true;
  }

  /** 重置某个 key */
  reset(key: string): void {
    this.buckets.delete(key);
  }

  /** 清空全部 */
  clear(): void {
    this.buckets.clear();
  }

  /** 监控：当前 key 的活跃请求数 */
  activeCount(key: string): number {
    const bucket = this.buckets.get(key);
    if (!bucket) return 0;
    const now = Date.now();
    return bucket.timestamps.filter((t) => now - t < this.options.windowMs).length;
  }
}

/**
 * 默认 LLM rate limiter：
 *   - 60 RPM（OpenAI tier 1 默认）
 *   - 单窗口 60s
 */
export const defaultLLMRateLimiter = new RateLimiter({ maxRequests: 60, windowMs: 60_000 });
