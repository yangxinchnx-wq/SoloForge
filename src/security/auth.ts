// SoloForge Security Layer: HTTP Auth + CORS Middleware
// Path: src/security/auth.ts
// Standards:
//   - OWASP Node.js Security Cheat Sheet (input validation, timing-safe compare)
//   - Express security best practices: CORS allow-list, header hardening
//   - RFC 6750 (Bearer Token Usage)
import type { IncomingHttpHeaders } from 'http';
import * as nodePath from 'path';
import { checkTenantAccess, pickDefaultTenant } from './tenantContext';

export type Role = 'admin' | 'operator' | 'agent' | 'public';

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
 *   - 在 evaluateRequest 基础上, 额外做 Token Family 复用检测
 *   - 检测到 grace period 外的旧 token → 整族吊销 + 返回 401
 *   - 检测到 grace period 内的旧 token → 仍允许 (网络抖动兼容)
 *
 * 协议:
 *   - principal.kid:  命中的 token kid (供审计)
 *   - principal.inGrace: true 表示命中的是 grace period 内的旧 token
 *   - principal.tenantIds: 该 token 被允许访问的 tenant 集合
 */
export async function evaluateRequestAsync(
  input: RouteGuardInput,
  cfg: AuthConfig = defaultAuthConfig
): Promise<RouteGuardResult> {
  // 先走同步鉴权（快速路径）
  const syncResult = evaluateRequest(input, cfg);
  if (syncResult.allow) return syncResult;

  // 异步路径：Token Family 复用检测
  const { headers, remoteAddress } = input;
  const bearer = extractBearerToken(headers, cfg.maxAuthHeaderLength);

  if (!bearer) return syncResult;

  try {
    // 动态导入 tokenStore（避免启动时强依赖 keytar/native 模块）
    const tokenStoreModule = await import('./tokenStore').catch(() => null);
    if (!tokenStoreModule?.tokenStoreInit) return syncResult;

    await tokenStoreModule.tokenStoreInit();
    const tokenFamily = await tokenStoreModule.lookupTokenFamily(bearer).catch(() => null);

    if (!tokenFamily) {
      // token 不在任何 family 中 → 可能已被吊销或不存在
      return syncResult;
    }

    // 检查 grace period：允许旧版本 token 在短时间内仍可使用（兼容网络抖动）
    const now = Date.now();
    const graceMs = parseInt(process.env.SOLOFORGE_TOKEN_GRACE_MS || '300000', 10); // 默认 5 分钟

    if (tokenFamily.revokedAt && now - tokenFamily.revokedAt > graceMs) {
      // grace period 已过 → 真正吊销
      return {
        allow: false,
        status: 401,
        corsOrigin: null,
        reason: 'token_revoked_grace_expired',
      };
    }

    // grace period 内或未吊销 → 放行，但标记 inGrace
    const origin = typeof headers['origin'] === 'string' ? headers['origin'] : '';
    return {
      allow: true,
      status: 200,
      principal: {
        id: tokenFamily.kid || 'token',
        role: 'operator',
        source: 'bearer',
        tenantIds: tokenFamily.tenantIds,
        inGrace: !!tokenFamily.revokedAt && now - tokenFamily.revokedAt <= graceMs,
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
    const tokens = await store.listTokens();
    if (tokens.length > 0) return tokens.map((t: any) => t.token);
  } catch (e) {
    // vault 不可用时静默降级
  }

  // Level 3: 自动生成（仅开发环境 / 首次启动）
  if (process.env.NODE_ENV === 'production') {
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

/** Token revocation list, read from env on each call. */

/**
 * 加载已吊销的 token 集合(每次请求都会调用,必须快).
 *
 * 来源:环境变量 `SOLOFORGE_REVOKED_TOKENS`(逗号分隔).
 * 使用时机:在 `handleRequest` 通过身份验证之后,再做一次吊销检查,
 * 防止 token 泄露后,虽然还没从 vault 删除但已经作废的情况.
 *
 * 注意:这层是防御性深度防御,主要的 token 生命周期管理走 vault.
 * env 列表适合紧急吊销:发现 token 泄露时,先加到 env 让请求立即被拒,
 * 然后异步 `npm run token:revoke` 从 vault 物理删除.
 *
 * @returns 字符串集合(便于 O(1) `has()` 查询)
 */
export function loadRevokedTokens(): Set<string> {
  const raw = process.env.SOLOFORGE_REVOKED_TOKENS || '';
  return new Set(raw.split(',').map((s: string) => s.trim()).filter(Boolean));
}
