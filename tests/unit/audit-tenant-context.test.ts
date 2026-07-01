/**
 * tests/unit/audit-tenant-context.test.ts
 *
 * 覆盖:
 *   - isValidTenantId
 *   - extractTenantId (header / path)
 *   - checkTenantAccess (wildcard / explicit / cross_tenant)
 *   - pickDefaultTenant
 *   - parseBindings
 */
import { describe, it, expect } from 'vitest';
import {
  isValidTenantId,
  extractTenantId,
  checkTenantAccess,
  pickDefaultTenant,
  parseBindings,
} from '../../src/security/tenantContext';

describe('tenantContext.isValidTenantId', () => {
  it('accepts typical ids', () => {
    expect(isValidTenantId('_default')).toBe(true);
    expect(isValidTenantId('t1')).toBe(true);
    expect(isValidTenantId('Tenant-1_v2')).toBe(true);
    expect(isValidTenantId('a'.repeat(64))).toBe(true);
  });
  it('rejects invalid ids', () => {
    expect(isValidTenantId('')).toBe(false);
    expect(isValidTenantId('a'.repeat(65))).toBe(false);
    expect(isValidTenantId('tenant with space')).toBe(false);
    expect(isValidTenantId('tenant/with/slash')).toBe(false);
    expect(isValidTenantId('../etc/passwd')).toBe(false);
  });
});

describe('tenantContext.extractTenantId', () => {
  it('prefers path over header', () => {
    const t = extractTenantId(
      '/api/t/acme/agents',
      { 'x-tenant-id': 'globex' } as any,
      {},
    );
    expect(t).toBe('acme');
  });

  it('falls back to header', () => {
    const t = extractTenantId(
      '/api/agents',
      { 'x-tenant-id': 'globex' } as any,
      {},
    );
    expect(t).toBe('globex');
  });

  it('returns undefined when neither', () => {
    expect(extractTenantId('/api/agents', {} as any, {})).toBeUndefined();
  });

  it('rejects invalid header (path wins)', () => {
    expect(extractTenantId('/api/t/ok/x', { 'x-tenant-id': '..' } as any, {})).toBe('ok');
  });

  it('respects custom header / prefix', () => {
    const t = extractTenantId(
      '/tenant/acme/agents',
      { 'x-org': 'globex' } as any,
      { headerName: 'X-Org', pathPrefix: '/tenant/' },
    );
    expect(t).toBe('acme');
  });

  it('handles array headers (takes first valid)', () => {
    const t = extractTenantId(
      '/api/agents',
      { 'x-tenant-id': ['globex', 'other'] } as any,
      {},
    );
    expect(t).toBe('globex');
  });
});

describe('tenantContext.checkTenantAccess', () => {
  it('wildcard allows any', () => {
    expect(checkTenantAccess(['*'], 't1').ok).toBe(true);
    expect(checkTenantAccess(['*'], 'anything').ok).toBe(true);
  });

  it('undefined tenantIds = wildcard (admin-like)', () => {
    expect(checkTenantAccess(undefined, 't1').ok).toBe(true);
    expect(checkTenantAccess([], 't1').ok).toBe(true);
  });

  it('explicit array requires exact match', () => {
    expect(checkTenantAccess(['t1', 't2'], 't1').ok).toBe(true);
    expect(checkTenantAccess(['t1', 't2'], 't2').ok).toBe(true);
    expect(checkTenantAccess(['t1', 't2'], 't3').ok).toBe(false);
  });

  it('rejects malformed tenantId', () => {
    const r = checkTenantAccess(['t1'], '..');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('invalid_id');
  });

  it('reason reflects decision', () => {
    expect(checkTenantAccess(['*'], 't1').reason).toBe('wildcard');
    expect(checkTenantAccess(['t1'], 't1').reason).toBe('explicit');
    expect(checkTenantAccess(['t1'], 't2').reason).toBe('cross_tenant');
  });
});

describe('tenantContext.pickDefaultTenant', () => {
  it('admin → _default', () => {
    expect(pickDefaultTenant(['t1', 't2'], 'admin')).toBe('_default');
    expect(pickDefaultTenant(undefined, 'admin')).toBe('_default');
  });

  it('operator (single tenant) → that tenant', () => {
    expect(pickDefaultTenant(['t1'], 'operator')).toBe('t1');
  });

  it('operator (multi tenant) → _default', () => {
    expect(pickDefaultTenant(['t1', 't2'], 'operator')).toBe('_default');
  });

  it('wildcard operator → _default', () => {
    expect(pickDefaultTenant(['*'], 'operator')).toBe('_default');
  });

  it('public → _default', () => {
    expect(pickDefaultTenant(['t1'], 'public')).toBe('_default');
  });
});

describe('tenantContext.parseBindings', () => {
  it('parses comma-separated kid:tenant+tenant', () => {
    const r = parseBindings('kid1:t1,kid2:t1+t2,kid3:*');
    expect(r).toEqual({
      kid1: ['t1'],
      kid2: ['t1', 't2'],
      kid3: ['*'],
    });
  });

  it('handles empty input', () => {
    expect(parseBindings(undefined)).toEqual({});
    expect(parseBindings('')).toEqual({});
  });

  it('skips malformed entries', () => {
    const r = parseBindings('kid1:t1,malformed,noColon:t2');
    expect(r).toEqual({ kid1: ['t1'], noColon: ['t2'] });
  });

  it('trims whitespace', () => {
    const r = parseBindings('  kid1 : t1 + t2  ');
    expect(r).toEqual({ kid1: ['t1', 't2'] });
  });
});
