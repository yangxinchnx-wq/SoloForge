// ────────────────────────────────────────────────────────────
// SoloForge API Server — Vault / Admin / Audit Routes
// Path: src/server/routes-vault.ts
//
// Endpoints:
//   GET    /api/auth/bootstrap
//   GET    /api/audit/list
//   GET    /api/audit/stats
//   GET    /api/audit/sinks
//   POST   /api/audit/sinks/config
//   GET    /api/vault/keys
//   GET    /api/vault/keys/:id
//   PUT    /api/vault/keys/:id
//   DELETE /api/vault/keys/:id
//   POST   /api/vault/keys/:id/verify
//   GET    /api/vault/keys/:id/reveal
//   POST   /api/vault/export
//   POST   /api/vault/import
//   POST   /api/vault/verify-passphrase
// ────────────────────────────────────────────────────────────

import type { SurrealPersistence } from '../data/surreal_persistence';
import type { AuthConfig, AuditSink } from '../security/auth';
import type { AuditSinkSurreal } from '../security/auditSinkSurreal';
import { queryAuditLog, countAuditLog, type AuditQuery } from '../security/auditQuery';
import { parseBindings, type TenantContextConfig } from '../security/tenantContext';
import {
  handleVaultList,
  handleVaultGet,
  handleVaultPut,
  handleVaultDelete,
  handleVaultVerify,
  handleVaultExport as vaultExportRaw,
  handleVaultImport as vaultImportRaw,
  handleVaultVerifyPassphrase as vaultVerifyPassphraseRaw,
  handleVaultReveal,
} from '../security/vaultHandler';
import type { ApiResponse } from './types';

// ------------------------------------------------------------
// Vault response sanitisation (allow-list, defense-in-depth)
// ------------------------------------------------------------

const VAULT_PUBLIC_FIELDS = new Set([
  'id', 'baseUrl', 'hasKey', 'source', 'createdAt', 'updatedAt',
  'items', 'count', 'item', 'error', 'verified', 'exported', 'imported' as any as never,
  'apiKey',
]);

function redactVaultBody(body: any): any {
  if (body === null || body === undefined) return body;
  if (Array.isArray(body)) return body.map(redactVaultBody);
  if (typeof body !== 'object') return body;
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(body)) {
    if (VAULT_PUBLIC_FIELDS.has(k)) {
      out[k] = v;
    } else if (k === 'items' || k === 'item') {
      out[k] = redactVaultBody(v);
    }
  }
  return out;
}

function vaultResultToApi(r: { status: number; headers?: Record<string, string>; body: any }): ApiResponse {
  return {
    status: r.status,
    headers: r.headers || { 'Content-Type': 'application/json' },
    body: redactVaultBody(r.body),
  };
}

// ------------------------------------------------------------
// Dependency bag
// ------------------------------------------------------------

export interface VaultRouteDeps {
  surrealPersistence: SurrealPersistence | null;
  authConfig: AuthConfig;
  auditSinkSurreal: AuditSinkSurreal | null;
  auditChangeFeed: any;
  tenantCtxConfig: TenantContextConfig;
}

// ------------------------------------------------------------
// Auth Bootstrap  (GET /api/auth/bootstrap)
// ------------------------------------------------------------

export async function handleAuthBootstrap(deps: VaultRouteDeps): Promise<ApiResponse> {
  // env mode: return first env token (legacy compat)
  const envRaw = process.env.SOLOFORGE_API_TOKENS || '';
  if (envRaw) {
    const envTokens = envRaw.split(',').map((s: string) => s.trim()).filter(Boolean);
    if (envTokens.length > 0) {
      return {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: { token: envTokens[0], kid: null, familyId: null, count: envTokens.length, source: 'env', expiresAt: null },
      };
    }
  }
  // vault mode: pick latest active
  try {
    const { pickBootstrapToken } = await import('../security/tokenStore');
    const cand = await pickBootstrapToken();
    if (cand) {
      return {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: {
          token: cand.token, kid: cand.kid, familyId: cand.familyId,
          count: deps.authConfig.apiTokens.length, source: 'vault', expiresAt: cand.expiresAt,
        },
      };
    }
  } catch { /* fallback */ }
  // fallback: legacy env/vault
  return {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    body: {
      token: deps.authConfig.apiTokens[0] || null,
      kid: null, familyId: null,
      count: deps.authConfig.apiTokens.length,
      source: process.env.SOLOFORGE_API_TOKENS ? 'env' : 'vault',
    },
  };
}

// ------------------------------------------------------------
// Audit list  (GET /api/audit/list)
// ------------------------------------------------------------

export async function handleAuditList(query: Record<string, string>, deps: VaultRouteDeps): Promise<ApiResponse> {
  if (!deps.surrealPersistence || !deps.surrealPersistence.isReady()) {
    return { status: 503, headers: { 'Content-Type': 'application/json' }, body: { error: 'Service Unavailable', reason: 'audit_db_not_ready' } };
  }
  const q: AuditQuery = {};
  if (query.action) q.action = query.action;
  if (query.route) q.route = query.route;
  if (query.status) q.status = parseInt(query.status, 10);
  if (query.principalId) q.principalId = query.principalId;
  if (query.since) q.since = parseInt(query.since, 10);
  if (query.until) q.until = parseInt(query.until, 10);
  if (query.reuseOnly === '1') q.reuseOnly = true;
  if (query.limit) q.limit = parseInt(query.limit, 10);
  try {
    const [items, total] = await Promise.all([
      queryAuditLog(deps.surrealPersistence, q),
      countAuditLog(deps.surrealPersistence, q),
    ]);
    return { status: 200, headers: { 'Content-Type': 'application/json' }, body: { count: items.length, total, items } };
  } catch (e) {
    return { status: 400, headers: { 'Content-Type': 'application/json' }, body: { error: 'Bad Request', reason: (e as Error).message } };
  }
}

// ------------------------------------------------------------
// Audit stats  (GET /api/audit/stats)
// ------------------------------------------------------------

export function handleAuditStats(deps: VaultRouteDeps): ApiResponse {
  const stats = deps.auditSinkSurreal?.getStats() ?? null;
  return { status: 200, headers: { 'Content-Type': 'application/json' }, body: { sinkMounted: !!deps.auditSinkSurreal, stats } };
}

// ------------------------------------------------------------
// Audit sinks  (GET /api/audit/sinks)
// ------------------------------------------------------------

export function handleAuditSinks(deps: VaultRouteDeps): ApiResponse {
  return {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    body: {
      surrealMounted: !!deps.auditSinkSurreal,
      surrealStats: deps.auditSinkSurreal?.getStats?.() ?? null,
      changeFeed: deps.auditChangeFeed?.getStats?.() ?? null,
      tenant: {
        headerName: deps.tenantCtxConfig.headerName,
        pathPrefix: deps.tenantCtxConfig.pathPrefix,
        defaultTenant: deps.tenantCtxConfig.defaultTenant,
        bindingsCount: Object.keys(deps.tenantCtxConfig.bindings ?? {}).length,
      },
    },
  };
}

// ------------------------------------------------------------
// Audit sinks config  (POST /api/audit/sinks/config)
// ------------------------------------------------------------

export function handleAuditSinksConfig(body: any, deps: VaultRouteDeps): ApiResponse {
  const b = body || {};
  if (typeof b.bindings === 'string') {
    deps.tenantCtxConfig.bindings = parseBindings(b.bindings);
  } else if (b.bindingsRaw) {
    deps.tenantCtxConfig.bindings = parseBindings(b.bindingsRaw);
  }
  if (typeof b.headerName === 'string') deps.tenantCtxConfig.headerName = b.headerName;
  if (typeof b.pathPrefix === 'string') deps.tenantCtxConfig.pathPrefix = b.pathPrefix;
  if (typeof b.defaultTenant === 'string') deps.tenantCtxConfig.defaultTenant = b.defaultTenant;
  return {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    body: {
      ok: true,
      tenant: {
        headerName: deps.tenantCtxConfig.headerName,
        pathPrefix: deps.tenantCtxConfig.pathPrefix,
        defaultTenant: deps.tenantCtxConfig.defaultTenant,
        bindingsCount: Object.keys(deps.tenantCtxConfig.bindings ?? {}).length,
      },
    },
  };
}

// ------------------------------------------------------------
// Vault key routes
// ------------------------------------------------------------

export async function handleVaultKeysList(): Promise<ApiResponse> {
  return vaultResultToApi(await handleVaultList());
}

export async function handleVaultKeyGet(id: string): Promise<ApiResponse> {
  return vaultResultToApi(await handleVaultGet(id));
}

export async function handleVaultKeyPut(id: string, body: any): Promise<ApiResponse> {
  return vaultResultToApi(await handleVaultPut(id, body));
}

export async function handleVaultKeyDelete(id: string): Promise<ApiResponse> {
  return vaultResultToApi(await handleVaultDelete(id));
}

export async function handleVaultKeyVerify(id: string): Promise<ApiResponse> {
  return vaultResultToApi(await handleVaultVerify(id));
}

export async function handleVaultKeyReveal(id: string): Promise<ApiResponse> {
  return vaultResultToApi(await handleVaultReveal(id));
}

export async function handleVaultExport(body: any): Promise<ApiResponse> {
  return vaultResultToApi(await vaultExportRaw(body));
}

export async function handleVaultImport(body: any): Promise<ApiResponse> {
  return vaultResultToApi(await vaultImportRaw(body));
}

export async function handleVaultVerifyPassphrase(body: any): Promise<ApiResponse> {
  return vaultResultToApi(await vaultVerifyPassphraseRaw(body));
}
