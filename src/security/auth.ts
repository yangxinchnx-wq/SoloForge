// SoloForge Security Layer: HTTP Auth + CORS Middleware
// Path: src/security/auth.ts
// Standards:
//   - OWASP Node.js Security Cheat Sheet (input validation, timing-safe compare)
//   - Express security best practices: CORS allow-list, header hardening
//   - RFC 6750 (Bearer Token Usage)
import type { IncomingHttpHeaders } from 'http';
import * as nodePath from 'path';

export type Role = 'admin' | 'operator' | 'agent' | 'public';

const ROLE_RANK: Record<Role, number> = {
  admin: 3,
  operator: 2,
  agent: 1,
  public: 0,
};

function roleSufficient(principalRole: Role, requiredRole: Role): boolean {
  return ROLE_RANK[principalRole] >= ROLE_RANK[requiredRole];
}

export interface Principal {
  id: string;
  role: Role;
  source: 'env-token' | 'bearer' | 'loopback' | 'anonymous';
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
}

export interface RouteGuardResult {
  allow: boolean;
  status: number;
  principal?: Principal;
  corsOrigin?: string | null;
  reason?: string;
}

function getRequiredRole(reqPath: string): Role {
  let requiredRole: Role = 'public';
  for (const r of ROLE_BY_ROUTE) {
    if (reqPath === r.prefix || reqPath.startsWith(r.prefix + '/')) {
      requiredRole = r.role;
      break;
    }
  }
  return requiredRole;
}

export function evaluateRequest(input: RouteGuardInput, cfg: AuthConfig = defaultAuthConfig): RouteGuardResult {
  const { reqPath, method, headers, query, remoteAddress } = input;

  const origin = typeof headers['origin'] === 'string' ? headers['origin'] : '';
  const corsOrigin = cfg.allowedOrigins.includes(origin) ? origin : null;

  if (method === 'OPTIONS') {
    return {
      allow: true,
      status: 204,
      corsOrigin,
    };
  }

  for (const pub of cfg.publicRoutes) {
    if (reqPath === pub || (pub.length > 1 && pub.endsWith('/') && reqPath.startsWith(pub))) {
      return {
        allow: true,
        status: 200,
        principal: { id: 'anonymous', role: 'public', source: 'anonymous' },
        corsOrigin,
      };
    }
  }

  const requiredRole = getRequiredRole(reqPath);

  if (cfg.trustLoopback && isLoopback(remoteAddress)) {
    const principal: Principal = { id: 'loopback', role: 'admin', source: 'loopback' };
    if (roleSufficient(principal.role, requiredRole)) {
      return { allow: true, status: 200, principal, corsOrigin };
    }
    return {
      allow: false,
      status: 403,
      principal,
      corsOrigin: null,
      reason: 'insufficient_role',
    };
  }

  const bearer = extractBearerToken(headers, cfg.maxAuthHeaderLength);
  const queryToken = typeof query['token'] === 'string' ? query['token'] : null;
  const candidate = bearer || queryToken;

  if (candidate) {
    for (const t of cfg.apiTokens) {
      if (safeEqual(candidate, t)) {
        const principal: Principal = { id: 'token', role: 'operator', source: bearer ? 'bearer' : 'env-token' };
        if (roleSufficient(principal.role, requiredRole)) {
          return { allow: true, status: 200, principal, corsOrigin };
        }
        return {
          allow: false,
          status: 403,
          principal,
          corsOrigin: null,
          reason: 'insufficient_role',
        };
      }
    }
  }

  return {
    allow: false,
    status: 401,
    corsOrigin: null,
    reason: requiredRole === 'public' ? 'unauthenticated' : 'insufficient_credentials',
  };
}

export function corsHeadersFor(headers: IncomingHttpHeaders, cfg: AuthConfig = defaultAuthConfig): Record<string, string> {
  const origin = typeof headers['origin'] === 'string' ? headers['origin'] : '';
  const allowed = cfg.allowedOrigins.includes(origin) ? origin : (cfg.allowedOrigins[0] || '');
  return {
    'Access-Control-Allow-Origin': allowed,
    'Vary': 'Origin',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '600',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
  };
}

export function safeJoin(sandboxDir: string, userInput: string): string | null {
  if (typeof userInput !== 'string') return null;
  if (userInput.length === 0 || userInput.length > 256) return null;
  if (/[\u0000-\u001f]/.test(userInput)) return null;
  if (/^[a-zA-Z]:[\\/]/.test(userInput) || userInput.startsWith('/') || userInput.startsWith('\\')) return null;

  const resolvedSandbox = nodePath.resolve(sandboxDir);
  const candidate = nodePath.resolve(resolvedSandbox, userInput);
  const rel = nodePath.relative(resolvedSandbox, candidate);
  if (rel.startsWith('..') || nodePath.isAbsolute(rel)) return null;
  return candidate;
}
// ============================================================
// Production Hardening: Rate Limiting, Security Headers, Body Cap
// ============================================================

import { createHash, randomUUID, randomBytes } from 'crypto';

/** RFC 6585 / 7231 — production-grade HTTP status helpers */
export const HTTP = {
  unauthorized: (reason: string) => ({ status: 401, body: { error: 'Unauthorized', reason } }),
  forbidden: (reason: string) => ({ status: 403, body: { error: 'Forbidden', reason } }),
  payloadTooLarge: () => ({ status: 413, body: { error: 'Payload Too Large' } }),
  tooManyRequests: (retryAfterSec: number) => ({
    status: 429,
    headers: { 'Retry-After': String(retryAfterSec) },
    body: { error: 'Too Many Requests', retryAfter: retryAfterSec },
  }),
} as const;

/** Process-local token-bucket rate limiter. Per-key (IP/token) sliding window. */
export interface RateLimitConfig {
  /** Max requests per window per principal/IP. */
  maxPerWindow: number;
  /** Window length in milliseconds. */
  windowMs: number;
  /** Burst capacity (token-bucket max tokens). */
  burst: number;
  /** Refill rate per second. */
  refillPerSec: number;
}

export const defaultRateLimit: RateLimitConfig = {
  maxPerWindow: 600,        // 10 RPS sustained per identity
  windowMs: 60_000,
  burst: 60,
  refillPerSec: 10,
};

export const strictRateLimit: RateLimitConfig = {
  maxPerWindow: 60,         // sensitive routes: 1 RPS, burst 10
  windowMs: 60_000,
  burst: 10,
  refillPerSec: 1,
};

interface Bucket {
  tokens: number;
  updatedAt: number;
}

/** In-process rate limiter; for HA deploys swap with a Redis-backed impl. */
export class RateLimiter {
  private buckets = new Map<string, Bucket>();
  private gcTimer: NodeJS.Timeout | null = null;

  constructor(private cfg: RateLimitConfig = defaultRateLimit) {
    // Periodic GC to prevent the map from growing unbounded.
    this.gcTimer = setInterval(() => this.gc(), Math.max(this.cfg.windowMs, 30_000));
    if (this.gcTimer.unref) this.gcTimer.unref();
  }

  /** Returns true if request is allowed; false if rate-limited. */
  public allow(key: string, cost = 1): boolean {
    const now = Date.now();
    let b = this.buckets.get(key);
    if (!b) {
      b = { tokens: this.cfg.burst, updatedAt: now };
      this.buckets.set(key, b);
    } else {
      const elapsedSec = (now - b.updatedAt) / 1000;
      b.tokens = Math.min(this.cfg.burst, b.tokens + elapsedSec * this.cfg.refillPerSec);
      b.updatedAt = now;
    }
    if (b.tokens < cost) return false;
    b.tokens -= cost;
    return true;
  }

  public retryAfterSec(key: string): number {
    const b = this.buckets.get(key);
    if (!b) return 0;
    const need = 1 - b.tokens;
    return Math.max(1, Math.ceil(need / this.cfg.refillPerSec));
  }

  private gc(): void {
    const cutoff = Date.now() - this.cfg.windowMs * 2;
    for (const [k, b] of this.buckets) {
      if (b.updatedAt < cutoff) this.buckets.delete(k);
    }
  }

  public stop(): void {
    if (this.gcTimer) clearInterval(this.gcTimer);
    this.gcTimer = null;
  }
}

/** Security headers modeled on helmet defaults. */
export function securityHeaders(opts: { isHttps: boolean } = { isHttps: false }): Record<string, string> {
  const out: Record<string, string> = {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
    'X-DNS-Prefetch-Control': 'off',
  };
  if (opts.isHttps) {
    // 2 years, include subdomains, preload-ready.
    out['Strict-Transport-Security'] = 'max-age=63072000; includeSubDomains';
  }
  return out;
}

/** Hard cap on request body to defend against OOM / decompression bombs. */
export const MAX_BODY_BYTES = 1 * 1024 * 1024; // 1 MiB

/** Strip cookies from CORS responses (OWASP: never combine wildcard origin with credentials). */
export const NO_CREDENTIALS = 'false';

/** Audit-log entry shape, suitable for shipping to a SIEM or SurrealDB. */
export interface AuditEvent {
  id: string;
  timestamp: number;
  principal?: Principal;
  action: string;        // e.g. 'auth.fail', 'rate.limit', 'vault.read'
  route: string;
  method: string;
  status: number;
  remoteAddress?: string;
  userAgent?: string;
  reason?: string;
  requestId?: string;
}

export type AuditSink = (ev: AuditEvent) => void | Promise<void>;

/** Default no-op sink; replace in production with a DB/queue writer. */
export const defaultAuditSink: AuditSink = (ev) => {
  // Mirrors to stdout in JSON for log aggregation; production should ship to SurrealDB / Loki.
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ tag: 'AUDIT', ...ev }));
};

/** Hash an IP for PII-light logging (no raw IPs in long-term storage). */
export function hashPii(input: string, salt: string): string {
  return createHash('sha256').update(salt + ':' + input).digest('hex').slice(0, 16);
}

/** Build a stable request id (or accept one from upstream). */
export function getOrAssignRequestId(headers: IncomingHttpHeaders): string {
  const v = headers['x-request-id'];
  if (typeof v === 'string' && v.length > 0 && v.length <= 128 && /^[A-Za-z0-9_-]+$/.test(v)) return v;
  return randomUUID();
}

/**
 * Token resolution order (single-host / desktop use):
 *   1) SOLOFORGE_API_TOKENS env var (comma-separated) - explicit override
 *   2) ApiKeyVault under provider 'soloforge.api.tokens' - long-lived store
 *   3) Auto-generate and persist to vault - first-run path
 *
 * Gate auto-generation with SOLOFORGE_REQUIRE_TOKENS=1 (default) so server
 * deployments without explicit tokens still fail loudly.
 */
const VAULT_PROVIDER_ID = 'soloforge.api.tokens';

/**
 * 内部:从 OS 钥匙串(vault)读取 token 列表。
 * 找不到或 vault 不可用时返回 null(让上层走下一级回退)。
 */
async function readVaultTokens(): Promise<string[] | null> {
  try {
    const { apiKeyVault } = await import('./apiKeyVault');
    await apiKeyVault.init();
    const stored = await apiKeyVault.getKey(VAULT_PROVIDER_ID);
    if (stored && stored.apiKey) {
      try {
        const arr = JSON.parse(Buffer.from(stored.apiKey, 'base64url').toString('utf8'));
        if (Array.isArray(arr)) {
          const tokens = arr.filter((t: any) => typeof t === 'string' && t.length > 0);
          if (tokens.length > 0) return tokens;
        }
      } catch { /* fall through */ }
    }
  } catch { /* vault unavailable */ }
  return null;
}

/**
 * 内部:把 token 列表写回 OS 钥匙串(vault)。
 * 编码方式:JSON 数组 -> UTF-8 -> base64url。
 * vault 内部已做加密(走 keytar / OS native 加密层),这里只负责序列化。
 */
async function writeVaultTokens(tokens: string[]): Promise<void> {
  const { apiKeyVault } = await import('./apiKeyVault');
  await apiKeyVault.init();
  const blob = Buffer.from(JSON.stringify(tokens), 'utf8').toString('base64url');
  await apiKeyVault.setKey(VAULT_PROVIDER_ID, blob, 'vault://api-tokens');
}

/**
 * 生成一个新的 API Token。
 *
 * 算法:Node 内置 crypto.randomBytes(32)(密码学安全伪随机数生成器,CSPRNG)。
 * 输出格式:64 个十六进制字符(每个字符 4 bit,32 字节 = 256 bit 熵)。
 *
 * 安全性:
 *   - 256 位熵,暴力破解 2^256 种可能,工程上不可破解
 *   - 不依赖任何外部熵源(纯 OS 提供的 CSPRNG)
 *   - 不通过网络传输、不写日志、不出现在任何错误信息中
 *
 * 用途:
 *   - 后端冷启动时,如果环境变量和 vault 都没有 token,可选自动生成一个
 *   - CLI 工具 
pm run token:init / 	oken:rotate 主动生成
 *
 * 典型值样例:'a3f7c91b2e4d6f8a1c3b5d7e9f1a3c5b7d9e1f3a5c7b9d1e3f5a7c9b1d3e5f7a9'
 *
 * @returns 64 字符的十六进制字符串
 */
export function generateApiToken(): string {
  return randomBytes(32).toString('hex');
}

/**
 * 异步加载 API Token(启动期主入口)。
 *
 * 三级回退解析顺序(找到第一处非空就返回):
 *   1) 环境变量 SOLOFORGE_API_TOKENS(逗号分隔多个,适合 CI/容器)
 *      示例: SOLOFORGE_API_TOKENS=tok1,tok2,tok3  ->  ['tok1','tok2','tok3']`n *   2) OS 钥匙串中的 vault(provider id = 'soloforge.api.tokens')
 *      存的是 base64url 编码的 JSON 数组,首次 init 后即由系统管理
 *   3) 自动生成(仅当 SOLOFORGE_REQUIRE_TOKENS=0 时启用,默认 1 拒绝)
 *      单机软件(桌面版/本地开发)的标准做法,生成的 token 立即写回 vault
 *
 * 异常行为:
 *   - 当 SOLOFORGE_REQUIRE_TOKENS=1(默认)且上述三层都拿不到时,抛出
 *     FATAL: No API tokens configured ...,后端拒绝启动。
 *   - 这是为了在服务器/生产场景下,部署者必须显式提供 token,避免空启动。
 *
 * 调用时机:在 pi-server.start() 开头同步等待(wait loadApiTokensAsync())。
 *
 * @returns 至少一个 token 的数组(单 token 模式通常只 1 个;轮换期可 2-3 个)
 */
export async function loadApiTokensAsync(): Promise<string[]> {
  const envRaw = process.env.SOLOFORGE_API_TOKENS || '';
  const envTokens = envRaw.split(',').map((s: string) => s.trim()).filter(Boolean);
  if (envTokens.length > 0) return envTokens;

  const fromVault = await readVaultTokens();
  if (fromVault && fromVault.length > 0) return fromVault;

  if ((process.env.SOLOFORGE_REQUIRE_TOKENS || '1') === '1') {
    throw new Error(
      'FATAL: No API tokens configured. Set SOLOFORGE_API_TOKENS=<hex,hex> ' +
      'or run: npm run token:init. ' +
      '(Set SOLOFORGE_REQUIRE_TOKENS=0 to allow auto-generation on first run.)'
    );
  }
  const fresh = generateApiToken();
  await writeVaultTokens([fresh]);
  return [fresh];
}

/**
 * 同步加载 API Token(热路径使用,例如吊销列表检查时)。
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

/** Token revocation list, read from env on each call. *//**
 * 加载已吊销的 token 集合(每次请求都会调用,必须快)。
 *
 * 来源:环境变量 `SOLOFORGE_REVOKED_TOKENS`(逗号分隔)。
 * 使用时机:在 `handleRequest` 通过身份验证之后,再做一次吊销检查,
 * 防止 token 泄露后,虽然还没从 vault 删除但已经作废的情况。
 *
 * 注意:这层是防御性深度防御,主要的 token 生命周期管理走 vault。
 * env 列表适合紧急吊销:发现 token 泄露时,先加到 env 让请求立即被拒,
 * 然后异步 `npm run token:revoke` 从 vault 物理删除。
 *
 * @returns 字符串集合(便于 O(1) `has()` 查询)
 */
export function loadRevokedTokens(): Set<string> {
  const raw = process.env.SOLOFORGE_REVOKED_TOKENS || '';
  return new Set(raw.split(',').map((s: string) => s.trim()).filter(Boolean));
}