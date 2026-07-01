/**
 * tenantContext.ts — 多租户上下文解析 + 跨租户检查
 *
 * 设计目标:
 *   - 一个 token 可配置可访问的 tenantIds (默认全通)
 *   - 客户端用 header X-Tenant-Id 或 path /api/t/{tenantId}/... 指定当前租户
 *   - 鉴权层 evaluateRequest 拒绝跨租户访问
 *   - 审计事件携带 activeTenantId 字段
 *
 * 配置:
 *   - SOLOFORGE_TENANT_HEADER (默认 'X-Tenant-Id')
 *   - SOLOFORGE_TENANT_PATH_PREFIX (默认 '/api/t/')
 *   - Token -> tenantIds 映射: 通过 SOLOFORGE_TENANT_BINDINGS 配置
 *     格式: 'kid1:t1,kid2:t1+t2,kid3:*'
 *
 * 语义:
 *   - token 没绑定 tenantIds → 默认 ['*'] (全通, admin-like)
 *   - 客户端指定 tenantId 但不在 token 的 tenantIds → 403
 *   - 客户端没指定 tenantId → 用 token 唯一 tenant, 或 '_default' (单租户模式)
 *
 * 不变量:
 *   - admin 角色默认 ['*']
 *   - operator 角色必须显式绑定 (否则 403)
 *   - public/loopback 角色 → '_default' (单租户)
 */

import type { IncomingHttpHeaders } from 'http';

const DEFAULT_HEADER = 'X-Tenant-Id';
const DEFAULT_PATH_PREFIX = '/api/t/';
const DEFAULT_TENANT = '_default';
const WILDCARD = '*';

export interface TenantContextConfig {
  headerName?: string;
  pathPrefix?: string;
  defaultTenant?: string;
  /** kid -> 允许的 tenantIds 数组, 例: { 'k_abc': ['t1','t2'] } */
  bindings?: Record<string, string[]>;
}

const TENANT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function isValidTenantId(id: string): boolean {
  return TENANT_ID_RE.test(id);
}

/**
 * 从请求解析 tenantId, 优先级:
 *   1. header X-Tenant-Id (可被 query 覆盖, 默认否)
 *   2. path /api/t/{tenantId}/...   (兼容性最好)
 *   3. 缺省 → undefined (caller 决定 fallback)
 */
export function extractTenantId(
  reqPath: string,
  headers: IncomingHttpHeaders,
  cfg: TenantContextConfig = {},
): string | undefined {
  const headerName = (cfg.headerName ?? DEFAULT_HEADER).toLowerCase();
  const pathPrefix = cfg.pathPrefix ?? DEFAULT_PATH_PREFIX;

  // 1) path
  if (reqPath.startsWith(pathPrefix)) {
    const rest = reqPath.slice(pathPrefix.length);
    const m = rest.match(/^([A-Za-z0-9_-]{1,64})(\/|$)/);
    if (m) return m[1];
  }
  // 2) header
  const h = headers[headerName];
  if (typeof h === 'string' && isValidTenantId(h)) return h;
  if (Array.isArray(h) && h.length > 0 && isValidTenantId(h[0]!)) return h[0]!;
  return undefined;
}

export interface TenantCheckResult {
  ok: boolean;
  tenantId: string;
  reason?: 'invalid_id' | 'cross_tenant' | 'wildcard' | 'explicit';
}

/**
 * 跨租户检查: 给定 principal 和请求 tenant, 决定放行
 */
export function checkTenantAccess(
  principalTenantIds: string[] | undefined,
  requestedTenantId: string,
): TenantCheckResult {
  // 租户 ID 格式校验
  if (!isValidTenantId(requestedTenantId)) {
    return { ok: false, tenantId: requestedTenantId, reason: 'invalid_id' };
  }
  // 缺省 → 全通 (admin-like)
  if (!principalTenantIds || principalTenantIds.length === 0) {
    return { ok: true, tenantId: requestedTenantId, reason: 'wildcard' };
  }
  // 通配
  if (principalTenantIds.includes(WILDCARD)) {
    return { ok: true, tenantId: requestedTenantId, reason: 'wildcard' };
  }
  // 精确匹配
  if (principalTenantIds.includes(requestedTenantId)) {
    return { ok: true, tenantId: requestedTenantId, reason: 'explicit' };
  }
  return { ok: false, tenantId: requestedTenantId, reason: 'cross_tenant' };
}

/**
 * 默认 tenant: 给 principal 挑一个合理的默认值
 *   - admin → '_default'
 *   - operator (单租户) → 那个唯一的 tenant
 *   - operator (多租户) → '_default'
 *   - public/loopback → '_default' (强制单租户模式)
 */
export function pickDefaultTenant(principalTenantIds: string[] | undefined, role: string): string {
  if (role === 'admin') return DEFAULT_TENANT;
  if (role === 'public' || role === 'agent') return DEFAULT_TENANT;
  if (!principalTenantIds || principalTenantIds.length === 0) return DEFAULT_TENANT;
  if (principalTenantIds.includes(WILDCARD)) return DEFAULT_TENANT;
  if (principalTenantIds.length === 1) return principalTenantIds[0]!;
  return DEFAULT_TENANT;
}

/**
 * 解析环境变量 SOLOFORGE_TENANT_BINDINGS
 * 格式: 'kid1:t1,kid2:t1+t2,kid3:*'
 * 解析为 { kid: [t1], kid2: [t1, t2], kid3: [*] }
 */
export function parseBindings(raw: string | undefined): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (!raw) return out;
  for (const pair of raw.split(',')) {
    const [kid, list] = pair.split(':');
    if (!kid || !list) continue;
    out[kid.trim()] = list.split('+').map((s) => s.trim()).filter(Boolean);
  }
  return out;
}
