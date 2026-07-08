// ────────────────────────────────────────────────────────────
// SoloForge API Server — Shared Types
// Path: src/server/types.ts
// ────────────────────────────────────────────────────────────

import http from 'http';
import type { Principal } from '../security/auth';

/** Parsed inbound API request (passed to route handlers) */
export interface ApiRequest {
  method: string;
  url: string;
  path: string;
  query: Record<string, string>;
  body: any;
  headers: http.IncomingHttpHeaders;
  remoteAddress?: string;
  principal?: Principal;
}

/** Uniform route handler return type */
export interface ApiResponse {
  status: number;
  headers: Record<string, string>;
  body: any;
}

/** Context assembled by the middleware layer before routing */
export interface MiddlewareContext {
  requestId: string;
  reqPath: string;
  method: string;
  userAgent: string;
  remoteAddress?: string;
  ipHash?: string;
  requestedTenantId: string | null;
  effectiveTenantId: string;
  apiReq: ApiRequest;
}
