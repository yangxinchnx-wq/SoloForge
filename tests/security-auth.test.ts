import { describe, it, expect } from 'vitest';
import {
  evaluateRequest,
  corsHeadersFor,
  safeJoin,
  defaultAuthConfig,
  AuthConfig,
} from '../src/security/auth';

const cfg: AuthConfig = {
  ...defaultAuthConfig,
  apiTokens: ['secret-token-1', 'secret-token-2'],
  allowedOrigins: ['http://localhost:5173'],
  trustLoopback: true,
  publicRoutes: ['/api/health', '/', '/ui'],
};

function h(origin?: string, auth?: string): Record<string, any> {
  const out: Record<string, any> = {};
  if (origin) out['origin'] = origin;
  if (auth) out['authorization'] = auth;
  return out;
}

describe('auth.evaluateRequest', () => {
  it('allows OPTIONS preflight for whitelisted origin', () => {
    const r = evaluateRequest(
      { reqPath: '/api/vault/keys', method: 'OPTIONS', headers: h('http://localhost:5173'), query: {} },
      cfg,
    );
    expect(r.allow).toBe(true);
    expect(r.status).toBe(204);
    expect(r.corsOrigin).toBe('http://localhost:5173');
  });

  it('denies OPTIONS from a non-whitelisted origin (corsOrigin null)', () => {
    const r = evaluateRequest(
      { reqPath: '/api/vault/keys', method: 'OPTIONS', headers: h('http://evil.example.com'), query: {} },
      cfg,
    );
    expect(r.corsOrigin).toBeNull();
  });

  it('allows public routes without auth', () => {
    const r = evaluateRequest(
      { reqPath: '/api/health', method: 'GET', headers: {}, query: {} },
      cfg,
    );
    expect(r.allow).toBe(true);
  });

  it('denies vault routes with no token', () => {
    const r = evaluateRequest(
      { reqPath: '/api/vault/keys', method: 'GET', headers: {}, query: {} },
      cfg,
    );
    expect(r.allow).toBe(false);
    expect(r.status).toBe(401);
  });

  it('accepts a valid bearer token for vault', () => {
    const r = evaluateRequest(
      { reqPath: '/api/vault/keys', method: 'GET', headers: h(undefined, 'Bearer secret-token-1'), query: {} },
      cfg,
    );
    expect(r.allow).toBe(true);
    expect(r.principal?.role).toBe('operator');
  });

  it('rejects an invalid bearer token', () => {
    const r = evaluateRequest(
      { reqPath: '/api/vault/keys', method: 'GET', headers: h(undefined, 'Bearer wrong-token'), query: {} },
      cfg,
    );
    expect(r.allow).toBe(false);
  });

  it('accepts ?token= query for SSE', () => {
    const r = evaluateRequest(
      { reqPath: '/api/vault/keys', method: 'GET', headers: {}, query: { token: 'secret-token-2' } },
      cfg,
    );
    expect(r.allow).toBe(true);
  });

  it('trusts loopback as admin when enabled', () => {
    const r = evaluateRequest(
      { reqPath: '/api/vault/keys', method: 'GET', headers: {}, query: {}, remoteAddress: '127.0.0.1' },
      cfg,
    );
    expect(r.allow).toBe(true);
    expect(r.principal?.role).toBe('admin');
  });

  it('does not trust loopback when disabled', () => {
    const noLoop: AuthConfig = { ...cfg, trustLoopback: false };
    const r = evaluateRequest(
      { reqPath: '/api/vault/keys', method: 'GET', headers: {}, query: {}, remoteAddress: '127.0.0.1' },
      noLoop,
    );
    expect(r.allow).toBe(false);
  });

  it('rejects bearer header that exceeds max length', () => {
    const long = 'Bearer ' + 'a'.repeat(5000);
    const r = evaluateRequest(
      { reqPath: '/api/vault/keys', method: 'GET', headers: h(undefined, long), query: {} },
      cfg,
    );
    expect(r.allow).toBe(false);
  });
});

describe('auth.corsHeadersFor', () => {
  it('echoes whitelisted origin with Vary', () => {
    const h2 = corsHeadersFor(h('http://localhost:5173'), cfg);
    expect(h2['Access-Control-Allow-Origin']).toBe('http://localhost:5173');
    expect(h2['Vary']).toBe('Origin');
  });

  it('falls back to first allowed origin when unknown', () => {
    const h2 = corsHeadersFor(h('http://unknown.com'), cfg);
    expect(h2['Access-Control-Allow-Origin']).toBe('http://localhost:5173');
  });
});

describe('auth.safeJoin (path-traversal defense)', () => {
  const sandbox = process.cwd();

  it('resolves a normal path', () => {
    const r = safeJoin(sandbox, 'src/ui/index.html');
    expect(r).not.toBeNull();
    expect(r!.endsWith('index.html')).toBe(true);
  });

  it('rejects ../ traversal', () => {
    expect(safeJoin(sandbox, '../package.json')).toBeNull();
  });

  it('rejects deeply nested ../ traversal', () => {
    expect(safeJoin(sandbox, 'a/../../../../etc/passwd')).toBeNull();
  });

  it('rejects absolute paths', () => {
    expect(safeJoin(sandbox, '/etc/passwd')).toBeNull();
    expect(safeJoin(sandbox, 'C:\\Windows\\System32')).toBeNull();
  });

  it('rejects empty / overlong input', () => {
    expect(safeJoin(sandbox, '')).toBeNull();
    expect(safeJoin(sandbox, 'a'.repeat(300))).toBeNull();
  });
});