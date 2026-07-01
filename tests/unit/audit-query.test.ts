/**
 * auditQuery 单元测试
 *
 * 验证:
 *   1. WHERE 拼接正确
 *   2. 时间范围 7 天上限保护
 *   3. limit 上限 500
 *   4. 复杂条件: action 前缀 + 时间窗 + reuseOnly
 */

import { describe, it, expect, vi } from 'vitest';
import { normalizeQuery, queryAuditLog, countAuditLog, type AuditQuery } from '../../src/security/auditQuery';
import type { SurrealPersistenceLike } from '../../src/security/auditSinkSurreal';

function makeSp(rows: any[] = []): SurrealPersistenceLike {
  return {
    query: vi.fn(async (sql: string, bindings?: any) => {
      // 简单分桶: SELECT count 返回 [[{c:N}]], SELECT * 返回 [[...rows]]
      if (sql.startsWith('SELECT count()')) {
        return [[{ c: rows.length }]];
      }
      return [rows];
    }),
    isReady: () => true,
  };
}

describe('auditQuery — normalizeQuery', () => {
  it('空查询 → 无 WHERE, 限制默认 100', () => {
    const r = normalizeQuery({});
    expect(r.where).toEqual([]);
    expect(r.limit).toBe(100);
    expect(r.bindings).toEqual({});
  });

  it('action 用 string::starts_with, route 用精确', () => {
    const r = normalizeQuery({ action: 'auth.fail', route: '/api/vault' });
    expect(r.where).toContain('string::starts_with(action, $action)');
    expect(r.where).toContain('route = $route');
    expect(r.bindings.action).toBe('auth.fail');
    expect(r.bindings.route).toBe('/api/vault');
  });

  it('status/principalId 精确', () => {
    const r = normalizeQuery({ status: 401, principalId: 'token:k_abc' });
    expect(r.where).toContain('status = $status');
    expect(r.where).toContain('principalId = $principalId');
    expect(r.bindings.status).toBe(401);
  });

  it('since/until 转 ISO 字符串', () => {
    const r = normalizeQuery({ since: 1_700_000_000_000, until: 1_700_000_001_000 });
    expect(r.bindings.since).toBe(new Date(1_700_000_000_000).toISOString());
    expect(r.bindings.until).toBe(new Date(1_700_000_001_000).toISOString());
  });

  it('reuseOnly=true → where 加上 reuseDetected = true', () => {
    const r = normalizeQuery({ reuseOnly: true });
    expect(r.where).toContain('reuseDetected = true');
  });

  it('limit 超过 500 → clamp 到 500', () => {
    const r = normalizeQuery({ limit: 9999 });
    expect(r.limit).toBe(500);
  });

  it('limit < 1 → clamp 到 1', () => {
    const r = normalizeQuery({ limit: 0 });
    expect(r.limit).toBe(1);
  });

  it('时间范围超过 7 天 → 抛错', () => {
    expect(() => normalizeQuery({
      since: 1_700_000_000_000,
      until: 1_700_000_000_000 + 8 * 86400_000,
    })).toThrow(/7 days/);
  });

  it('时间范围 7 天内 → 允许', () => {
    expect(() => normalizeQuery({
      since: 1_700_000_000_000,
      until: 1_700_000_000_000 + 7 * 86400_000,
    })).not.toThrow();
  });
});

describe('auditQuery — queryAuditLog / countAuditLog', () => {
  it('queryAuditLog 走 SELECT * + 排序 + limit', async () => {
    const sp = makeSp([{ id: 'r1', action: 'auth.fail' }]);
    const items = await queryAuditLog(sp, { action: 'auth.fail', limit: 50 });
    expect(items.length).toBe(1);
    expect(items[0].id).toBe('r1');
    expect(items[0].action).toBe('auth.fail');
    // 验证 sp.query 收到正确的 sql
    const calls = (sp.query as any).mock.calls;
    const [sql, bindings] = calls[calls.length - 1];
    expect(sql).toContain('SELECT * FROM httpAuditLog');
    expect(sql).toContain('ORDER BY timestamp DESC');
    expect(sql).toContain('LIMIT $limit');
    expect(bindings.limit).toBe(50);
    expect(bindings.action).toBe('auth.fail');
  });

  it('countAuditLog 走 SELECT count()', async () => {
    const sp = makeSp([{ id: 'r1' }, { id: 'r2' }, { id: 'r3' }]);
    const c = await countAuditLog(sp, {});
    expect(c).toBe(3);
    const calls = (sp.query as any).mock.calls;
    const [sql] = calls[calls.length - 1];
    expect(sql).toContain('SELECT count() AS c FROM httpAuditLog');
  });

  it('复用: 复杂条件 action+reuseOnly+时间', async () => {
    const sp = makeSp([{ id: 'x' }]);
    await queryAuditLog(sp, {
      action: 'auth.reuse',
      reuseOnly: true,
      since: 1_700_000_000_000,
      until: 1_700_000_000_500,
    });
    const [, bindings] = (sp.query as any).mock.calls[0];
    expect(bindings.action).toBe('auth.reuse');
    expect(bindings.since).toBeDefined();
    expect(bindings.until).toBeDefined();
  });
});
