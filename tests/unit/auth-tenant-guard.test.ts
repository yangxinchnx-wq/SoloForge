/**
 * tests/unit/auth-tenant-guard.test.ts
 *
 * 覆盖:
 *   - extractTenantId 在 evaluateRequest / evaluateRequestAsync 链路里的集成
 *   - public 路由: anonymous principal, activeTenantId = '_default'
 *   - loopback: admin 默认 ['*'], tenant 默认 '_default'
 *   - tenant 路径 /api/t/{id}/...: 提取成功
 *   - 跨租户 403 (cross_tenant_access) 在 token bearer 路径上
 *
 * Vault 被 mock 掉, 简化 token 测试 (不依赖 keytar)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockVault } = vi.hoisted(() => ({ mockVault: new Map<string, any>() }));

vi.mock('../../src/security/apiKeyVault', () => ({
  apiKeyVault: {
    init: vi.fn(async () => undefined),
    getKey: vi.fn(async (id: string) => {
      const v = mockVault.get(id);
      return v ? { apiKey: v, baseUrl: 'vault://test', source: 'keychain' as const } : null;
    }),
    setKey: vi.fn(async (id: string, v: string) => mockVault.set(id, v)),
    deleteKey: vi.fn(async (id: string) => mockVault.delete(id)),
    flush: vi.fn(),
  },
}));

import {
  evaluateRequestAsync,
  defaultAuthConfig,
  type AuthConfig,
} from '../../src/security/auth';
import { extractTenantId } from '../../src/security/tenantContext';

const cfgNoTokens: AuthConfig = {
  ...defaultAuthConfig,
  apiTokens: [],
  trustLoopback: true, // 测试用 loopback
};

/** 把 headers + path 转成 evaluateRequestAsync 用的 input (含 requestedTenantId) */
function withExtractedTenant(reqPath: string, headers: any, remoteAddress: string, extras: any = {}) {
  const requestedTenantId = extractTenantId(reqPath, headers, {});
  return {
    reqPath, method: 'GET', headers, query: {}, remoteAddress,
    requestedTenantId,
    ...extras,
  };
}

describe('auth — tenant context integration', () => {
  beforeEach(() => {
    mockVault.clear();
  });

  it('public 路由 → anonymous, activeTenantId = _default', async () => {
    const r = await evaluateRequestAsync({
      reqPath: '/api/health',
      method: 'GET',
      headers: {} as any,
      query: {},
      remoteAddress: '1.2.3.4', // 非 loopback, 走 public
    }, cfgNoTokens);
    expect(r.allow).toBe(true);
    expect(r.principal?.source).toBe('anonymous');
    expect(r.principal?.activeTenantId).toBe('_default');
  });

  it('loopback → admin (默认 wildcard), tenant 默认 _default', async () => {
    const r = await evaluateRequestAsync({
      reqPath: '/api/agents',
      method: 'GET',
      headers: {} as any,
      query: {},
      remoteAddress: '127.0.0.1',
    }, cfgNoTokens);
    expect(r.allow).toBe(true);
    expect(r.principal?.role).toBe('admin');
    expect(r.principal?.activeTenantId).toBe('_default');
  });

  it('loopback + header X-Tenant-Id=acme → 接受, principal.activeTenantId=acme', async () => {
    const input = withExtractedTenant('/api/agents', { 'x-tenant-id': 'acme' } as any, '127.0.0.1');
    const r = await evaluateRequestAsync(input, cfgNoTokens);
    expect(r.allow).toBe(true);
    expect(r.principal?.activeTenantId).toBe('acme');
  });

  it('loopback + 非法 tenant id (e.g. "../") → 403 invalid_tenant_id', async () => {
    // 显式设置非法 tenant id (绕过 extractTenantId 的格式校验)
    const input = withExtractedTenant('/api/agents', {} as any, '127.0.0.1');
    input.requestedTenantId = '../etc';
    const r = await evaluateRequestAsync(input, cfgNoTokens);
    expect(r.allow).toBe(false);
    expect(r.status).toBe(403);
    expect(r.reason).toBe('invalid_tenant_id');
    expect(r.crossTenant).toBe(true);
  });

  it('path /api/t/{id}/... 提取 tenantId', async () => {
    const input = withExtractedTenant('/api/t/globex/agents', {} as any, '127.0.0.1');
    const r = await evaluateRequestAsync(input, cfgNoTokens);
    expect(r.allow).toBe(true);
    expect(r.principal?.activeTenantId).toBe('globex');
  });

  it('vault token: tenantBindings [t1], 请求 t2 → 403 cross_tenant', async () => {
    // 不用 env apiTokens, 走 vault 路径 (有 kid)
    const { createToken } = await import('../../src/security/tokenStore');
    await import('../../src/security/tokenStore').then((m) => m.tokenStoreInit());
    const t = await createToken({ source: 'init' });
    const cfgVaultOnly: AuthConfig = {
      ...defaultAuthConfig,
      apiTokens: [], // 不放 env, 走 vault 路径
      trustLoopback: false,
    };
    const input = withExtractedTenant(
      '/api/agents',
      { authorization: 'Bearer ' + t.token } as any,
      '10.0.0.1', // 非 loopback
      { tenantBindings: { [t.kid]: ['t1'] } },
    );
    input.requestedTenantId = 't2';
    const r = await evaluateRequestAsync(input, cfgVaultOnly);
    expect(r.allow).toBe(false);
    expect(r.status).toBe(403);
    expect(r.reason).toBe('cross_tenant_access');
    expect(r.crossTenant).toBe(true);
  });

  it('vault token: tenantBindings [t1, t2], 请求 t1 → 200 + activeTenantId=t1', async () => {
    const { createToken } = await import('../../src/security/tokenStore');
    const t = await createToken({ source: 'init' });
    const cfgVaultOnly: AuthConfig = {
      ...defaultAuthConfig,
      apiTokens: [],
      trustLoopback: false,
    };
    const input = withExtractedTenant(
      '/api/agents',
      { authorization: 'Bearer ' + t.token } as any,
      '10.0.0.1',
      { tenantBindings: { [t.kid]: ['t1', 't2'] } },
    );
    input.requestedTenantId = 't1';
    const r = await evaluateRequestAsync(input, cfgVaultOnly);
    expect(r.allow).toBe(true);
    expect(r.principal?.activeTenantId).toBe('t1');
    expect(r.principal?.tenantIds).toEqual(['t1', 't2']);
    expect(r.principal?.kid).toBe(t.kid);
  });

  it('vault token: 没绑定 → 走 ["*"], 任何 tenant 都放行', async () => {
    const { createToken } = await import('../../src/security/tokenStore');
    const t = await createToken({ source: 'init' });
    const cfgVaultOnly: AuthConfig = {
      ...defaultAuthConfig,
      apiTokens: [],
      trustLoopback: false,
    };
    const input = withExtractedTenant(
      '/api/agents',
      { authorization: 'Bearer ' + t.token } as any,
      '10.0.0.1',
    );
    input.requestedTenantId = 'anything';
    // 不传 tenantBindings → 缺省 wildcard
    const r = await evaluateRequestAsync(input, cfgVaultOnly);
    expect(r.allow).toBe(true);
    expect(r.principal?.activeTenantId).toBe('anything');
  });
});
