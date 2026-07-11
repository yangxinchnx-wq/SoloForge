import type { Request, Response, NextFunction } from 'express';

interface RateLimitEntry {
  timestamps: number[];
  count: number;
}

interface RateLimitConfig {
  windowMs: number;
  maxRequests: number;
  statusCode?: number;
  message?: string;
  headers?: boolean;
  skip?: (req: Request) => boolean;
}

const DEFAULT_CONFIG: Required<Omit<RateLimitConfig, 'skip'>> = {
  windowMs: 60_000,
  maxRequests: 100,
  statusCode: 429,
  message: 'Too many requests, please slow down',
  headers: true,
};

const stores = new Map<string, RateLimitEntry>();

const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
let cleanupTimer: ReturnType<typeof setInterval> | null = null;

function startCleanup(): void {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of stores) {
      const latest = entry.timestamps[entry.timestamps.length - 1];
      if (!latest || now - latest > 10 * 60 * 1000) {
        stores.delete(key);
      }
    }
  }, CLEANUP_INTERVAL_MS);

  if (cleanupTimer && cleanupTimer.unref) {
    cleanupTimer.unref();
  }
}

function ensureCleanup(): void {
  if (!cleanupTimer) startCleanup();
}

export function createRateLimiter(config: Partial<RateLimitConfig> = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const windowMs = cfg.windowMs;
  const maxRequests = cfg.maxRequests;

  return function rateLimitMiddleware(req: Request, res: Response, next: NextFunction): void {
    ensureCleanup();

    if (config.skip && config.skip(req)) {
      return next();
    }

    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    const pathPrefix = req.path.split('/').slice(0, 3).join('/') || '/';
    const key = `${ip}:${pathPrefix}`;

    const now = Date.now();
    let entry = stores.get(key);

    if (!entry) {
      entry = { timestamps: [], count: 0 };
      stores.set(key, entry);
    }

    const windowStart = now - windowMs;
    while (entry.timestamps.length > 0 && entry.timestamps[0] < windowStart) {
      entry.timestamps.shift();
      entry.count--;
    }

    if (entry.count >= maxRequests) {
      const retryAfterMs = entry.timestamps[0] + windowMs - now;

      if (cfg.headers) {
        res.setHeader('X-RateLimit-Limit', String(maxRequests));
        res.setHeader('X-RateLimit-Remaining', '0');
        res.setHeader('X-RateLimit-Reset', String(Math.ceil(retryAfterMs / 1000)));
      }

      res.status(cfg.statusCode).json({
        error: cfg.message,
        code: 'RATE_LIMIT_EXCEEDED',
        retryAfterMs: Math.max(0, retryAfterMs),
      });
      return;
    }

    entry.timestamps.push(now);
    entry.count++;

    if (cfg.headers) {
      res.setHeader('X-RateLimit-Limit', String(maxRequests));
      res.setHeader('X-RateLimit-Remaining', String(Math.max(0, maxRequests - entry.count)));
      res.setHeader('X-RateLimit-Reset', String(Math.ceil(windowMs / 1000)));
    }

    next();
  };
}

export const globalRateLimit = createRateLimiter({
  windowMs: 60_000,
  maxRequests: 600,
  // ★ 跳过非 API 请求 — Vite dev server 加载首屏时会并发请求数百个
  //   ESM 模块 (/src/*.ts, /src/*.tsx, /@vite/*, /node_modules/.vite/*),
  //   这些请求不应被速率限制拦截,否则 JS 无法加载 → 页面永远转圈。
  //   速率限制只保护 /api/ 路径下的业务端点。
  // ★ 600 req/min (10 req/sec) — 本地开发服务器需要容纳:
  //   - /api/system-metrics 每 500ms 轮询 (120 req/min)
  //   - /api/canvas/notifications 每 1s 轮询 (60 req/min)
  //   - 首屏加载时的批量 API 调用
  skip: (req) => !req.path.startsWith('/api/'),
});

export const authRateLimit = createRateLimiter({
  windowMs: 15 * 60_000,
  maxRequests: 10,
  message: 'Too many authentication attempts, please wait before retrying',
});

export const aiChatRateLimit = createRateLimiter({
  windowMs: 60_000,
  maxRequests: 30,
  message: 'AI chat rate limit exceeded, please slow down',
});

export const fileOpsRateLimit = createRateLimiter({
  windowMs: 60_000,
  maxRequests: 60,
});

export const trainingRateLimit = createRateLimiter({
  windowMs: 60_000,
  maxRequests: 10,
  message: 'URL fetch rate limit exceeded',
});
