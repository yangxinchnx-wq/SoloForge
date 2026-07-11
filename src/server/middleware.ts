// ────────────────────────────────────────────────────────────
// SoloForge API Server — Middleware Layer
// Path: src/server/middleware.ts
//
// Extracts the security / auth / rate-limit / tenant-context
// pipeline from the monolithic handleRequest().
// ────────────────────────────────────────────────────────────

import http from 'http';
import {
  evaluateRequestAsync,
  corsHeadersFor,
  securityHeaders,
  MAX_BODY_BYTES,
  getOrAssignRequestId,
  hashPii,
  loadRevokedTokens,
  type AuthConfig,
  type AuditSink,
  type RateLimiter,
} from '../security/auth';
import type { TenantContextConfig } from '../security/tenantContext';
import { extractTenantId } from '../security/tenantContext';
import type { MiddlewareContext, ApiResponse } from './types';

/**
 * Parse the HTTP request body (JSON only, size-capped).
 * Returns the parsed object, null for empty bodies, or
 * the sentinel string '__TOO_LARGE__' if the limit is exceeded.
 */
export function parseBody(
  req: http.IncomingMessage,
  maxBytes: number = MAX_BODY_BYTES,
): Promise<any> {
  return new Promise((resolve) => {
    let size = 0;
    let data = '';
    let aborted = false;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        aborted = true;
        resolve('__TOO_LARGE__');
        try { req.destroy(); } catch { /* ignore */ }
        return;
      }
      data += chunk.toString('utf8');
    });
    req.on('end', () => {
      if (aborted) return;
      try {
        resolve(data ? JSON.parse(data) : null);
      } catch {
        resolve(null);
      }
    });
    req.on('error', () => { if (!aborted) resolve(null); });
  });
}

// ------------------------------------------------------------
// Dependencies the middleware needs from the server instance.
// Passed once at construction; avoids circular imports.
// ------------------------------------------------------------

export interface MiddlewareDeps {
  port: number;
  authConfig: AuthConfig;
  rateLimiter: RateLimiter;
  strictRateLimiter: RateLimiter;
  piiSalt: string;
  audit: AuditSink;
  tenantCtxConfig: TenantContextConfig;
  getTenantBindings: () => Record<string, string[]>;
}

/**
 * Run the full pre-route security pipeline:
 *   1. Security headers + CORS
 *   2. OPTIONS short-circuit
 *   3. IP rate limiting
 *   4. Body parsing (POST/PUT/DELETE)
 *   5. Auth / token evaluation
 *   6. Sensitive-route strict rate limiting
 *   7. Revoked-token check
 *
 * Returns:
 *   - { done: true, response } — caller should send `response` and stop.
 *   - { done: false, ctx }     — caller should continue to `route(ctx.apiReq)`.
 */
export async function runMiddleware(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: MiddlewareDeps,
): Promise<{ done: true; response: ApiResponse } | { done: false; ctx: MiddlewareContext }> {
  const { port, authConfig, rateLimiter, strictRateLimiter, piiSalt, audit, tenantCtxConfig, getTenantBindings } = deps;

  // --- Security headers + CORS ---
  const isHttps = (req.socket as any)?.encrypted === true;
  const sec = securityHeaders({ isHttps });
  for (const [k, v] of Object.entries(sec)) res.setHeader(k, v);
  const cors = corsHeadersFor(req.headers, authConfig);
  for (const [k, v] of Object.entries(cors)) res.setHeader(k, v);
  res.setHeader('Access-Control-Allow-Credentials', 'false');

  // --- OPTIONS ---
  if (req.method === 'OPTIONS') {
    return { done: true, response: { status: 204, headers: {}, body: null } };
  }

  // --- Basic request metadata ---
  const url = new URL(req.url || '/', `http://localhost:${port}`);
  const reqPath = url.pathname;
  const method = req.method || 'GET';
  const requestId = getOrAssignRequestId(req.headers);
  res.setHeader('X-Request-Id', requestId);
  const userAgent = String(req.headers['user-agent'] || '').slice(0, 256);
  const remoteAddress = req.socket?.remoteAddress;
  const ipHash = remoteAddress ? hashPii(remoteAddress, piiSalt) : undefined;

  // --- Tenant context ---
  const requestedTenantId = extractTenantId(reqPath, req.headers, tenantCtxConfig);

  // --- IP rate limit ---
  const ipKey = `ip:${remoteAddress || 'unknown'}`;
  if (!rateLimiter.allow(ipKey)) {
    const ra = rateLimiter.retryAfterSec(ipKey);
    audit({
      id: requestId, timestamp: Date.now(),
      action: 'rate.limit.ip', route: reqPath, method, status: 429,
      remoteAddress: ipHash, userAgent, reason: 'rate_limit_ip',
      tenantId: requestedTenantId,
    });
    return {
      done: true,
      response: {
        status: 429,
        headers: { 'Content-Type': 'application/json', 'Retry-After': String(ra) },
        body: { error: 'Too Many Requests', retryAfter: ra },
      },
    };
  }

  // --- Body parsing ---
  let body: any = null;
  if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
    const ct = String(req.headers['content-type'] || '').toLowerCase();
    if (ct.length > 0 && !ct.includes('application/json')) {
      return { done: true, response: { status: 415, headers: { 'Content-Type': 'application/json' }, body: { error: 'Unsupported Media Type' } } };
    }
    body = await parseBody(req, MAX_BODY_BYTES);
    if (body === '__TOO_LARGE__') {
      audit({
        id: requestId, timestamp: Date.now(),
        action: 'body.too_large', route: reqPath, method, status: 413,
        remoteAddress: ipHash, userAgent,
        tenantId: requestedTenantId,
      });
      return { done: true, response: { status: 413, headers: { 'Content-Type': 'application/json' }, body: { error: 'Payload Too Large' } } };
    }
  }

  const apiReq = {
    method, url: req.url || '/', path: reqPath,
    query: Object.fromEntries(url.searchParams),
    body, headers: req.headers, remoteAddress,
  };

  // --- Auth / token evaluation ---
  const guard = await evaluateRequestAsync({
    reqPath, method, headers: req.headers, query: apiReq.query, remoteAddress,
    requestedTenantId, tenantBindings: getTenantBindings(),
  }, authConfig);

  if (!guard.allow) {
    if (guard.reuseDetected) {
      (audit as any)({ id: requestId, timestamp: Date.now(), action: 'auth.reuse_detected', route: reqPath, method, status: guard.status, remoteAddress: ipHash, userAgent, reason: guard.reason, autoRevokedTokens: (guard as any).autoRevokedTokens, tenantId: requestedTenantId });
    } else if (guard.crossTenant) {
      audit({ id: requestId, timestamp: Date.now(), action: 'tenant.cross', route: reqPath, method, status: guard.status, remoteAddress: ipHash, userAgent, reason: guard.reason, tenantId: requestedTenantId });
    } else {
      audit({ id: requestId, timestamp: Date.now(), action: 'auth.fail', route: reqPath, method, status: guard.status, remoteAddress: ipHash, userAgent, reason: guard.reason, tenantId: requestedTenantId });
    }
    const resBody: any = { error: guard.status === 403 ? 'Forbidden' : 'Unauthorized', reason: guard.reason };
    if (guard.reuseDetected) resBody.reuseDetected = true;
    if (guard.crossTenant) resBody.crossTenant = true;
    return { done: true, response: { status: guard.status, headers: { 'Content-Type': 'application/json' }, body: resBody } };
  }

  const effectiveTenantId = guard.principal?.activeTenantId ?? requestedTenantId ?? '_default';

  // --- Sensitive-route strict rate limit ---
  const isSensitive = reqPath.startsWith('/api/vault') || reqPath.startsWith('/api/admin');
  if (isSensitive) {
    const idKey = `id:${guard.principal?.id || ipKey}`;
    if (!strictRateLimiter.allow(idKey)) {
      const ra = strictRateLimiter.retryAfterSec(idKey);
      audit({ id: requestId, timestamp: Date.now(), principal: guard.principal, action: 'rate.limit.sensitive', route: reqPath, method, status: 429, remoteAddress: ipHash, userAgent, tenantId: effectiveTenantId });
      return { done: true, response: { status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': String(ra) }, body: { error: 'Too Many Requests', retryAfter: ra } } };
    }
  }

  // --- Revoked token check ---
  const bearer = String(req.headers['authorization'] || '').replace(/^Bearer\s+/i, '').trim();
  if (bearer && loadRevokedTokens().has(bearer)) {
    audit({ id: requestId, timestamp: Date.now(), principal: guard.principal, action: 'auth.revoked', route: reqPath, method, status: 401, remoteAddress: ipHash, userAgent, reason: 'token_revoked', tenantId: effectiveTenantId });
    return { done: true, response: { status: 401, headers: { 'Content-Type': 'application/json' }, body: { error: 'Unauthorized', reason: 'token_revoked' } } };
  }

  return {
    done: false,
    ctx: { requestId, reqPath, method, userAgent, remoteAddress, ipHash, requestedTenantId, effectiveTenantId, apiReq },
  };
}
