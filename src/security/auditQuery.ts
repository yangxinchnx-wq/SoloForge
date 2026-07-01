/**
 * auditQuery.ts — httpAuditLog 查询助手
 *
 * 提供 admin 鉴权 + 参数化查询, 供 /api/audit/list 使用
 *
 * 过滤维度:
 *   - action       (string, 支持前缀, e.g. 'auth.fail')
 *   - route        (string, 精确)
 *   - status       (int)
 *   - principalId  (string, 精确)
 *   - since/until  (ms epoch)
 *   - reuseOnly    (bool, 仅看复用检测命中)
 *
 * 限制:
 *   - 默认返回最近 100 条, max 500
 *   - 时间范围不超过 7 天
 *   - 结果按 timestamp 倒序
 */

import type { SurrealPersistenceLike } from './auditSinkSurreal';

export interface AuditQuery {
  action?: string;
  route?: string;
  status?: number;
  principalId?: string;
  since?: number; // ms epoch
  until?: number; // ms epoch
  reuseOnly?: boolean;
  limit?: number; // 1..500, 默认 100
  /** 多租户过滤; 不传 = 全部 */
  tenantId?: string;
}

export interface AuditRow {
  id: string;
  timestamp: string;
  action: string;
  route: string;
  method: string;
  status: number;
  principalId: string | null;
  principalRole: string | null;
  principalSource: string | null;
  principalKid: string | null;
  remoteAddressHash: string | null;
  userAgent: string | null;
  reason: string | null;
  reuseDetected: boolean;
  autoRevokedTokens: number | null;
  extra: string | null;
  writtenAt: string;
}

const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 100;
const MAX_SPAN_MS = 7 * 24 * 60 * 60 * 1000; // 7 天

export function normalizeQuery(q: AuditQuery): { where: string[]; bindings: Record<string, any>; limit: number } {
  const where: string[] = [];
  const bindings: Record<string, any> = {};

  if (q.action) {
    where.push('string::starts_with(action, $action)');
    bindings.action = q.action;
  }
  if (q.route) {
    where.push('route = $route');
    bindings.route = q.route;
  }
  if (typeof q.status === 'number') {
    where.push('status = $status');
    bindings.status = q.status;
  }
  if (q.principalId) {
    where.push('principalId = $principalId');
    bindings.principalId = q.principalId;
  }
  if (q.since) {
    where.push('timestamp >= $since');
    bindings.since = new Date(q.since).toISOString();
  }
  if (q.until) {
    where.push('timestamp <= $until');
    bindings.until = new Date(q.until).toISOString();
  }
  if (q.reuseOnly) {
    where.push('reuseDetected = true');
  }
  if (q.tenantId) {
    where.push('tenantId = $tenantId');
    bindings.tenantId = q.tenantId;
  }

  // 范围保护
  if (q.since && q.until && q.until - q.since > MAX_SPAN_MS) {
    throw new Error('time range exceeds 7 days');
  }

  const limit = Math.max(1, Math.min(q.limit ?? DEFAULT_LIMIT, MAX_LIMIT));
  return { where, bindings, limit };
}

export async function queryAuditLog(sp: SurrealPersistenceLike, q: AuditQuery): Promise<AuditRow[]> {
  const { where, bindings, limit } = normalizeQuery(q);
  const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const sql = `SELECT * FROM httpAuditLog ${whereClause} ORDER BY timestamp DESC LIMIT $limit`;
  const result = await sp.query(sql, { ...bindings, limit });
  // SurrealDB 返回 [[...]] 或 {result: [...]} 或 直接数组
  const rows: any[] = Array.isArray(result) && Array.isArray(result[0])
    ? result[0]
    : Array.isArray(result?.result)
      ? result.result
      : Array.isArray(result)
        ? result
        : [];
  return rows.map(coerceRow);
}

export async function countAuditLog(sp: SurrealPersistenceLike, q: Omit<AuditQuery, 'limit'>): Promise<number> {
  const { where, bindings } = normalizeQuery({ ...q, limit: 1 });
  const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const sql = `SELECT count() AS c FROM httpAuditLog ${whereClause} GROUP ALL`;
  const result = await sp.query(sql, bindings);
  const rows: any[] = Array.isArray(result) && Array.isArray(result[0]) ? result[0] : [];
  return Number(rows[0]?.c ?? 0);
}

function coerceRow(r: any): AuditRow {
  return {
    id: String(r.id ?? ''),
    timestamp: String(r.timestamp ?? ''),
    action: String(r.action ?? ''),
    route: String(r.route ?? ''),
    method: String(r.method ?? ''),
    status: Number(r.status ?? 0),
    principalId: r.principalId ?? null,
    principalRole: r.principalRole ?? null,
    principalSource: r.principalSource ?? null,
    principalKid: r.principalKid ?? null,
    remoteAddressHash: r.remoteAddressHash ?? null,
    userAgent: r.userAgent ?? null,
    reason: r.reason ?? null,
    reuseDetected: Boolean(r.reuseDetected ?? false),
    autoRevokedTokens: r.autoRevokedTokens != null ? Number(r.autoRevokedTokens) : null,
    extra: r.extra ?? null,
    writtenAt: String(r.writtenAt ?? ''),
  };
}
