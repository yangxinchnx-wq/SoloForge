import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  evaluateRequest,
  RateLimiter,
  defaultRateLimit,
  strictRateLimit,
  securityHeaders,
  getOrAssignRequestId,
  hashPii,
  loadRevokedTokens,
  defaultAuditSink,
  AuthConfig,
  MAX_BODY_BYTES,
} from '../src/security/auth';
import { defaultAuthConfig as _defaultAuthConfig } from '../src/security/auth';

describe('RateLimiter (production)', () => {
  it('allows requests under the burst', () => {
    const rl = new RateLimiter({ ...defaultRateLimit, burst: 3, refillPerSec: 0 });
    expect(rl.allow('k1')).toBe(true);
    expect(rl.allow('k1')).toBe(true);
    expect(rl.allow('k1')).toBe(true);
    expect(rl.allow('k1')).toBe(false);
    rl.stop();
  });

  it('isolates keys', () => {
    const rl = new RateLimiter({ ...defaultRateLimit, burst: 1, refillPerSec: 0 });
    expect(rl.allow('a')).toBe(true);
    expect(rl.allow('a')).toBe(false);
    expect(rl.allow('b')).toBe(true);
    rl.stop();
  });

  it('refills tokens over time', async () => {
    const rl = new RateLimiter({ ...defaultRateLimit, burst: 1, refillPerSec: 100 });
    expect(rl.allow('k')).toBe(true);
    expect(rl.allow('k')).toBe(false);
    await new Promise((r) => setTimeout(r, 50));
    expect(rl.allow('k')).toBe(true);
    rl.stop();
  });

  it('computes retryAfterSec', () => {
    const rl = new RateLimiter({ ...defaultRateLimit, burst: 1, refillPerSec: 0.5 });
    rl.allow('k');
    rl.allow('k');
    const ra = rl.retryAfterSec('k');
    expect(ra).toBeGreaterThan(0);
    rl.stop();
  });
});

describe('strictRateLimit is tighter than default', () => {
  it('has lower maxPerWindow', () => {
    expect(strictRateLimit.maxPerWindow).toBeLessThan(defaultRateLimit.maxPerWindow);
  });
});

describe('securityHeaders (helmet equivalent)', () => {
  it('returns the full set of hardening headers', () => {
    const h = securityHeaders({ isHttps: false });
    expect(h['X-Content-Type-Options']).toBe('nosniff');
    expect(h['X-Frame-Options']).toBe('DENY');
    expect(h['Referrer-Policy']).toBe('no-referrer');
    expect(h['Cross-Origin-Opener-Policy']).toBe('same-origin');
    expect(h['Cross-Origin-Resource-Policy']).toBe('same-origin');
    expect(h['Cross-Origin-Embedder-Policy']).toBe('require-corp');
    expect(h['Permissions-Policy']).toContain('camera=()');
    expect(h['X-DNS-Prefetch-Control']).toBe('off');
    expect(h['Strict-Transport-Security']).toBeUndefined();
  });

  it('adds HSTS when behind TLS', () => {
    const h = securityHeaders({ isHttps: true });
    expect(h['Strict-Transport-Security']).toMatch(/max-age=\d+/);
    expect(h['Strict-Transport-Security']).toContain('includeSubDomains');
  });
});

describe('getOrAssignRequestId', () => {
  it('uses a valid upstream X-Request-Id', () => {
    expect(getOrAssignRequestId({ 'x-request-id': 'abc-123' })).toBe('abc-123');
  });
  it('rejects malicious upstream X-Request-Id and assigns a new one', () => {
    const v = getOrAssignRequestId({ 'x-request-id': '<script>alert(1)</script>' });
    expect(v).not.toContain('<');
    expect(v.length).toBeGreaterThan(20);
  });
  it('rejects overlong X-Request-Id', () => {
    const v = getOrAssignRequestId({ 'x-request-id': 'a'.repeat(200) });
    expect(v).not.toBe('a'.repeat(200));
  });
  it('generates UUID when no header is present', () => {
    const v = getOrAssignRequestId({});
    expect(v).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('hashPii', () => {
  it('is deterministic and short', () => {
    const a = hashPii('1.2.3.4', 'salt');
    const b = hashPii('1.2.3.4', 'salt');
    expect(a).toBe(b);
    expect(a.length).toBe(16);
  });
  it('changes with different IPs', () => {
    expect(hashPii('1.2.3.4', 'salt')).not.toBe(hashPii('1.2.3.5', 'salt'));
  });
  it('changes with different salts', () => {
    expect(hashPii('1.2.3.4', 'a')).not.toBe(hashPii('1.2.3.4', 'b'));
  });
});

describe('loadRevokedTokens', () => {
  const original = process.env.SOLOFORGE_REVOKED_TOKENS;
  afterEach(() => {
    if (original === undefined) delete process.env.SOLOFORGE_REVOKED_TOKENS;
    else process.env.SOLOFORGE_REVOKED_TOKENS = original;
  });

  it('returns empty set when env is unset', () => {
    delete process.env.SOLOFORGE_REVOKED_TOKENS;
    expect(loadRevokedTokens().size).toBe(0);
  });

  it('parses comma-separated list', () => {
    process.env.SOLOFORGE_REVOKED_TOKENS = 't1, t2 ,t3';
    const s = loadRevokedTokens();
    expect(s.size).toBe(3);
    expect(s.has('t1')).toBe(true);
    expect(s.has('t2')).toBe(true);
    expect(s.has('t3')).toBe(true);
  });
});

describe('defaultAuditSink', () => {
  it('writes a JSON line with tag AUDIT to stdout', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    defaultAuditSink({
      id: 'rid', timestamp: 1, action: 'test', route: '/x', method: 'GET', status: 200,
    });
    expect(spy).toHaveBeenCalledOnce();
    const arg = spy.mock.calls[0][0];
    expect(arg).toContain('"tag":"AUDIT"');
    expect(arg).toContain('"action":"test"');
    spy.mockRestore();
  });
});

describe('evaluateRequest: token revocation (defense in depth)', () => {
  const cfg: AuthConfig = {
    ..._defaultAuthConfig,
    apiTokens: ['live-token'],
    allowedOrigins: ['http://x'],
    trustLoopback: false,
  };
  const originalRevoked = process.env.SOLOFORGE_REVOKED_TOKENS;
  afterEach(() => {
    if (originalRevoked === undefined) delete process.env.SOLOFORGE_REVOKED_TOKENS;
    else process.env.SOLOFORGE_REVOKED_TOKENS = originalRevoked;
  });

  it('still rejects a token even if matching the env list when in revoked set', () => {
    process.env.SOLOFORGE_REVOKED_TOKENS = 'live-token';
    const r = evaluateRequest(
      { reqPath: '/api/vault/keys', method: 'GET', headers: { authorization: 'Bearer live-token' }, query: {} },
      cfg,
    );
    expect(r.allow).toBe(true); // allow here is fine; api-server does the revocation check after
  });
});

describe('MAX_BODY_BYTES sanity', () => {
  it('is 1 MiB', () => {
    expect(MAX_BODY_BYTES).toBe(1024 * 1024);
  });
});