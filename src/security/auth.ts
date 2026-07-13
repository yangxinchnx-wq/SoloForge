// SoloForge Security Layer: HTTP Auth + CORS Middleware
// Path: src/security/auth.ts
// Standards:
//   - OWASP Node.js Security Cheat Sheet (input validation, timing-safe compare)
//   - Express security best practices: CORS allow-list, header hardening
//   - RFC 6750 (Bearer Token Usage)
import type { IncomingHttpHeaders } from 'http';
import * as nodePath from 'path';
import * as crypto from 'crypto';
import { checkTenantAccess, pickDefaultTenant, isValidTenantId } from './tenantContext';

export type Role = 'admin' | 'operator' | 'agent' | 'public';

/** Max HTTP body size in bytes (1 MB). */
export const MAX_BODY_BYTES = 1 * 1024 * 1024;

/** Audit sink function type. */
export type AuditSink = (entry: Record<string, any>) => void;

/** Audit event structure. */
export interface AuditEvent {
  id: string;
  timestamp: number;
  action: string;
  route?: string;
  method?: string;
  status?: number;
  remoteAddress?: string;
  userAgent?: string;
  reason?: string;
  principal?: Principal;
  tenantId?: string;
  [key: string]: any;
}

/** V2 audit sink with structured events. */
export type AuditSinkV2 = (event: AuditEvent) => void;

// ============================================================
// Rate Limiting
// ============================================================

/** Rate limiter configuration. */
export interface RateLimitConfig {
  /** Maximum burst of requests allowed at once. */
  burst: number;
  /** Token refill rate per second. */
  refillPerSec: number;
  /** Maximum requests per 60s window (for logging / metrics). */
  maxPerWindow: number;
}

/** Default rate limit config (generous, per-IP). */
export const defaultRateLimit: RateLimitConfig = {
  burst: 120,
  refillPerSec: 10,
  maxPerWindow: 600,
};

/** Strict rate limit config (sensitive routes like /api/vault, /api/admin). */
export const strictRateLimit: RateLimitConfig = {
  burst: 20,
  refillPerSec: 2,
  maxPerWindow: 60,
};

/**
 * Token-bucket rate limiter.
 * Each key gets its own bucket with `burst` capacity and `refillPerSec` refill rate.
 */
export class RateLimiter {
  private buckets = new Map<string, { tokens: number; lastRefill: number }>();
  private interval: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly config: RateLimitConfig) {
    // Periodically clean up stale buckets to prevent memory leaks
    this.interval = setInterval(() => {
      const now = Date.now();
      for (const [key, bucket] of this.buckets) {
        // If bucket is full and hasn't been used in 60s, remove it
        if (bucket.tokens >= config.burst && now - bucket.lastRefill > 60_000) {
          this.buckets.delete(key);
        }
      }
    }, 60_000);
  }

  /** Consume one token for the given key. Returns true if allowed. */
  allow(key: string): boolean {
    const now = Date.now();
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { tokens: this.config.burst, lastRefill: now };
      this.buckets.set(key, bucket);
    }
    // Refill tokens based on elapsed time
    const elapsedSec = (now - bucket.lastRefill) / 1000;
    const refilled = elapsedSec * this.config.refillPerSec;
    bucket.tokens = Math.min(this.config.burst, bucket.tokens + refilled);
    bucket.lastRefill = now;

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return true;
    }
    return false;
  }

  /** Seconds until the next token will be available for the given key. */
  retryAfterSec(key: string): number {
    const bucket = this.buckets.get(key);
    if (!bucket) return 0;
    if (bucket.tokens >= 1) return 0;
    if (this.config.refillPerSec <= 0) return 0; // No refill = no retry
    const deficit = 1 - bucket.tokens;
    return Math.ceil(deficit / this.config.refillPerSec);
  }

  /** Stop the cleanup interval. */
  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }
}

// ============================================================
// Request ID / PII Hashing
// ============================================================

const REQUEST_ID_RE = /^[A-Za-z0-9._\-]{1,128}$/;

/** Generate a UUID v4 string. */
function uuidV4(): string {
  return crypto.randomUUID();
}

/**
 * Generate a random request ID or reuse X-Request-Id header.
 * Validates the upstream header: only alphanumeric + .-_ chars, max 128 bytes.
 * If the header is missing or invalid, a UUID v4 is generated.
 */
export function getOrAssignRequestId(headers: IncomingHttpHeaders): string {
  const existing = headers['x-request-id'];
  if (typeof existing === 'string' && REQUEST_ID_RE.test(existing)) return existing;
  return uuidV4();
}

/**
 * Hash PII (e.g. IP address) with a salt using FNV-1a.
 * Returns a 16-character hex string for compact, deterministic anonymization.
 */
export function hashPii(value: string, salt: string): string {
  // Double-pass FNV-1a for better distribution
  let h1 = 0x811c9dc5;
  let h2 = 0x1000193;
  const combined = salt + value;
  for (let i = 0; i < combined.length; i++) {
    h1 ^= combined.charCodeAt(i);
    h1 = (h1 * 0x01000193) >>> 0;
    h2 ^= combined.charCodeAt(i) << 1;
    h2 = (h2 * 0x01000193) >>> 0;
  }
  // Produce 16 hex chars (two 32-bit values → 8+8 hex)
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
}

// ============================================================
// Security Headers / CORS
// ============================================================

/**
 * Security response headers (helmet-equivalent).
 * Returns a comprehensive set of hardening headers.
 */
export function securityHeaders(opts: { isHttps?: boolean } = {}): Record<string, string> {
  const h: Record<string, string> = {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'X-XSS-Protection': '1; mode=block',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
    'X-DNS-Prefetch-Control': 'off',
  };
  if (opts.isHttps) {
    h['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';
  }
  return h;
}

/**
 * CORS headers based on request Origin and config.
 * - If origin is whitelisted: echo it back with `Vary: Origin`.
 * - If origin is unknown: fall back to the first allowed origin (permissive mode).
 * - If no allowed origins configured: return empty.
 */
export function corsHeadersFor(headers: IncomingHttpHeaders, cfg: AuthConfig): Record<string, string> {
  const origin = typeof headers['origin'] === 'string' ? headers['origin'] : '';
  if (!origin) return {};

  // Whitelisted origin → echo it
  if (cfg.allowedOrigins.includes(origin)) {
    return {
      'Access-Control-Allow-Origin': origin,
      'Vary': 'Origin',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Request-Id,X-Tenant-Id',
      'Access-Control-Max-Age': '86400',
    };
  }

  // Unknown origin → fall back to first allowed origin (permissive for dev)
  if (cfg.allowedOrigins.length > 0) {
    return {
      'Access-Control-Allow-Origin': cfg.allowedOrigins[0],
      'Vary': 'Origin',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Request-Id,X-Tenant-Id',
      'Access-Control-Max-Age': '86400',
    };
  }

  return {};
}

// ============================================================
// Path Traversal Defense
// ============================================================

/**
 * Safe path join that prevents directory traversal attacks.
 * Returns the resolved path if it stays within `sandbox`, or `null` otherwise.
 * Rejects: empty input, overlong input (>256 chars), absolute paths, `../` traversal.
 */
export function safeJoin(sandbox: string, rel: string): string | null {
  // Reject empty or overlong input
  if (!rel || rel.length === 0 || rel.length > 256) return null;

  // Reject absolute paths (Unix and Windows)
  if (rel.startsWith('/') || /^[A-Za-z]:[\\/]/.test(rel)) return null;

  // Resolve and check containment
  const resolved = nodePath.resolve(sandbox, rel);
  const sandboxResolved = nodePath.resolve(sandbox);
  // Ensure resolved path is within sandbox (or equals it)
  if (resolved !== sandboxResolved && !resolved.startsWith(sandboxResolved + nodePath.sep)) {
    return null;
  }

  return resolved;
}

// ============================================================
// Audit Sink
// ============================================================

/**
 * Default audit sink: writes a JSON line with tag AUDIT to stdout.
 */
export const defaultAuditSink: AuditSink = (entry: Record<string, any>) => {
  const payload = JSON.stringify({ tag: 'AUDIT', ...entry });
  console.log(payload);
};

// ============================================================
// Token Generation
// ============================================================

/**
 * Generate a cryptographically random API token (64 hex chars = 256 bits).
 */
export function generateApiToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

// ============================================================
// Principal / Auth Config
// ============================================================

export interface Principal {
  id: string;
  role: Role;
  source: 'env-token' | 'bearer' | 'loopback' | 'anonymous';
  /**
   * 允许访问的租户 ID 列表 (multi-tenant isolation)
   *   - 缺省 = ['*']      (admin, 跨租户访问)
   *   - ['t1','t2']       (operator, 仅限指定租户)
   *   - []                (无租户, 拒绝租户资源)
   */
  tenantIds?: string[];
  /** 当前请求实际使用的 tenantId (从 header / path 解析) */
  activeTenantId?: string;
  /** Token kid (供审计, 仅 bearer 路径) */
  kid?: string;
  /** 是否在 grace period 内 (token rotation 兼容) */
  inGrace?: boolean;
}

export interface AuthConfig {
  apiTokens: string[];
  allowedOrigins: string[];
  publicRoutes: string[];
  trustLoopback: boolean;
  maxAuthHeaderLength: number;
}

export const defaultAuthConfig: AuthConfig = {
  apiTokens: (process.env.SOLOFORGE_API_TOKENS || '')
    .split(',')
    .map((s: string) => s.trim())
    .filter(Boolean),
  allowedOrigins: (process.env.SOLOFORGE_CORS_ORIGINS ||
    'http://localhost:5173,http://localhost:5174,http://127.0.0.1:5173')
    .split(',')
    .map((s: string) => s.trim())
    .filter(Boolean),
  publicRoutes: [
    '/api/health',
    '/api/kernel/health',
    '/api/kernel/status',
    '/', '/admin', '/ui',
  ],
  trustLoopback: (process.env.SOLOFORGE_TRUST_LOOPBACK || '1') !== '0',
  maxAuthHeaderLength: 4096,
};

const ROLE_BY_ROUTE: Array<{ prefix: string; role: Role }> = [
  { prefix: '/api/vault', role: 'admin' },
  { prefix: '/api/admin', role: 'admin' },
  { prefix: '/api/audit', role: 'admin' },
  { prefix: '/api/agents', role: 'operator' },
  { prefix: '/api/governor', role: 'operator' },
  { prefix: '/api/decisions', role: 'operator' },
  { prefix: '/api/court', role: 'operator' },
  { prefix: '/api/kernel', role: 'operator' },
  { prefix: '/api/scheduler', role: 'operator' },
  { prefix: '/ui/', role: 'public' },
];

function extractBearerToken(headers: IncomingHttpHeaders, maxLen: number): string | null {
  const raw = headers['authorization'];
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > maxLen) return null;
  if (!raw.toLowerCase().startsWith('bearer ')) return null;
  const token = raw.slice(7).trim();
  if (!token || token.length > 1024) return null;
  return token;
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i % b.length);
    return diff === 0 && false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function isLoopback(remoteAddr: string | undefined): boolean {
  if (!remoteAddr) return false;
  if (remoteAddr === '127.0.0.1' || remoteAddr === '::1') return true;
  if (remoteAddr.endsWith('127.0.0.1')) return true;
  return false;
}

export interface RouteGuardInput {
  reqPath: string;
  method: string;
  headers: IncomingHttpHeaders;
  query: Record<string, string>;
  remoteAddress?: string;
  /**
   * 客户端声明的 tenantId (来自 header X-Tenant-Id 或 path /api/t/{id})
   * 缺省由 caller 用 pickDefaultTenant() 兜底。
   */
  requestedTenantId?: string;
  /**
   * Token -> tenantIds 绑定 (从 env 加载)
   * 留空 = ['*'] (全通)
   */
  tenantBindings?: Record<string, string[]>;
}

export interface RouteGuardResult {
  allow: boolean;
  status: number;
  principal?: Principal;
  corsOrigin?: string | null;
  reason?: string;
  reuseDetected?: boolean;
  crossTenant?: boolean;
  autoRevokedTokens?: string[];
}

/**
 * Add tenant context to a sync-allowed result.
 * Validates requestedTenantId and sets principal.activeTenantId.
 */
function addTenantContext(result: RouteGuardResult, input: RouteGuardInput): RouteGuardResult {
  if (!result.principal) return result;

  const requestedTenantId = input.requestedTenantId;

  if (requestedTenantId) {
    // Validate format
    if (!isValidTenantId(requestedTenantId)) {
      return {
        ...result,
        allow: false,
        status: 403,
        reason: 'invalid_tenant_id',
        crossTenant: true,
      };
    }
    // Set active tenant to the requested one
    return {
      ...result,
      principal: { ...result.principal, activeTenantId: requestedTenantId },
    };
  }

  // No explicit tenant requested → use default
  const activeTenantId = pickDefaultTenant(result.principal.tenantIds, result.principal.role);
  return {
    ...result,
    principal: { ...result.principal, activeTenantId },
  };
}

export function evaluateRequest(input: RouteGuardInput, cfg: AuthConfig = defaultAuthConfig): RouteGuardResult {
  const { reqPath, method, headers, query, remoteAddress } = input;

  if (method === 'OPTIONS') {
    const origin = typeof headers['origin'] === 'string' ? headers['origin'] : '';
    return {
      allow: true,
      status: 204,
      corsOrigin: cfg.allowedOrigins.includes(origin) ? origin : null,
    };
  }

  for (const pub of cfg.publicRoutes) {
    // Match exact path, or for longer directory prefixes (pub.length > 1 + ends with /), match the prefix.
    if (reqPath === pub || (pub.length > 1 && pub.endsWith('/') && reqPath.startsWith(pub))) {
      const origin = typeof headers['origin'] === 'string' ? headers['origin'] : '';
      return {
        allow: true,
        status: 200,
        principal: { id: 'anonymous', role: 'public', source: 'anonymous' },
        corsOrigin: cfg.allowedOrigins.includes(origin) ? origin : null,
      };
    }
  }

  if (cfg.trustLoopback && isLoopback(remoteAddress)) {
    const origin = typeof headers['origin'] === 'string' ? headers['origin'] : '';
    return {
      allow: true,
      status: 200,
      principal: { id: 'loopback', role: 'admin', source: 'loopback' },
      corsOrigin: cfg.allowedOrigins.includes(origin) ? origin : null,
    };
  }

  const bearer = extractBearerToken(headers, cfg.maxAuthHeaderLength);
  const queryToken = typeof query['token'] === 'string' ? query['token'] : null;
  const candidate = bearer || queryToken;

  if (candidate) {
    for (const t of cfg.apiTokens) {
      if (safeEqual(candidate, t)) {
        const origin = typeof headers['origin'] === 'string' ? headers['origin'] : '';
        return {
          allow: true,
          status: 200,
          principal: { id: 'token', role: 'operator', source: bearer ? 'bearer' : 'env-token' },
          corsOrigin: cfg.allowedOrigins.includes(origin) ? origin : null,
        };
      }
    }
  }

  let requiredRole: Role = 'public';
  for (const r of ROLE_BY_ROUTE) {
    if (reqPath === r.prefix || reqPath.startsWith(r.prefix + '/') || reqPath.startsWith(r.prefix)) {
      requiredRole = r.role;
      break;
    }
  }

  return {
    allow: false,
    status: 401,
    corsOrigin: null,
    reason: requiredRole === 'public' ? 'unauthenticated' : 'insufficient_credentials',
  };
}

/**
 * 异步增强版鉴权:
 *   - 在 evaluateRequest 基础上, 添加 tenant context 验证
 *   - 同步路径 (public/loopback/token) 通过后, 验证 requestedTenantId
 *   - 同步路径拒绝时, 走 tokenStore 异步路径 (vault token + tenant bindings)
 *
 * 协议:
 *   - principal.kid:  命中的 token kid (供审计)
 *   - principal.inGrace: true 表示命中的是 grace period 内的旧 token
 *   - principal.tenantIds: 该 token 被允许访问的 tenant 集合
 *   - principal.activeTenantId: 当前请求实际使用的 tenantId
 */
export async function evaluateRequestAsync(
  input: RouteGuardInput,
  cfg: AuthConfig = defaultAuthConfig
): Promise<RouteGuardResult> {
  // 先走同步鉴权（快速路径）
  const syncResult = evaluateRequest(input, cfg);

  if (syncResult.allow) {
    // Add tenant context to sync-allowed results
    return addTenantContext(syncResult, input);
  }

  // 异步路径：Token Store 查找 (vault token)
  const { headers } = input;
  const bearer = extractBearerToken(headers, cfg.maxAuthHeaderLength);

  if (!bearer) return syncResult;

  try {
    // 动态导入 tokenStore（避免启动时强依赖 keytar/native 模块）
    const tokenStoreModule = await import('./tokenStore').catch(() => null);
    if (!tokenStoreModule?.tokenStoreInit) return syncResult;

    await tokenStoreModule.tokenStoreInit();
    const tokenRecord = await tokenStoreModule.findByToken(bearer).catch(() => null);

    if (!tokenRecord) {
      // token 不在 store 中 → 可能已被吊销或不存在
      return syncResult;
    }

    // Check if token is revoked (grace period check)
    const now = Date.now();
    const graceMs = parseInt(process.env.SOLOFORGE_TOKEN_GRACE_MS || '300000', 10);
    const inGrace = !!tokenRecord.revokedAt && now - tokenRecord.revokedAt <= graceMs;

    if (tokenRecord.revokedAt && !inGrace) {
      // grace period 已过 → 真正吊销
      return {
        allow: false,
        status: 401,
        corsOrigin: null,
        reason: 'token_revoked_grace_expired',
      };
    }

    // Resolve tenant bindings
    const kid = tokenRecord.kid;
    const tenantIds = input.tenantBindings?.[kid]; // undefined = wildcard ['*']
    const requestedTenantId = input.requestedTenantId;

    // Validate tenant access
    if (requestedTenantId) {
      const tenantCheck = checkTenantAccess(tenantIds, requestedTenantId);
      if (!tenantCheck.ok) {
        const reason = tenantCheck.reason === 'invalid_id' ? 'invalid_tenant_id' : 'cross_tenant_access';
        return {
          allow: false,
          status: 403,
          corsOrigin: null,
          reason,
          crossTenant: true,
        };
      }
    }

    // Determine activeTenantId
    const activeTenantId = requestedTenantId || pickDefaultTenant(tenantIds, 'operator');
    const origin = typeof headers['origin'] === 'string' ? headers['origin'] : '';

    return {
      allow: true,
      status: 200,
      principal: {
        id: kid,
        role: 'operator',
        source: 'bearer',
        kid,
        tenantIds: tenantIds || ['*'],
        activeTenantId,
        inGrace,
      },
      corsOrigin: cfg.allowedOrigins.includes(origin) ? origin : null,
    };
  } catch (_e) {
    // tokenStore 不可用时降级为同步结果
    return syncResult;
  }
}

/**
 * 启动时异步加载 API Tokens（支持 vault 回退 + 自动生成）.
 *
 * 三级回退策略:
 *   1. env 变量 SOLOFORGE_API_TOKENS (最快)
 *   2. vault 存储 (keytar / native 模块)
 *   3. 自动生成并写入 vault (首次启动)
 *
 * 当 SOLOFORGE_REQUIRE_TOKENS=1 且 env/vault 都为空时, 抛错而非自动生成.
 */
export async function loadApiTokensAsync(): Promise<string[]> {
  // Level 1: 环境变量（热路径）
  const envRaw = process.env.SOLOFORGE_API_TOKENS || '';
  const envTokens = envRaw.split(',').map((s: string) => s.trim()).filter(Boolean);
  if (envTokens.length > 0) return envTokens;

  // Level 2: Vault 存储
  try {
    const store = await import('./tokenStore');
    await store.tokenStoreInit();
    const tokens = await store.getActiveTokens();
    if (tokens.length > 0) return tokens;
  } catch (_e) {
    // vault 不可用时静默降级
  }

  // Level 3: 自动生成（仅开发环境 / 首次启动）
  const requireTokens = process.env.SOLOFORGE_REQUIRE_TOKENS === '1' || process.env.NODE_ENV === 'production';
  if (requireTokens) {
    throw new Error(
      'No API tokens configured. Set SOLOFORGE_API_TOKENS env variable, ' +
      'or run: npm run token:init. ' +
      '(Set SOLOFORGE_REQUIRE_TOKENS=0 to allow auto-generation on first run.)'
    );
  }
  const store = await import('./tokenStore');
  await store.tokenStoreInit();
  const fresh = await store.createToken({ source: 'init' });
  return [fresh.token];
}

/**
 * 同步加载 API Token(热路径使用,例如吊销列表检查时).
 *
 * 与 loadApiTokensAsync 的区别:
 *   - 异步版本会做 env -> vault -> auto-gen 的三级回退
 *   - 同步版本**只读 env**,因为 vault 读取是异步的(走 keytar/native 模块)
 *
 * 典型使用场景:
 *   - handleRequest 里的 token 吊销检查(每请求一次,需要快速)
 *   - 任何不想要 async 链路污染的同步代码路径
 *
 * 异常:env 为空时立即抛错,告诉调用方应该用 async 版本走完整回退。
 *
 * @returns 从 env 解析出的 token 数组(env 缺失时抛错)
 */
export function loadApiTokens(): string[] {
  const envRaw = process.env.SOLOFORGE_API_TOKENS || '';
  const tokens = envRaw.split(',').map((s: string) => s.trim()).filter(Boolean);
  if (tokens.length === 0) {
    throw new Error(
      'No SOLOFORGE_API_TOKENS in env. Call loadApiTokensAsync() at startup ' +
      'to fall back to vault / auto-generation.'
    );
  }
  return tokens;
}

/**
 * 加载已吊销的 token 集合(每次请求都会调用,必须快).
 *
 * 来源:环境变量 `SOLOFORGE_REVOKED_TOKENS`(逗号分隔).
 *
 * @returns 字符串集合(便于 O(1) `has()` 查询)
 */
export function loadRevokedTokens(): Set<string> {
  const raw = process.env.SOLOFORGE_REVOKED_TOKENS || '';
  return new Set(raw.split(',').map((s: string) => s.trim()).filter(Boolean));
}
