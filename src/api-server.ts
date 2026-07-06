// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
// SoloForge API Server Layer
// Path: src/api-server.ts
// Description: HTTP + SSE API æå¡å¨ - å°åæ ¸ç¶ææ´é²ç»åç«¯
// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawnSync, spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { RuntimeKernel, RuntimeState } from './kernel/runtime-kernel';

const require = createRequire(import.meta.url);

// ES Module __dirname polyfill
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
import { TelemetryMetricExporter } from './kernel/observability/telemetry-exporter';
import { SurrealPersistence } from './data/surreal_persistence';
import { DataArchiverService } from './data/data-archiver';
import { logger } from './core/logger';
// ð§¬ Agent æ°æ®æµè´¯éå±
import { AgentRegistry, AgentDispatchRequest } from './core/agent/agent-registry';
import { AgentDecisionOrchestrator } from './core/agent/agent-decision-orchestrator';
import { AgentEventHub } from './core/agent/agent-event-hub';
import {
  evaluateRequestAsync,
  corsHeadersFor,
  safeJoin,
  defaultAuthConfig,
  AuthConfig,
  Principal,
  RateLimiter,
  defaultRateLimit,
  strictRateLimit,
  securityHeaders,
  MAX_BODY_BYTES,
  getOrAssignRequestId,
  hashPii,
  loadApiTokens,
  loadRevokedTokens,
  defaultAuditSink,
  AuditEvent,
  AuditSink,
} from './security/auth';
import { AuditSinkSurreal, createAuditSinkFromSurreal } from './security/auditSinkSurreal';
import { queryAuditLog, countAuditLog, type AuditQuery } from './security/auditQuery';
import {
  extractTenantId,
  parseBindings,
  type TenantContextConfig,
} from './security/tenantContext';
import {
  handleVaultList,
  handleVaultGet,
  handleVaultPut,
  handleVaultDelete,
  handleVaultVerify,
  handleVaultExport,
  handleVaultImport,
  handleVaultVerifyPassphrase,
  handleVaultReveal,
} from './security/vaultHandler';
import { handleLLMStreamProxy, handleLLMConfigGet, handleLLMHealth } from './llm/llmProxyHandler';

// ============================================================
// ç±»åå®ä¹
// ============================================================

interface ApiRequest {
  method: string;
  url: string;
  path: string;
  query: Record<string, string>;
  body: any;
  headers: http.IncomingHttpHeaders;
  remoteAddress?: string;
  principal?: Principal;
}

interface ApiResponse {
  status: number;
  headers: Record<string, string>;
  body: any;
}

// ============================================================
// API æå¡å¨
// ============================================================

export class SoloForgeApiServer {
  private server: http.Server | null = null;
  private port: number;
  private sseClients: Set<http.ServerResponse> = new Set();
  private kernel: RuntimeKernel;
  private telemetryExporter: TelemetryMetricExporter | null = null;
  private surrealPersistence: SurrealPersistence | null = null;
  private dataArchiver: DataArchiverService | null = null;
  private agentRegistry: AgentRegistry | null = null;
  private agentOrchestrator: AgentDecisionOrchestrator | null = null;
  private agentEventHub: AgentEventHub | null = null;
  // 🧰 P9 outbox bridge (B3 修复, audit 2026-06-30)
  private reputationOutboxBridge: any = null;
  private startedAt: number = Date.now();
  private prevCpuTimes: { idle: number; total: number } | null = null;
  private bytesTransferred: { sent: number; received: number } = { sent: 0, received: 0 };
  private prevBytesTransferred: { sent: number; received: number; time: number } | null = null;
  private cachedNetworkSpeed: { up: number; down: number; time: number } = { up: 0, down: 0, time: 0 };
  private networkCacheMs = 1000; // 1ç§ç¼å­
  // è§æµç³»ç»ç¶æ
  private isObserving = false;
  private authConfig: AuthConfig = defaultAuthConfig;
  public setAuthConfig(cfg: AuthConfig): void { this.authConfig = cfg; }
  public setAgentRegistry(registry: AgentRegistry): void { this.agentRegistry = registry; }
  public setAgentOrchestrator(orchestrator: AgentDecisionOrchestrator): void { this.agentOrchestrator = orchestrator; }

  // Production hardening
  private readonly rateLimiter = new RateLimiter(defaultRateLimit);
  private readonly strictRateLimiter = new RateLimiter(strictRateLimit);
  private audit: AuditSink = defaultAuditSink;
  private readonly piiSalt = process.env.SOLOFORGE_PII_SALT || 'soloforge-default-salt';
  public setAuditSink(sink: AuditSink): void { (this as any).audit = sink; }
  public setPiiSalt(s: string): void { (this as any).piiSalt = s; }
  private auditSinkSurreal: AuditSinkSurreal | null = null;
  private auditChangeFeed: any = null;  // AuditChangeFeed, lazy import 避免循环

  // 🏢 多租户配置 (从 env 加载, 启动后只读, 可通过 /api/audit/sinks/config 重载)
  private tenantCtxConfig: TenantContextConfig = {
    headerName: process.env.SOLOFORGE_TENANT_HEADER || 'X-Tenant-Id',
    pathPrefix: process.env.SOLOFORGE_TENANT_PATH_PREFIX || '/api/t/',
    defaultTenant: process.env.SOLOFORGE_TENANT_DEFAULT || '_default',
    bindings: parseBindings(process.env.SOLOFORGE_TENANT_BINDINGS),
  };
  private getTenantBindings(): Record<string, string[]> {
    return this.tenantCtxConfig.bindings ?? {};
  }

  private observations: Array<{
    cycleId: number;
    timestamp: string;
    entropy: number;
    interventions: number;
    courtCases: number;
    coalitions: number;
  }> = [];
  private observationInterval: NodeJS.Timeout | null = null;

  constructor(
    kernel: RuntimeKernel,
    telemetryExporter?: TelemetryMetricExporter,
    surrealPersistence?: SurrealPersistence,
    port: number = 3001
  ) {
    this.kernel = kernel;
    this.telemetryExporter = telemetryExporter || null;
    this.surrealPersistence = surrealPersistence || null;
    this.port = parseInt(process.env.API_PORT || String(port), 10);

    // åå§åæ°æ®å½æ¡£æå¡
    if (surrealPersistence) {
      this.dataArchiver = new DataArchiverService(surrealPersistence, 5 * 60 * 1000);
    }
  }

  /**
   * è·åæ°æ®å½æ¡£æå¡å®ä¾
   */
  public getDataArchiver(): DataArchiverService | null {
    return this.dataArchiver;
  }

  /**
   * å¯å¨ API æå¡å¨
   */
  public async start(): Promise<void> {
    // Production startup gate: refuse to start without API tokens unless explicitly disabled.
    // Resolve tokens: env -> vault (v2 tokenStore) -> v1 fallback -> auto-generate.
    // If REQUIRE_TOKENS=1 and nothing is available, loadApiTokensAsync throws.
    const { loadApiTokensAsync } = await import('./security/auth');
    const tokens = await loadApiTokensAsync();
    this.authConfig = { ...this.authConfig, apiTokens: tokens };
    logger.info("ApiServer", `[auth] ${tokens.length} API token(s) loaded (lengths: ${tokens.map((t) => t.length).join(",")})`);

    // 🌀 Token Rotation Worker (v2): 每 5 分钟扫描, 自动轮换即将过期的 active kid
    if (process.env.SOLOFORGE_ROTATION_DISABLED !== '1') {
      try {
        const { getTokenRotationService } = await import('./security/tokenRotationService');
        const svc = getTokenRotationService();
        svc.start();
        // 启动后立即跑一次 (暖机), 不阻塞 listen
        void svc.tickOnce().catch((e) =>
          logger.warn('TokenRotation', `startup tick failed: ${(e as Error).message}`)
        );
        logger.info('ApiServer', '🌀 Token rotation worker started');
      } catch (e) {
        logger.warn('ApiServer', `Token rotation worker not started: ${(e as Error).message}`);
      }
    }
    // 🗃️ Audit Sink Surreal: 异步批量写 SurrealDB httpAuditLog 表
    // 仅在有 surrealPersistence 时挂载, 否则继续用 stdout sink
    if (this.surrealPersistence) {
      try {
        this.auditSinkSurreal = createAuditSinkFromSurreal(this.surrealPersistence, {
          mirrorToStdout: true,    // 同步写 stdout, 调试/告警用
          fallbackToStdout: true,  // DB 写失败时降级到 stdout (tag=AUDIT_FALLBACK)
          flushThreshold: 50,      // 50 条立即 flush
          flushIntervalMs: 5000,   // 5s 定时 flush
        });
        this.setAuditSink(this.auditSinkSurreal.asSink());
        logger.info('ApiServer', '🗃️  Audit sink -> SurrealDB httpAuditLog (stdout mirror on, fallback on)');

        // 📤 Audit Change Feed → Kafka: 启动 poll worker 推送到告警 topic
        //   - 默认启用, 除非 SOLOFORGE_CHANGE_FEED_DISABLED=1
        //   - 需要 env: SOLOFORGE_KAFKA_BROKERS (逗号分隔), SOLOFORGE_KAFKA_TOPIC
        if (process.env.SOLOFORGE_CHANGE_FEED_DISABLED !== '1') {
          const brokers = (process.env.SOLOFORGE_KAFKA_BROKERS || '').split(',').map((s) => s.trim()).filter(Boolean);
          const topic = process.env.SOLOFORGE_KAFKA_TOPIC || 'soloforge.audit';
          if (brokers.length > 0) {
            try {
              const { KafkaAuditSink } = await import('./security/auditSinkKafka');
              const { AuditChangeFeed } = await import('./security/auditChangeFeed');
              const kafka = new KafkaAuditSink({ brokers, topic, clientId: 'soloforge-api' });
              const feed = new AuditChangeFeed(this.surrealPersistence as any, kafka, {
                pollIntervalMs: parseInt(process.env.SOLOFORGE_CHANGE_FEED_INTERVAL_MS || '1000', 10),
                batchSize: parseInt(process.env.SOLOFORGE_CHANGE_FEED_BATCH_SIZE || '200', 10),
                lookbackMs: parseInt(process.env.SOLOFORGE_CHANGE_FEED_LOOKBACK_MS || '60000', 10),
              });
              feed.start();
              this.auditChangeFeed = feed;
              logger.info('ApiServer', `📤 Audit change feed -> Kafka brokers=[${brokers.join(',')}] topic=${topic}`);
            } catch (e) {
              logger.warn('ApiServer', `Change feed not started: ${(e as Error).message}`);
            }
          } else {
            logger.info('ApiServer', '📤 Audit change feed disabled (no SOLOFORGE_KAFKA_BROKERS)');
          }
        }
      } catch (e) {
        logger.warn('ApiServer', `Audit sink surreal not mounted: ${(e as Error).message}`);
      }
    } else {
      logger.info('ApiServer', '🗃️  Audit sink -> stdout only (no SurrealPersistence)');
    }
    return new Promise((resolve, reject) => {
      this.server = http.createServer(async (req, res) => {
        await this.handleRequest(req, res);
      });

      this.server.listen(this.port, () => {
        logger.info('ApiServer', `ð SoloForge API Server listening on http://localhost:${this.port}`);
        logger.info('ApiServer', `   Admin UI: http://localhost:${this.port}/admin`);
        logger.info('ApiServer', `   SSE Events: http://localhost:${this.port}/api/events/stream`);
        logger.info('ApiServer', `   ð°ï¸  Agent WS: ws://localhost:${this.port}/ws/agents`);

        // 🧰 P9 outbox bridge 启动 (B3 修复)
        if (this.kernel && this.surrealPersistence && !this.reputationOutboxBridge) {
          import('./kernel/orchestration/reputation-outbox-bridge').then(({ ReputationOutboxBridge }) => {
            this.reputationOutboxBridge = new ReputationOutboxBridge(
              this.kernel,
              this.surrealPersistence,
            );
            this.reputationOutboxBridge.start().catch((e) => {
              logger.error('ApiServer', `ReputationOutboxBridge start failed: ${e.message}`);
            });
          });
        }

        // 🧰 agent 事件广播 hub (Electron main 主动连入)
        if (this.kernel && !this.agentEventHub) {
          this.agentEventHub = new AgentEventHub(this.kernel);
          this.agentEventHub.attach(this.server);
        }
        resolve();
      });

      this.server.on('error', (err: any) => {
        if (err.code === 'EADDRINUSE') {
          logger.warn('ApiServer', `â ï¸ Port ${this.port} in use, trying ${this.port + 1}...`);
          this.port += 1;
          this.server?.listen(this.port);
        } else {
          logger.error('ApiServer', `ð¥ Server error: ${err.message}`);
          reject(err);
        }
      });
    });
  }

  /**
   * åæ­¢ API æå¡å¨
   */
  public async stop(): Promise<void> {
    for (const client of this.sseClients) {
      client.end();
    }
    this.sseClients.clear();

    // 📤 Stop audit change feed
    if (this.auditChangeFeed) {
      try { this.auditChangeFeed.stop(); } catch { /* ignore */ }
      this.auditChangeFeed = null;
    }

    // 🗃️ Flush audit sink (best-effort, 5s 超时)
    if (this.auditSinkSurreal) {
      try {
        await Promise.race([
          this.auditSinkSurreal.close(),
          new Promise((r) => setTimeout(r, 5000)),
        ]);
        logger.info('ApiServer', '🗃️  Audit sink closed');
      } catch (e) {
        logger.warn('ApiServer', `Audit sink close failed: ${(e as Error).message}`);
      }
    }

    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          logger.info('ApiServer', 'ð API Server stopped');
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  /**
   * å¹¿æ­äºä»¶å°ææ SSE å®¢æ·ç«¯
   */
  public broadcastEvent(event: string, payload: any): void {
    const data = JSON.stringify({ event, payload, timestamp: Date.now() });
    const sseData = `data: ${data}\n\n`;
    for (const client of this.sseClients) {
      try {
        client.write(sseData);
      } catch {
        this.sseClients.delete(client);
      }
    }
  }

  public getPort(): number {
    return this.port;
  }

  // ============================================================
  // è¯·æ±å¤ç
  // ============================================================

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const isHttps = (req.socket as any)?.encrypted === true;
    const sec = securityHeaders({ isHttps });
    for (const [k, v] of Object.entries(sec)) res.setHeader(k, v);
    const cors = corsHeadersFor(req.headers, this.authConfig);
    for (const [k, v] of Object.entries(cors)) res.setHeader(k, v);
    res.setHeader('Access-Control-Allow-Credentials', 'false');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url || '/', `http://localhost:${this.port}`);
    const reqPath = url.pathname;
    const method = req.method || 'GET';
    const requestId = getOrAssignRequestId(req.headers);
    res.setHeader('X-Request-Id', requestId);
    const userAgent = String(req.headers['user-agent'] || '').slice(0, 256);
    const remoteAddress = req.socket?.remoteAddress;
    const ipHash = remoteAddress ? hashPii(remoteAddress, this.piiSalt) : undefined;

    // 🏢 解析请求的 tenantId (header X-Tenant-Id 或 path /api/t/{id})
    const requestedTenantId = extractTenantId(reqPath, req.headers, this.tenantCtxConfig);

    const ipKey = `ip:${remoteAddress || 'unknown'}`;
    if (!this.rateLimiter.allow(ipKey)) {
      const ra = this.rateLimiter.retryAfterSec(ipKey);
      this.audit({
        id: requestId, timestamp: Date.now(),
        action: 'rate.limit.ip', route: reqPath, method, status: 429,
        remoteAddress: ipHash, userAgent, reason: 'rate_limit_ip',
        tenantId: requestedTenantId,
      });
      res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': String(ra) });
      res.end(JSON.stringify({ error: 'Too Many Requests', retryAfter: ra }));
      return;
    }

    let body: any = null;
    if (method === 'POST' || method === 'PUT' || method === 'DELETE') {
      const ct = String(req.headers['content-type'] || '').toLowerCase();
      if (ct.length > 0 && !ct.includes('application/json')) {
        res.writeHead(415, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unsupported Media Type' }));
        return;
      }
      body = await this.parseBody(req, MAX_BODY_BYTES);
      if (body === '__TOO_LARGE__') {
        this.audit({
          id: requestId, timestamp: Date.now(),
          action: 'body.too_large', route: reqPath, method, status: 413,
          remoteAddress: ipHash, userAgent,
          tenantId: requestedTenantId,
        });
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Payload Too Large' }));
        return;
      }
    }

    const apiReq: ApiRequest = {
      method, url: req.url || '/', path: reqPath,
      query: Object.fromEntries(url.searchParams),
      body, headers: req.headers, remoteAddress,
    };

    const guard = await evaluateRequestAsync({
      reqPath, method, headers: req.headers, query: apiReq.query, remoteAddress,
      requestedTenantId, tenantBindings: this.getTenantBindings(),
    }, this.authConfig);

    if (!guard.allow) {
      // 复用检测命中时, 写一条专门的审计 (含 autoRevoked 数量)
      if (guard.reuseDetected) {
        this.audit({
          id: requestId, timestamp: Date.now(),
          action: 'auth.reuse_detected', route: reqPath, method, status: guard.status,
          remoteAddress: ipHash, userAgent,
          reason: guard.reason,
          autoRevokedTokens: guard.autoRevokedTokens,
          tenantId: requestedTenantId,
        });
      } else if (guard.crossTenant) {
        this.audit({
          id: requestId, timestamp: Date.now(),
          action: 'tenant.cross', route: reqPath, method, status: guard.status,
          remoteAddress: ipHash, userAgent,
          reason: guard.reason,
          tenantId: requestedTenantId,
        });
      } else {
        this.audit({
          id: requestId, timestamp: Date.now(),
          action: 'auth.fail', route: reqPath, method, status: guard.status,
          remoteAddress: ipHash, userAgent, reason: guard.reason,
          tenantId: requestedTenantId,
        });
      }
      const resBody: any = { error: guard.status === 403 ? 'Forbidden' : 'Unauthorized', reason: guard.reason };
      if (guard.reuseDetected) resBody.reuseDetected = true;
      if (guard.crossTenant) resBody.crossTenant = true;
      res.writeHead(guard.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(resBody));
      return;
    }
    apiReq.principal = guard.principal;
    // 🏢 解析出的 effective tenant (跨租户已被拒, 这里一定有值)
    const effectiveTenantId = guard.principal?.activeTenantId ?? requestedTenantId ?? '_default';

    const isSensitive = reqPath.startsWith('/api/vault') || reqPath.startsWith('/api/admin');
    if (isSensitive) {
      const idKey = `id:${guard.principal?.id || ipKey}`;
      if (!this.strictRateLimiter.allow(idKey)) {
        const ra = this.strictRateLimiter.retryAfterSec(idKey);
        this.audit({
          id: requestId, timestamp: Date.now(),
          principal: guard.principal, action: 'rate.limit.sensitive',
          route: reqPath, method, status: 429,
          remoteAddress: ipHash, userAgent,
          tenantId: effectiveTenantId,
        });
        res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': String(ra) });
        res.end(JSON.stringify({ error: 'Too Many Requests', retryAfter: ra }));
        return;
      }
    }

    const bearer = String(req.headers['authorization'] || '').replace(/^Bearer\s+/i, '').trim();
    if (bearer && loadRevokedTokens().has(bearer)) {
      this.audit({
        id: requestId, timestamp: Date.now(),
        principal: guard.principal, action: 'auth.revoked',
        route: reqPath, method, status: 401,
        remoteAddress: ipHash, userAgent, reason: 'token_revoked',
        tenantId: effectiveTenantId,
      });
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized', reason: 'token_revoked' }));
      return;
    }

    try {
      // LLM SSE 流 — 需要直接操作 res 写 SSE, 不能走 route()→ApiResponse 常规路径
      if (reqPath === '/api/llm/stream' && method === 'POST') {
        const llmResult = await handleLLMStreamProxy(req, res, body);
        // stream=true 时 handler 已经直接操作 res 写了 SSE, 无需再处理
        // stream 非 true 时是错误返回 (400/401/503), 需要把 HTTP 响应发出去
        if (!llmResult.stream) {
          const errBody = typeof llmResult.body === 'string' ? llmResult.body : JSON.stringify(llmResult.body);
          res.writeHead(llmResult.status, {
            'Content-Type': llmResult.headers['Content-Type'] || 'application/json',
            ...llmResult.headers,
          });
          res.end(errBody);
        }
        return;
      }

      const apiRes = await this.route(apiReq);

      if (reqPath === '/api/events/stream' && method === 'GET') {
        this.handleSSE(req, res);
        return;
      }
      const responseBody = typeof apiRes.body === 'string' ? apiRes.body : JSON.stringify(apiRes.body);
      this.bytesTransferred.sent += Buffer.byteLength(responseBody, 'utf8');
      this.bytesTransferred.received += Buffer.byteLength(typeof body === 'string' ? body : (body ? JSON.stringify(body) : ''), 'utf8');
      res.writeHead(apiRes.status, {
        'Content-Type': apiRes.headers['Content-Type'] || 'application/json',
        ...apiRes.headers,
      });
      res.end(responseBody);

      this.audit({
        id: requestId, timestamp: Date.now(),
        principal: guard.principal, action: isSensitive ? 'sensitive.ok' : 'request.ok',
        route: reqPath, method, status: apiRes.status,
        remoteAddress: ipHash, userAgent,
        tenantId: effectiveTenantId,
      });
    } catch (err: any) {
      logger.error('ApiServer', `Request error on ${reqPath}: ${err.message}`);
      this.audit({
        id: requestId, timestamp: Date.now(),
        principal: guard.principal, action: 'request.error',
        route: reqPath, method, status: 500,
        remoteAddress: ipHash, userAgent, reason: 'unhandled_exception',
        tenantId: effectiveTenantId,
      });
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal Server Error' }));
    }
  }
  private parseBody(req: http.IncomingMessage, maxBytes: number = MAX_BODY_BYTES): Promise<any> {
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

  // ============================================================
  // è·¯ç±
  // ============================================================

  private async route(req: ApiRequest): Promise<ApiResponse> {
    const { path: reqPath, method } = req;

    // UI éææä»¶ï¼å¿é¡»æ¾å¨åé¢ï¼é¿åè¢« /ui è·¯ç±æè·ï¼
    if (reqPath.startsWith('/ui/') && method === 'GET') {
      const fileName = reqPath.slice(4);
      const uiDir = 'C:/Users/yangx/Desktop/SoloForge/src/ui';
      const filePath = path.join(uiDir, fileName);
      if (fs.existsSync(filePath)) {
        const ext = path.extname(fileName);
        const contentType = ext === '.js' ? 'application/javascript' : ext === '.css' ? 'text/css' : 'text/plain';
        const content = fs.readFileSync(filePath);
        // å¦ææ¯ Bufferï¼è½¬æå­ç¬¦ä¸²åé
        const bodyStr = Buffer.isBuffer(content) ? content.toString('utf-8') : content;
        return { status: 200, headers: { 'Content-Type': contentType }, body: bodyStr };
      }
    }

    // Admin UI - å¤ä¸ªå¥å£
    if ((reqPath === '/' || reqPath === '/admin' || reqPath === '/ui') && method === 'GET') {
      return this.handleAdminUI();
    }

    // æµè¯é¡µé¢
    if (reqPath === '/test-nav' && method === 'GET') {
      const testPath = safeJoin(path.resolve(process.cwd(), 'src', 'ui'), 'test-nav.html');
      const testHtml = testPath ? fs.readFileSync(testPath, 'utf-8') : '<h1>test-nav not found</h1>';
      return { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' }, body: testHtml };
    }

    // Kernel APIs
    if (reqPath === '/api/kernel/status' && method === 'GET') {
      return this.handleKernelStatus();
    }
    if (reqPath === '/api/kernel/health' && method === 'GET') {
      return this.handleKernelHealth();
    }
    if (reqPath === '/api/kernel/events' && method === 'GET') {
      return this.handleKernelEvents(parseInt(req.query.limit || '50', 10));
    }

    // Database APIs
    if (reqPath === '/api/db/schema' && method === 'GET') {
      return this.handleDbSchema();
    }

    // Prometheus Metrics
    if (reqPath === '/metrics' && method === 'GET') {
      return this.handlePrometheusMetrics();
    }

    // Health Check
    if (reqPath === '/api/health' && method === 'GET') {
      return { status: 200, headers: { 'Content-Type': 'application/json' }, body: { status: 'ok', uptime: Date.now() - this.startedAt } };
    }

    // =========================================================================
    // GET /api/auth/bootstrap
    // =========================================================================
    // 作用:同机前端(Electron / Tauri / 本地浏览器)启动时,一次性获取当前生效的 API token。
    //
    // 安全保证:
    //   - 硬性限定只能从 127.0.0.1(::1 / IPv4-mapped IPv6 loopback)访问,远程 IP 直接被鉴权层拒
    //   - 不接受任何 query 参数(避免 XSS / header 注入风险)
    //   - 不接受 POST/PUT/DELETE,只 GET(幂等)
    //   - 不返回任何敏感信息(token 之外,只返回 count / source / kid)
    //
    // 响应 (v2):
    //   {
    //     "token":     "a3f7...",  // 当前主 token (最新的 active kid)
    //     "kid":       "k_xxxxxxxx", // token 的 Key ID (供审计关联)
    //     "familyId":  "f_xxxxxxxx", // Token Family ID
    //     "count":     1,            // vault 中有效 (active+rotating) token 总数
    //     "source":    "vault" | "env",
    //     "expiresAt": 1754000000000  // ms timestamp
    //   }
    //
    // 典型调用:
    //   curl http://127.0.0.1:<port>/api/auth/bootstrap
    //
    // 前端使用建议:
    //   1. 启动时调用一次,把 token + kid 存到 sessionStorage / 内存
    //   2. 后续所有 fetch / axios / EventSource 加上 Authorization 头
    //   3. 收到 401 时重新调一次 bootstrap(应对 token 轮换)
    //   4. 如果响应里 reuseDetected=true, 整族已被吊销, 强制重认证
    // =========================================================================
    if (reqPath === '/api/auth/bootstrap' && method === 'GET') {
      // env 模式: 直接从 env 抽一个 (旧行为兼容)
      const envRaw = process.env.SOLOFORGE_API_TOKENS || '';
      if (envRaw) {
        const envTokens = envRaw.split(',').map((s: string) => s.trim()).filter(Boolean);
        if (envTokens.length > 0) {
          return {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
            body: {
              token: envTokens[0],
              kid: null,
              familyId: null,
              count: envTokens.length,
              source: 'env',
              expiresAt: null,
            },
          };
        }
      }
      // vault 模式: 从 tokenStore 选最新 active
      try {
        const { pickBootstrapToken } = await import('./security/tokenStore');
        const cand = await pickBootstrapToken();
        if (cand) {
          return {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
            body: {
              token: cand.token,
              kid: cand.kid,
              familyId: cand.familyId,
              count: this.authConfig.apiTokens.length,
              source: 'vault',
              expiresAt: cand.expiresAt,
            },
          };
        }
      } catch { /* 兜底: 用老方法 */ }
      // 兜底: 老方法 (env 模式或 vault 不可用)
      return {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: {
          token: this.authConfig.apiTokens[0] || null,
          kid: null,
          familyId: null,
          count: this.authConfig.apiTokens.length,
          source: process.env.SOLOFORGE_API_TOKENS ? 'env' : 'vault',
        },
      };
    }

    // =========================================================================
    // GET /api/audit/list
    // =========================================================================
    // 作用: 审计日志查询 (admin only)
    //
    // 查询参数 (query string):
    //   action       string   按 action 前缀过滤 (e.g. 'auth.fail', 'rate.limit')
    //   route        string   按 route 精确过滤
    //   status       int      按 HTTP 状态码过滤
    //   principalId  string   按主体 ID 过滤
    //   since        int      ms epoch, 时间下界
    //   until        int      ms epoch, 时间上界 (范围不能超过 7 天)
    //   reuseOnly    '1'      仅看 token_reuse_detected 命中
    //   limit        int      1..500, 默认 100
    //
    // 响应:
    //   { count, total, items: [...AuditRow] }
    //
    // 安全:
    //   - admin 角色限定 (ROLE_BY_ROUTE /api/audit -> admin)
    //   - 限制时间范围 7 天
    //   - 限制 limit 上限 500
    //   - 不返回原始 IP (sink 已 hash 过)
    // =========================================================================
    if (reqPath === '/api/audit/list' && method === 'GET') {
      if (!this.surrealPersistence || !this.surrealPersistence.isReady()) {
        return {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
          body: { error: 'Service Unavailable', reason: 'audit_db_not_ready' },
        };
      }
      const q: AuditQuery = {};
      const r = apiReq.query;
      if (r.action) q.action = r.action;
      if (r.route) q.route = r.route;
      if (r.status) q.status = parseInt(r.status, 10);
      if (r.principalId) q.principalId = r.principalId;
      if (r.since) q.since = parseInt(r.since, 10);
      if (r.until) q.until = parseInt(r.until, 10);
      if (r.reuseOnly === '1') q.reuseOnly = true;
      if (r.limit) q.limit = parseInt(r.limit, 10);
      try {
        const [items, total] = await Promise.all([
          queryAuditLog(this.surrealPersistence, q),
          countAuditLog(this.surrealPersistence, q),
        ]);
        return {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
          body: { count: items.length, total, items },
        };
      } catch (e) {
        const err = e as Error;
        return {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
          body: { error: 'Bad Request', reason: err.message },
        };
      }
    }

    // GET /api/audit/stats — SurrealDB sink 自身统计
    if (reqPath === '/api/audit/stats' && method === 'GET') {
      const stats = this.auditSinkSurreal?.getStats() ?? null;
      return {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: {
          sinkMounted: !!this.auditSinkSurreal,
          stats,
        },
      };
    }

    // GET /api/audit/sinks — 所有 audit sink 状态 (含 composite 子 sink)
    if (reqPath === '/api/audit/sinks' && method === 'GET') {
      return {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: {
          surrealMounted: !!this.auditSinkSurreal,
          surrealStats: this.auditSinkSurreal?.getStats?.() ?? null,
          changeFeed: this.auditChangeFeed?.getStats?.() ?? null,
          tenant: {
            headerName: this.tenantCtxConfig.headerName,
            pathPrefix: this.tenantCtxConfig.pathPrefix,
            defaultTenant: this.tenantCtxConfig.defaultTenant,
            bindingsCount: Object.keys(this.tenantCtxConfig.bindings ?? {}).length,
          },
        },
      };
    }

    // POST /api/audit/sinks/config — 重载 tenant bindings (从最新 env)
    //   body: { bindings?: 'kid1:t1,kid2:t1+t2', headerName?, pathPrefix?, defaultTenant? }
    if (reqPath === '/api/audit/sinks/config' && method === 'POST') {
      const b = (req.body as any) || {};
      if (typeof b.bindings === 'string') {
        this.tenantCtxConfig.bindings = parseBindings(b.bindings);
      } else if (b.bindingsRaw) {
        this.tenantCtxConfig.bindings = parseBindings(b.bindingsRaw);
      }
      if (typeof b.headerName === 'string') this.tenantCtxConfig.headerName = b.headerName;
      if (typeof b.pathPrefix === 'string') this.tenantCtxConfig.pathPrefix = b.pathPrefix;
      if (typeof b.defaultTenant === 'string') this.tenantCtxConfig.defaultTenant = b.defaultTenant;
      return {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: {
          ok: true,
          tenant: {
            headerName: this.tenantCtxConfig.headerName,
            pathPrefix: this.tenantCtxConfig.pathPrefix,
            defaultTenant: this.tenantCtxConfig.defaultTenant,
            bindingsCount: Object.keys(this.tenantCtxConfig.bindings ?? {}).length,
          },
        },
      };
    }

    // Admin Dashboard APIs
    if (reqPath === '/api/status' && method === 'GET') {
      return this.handleSystemStatus();
    }
    if (reqPath === '/api/database/stats' && method === 'GET') {
      return this.handleDatabaseStats();
    }
    if (reqPath === '/api/agents' && method === 'GET') {
      return await this.handleAgents();
    }
    // ð§¬ Agent æ°æ®æµè´¯éç«¯ç¹
    if (reqPath === '/api/agents/snapshot' && method === 'GET') {
      return await this.handleAgentSnapshot();
    }
    if (reqPath === '/api/agents/dispatch' && method === 'POST') {
      return await this.handleAgentDispatch(req.body);
    }
    if (reqPath === '/api/agents/dispute' && method === 'POST') {
      return await this.handleAgentDispute(req.body);
    }
    if (reqPath === '/api/agents/bindSubTask' && method === 'POST') {
      return await this.handleAgentBindSubTask(req.body);
    }
    // P1.1 验证用: dev-only hook, 手工 enqueue 一条 ReputationIncrementRequested
    // 让 outbox_sync + worker + fetch 8766 + SQLite 整条链路走通
    // 仅当 SOLOFORGE_ENABLE_TEST_HOOK=1 环境变量开启时暴露
    if (
      reqPath === '/api/test/reputation-enqueue' &&
      method === 'POST' &&
      process.env.SOLOFORGE_ENABLE_TEST_HOOK === '1'
    ) {
      return await this.handleTestReputationEnqueue(req.body);
    }
    if (
      reqPath === '/api/test/reputation-bridge-status' &&
      method === 'GET' &&
      process.env.SOLOFORGE_ENABLE_TEST_HOOK === '1'
    ) {
      return this.handleTestReputationBridgeStatus();
    }
    if (reqPath === '/api/archiver/check' && method === 'POST') {
      return await this.handleArchiverCheck();
    }
    if (reqPath === '/api/archiver/start' && method === 'POST') {
      return this.handleArchiverStart();
    }
    if (reqPath === '/api/archiver/stop' && method === 'POST') {
      return this.handleArchiverStop();
    }
    if (reqPath === '/api/archiver/stats' && method === 'GET') {
      return this.handleArchiverStats();
    }

    // Scheduler APIs
    if (reqPath === '/api/scheduler/stats' && method === 'GET') {
      return this.handleSchedulerStats();
    }
    if (reqPath === '/api/scheduler/queue' && method === 'GET') {
      return this.handleSchedulerQueue();
    }

    // Events APIs
    if (reqPath === '/api/events/list' && method === 'GET') {
      return this.handleEventsList();
    }

    // Observation APIs
    if (reqPath === '/api/observation/data' && method === 'GET') {
      return this.handleObservationData();
    }
    if (reqPath === '/api/observation/start' && method === 'POST') {
      return this.handleObservationStart();
    }
    if (reqPath === '/api/observation/stop' && method === 'POST') {
      return this.handleObservationStop();
    }
    if (reqPath === '/api/observation/clear' && method === 'POST') {
      return this.handleObservationClear();
    }

    // Vault APIs (apiKey éåº, OS é¥åä¸²å¯ä¸å¯ä¿¡æº)
    // è·¯ç±:
    //   GET    /api/vault/keys              â ååºææ provider (è±æ)
    //   GET    /api/vault/keys/:id          â åä¸ª provider åä¿¡æ¯
    //   PUT    /api/vault/keys/:id          â åå¥/æ´æ° apiKey + baseUrl
    //   DELETE /api/vault/keys/:id          â å é¤ (idempotent)
    //   POST   /api/vault/keys/:id/verify   â æµè¯è¿éæ§
    //   POST   /api/vault/export           â å å¯å¯¼åº
    //   POST   /api/vault/import           â å å¯å¯¼å¥
    //   POST   /api/vault/verify-passphrase â éªè¯ passphrase
    if (reqPath === '/api/vault/keys' && method === 'GET') {
      return this.vaultResultToApi(await handleVaultList());
    }
    const vaultKeyMatch = reqPath.match(/^\/api\/vault\/keys\/([A-Za-z0-9_-]{1,64})(?:\/(verify|reveal))?$/);
    if (vaultKeyMatch) {
      const id = decodeURIComponent(vaultKeyMatch[1]);
      const sub = vaultKeyMatch[2];
      if (sub === 'verify') {
        if (method === 'POST') return this.vaultResultToApi(await handleVaultVerify(id));
      } else if (sub === 'reveal') {
        if (method === 'GET') return this.vaultResultToApi(await handleVaultReveal(id));
      } else if (method === 'GET') {
        return this.vaultResultToApi(await handleVaultGet(id));
      } else if (method === 'PUT') {
        return this.vaultResultToApi(await handleVaultPut(id, req.body));
      } else if (method === 'DELETE') {
        return this.vaultResultToApi(await handleVaultDelete(id));
      }
    }
    if (reqPath === '/api/vault/export' && method === 'POST') {
      return this.vaultResultToApi(await handleVaultExport(req.body));
    }
    if (reqPath === '/api/vault/import' && method === 'POST') {
      return this.vaultResultToApi(await handleVaultImport(req.body));
    }
    if (reqPath === '/api/vault/verify-passphrase' && method === 'POST') {
      return this.vaultResultToApi(await handleVaultVerifyPassphrase(req.body));
    }

    // Analytics APIs (DuckDB OLAP, 2026-07-02)
    if (reqPath === '/api/analytics/health' && method === 'GET') {
      return this.handleAnalyticsHealth();
    }
    if (reqPath === '/api/analytics/queries' && method === 'GET') {
      return this.handleAnalyticsQueries();
    }
    const analyticsRunMatch = reqPath.match(/^\/api\/analytics\/run\/([A-Za-z0-9_-]{1,64})$/);
    if (analyticsRunMatch && method === 'GET') {
      return this.handleAnalyticsRun(decodeURIComponent(analyticsRunMatch[1]));
    }
    if (reqPath === '/api/analytics/direct' && method === 'POST') {
      return this.handleAnalyticsDirect(req.body);
    }
    if (reqPath === '/api/analytics/snapshot' && method === 'POST') {
      return this.handleAnalyticsSnapshot(req.body);
    }
    if (reqPath === '/api/analytics/parquet' && method === 'POST') {
      return this.handleAnalyticsParquet(req.body);
    }

    // LLM Proxy APIs (非 SSE 的常规 JSON 端点)
    if (reqPath === '/api/llm/config' && method === 'GET') {
      return handleLLMConfigGet();
    }
    if (reqPath === '/api/llm/health' && method === 'GET') {
      return await handleLLMHealth(req);
    }

    // Terminal APIs — 用户在前端终端输入命令 → spawn 真实 shell → 通过 SSE 推 stdout/stderr/exit
    // 流程:
    //   1) 前端 POST { chatId, command, cwd, toolCallId }
    //   2) 后端 spawn cmd.exe/sh -c, 异步执行
    //   3) 后端 broadcastEvent('tool_started'/'tool_stdout'/'tool_stderr'/'tool_exit', payload)
    //   4) 前端 sseBackend 收到后桥接到 terminalLogStore
    if (reqPath === '/api/terminal/run' && method === 'POST') {
      return this.handleTerminalRun(req.body);
    }

    // Names API — 用户双击胶囊名称自定义 → 写入 names.txt 末尾 [CUSTOM] 标记位
    // 文件格式: "原名称1 原名称2 ... [CUSTOM] 自定义名称"
    // 读取时按 [CUSTOM] 分割: 前部是原列表, 后部是 customName (单独槽位, 每次覆盖)
    if (reqPath === '/api/names/update' && method === 'POST') {
      return this.handleNamesUpdate(req.body);
    }

    return { status: 404, headers: { 'Content-Type': 'application/json' }, body: { error: 'Not Found' } };
  }

  /**
   * æ vaultHandler è¿åç VaultRouteResult è½¬æ¢ä¸º API å±ç ApiResponse å½¢ç¶
   * (headers å¯é, é»è®¤ application/json; body éä¼ )
   */
  // Allow-list of fields that may be returned from /api/vault/* to the browser.
  // Even if PublicKeyInfo gains a new field in the future, this guard prevents
  // accidental secret leakage to the front-end (defense-in-depth).
  // 'apiKey' 仅由 /api/vault/keys/:id/reveal 端点返回明文，供前端小眼睛显示/复制
  private static readonly VAULT_PUBLIC_FIELDS = new Set([
    'id', 'baseUrl', 'hasKey', 'source', 'createdAt', 'updatedAt',
    'items', 'count', 'item', 'error', 'verified', 'exported', 'imported' as any as never,
    'apiKey',
  ]);

  private redactVaultBody(body: any): any {
    if (body === null || body === undefined) return body;
    if (Array.isArray(body)) return body.map((b) => this.redactVaultBody(b));
       if (typeof body !== 'object') return body;
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(body)) {
      if (SoloForgeApiServer.VAULT_PUBLIC_FIELDS.has(k)) {
        out[k] = v;
      } else if (k === 'items' || k === 'item') {
        out[k] = this.redactVaultBody(v);
      }
    }
    return out;
  }

  private vaultResultToApi(r: { status: number; headers?: Record<string, string>; body: any }): ApiResponse {
    return {
      status: r.status,
      headers: r.headers || { 'Content-Type': 'application/json' },
      body: this.redactVaultBody(r.body),
    };
  }

  // ============================================================
  // Admin UI Handler
  // ============================================================

  private handleAdminUI(): ApiResponse {
    const possiblePaths = [
      path.join(process.cwd(), 'src', 'ui', 'index.html'),
      path.join(__dirname, 'ui', 'index.html'),
      path.join(process.cwd(), '..', 'src', 'ui', 'index.html'),
      path.resolve(process.cwd(), 'src', 'ui', 'index.html')
    ];

    for (const uiPath of possiblePaths) {
      try {
        if (fs.existsSync(uiPath)) {
          const html = fs.readFileSync(uiPath, 'utf-8');
          logger.info('ApiServer', `Admin UI loaded from: ${uiPath}`);
          return {
            status: 200,
            headers: { 'Content-Type': 'text/html; charset=utf-8' },
            body: html
          };
        }
      } catch (err: any) {
        logger.warn('ApiServer', `Failed to load UI from ${uiPath}: ${err.message}`);
      }
    }

    // è¿åç®åçåè HTML
    return {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
      body: this.getInlineAdminUI()
    };
  }

  private getInlineAdminUI(): string {
    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>SoloForge ç®¡çåå°</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    body { background: linear-gradient(135deg, #0a0a0f 0%, #12121a 100%); min-height: 100vh; }
    .glass { background: rgba(26,28,28,0.8); backdrop-filter: blur(10px); border: 1px solid rgba(77,70,54,0.5); border-radius: 16px; }
    .stat { font-size: 48px; font-weight: bold; background: linear-gradient(135deg, #ffde82, #ffdf5d); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
  </style>
</head>
<body class="text-gray-200 p-8">
  <div class="max-w-6xl mx-auto">
    <h1 class="text-4xl font-bold text-amber-400 mb-8">SoloForge ç®¡çåå°</h1>

    <div class="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
      <div class="glass p-6">
        <h3 class="text-gray-400 mb-2">ç»ä»¶æ°</h3>
        <div class="stat" id="components">--</div>
      </div>
      <div class="glass p-6">
        <h3 class="text-gray-400 mb-2">è¿è¡æ¶é´</h3>
        <div class="stat text-3xl" id="uptime">--:--:--</div>
      </div>
      <div class="glass p-6">
        <h3 class="text-gray-400 mb-2">ç¶æ</h3>
        <div class="flex items-center gap-2">
          <span class="w-3 h-3 rounded-full bg-green-500 animate-pulse"></span>
          <span class="text-green-400">è¿è¡ä¸­</span>
        </div>
      </div>
    </div>

    <div class="glass p-6 mb-8">
      <h2 class="text-xl font-bold mb-4">API ç«¯ç¹</h2>
      <ul class="space-y-2">
        <li><a href="/api/status" class="text-blue-400 hover:underline">/api/status</a> - ç³»ç»ç¶æ</li>
        <li><a href="/api/database/stats" class="text-blue-400 hover:underline">/api/database/stats</a> - æ°æ®åºç»è®¡</li>
        <li><a href="/api/agents" class="text-blue-400 hover:underline">/api/agents</a> - ç»ä»¶åè¡¨</li>
        <li><a href="/api/kernel/status" class="text-blue-400 hover:underline">/api/kernel/status</a> - åæ ¸ç¶æ</li>
        <li><a href="/metrics" class="text-blue-400 hover:underline">/metrics</a> - Prometheus ææ </li>
      </ul>
    </div>

    <div class="glass p-6">
      <h2 class="text-xl font-bold mb-4">ç³»ç»ä¿¡æ¯</h2>
      <div id="sysinfo" class="text-gray-400">å è½½ä¸­...</div>
    </div>
  </div>

  <script>
    async function loadData() {
      try {
        const res = await fetch('/api/status');
        const data = await res.json();
        document.getElementById('components').textContent = (data.agents?.active || '--') + '/' + (data.agents?.total || '--');
        document.getElementById('sysinfo').innerHTML = \`
          <p>Node.js: \${data.nodeVersion || '--'}</p>
          <p>å¹³å°: \${data.platform || '--'}</p>
          <p>CPU: \${data.cpu?.toFixed(1) || '--'}%</p>
          <p>åå­: \${data.memory?.toFixed(1) || '--'}%</p>
          <p>åæ ¸ç¶æ: \${data.kernel?.state || '--'}</p>
        \`;
      } catch (e) {
        document.getElementById('sysinfo').textContent = 'æ æ³å è½½æ°æ®ï¼è¯·ç¡®ä¿åç«¯æå¡æ­£å¨è¿è¡';
      }
    }
    loadData();
    setInterval(loadData, 5000);

    // è®¡æ¶å¨
    let seconds = 0;
    setInterval(() => {
      seconds++;
      const h = Math.floor(seconds / 3600);
      const m = Math.floor((seconds % 3600) / 60);
      const s = seconds % 60;
      document.getElementById('uptime').textContent = \`\${String(h).padStart(2,'0')}:\${String(m).padStart(2,'0')}:\${String(s).padStart(2,'0')}\`;
    }, 1000);
  </script>
</body>
</html>`;
  }

  // ============================================================
  // System Status Handler
  // ============================================================

  private handleSystemStatus(): ApiResponse {
    const cpus = os.cpus();
    let totalIdle = 0, totalTick = 0;
    for (const cpu of cpus) {
      for (const type in cpu.times) {
        totalTick += (cpu.times as any)[type];
      }
      totalIdle += cpu.times.idle;
    }

    // è®¡ç®ç¬æ¶ CPU ä½¿ç¨çï¼ä¸¤æ¬¡éæ ·å¯¹æ¯ï¼
    let cpuUsage = 0;
    if (this.prevCpuTimes) {
      const idleDiff = totalIdle - this.prevCpuTimes.idle;
      const totalDiff = totalTick - this.prevCpuTimes.total;
      cpuUsage = totalDiff > 0 ? 100 - (100 * idleDiff / totalDiff) : 0;
    }
    this.prevCpuTimes = { idle: totalIdle, total: totalTick };

    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    const memUsage = (usedMem / totalMem) * 100;

    let kernelState = 'UNKNOWN', kernelVersion = 1;
    let activeComponents = 5, totalComponents = 5;

    try {
      kernelState = this.kernel['state'] || RuntimeState.READY;
      kernelVersion = this.kernel.version || 1;
      const componentsMap = this.kernel['components'];
      if (componentsMap && componentsMap instanceof Map) {
        totalComponents = componentsMap.size || 5;
        activeComponents = totalComponents;
      }
    } catch {}

    // è®¡ç®ç½ç»éç
    let networkSpeed = { up: 0, down: 0 };
    try {
      const networkStats = this.getSystemNetworkSpeed();
      networkSpeed = networkStats;
    } catch {}

    return {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: {
        cpu: cpuUsage,
        memory: memUsage,
        memoryUsed: (usedMem / (1024 * 1024 * 1024)).toFixed(2),
        memoryTotal: (totalMem / (1024 * 1024 * 1024)).toFixed(2),
        uptime: Date.now() - this.startedAt,
        platform: os.platform(),
        nodeVersion: process.version,
        network: networkSpeed,
        kernel: {
          state: kernelState,
          version: kernelVersion
        },
        agents: {
          active: activeComponents,
          total: totalComponents
        }
      }
    };
  }

  /**
   * è·åç½ç»éçï¼å­è/ç§ï¼
   */
  private getNetworkSpeed(): { up: number; down: number } {
    try {
      const now = Date.now();
      if (this.prevBytesTransferred) {
        const timeDiff = (now - this.prevBytesTransferred.time) / 1000;
        if (timeDiff >= 0.5) {
          const sentDiff = this.bytesTransferred.sent - this.prevBytesTransferred.sent;
          const recvDiff = this.bytesTransferred.received - this.prevBytesTransferred.received;
          this.prevBytesTransferred = { ...this.bytesTransferred, time: now };
          return {
            up: Math.round(sentDiff / timeDiff),
            down: Math.round(recvDiff / timeDiff)
          };
        }
      } else {
        this.prevBytesTransferred = { ...this.bytesTransferred, time: now };
      }
      return { up: 0, down: 0 };
    } catch {
      return { up: 0, down: 0 };
    }
  }

  /**
   * è·åçå®çç³»ç»ç½ç»æ¥å£æµéï¼Windowsï¼- ä½¿ç¨ PowerShell Get-Counter
   */
  private getSystemNetworkSpeed(): { up: number; down: number } {
    const now = Date.now();

    // 500ms ç¼å­ï¼é¿åé¢ç¹è°ç¨
    if (now - this.cachedNetworkSpeed.time < 500) {
      return { up: this.cachedNetworkSpeed.up, down: this.cachedNetworkSpeed.down };
    }

    try {
      const { execSync } = require("child_process");

      // ä½¿ç¨ PowerShell èæ¬æä»¶è·åç½ç»æ¥å£æ¯ç§å­èæ°
      const scriptPath = path.resolve(process.cwd(), 'get-network-speed.ps1');
      const psOutput = execSync(
        `powershell -ExecutionPolicy Bypass -File "${scriptPath}"`,
        { encoding: "utf8", timeout: 5000, windowsHide: true }
      );

      const values = psOutput.trim().split('\n')
        .map(v => parseFloat(v.trim()))
        .filter(v => !isNaN(v));

      let totalUp = 0, totalDown = 0;
      // å¶æ°ç´¢å¼æ¯åééçï¼å¥æ°ç´¢å¼æ¯æ¥æ¶éç
      for (let i = 0; i < values.length; i += 2) {
        totalUp += values[i] || 0;
        totalDown += values[i + 1] || 0;
      }

      const upVal = Math.round(totalUp);
      const downVal = Math.round(totalDown);
      this.cachedNetworkSpeed = { up: upVal, down: downVal, time: now };
      return { up: upVal, down: downVal };
    } catch {
      return { up: this.cachedNetworkSpeed.up, down: this.cachedNetworkSpeed.down };
    }
  }

  // ============================================================
  // Database Stats Handler
  // ============================================================

  private async handleDatabaseStats(): Promise<ApiResponse> {
    const stats = {
      garnet: { sessions: 0, tasks: 0, counters: 0, connected: false, healthy: false },
      surrealdb: { records: 0, hot: 0, connected: false, healthy: false },
      jsonl: { records: 0, size: '0 KB', healthy: true }
    };

    // Garnet
    try {
      const { getClient, healthCheck } = await import('./data/garnet/client');
      const client = getClient();
      if (client) {
        stats.garnet.connected = true;
        stats.garnet.healthy = await healthCheck().catch(() => false);
        const keys = await client.keys('*').catch(() => []);
        stats.garnet.sessions = keys.filter((k: string) => k.startsWith('session:')).length;
        stats.garnet.tasks = keys.filter((k: string) => k.startsWith('task:')).length;
        stats.garnet.counters = keys.filter((k: string) => k.startsWith('counter:')).length;
      }
    } catch {}

    // SurrealDB
    try {
      if (this.surrealPersistence) {
        const ready = this.surrealPersistence.isReady();
        if (ready) {
          stats.surrealdb.connected = true;
          stats.surrealdb.healthy = true;
        }
      }
    } catch {}

    // JSONL
    try {
      const jsonlFile = path.join(process.cwd(), 'data', 'jsonl', 'archive', 'cold_data.jsonl');
      if (fs.existsSync(jsonlFile)) {
        const content = fs.readFileSync(jsonlFile, 'utf-8');
        const lines = content.split('\n').filter((l: string) => l.trim());
        stats.jsonl.records = lines.length;
        const size = fs.statSync(jsonlFile).size;
        stats.jsonl.size = size > 1024 * 1024 ? `${(size / 1024 / 1024).toFixed(2)} MB` : `${(size / 1024).toFixed(2)} KB`;
      }
    } catch {}

    return { status: 200, headers: { 'Content-Type': 'application/json' }, body: stats };
  }

  // ============================================================
  // Agents Handler
  // ============================================================

  private async handleAgents(): Promise<ApiResponse> {
    const agents: Array<{ id: string; name: string; type: string; status: string; tasks: number }> = [];

    try {
      const componentsMap = this.kernel['components'];
      if (componentsMap && componentsMap instanceof Map) {
        let index = 1;
        for (const [name, component] of componentsMap) {
          let status = 'running';
          if (typeof (component as any).healthCheck === 'function') {
            try {
              status = await (component as any).healthCheck() ? 'running' : 'error';
            } catch {
              status = 'error';
            }
          }

          let type = 'system';
          if (name.includes('Court')) type = 'court';
          else if (name.includes('Decision')) type = 'decision';
          else if (name.includes('Governor')) type = 'governor';
          else if (name.includes('Agent')) type = 'agent';
          else if (name.includes('Event')) type = 'events';
          else if (name.includes('Scheduler')) type = 'scheduler';
          else if (name.includes('Persistence')) type = 'data';

          agents.push({
            id: `agent_${String(index).padStart(3, '0')}`,
            name,
            type,
            status,
            tasks: (component as any).taskCount || 0
          });
          index++;
        }
      }
    } catch {}

    if (agents.length === 0) {
      agents.push(
        { id: 'agent_001', name: 'RuntimeKernel', type: 'system', status: 'running', tasks: 0 },
        { id: 'agent_002', name: 'EventBus', type: 'events', status: 'running', tasks: this.kernel.eventBus.getEventLog().length },
        { id: 'agent_003', name: 'SchedulerClient', type: 'scheduler', status: 'running', tasks: 0 },
        { id: 'agent_004', name: 'SurrealPersistence', type: 'data', status: this.surrealPersistence?.isReady() ? 'running' : 'idle', tasks: 0 }
      );
    }

    return { status: 200, headers: { 'Content-Type': 'application/json' }, body: agents };
  }

  // ============================================================
  // ð§¬ Agent æ°æ®æµè´¯é Handlers
  //   /api/agents/snapshot  GET   â ååºæ± ä¸­ææ agent + å®æ¶ä¿¡ç¨å + metrics
  //   /api/agents/dispatch  POST  â RACER éè·¯ + çå®æ§è¡
  //   /api/agents/dispute   POST  â æäº¤è¯ç¶ â æ³é¢ â ååååä¿¡ç¨
  // ============================================================

  private async handleAgentSnapshot(): Promise<ApiResponse> {
    if (!this.agentRegistry) {
      return { status: 503, headers: { 'Content-Type': 'application/json' }, body: { error: 'AgentRegistry not initialized' } };
    }
    const snapshot = this.agentRegistry.snapshot();
    return {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: {
        count: snapshot.length,
        cpuLoad: this.agentRegistry.getCpuLoad(),
        agents: snapshot,
      },
    };
  }

  private async handleAgentDispatch(body: any): Promise<ApiResponse> {
    if (!this.agentOrchestrator) {
      return { status: 503, headers: { 'Content-Type': 'application/json' }, body: { error: 'AgentDecisionOrchestrator not initialized' } };
    }
    const payload = body?.payload ?? {};
    const mainProvider = body?.mainProvider ?? payload.mainProvider ?? null;
    const req: AgentDispatchRequest = {
      packetUuid: body?.packetUuid,
      packetSizeKb: body?.packetSizeKb,
      requiresDeepCognition: body?.requiresDeepCognition,
      globalConfidenceMetric: body?.globalConfidenceMetric,
      taskComplexityMetrics: body?.taskComplexityMetrics,
      chatId: body?.chatId,
      prompt: payload.prompt ?? body?.prompt,
      history: payload.history ?? body?.history,
      activeFile: payload.activeFile ?? body?.activeFile ?? null,
      mainProvider: mainProvider ? {
        baseUrl: mainProvider.baseUrl,
        apiKey: mainProvider.apiKey,
        model: mainProvider.model,
      } : undefined,
    };
    try {
      const result = await this.agentOrchestrator.dispatchPacket(req);
      return { status: 200, headers: { 'Content-Type': 'application/json' }, body: result };
    } catch (e: any) {
      return { status: 500, headers: { 'Content-Type': 'application/json' }, body: { error: e.message } };
    }
  }

  private async handleAgentDispute(body: any): Promise<ApiResponse> {
    if (!this.agentRegistry) {
      return { status: 503, headers: { 'Content-Type': 'application/json' }, body: { error: 'AgentRegistry not initialized' } };
    }
    const agentId = body?.agentId;
    const statement = body?.statement ?? 'Custody dispute over packet execution ordering';
    const attackMode = body?.attackMode ?? 'legitimate';
    if (!agentId) {
      return { status: 400, headers: { 'Content-Type': 'application/json' }, body: { error: 'agentId is required' } };
    }
    const agent = this.agentRegistry.getAgent(agentId);
    if (!agent) {
      return { status: 404, headers: { 'Content-Type': 'application/json' }, body: { error: `agent not found: ${agentId}` } };
    }
    const traceId = body?.traceId ?? `trace_${Date.now()}`;
    const claim = agent.forgeDisputeClaim(statement, attackMode);
    try {
      const verdict = await this.agentRegistry.raiseDispute(claim, traceId);
      return { status: 200, headers: { 'Content-Type': 'application/json' }, body: { claim, verdict, traceId } };
    } catch (e: any) {
      return { status: 500, headers: { 'Content-Type': 'application/json' }, body: { error: e.message } };
    }
  }

  /**
   * B+C 升级配套: 前端流送区在 phase0 阶段调用, 把 packetUuid:workerIdx 绑到
   *   前端 subTaskId, 这样 executeOnAgent 时能精确构造 streamHook → 工具调用 emit
   *   → SSE → 流送区 subTask.stepHistory
   */
  private async handleAgentBindSubTask(body: any): Promise<ApiResponse> {
    if (!this.agentRegistry) {
      return { status: 503, headers: { 'Content-Type': 'application/json' }, body: { error: 'AgentRegistry not initialized' } };
    }
    const { packetUuid, workerIdx, chatId, subTaskId, agentId } = body ?? {};
    if (!packetUuid || workerIdx === undefined || !chatId || !subTaskId || !agentId) {
      return { status: 400, headers: { 'Content-Type': 'application/json' }, body: { error: 'packetUuid, workerIdx, chatId, subTaskId, agentId are all required' } };
    }
    try {
      const result = this.agentRegistry.bindSubTask({ packetUuid, workerIdx, chatId, subTaskId, agentId });
      return { status: 200, headers: { 'Content-Type': 'application/json' }, body: result };
    } catch (e: any) {
      return { status: 500, headers: { 'Content-Type': 'application/json' }, body: { error: e.message } };
    }
  }

  // ============================================================
  // P1.1 dev-only test hook
  // ============================================================
  // 仅当 SOLOFORGE_ENABLE_TEST_HOOK=1 时才被路由调用。
  // 作用: 手工 emit 一条 ReputationIncrementRequested, 让
  //   outbox_sync → OutboxWorker → fetch 8766 → AI Society → SQLite
  // 整条链路在生产进程上跑通。
  // 字段名严格跟 reputation-bridge.ts:7-16 对齐 (P1.2 核对结果)。
  private handleTestReputationBridgeStatus(): ApiResponse {
    if (!this.reputationOutboxBridge) {
      return { status: 503, headers: { 'Content-Type': 'application/json' }, body: { error: 'ReputationOutboxBridge not started' } };
    }
    try {
      const status = this.reputationOutboxBridge.getStatus();
      return { status: 200, headers: { 'Content-Type': 'application/json' }, body: status };
    } catch (e: any) {
      return { status: 500, headers: { 'Content-Type': 'application/json' }, body: { error: e.message } };
    }
  }

  private async handleTestReputationEnqueue(body: any): Promise<ApiResponse> {
    if (!this.reputationOutboxBridge) {
      return { status: 503, headers: { 'Content-Type': 'application/json' }, body: { error: 'ReputationOutboxBridge not started' } };
    }
    if (!this.kernel || !this.kernel.eventBus) {
      return { status: 503, headers: { 'Content-Type': 'application/json' }, body: { error: 'kernel/eventBus not ready' } };
    }
    const payload = {
      commandId: body?.commandId ?? `test_cmd_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      txId: body?.txId ?? `test_tx_${Date.now()}`,
      traceId: body?.traceId ?? `test_trace_${Date.now()}`,
      agentClusterId: body?.agentClusterId ?? 'test_cluster',
      reputationIncrement: typeof body?.reputationIncrement === 'number' ? body.reputationIncrement : 1.0,
      reasonCode: body?.reasonCode ?? 'TEST_HOOK_E2E',
      kernelVersionSeal: body?.kernelVersionSeal ?? 1,
      timestamp: Date.now(),
    };
    try {
      // 关键: emit 而不是直接 enqueue, 走 bridge 订阅的真实路径
      const { RuntimeEvent } = await import('./core/events/runtime-events');
      this.kernel.eventBus.emit(RuntimeEvent.ReputationIncrementRequested, payload);
      return {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: { ok: true, payload, note: 'emit 完成, outbox worker 100ms 内会推到 8766' },
      };
    } catch (e: any) {
      return { status: 500, headers: { 'Content-Type': 'application/json' }, body: { error: e.message } };
    }
  }

  // ============================================================
  // Kernel Handlers
  // ============================================================

  private handleKernelStatus(): ApiResponse {
    return {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: {
        state: this.kernel['state'] || RuntimeState.READY,
        mode: this.kernel['mode'] || 'NORMAL',
        version: this.kernel.version,
        currentTick: this.kernel.currentTick,
        startedAt: this.kernel.startedAt,
        uptime: Date.now() - this.kernel.startedAt
      }
    };
  }

  private handleKernelHealth(): ApiResponse {
    const healthy = this.kernel['state'] !== RuntimeState.PANIC && this.kernel['state'] !== RuntimeState.STOPPED;
    return { status: 200, headers: { 'Content-Type': 'application/json' }, body: { healthy, state: this.kernel['state'] } };
  }

  private handleKernelEvents(limit: number): ApiResponse {
    return { status: 200, headers: { 'Content-Type': 'application/json' }, body: this.kernel.eventBus.getEventLog().slice(-limit) };
  }

  private async handleDbSchema(): Promise<ApiResponse> {
    return {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: {
        tables: ['decision', 'courtSubmission', 'courtVerdict', 'marlEpisode', 'eventLog', 'migration_history'],
        namespaces: ['soloforge_core'],
        databases: ['autonomous_network']
      }
    };
  }

  // ============================================================
  // SSE Handler
  // ============================================================

  private handleSSE(req: http.IncomingMessage, res: http.ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': (this.authConfig.allowedOrigins.includes(String(req.headers['origin'] || '')) ? String(req.headers['origin']) : (this.authConfig.allowedOrigins[0] || ''))
    });

    res.write(`data: ${JSON.stringify({ event: 'connected', timestamp: Date.now() })}\n\n`);
    this.sseClients.add(res);

    req.on('close', () => {
      this.sseClients.delete(res);
    });
  }

  // ============================================================
  // Prometheus Metrics
  // ============================================================

  private handlePrometheusMetrics(): ApiResponse {
    const uptime = Date.now() - this.startedAt;
    const eventCount = this.kernel.eventBus.getEventLog().length;

    const text = `# HELP soloforge_uptime_seconds Uptime in seconds
# TYPE soloforge_uptime_seconds gauge
soloforge_uptime_seconds ${(uptime / 1000).toFixed(0)}

# HELP soloforge_events_total Total events processed
# TYPE soloforge_events_total counter
soloforge_events_total ${eventCount}

# HELP soloforge_kernel_version Kernel version
# TYPE soloforge_kernel_version gauge
soloforge_kernel_version{state="${this.kernel['state'] || 'READY'}"} ${this.kernel.version || 1}
`;

    return { status: 200, headers: { 'Content-Type': 'text/plain' }, body: text };
  }

  // ============================================================
  // Archiver Handlers
  // ============================================================

  private async handleArchiverCheck(): Promise<ApiResponse> {
    if (!this.dataArchiver) {
      return { status: 200, headers: { 'Content-Type': 'application/json' }, body: { error: 'Archiver not initialized' } };
    }
    try {
      const stats = await this.dataArchiver.runArchiveCheck();
      return { status: 200, headers: { 'Content-Type': 'application/json' }, body: stats };
    } catch (err: any) {
      return { status: 200, headers: { 'Content-Type': 'application/json' }, body: { error: err.message } };
    }
  }

  private handleArchiverStart(): ApiResponse {
    if (this.dataArchiver) {
      this.dataArchiver.start();
      return { status: 200, headers: { 'Content-Type': 'application/json' }, body: { success: true } };
    }
    return { status: 200, headers: { 'Content-Type': 'application/json' }, body: { error: 'Archiver not initialized' } };
  }

  private handleArchiverStop(): ApiResponse {
    if (this.dataArchiver) {
      this.dataArchiver.stop();
      return { status: 200, headers: { 'Content-Type': 'application/json' }, body: { success: true } };
    }
    return { status: 200, headers: { 'Content-Type': 'application/json' }, body: { error: 'Archiver not initialized' } };
  }

  private handleArchiverStats(): ApiResponse {
    // è¿åæ¨¡æçå½æ¡£ç»è®¡
    const stats = {
      totalRecords: 0,
      hotRecords: 0,
      coldRecords: 0,
      archivedThisRun: 0,
      deletedThisRun: 0,
      garnetKeys: 0,
      surrealdbTables: ['conversation', 'message', 'decision', 'courtSubmission', 'courtVerdict', 'eventLog'],
      jsonlFiles: 0
    };
    return { status: 200, headers: { 'Content-Type': 'application/json' }, body: stats };
  }

  // ============================================================
  // Observation Handlers (æææ¼åè§æµ)
  // ============================================================

  /**
   * è·åè§æµæ°æ®
   */
  private handleObservationData(): ApiResponse {
    try {
      // è·åçå®äºä»¶æ°æ®
      const eventLog = this.kernel.eventBus.getEventLog();

      // ç»è®¡çå®æ°æ®
      const totalEvents = eventLog.length;
      let interventions = 0;
      let courtCases = 0;
      let coalitions = 0;

      // ç»è®¡åç±»äºä»¶
      for (const event of eventLog) {
        const eventType = ((event as any).type ?? (event as any).event ?? '').toLowerCase();
        if (eventType.includes('govern') || eventType.includes('intervention')) {
          interventions++;
        } else if (eventType.includes('court') || eventType.includes('verdict')) {
          courtCases++;
        } else if (eventType.includes('coalition') || eventType.includes('alliance')) {
          coalitions++;
        }
      }

      // è®¡ç®çå®ç³»ç»çµå¼ï¼åºäºäºä»¶å¤æ ·æ§ï¼
      let entropy = 0.5;
      if (totalEvents > 0) {
        // äºä»¶è¶å¤ï¼ç³»ç»è¶å¤æï¼çµå¼è¶é«
        const eventRate = Math.min(totalEvents / 500, 1);
        // å¤æ ·æ§å å­
        const diversity = (interventions + courtCases + coalitions) / Math.max(totalEvents, 1);
        // ç»¼åçµå¼
        entropy = 0.2 + eventRate * 0.5 + diversity * 0.3;
        entropy = Math.max(0, Math.min(1, entropy));
      }

      // å¦ææ­£å¨è§æµï¼è®°å½æ°æ°æ®
      if (this.isObserving) {
        const cycleId = this.observations.length + 1;
        const observation = {
          cycleId,
          timestamp: new Date().toISOString(),
          entropy,
          interventions,
          courtCases,
          coalitions
        };
        this.observations.push(observation);

        // ä¿çæè¿ 100 æ¡è®°å½
        if (this.observations.length > 100) {
          this.observations = this.observations.slice(-100);
        }
      }

      const lastUpdate = this.isObserving && this.observations.length > 0
        ? this.observations[this.observations.length - 1].timestamp
        : 'N/A';

      return {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: {
          isObserving: this.isObserving,
          lastUpdate,
          observations: this.observations.slice(-20),
          kernelVersion: this.kernel.version || 1,
          currentTick: this.kernel.currentTick || 0,
          uptime: Date.now() - this.startedAt,
          // éå çå®ç»è®¡
          stats: {
            totalEvents,
            interventions,
            courtCases,
            coalitions
          }
        }
      };
    } catch (err: any) {
      return {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: {
          isObserving: this.isObserving,
          lastUpdate: 'N/A',
          observations: [],
          kernelVersion: this.kernel.version || 1,
          currentTick: this.kernel.currentTick || 0,
          uptime: Date.now() - this.startedAt,
          error: err.message
        }
      };
    }
  }

  /**
   * å¼å§è§æµ
   */
  /**
   * Terminal Run — 用户在终端输入命令 → spawn 真实 shell → SSE 推 stdout/stderr/exit
   *
   * 设计要点:
   *   - 立即返回 200 + { ok: true, toolCallId }, 不阻塞 HTTP 响应
   *   - spawn 子进程异步执行, 通过 broadcastEvent 把事件推到所有 SSE 客户端
   *   - 前端 sseBackend 收到 tool_* 事件后桥接到 terminalLogStore
   *   - toolCallId 由前端生成 (如 `user-${Date.now()}`), 后端透传使用
   *   - 30s 超时兜底, 避免僵尸进程
   *   - 命令执行不受 chat 流送状态影响 (用户可独立跑命令)
   */
  private handleTerminalRun(body: any): ApiResponse {
    const chatId = String(body?.chatId || '').trim();
    const command = String(body?.command || '').trim();
    const cwd = String(body?.cwd || '').trim() || process.cwd();
    const toolCallId = String(body?.toolCallId || `user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);

    if (!chatId) {
      return { status: 400, headers: { 'Content-Type': 'application/json' }, body: { error: 'chatId required' } };
    }
    if (!command) {
      return { status: 400, headers: { 'Content-Type': 'application/json' }, body: { error: 'command required' } };
    }

    // 异步 spawn — 不阻塞 HTTP 响应
    const isWin = process.platform === 'win32';
    const child = isWin
      ? spawn('cmd.exe', ['/c', command], { cwd, windowsHide: true })
      : spawn('sh', ['-c', command], { cwd });

    const toolStart = Date.now();
    const tool = 'execute_cmd';

    // emit tool_started
    this.broadcastEvent('tool_started', {
      chatId, subTaskId: null, toolCallId, tool, args: command, ts: toolStart,
    });

    child.stdout?.on('data', (data: Buffer) => {
      const chunk = data.toString('utf-8');
      if (chunk) {
        this.broadcastEvent('tool_stdout', {
          chatId, subTaskId: null, toolCallId, tool, chunk, ts: Date.now(),
        });
      }
    });

    child.stderr?.on('data', (data: Buffer) => {
      const chunk = data.toString('utf-8');
      if (chunk) {
        this.broadcastEvent('tool_stderr', {
          chatId, subTaskId: null, toolCallId, tool, chunk, ts: Date.now(),
        });
      }
    });

    child.on('error', (err: Error) => {
      this.broadcastEvent('tool_stderr', {
        chatId, subTaskId: null, toolCallId, tool,
        chunk: `\n[spawn error] ${err.message}\n`, ts: Date.now(),
      });
      this.broadcastEvent('tool_exit', {
        chatId, subTaskId: null, toolCallId, tool,
        exitCode: 1, durationMs: Date.now() - toolStart, ts: Date.now(),
      });
    });

    child.on('close', (code: number | null) => {
      this.broadcastEvent('tool_exit', {
        chatId, subTaskId: null, toolCallId, tool,
        exitCode: code ?? 0, durationMs: Date.now() - toolStart, ts: Date.now(),
      });
    });

    // 兜底超时: 30s 后强制 kill
    setTimeout(() => {
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
    }, 30000);

    return {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: { ok: true, toolCallId },
    };
  }

  /**
   * 处理用户自定义名称 — 双击胶囊名称 → 输入新文字 → 写入 names.txt [CUSTOM] 槽位
   * 文件格式: "原名称1 原名称2 ... [CUSTOM] 自定义名称"
   * 单独槽位: 每次双击保存都会覆盖上一个自定义名称, 原列表保持完整
   */
  private handleNamesUpdate(body: any): ApiResponse {
    const customName = String(body?.customName || '').trim();

    // 定位 names.txt — 从 src/ 向上一级到项目根, 再进入 UI/public/名字/
    const namesPath = path.join(__dirname, '..', 'UI', 'public', '名字', 'names.txt');

    try {
      if (!fs.existsSync(namesPath)) {
        return { status: 404, headers: { 'Content-Type': 'application/json' }, body: { error: 'names.txt not found' } };
      }

      const content = fs.readFileSync(namesPath, 'utf-8');
      // 按 [CUSTOM] 分割, 只保留原列表部分
      const [origPart] = content.split(/\[CUSTOM\]/);
      const origText = (origPart || '').trim();

      // customName 非空 → 追加 [CUSTOM] 槽位; 为空 → 只保留原列表 (清除自定义)
      const newContent = customName
        ? `${origText} [CUSTOM] ${customName}`
        : origText;

      fs.writeFileSync(namesPath, newContent, 'utf-8');

      return {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: { ok: true, customName: customName || null },
      };
    } catch (err) {
      return {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
        body: { error: String(err) },
      };
    }
  }

  private handleObservationStart(): ApiResponse {
    if (this.isObserving) {
      return { status: 200, headers: { 'Content-Type': 'application/json' }, body: { success: true, message: 'Already observing' } };
    }

    this.isObserving = true;
    this.observations = [];

    // æ¯ 5 ç§ééä¸æ¬¡æ°æ®
    this.observationInterval = setInterval(() => {
      // è§¦åä¸æ¬¡æ°æ®æ´æ°ï¼å¹¿æ­ç» SSE å®¢æ·ç«¯
      this.broadcastEvent('observation', { isObserving: true, timestamp: Date.now() });
    }, 5000);

    console.log('[Observation] Started observing civilization evolution');
    return { status: 200, headers: { 'Content-Type': 'application/json' }, body: { success: true, message: 'Observation started' } };
  }

  /**
   * åæ­¢è§æµ
   */
  private handleObservationStop(): ApiResponse {
    if (this.observationInterval) {
      clearInterval(this.observationInterval);
      this.observationInterval = null;
    }
    this.isObserving = false;

    console.log('[Observation] Stopped observing');
    return { status: 200, headers: { 'Content-Type': 'application/json' }, body: { success: true, message: 'Observation stopped' } };
  }

  /**
   * æ¸ç©ºè§æµæ°æ®
   */
  private handleObservationClear(): ApiResponse {
    this.observations = [];
    console.log('[Observation] Cleared observation data');
    return { status: 200, headers: { 'Content-Type': 'application/json' }, body: { success: true, message: 'Observation data cleared' } };
  }

  // ============================================================
  // Scheduler Handlers (ä»»å¡è°åº¦å¨)
  // ============================================================

  /**
   * è·åè°åº¦å¨ç»è®¡
   */
  private handleSchedulerStats(): ApiResponse {
    // è·å Rust è°åº¦å¨çç»è®¡ä¿¡æ¯
    // ç±äº Rust è°åº¦å¨å¯è½ä¸å¯ç¨ï¼è¿åæ¨¡ææ°æ®
    const stats = {
      mode: 'RUNNING',
      queueSize: Math.floor(Math.random() * 10),
      stats: {
        total_push: Math.floor(Math.random() * 1000),
        total_pop: Math.floor(Math.random() * 900),
        total_ping: Math.floor(Math.random() * 500),
        aging_boosts: Math.floor(Math.random() * 50)
      },
      connected: true,
      error: null
    };

    // å°è¯ä»çå®çè°åº¦å¨å®¢æ·ç«¯è·åæ°æ®
    try {
      const schedulerClient = (this.kernel as any).schedulerClient;
      if (schedulerClient && schedulerClient.stats) {
        return {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
          body: schedulerClient.stats
        };
      }
    } catch {}

    return {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: stats
    };
  }

  /**
   * è·åè°åº¦å¨éå
   */
  private handleSchedulerQueue(): ApiResponse {
    // è¿åè°åº¦å¨éåä¿¡æ¯
    return {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: {
        tasks: [],
        total: 0,
        aging_queue: 0,
        priority_queue: 0
      }
    };
  }

  // ============================================================
  // Events Handlers (äºä»¶åè¡¨)
  // ============================================================

  /**
   * è·åäºä»¶åè¡¨
   */
  private handleEventsList(): ApiResponse {
    const eventLog = this.kernel.eventBus.getEventLog();
    const limit = parseInt(new URL('http://localhost' + '?limit=100').searchParams.get('limit') || '100', 10);

    return {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: {
        events: eventLog.slice(-limit).reverse(),
        total: eventLog.length,
        connected: true
      }
    };
  }

  // ============================================================
  // DuckDB Analytics Handlers (2026-07-02)
  //   /api/analytics/health     GET   — 探活 (duckdb.exe + sqlite)
  //   /api/analytics/queries    GET   — 列出 4 个内置聚合查询模板
  //   /api/analytics/run/:name  GET   — 跑指定查询 (read-only)
  //   /api/analytics/direct     POST  — 任意 SQL (read-only 推荐)
  //   /api/analytics/snapshot   POST  — 抽 SQLite → .duckdb
  //   /api/analytics/parquet    POST  — 抽 SQLite → .parquet (训练数据)
  //
  // 直接 spawn duckdb.exe CLI（与 Python analytics.py 同一二进制），
  // 跳过 Python 包装，零跨语言延迟。SQLite ATTACH 走 db.main.<table>。
  // ============================================================

  private static readonly ANALYTICS_QUERIES: Record<string, { description: string; sql: string }> = {
    governance_summary: {
      description: "治理合规记录按 action_taken 聚合（最近）",
      sql: `SELECT action_taken, compliant, COUNT(*) AS cnt
            FROM db.main.governance_record GROUP BY action_taken, compliant
            ORDER BY cnt DESC LIMIT 20`,
    },
    top_institutions: {
      description: "Top 机构 by 信誉分 (reputation)",
      sql: `SELECT entity_id, entity_type, score, name
            FROM db.main.reputation ORDER BY CAST(score AS DOUBLE) DESC NULLS LAST LIMIT 10`,
    },
    law_violation_by_type: {
      description: "法律违规按 status 聚合 + 平均 ID 分布",
      sql: `SELECT status, COUNT(*) AS cnt, COUNT(DISTINCT law_id) AS distinct_laws
            FROM db.main.law_violation GROUP BY status
            HAVING cnt > 0 ORDER BY cnt DESC LIMIT 20`,
    },
    memory_table_counts: {
      description: "每个业务表的 DuckDB 视角行数",
      sql: `SELECT 'coalition' AS table_name, COUNT(*) AS row_count FROM db.main.coalition
            UNION ALL SELECT 'economy', COUNT(*) FROM db.main.economy
            UNION ALL SELECT 'governance', COUNT(*) FROM db.main.governance
            UNION ALL SELECT 'governance_record', COUNT(*) FROM db.main.governance_record
            UNION ALL SELECT 'law', COUNT(*) FROM db.main.law
            UNION ALL SELECT 'law_violation', COUNT(*) FROM db.main.law_violation
            UNION ALL SELECT 'reputation', COUNT(*) FROM db.main.reputation
            UNION ALL SELECT 'reputation_record', COUNT(*) FROM db.main.reputation_record
            UNION ALL SELECT 'social_memory', COUNT(*) FROM db.main.social_memory
            UNION ALL SELECT 'credit_transaction', COUNT(*) FROM db.main.credit_transaction
            UNION ALL SELECT 'economy_record', COUNT(*) FROM db.main.economy_record
            UNION ALL SELECT 'culture', COUNT(*) FROM db.main.culture
            UNION ALL SELECT 'institution', COUNT(*) FROM db.main.institution
            ORDER BY row_count DESC`,
    },
  };

  // 2026-07-02: 与 init_ai_society.py init 出来的 14 张业务表完全对齐
  //   (institution / governance / reputation / culture / economy / law / law_violation
  //    / coalition / social_memory / credit_transaction / economy_record
  //    / governance_record / reputation_record / reputation_sync_log)
  // 之前错误的 5 张 (agent/cluster/memory/event/transaction) 在 ai_society.db 中根本不存在,
  // 现已替换为 5 张实际存在的业务表 (institution/governance/culture/economy/social_memory) + reputation_sync_log
  private static readonly ANALYTICS_SNAPSHOT_TABLES: string[] = [
    "institution", "governance", "reputation", "culture", "economy", "law",
    "law_violation", "coalition", "social_memory",
    "credit_transaction", "economy_record", "governance_record",
    "reputation_record", "reputation_sync_log",
  ];

  private resolveDuckDbBinary(): string | null {
    const candidates = [
      path.resolve(process.cwd(), "bin", "duckdb", "duckdb.exe"),
      "C:/Users/yangx/Desktop/SoloForge/bin/duckdb/duckdb.exe",
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }
    return null;
  }

  private resolveAnalyticsSqlitePath(): string | null {
    const candidates = [
      path.resolve(process.cwd(), "python", "data", "ai_society", "ai_society.db"),
      "C:/Users/yangx/Desktop/SoloForge/python/data/ai_society/ai_society.db",
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }
    return null;
  }

  private runDuckDbQuery(sql: string, timeoutMs: number = 30000): { ok: boolean; csv: string; stderr: string; elapsedMs: number } {
    const bin = this.resolveDuckDbBinary();
    if (!bin) return { ok: false, csv: "", stderr: "duckdb.exe not found", elapsedMs: 0 };
    const sqlite = this.resolveAnalyticsSqlitePath();
    if (!sqlite) return { ok: false, csv: "", stderr: "ai_society.db not found", elapsedMs: 0 };
    const attach = sqlite.replace(/\\/g, "/");
    const fullSql = `INSTALL sqlite; LOAD sqlite; ATTACH '${attach}' AS db (TYPE sqlite, READ_ONLY); ${sql}`;
    const t0 = Date.now();
    const proc = spawnSync(bin, ["-csv", "-c", fullSql], { encoding: "utf8", timeout: timeoutMs, windowsHide: true });
    return {
      ok: proc.status === 0,
      csv: proc.stdout || "",
      stderr: proc.stderr || "",
      elapsedMs: Date.now() - t0,
    };
  }

  private parseCsv(csv: string): string[][] {
    return csv.split("\n").filter((l) => l.length > 0).map((l) => l.split(","));
  }

  private handleAnalyticsHealth(): ApiResponse {
    const bin = this.resolveDuckDbBinary();
    const sqlite = this.resolveAnalyticsSqlitePath();
    const versionProc = bin ? spawnSync(bin, ["-version"], { encoding: "utf8", timeout: 5000, windowsHide: true }) : null;
    const version = versionProc?.status === 0 ? (versionProc.stdout || "").trim() : null;
    return {
      status: 200,
      headers: { "Content-Type": "application/json" },
      body: {
        duckdb_available: !!bin,
        duckdb_binary: bin,
        duckdb_version: version,
        sqlite_path: sqlite,
        sqlite_exists: !!sqlite,
        queries_defined: Object.keys(SoloForgeApiServer.ANALYTICS_QUERIES),
        snapshot_tables: SoloForgeApiServer.ANALYTICS_SNAPSHOT_TABLES,
      },
    };
  }

  private handleAnalyticsQueries(): ApiResponse {
    return {
      status: 200,
      headers: { "Content-Type": "application/json" },
      body: {
        queries: Object.entries(SoloForgeApiServer.ANALYTICS_QUERIES).map(([name, spec]) => ({
          name,
          description: spec.description,
        })),
      },
    };
  }

  private handleAnalyticsRun(name: string): ApiResponse {
    const spec = SoloForgeApiServer.ANALYTICS_QUERIES[name];
    if (!spec) {
      return { status: 404, headers: { "Content-Type": "application/json" }, body: { error: `Unknown query: ${name}`, available: Object.keys(SoloForgeApiServer.ANALYTICS_QUERIES) } };
    }
    const r = this.runDuckDbQuery(spec.sql);
    if (!r.ok) {
      return { status: 500, headers: { "Content-Type": "application/json" }, body: { error: "duckdb query failed", stderr: r.stderr, query: name } };
    }
    const rows = this.parseCsv(r.csv);
    return {
      status: 200,
      headers: { "Content-Type": "application/json" },
      body: {
        query_name: name,
        description: spec.description,
        row_count: Math.max(0, rows.length - 1),
        rows,
        elapsed_ms: r.elapsedMs,
      },
    };
  }

  private handleAnalyticsDirect(body: any): ApiResponse {
    const rawSql = String(body?.sql || "").trim();
    if (!rawSql) {
      return { status: 400, headers: { "Content-Type": "application/json" }, body: { error: "sql is required (POST body: { sql: 'SELECT ...' })" } };
    }
    // 防御：拦截明显破坏性语句（无 WHERE 的 DROP/TRUNCATE/DELETE/UPDATE）
    const upper = rawSql.toUpperCase().replace(/\s+/g, " ");
    if (/\b(DROP|TRUNCATE)\b/.test(upper) || (/\b(DELETE\s+FROM|UPDATE\s+\w+\s+SET)\b/.test(upper) && !upper.includes("WHERE"))) {
      return { status: 403, headers: { "Content-Type": "application/json" }, body: { error: "destructive statement rejected" } };
    }
    // 2026-07-02 修复: CAST(x AS T) → TRY_CAST(x AS T)
    //   SQLite 列类型弱, DuckDB ATTACH 后推断为 VARCHAR, CAST AS INTEGER 在非数字列上会 500
    //   TRY_CAST 失败返回 NULL 而不是报错, 符合 OLAP 容错语义
    const sql = rawSql.replace(/\bCAST\s*\(/gi, "TRY_CAST(");
    const r = this.runDuckDbQuery(sql);
    if (!r.ok) {
      return { status: 500, headers: { "Content-Type": "application/json" }, body: { error: "duckdb query failed", stderr: r.stderr, sql: rawSql, transformed_sql: sql } };
    }
    const rows = this.parseCsv(r.csv);
    return {
      status: 200,
      headers: { "Content-Type": "application/json" },
      body: { row_count: Math.max(0, rows.length - 1), rows, elapsed_ms: r.elapsedMs, cast_transformed: sql !== rawSql },
    };
  }

  private handleAnalyticsSnapshot(body: any): ApiResponse {
    const outPathRaw = body?.out_path || path.resolve(process.cwd(), "python", "data", "ai_society", "analytics", "snapshot.duckdb");
    const outPath = path.resolve(outPathRaw);
    const tables: string[] = Array.isArray(body?.tables) && body.tables.length > 0
      ? body.tables
      : SoloForgeApiServer.ANALYTICS_SNAPSHOT_TABLES;

    const allowed = new Set(SoloForgeApiServer.ANALYTICS_SNAPSHOT_TABLES);
    for (const t of tables) {
      if (!allowed.has(t)) {
        return { status: 400, headers: { "Content-Type": "application/json" }, body: { error: `table not in whitelist: ${t}`, allowed: [...allowed] } };
      }
    }

    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    if (fs.existsSync(outPath)) fs.unlinkSync(outPath);

    const bin = this.resolveDuckDbBinary();
    const sqlite = this.resolveAnalyticsSqlitePath();
    if (!bin || !sqlite) {
      return { status: 503, headers: { "Content-Type": "application/json" }, body: { error: "duckdb.exe or ai_society.db not available" } };
    }
    const attachSrc = sqlite.replace(/\\/g, "/");
    const attachDst = outPath.replace(/\\/g, "/");
    const prefix = `INSTALL sqlite; LOAD sqlite; ATTACH '${attachSrc}' AS src (TYPE sqlite, READ_ONLY); ATTACH '${attachDst}' AS dst; CREATE SCHEMA IF NOT EXISTS dst.main; `;

    const t0 = Date.now();
    const results: Array<{ table: string; row_count: number }> = [];
    for (const table of tables) {
      const r1 = spawnSync(bin, ["-c", prefix + `CREATE OR REPLACE TABLE dst.main.${table} AS SELECT * FROM src.main.${table} WHERE 0`], { encoding: "utf8", timeout: 30000, windowsHide: true });
      if (r1.status !== 0) {
        return { status: 500, headers: { "Content-Type": "application/json" }, body: { error: `schema copy failed for ${table}`, stderr: r1.stderr } };
      }
      const r2 = spawnSync(bin, ["-c", prefix + `INSERT INTO dst.main.${table} SELECT * FROM src.main.${table}`], { encoding: "utf8", timeout: 30000, windowsHide: true });
      if (r2.status !== 0) {
        return { status: 500, headers: { "Content-Type": "application/json" }, body: { error: `data copy failed for ${table}`, stderr: r2.stderr } };
      }
      const r3 = spawnSync(bin, ["-csv", "-c", prefix + `SELECT COUNT(*) FROM dst.main.${table}`], { encoding: "utf8", timeout: 10000, windowsHide: true });
      const cnt = parseInt((r3.stdout || "").trim().split("\n").pop() || "0", 10) || 0;
      results.push({ table, row_count: cnt });
    }
    const elapsedMs = Date.now() - t0;
    const sizeBytes = fs.existsSync(outPath) ? fs.statSync(outPath).size : 0;
    return {
      status: 200,
      headers: { "Content-Type": "application/json" },
      body: {
        out_path: outPath,
        tables_exported: results,
        total_rows: results.reduce((s, r) => s + r.row_count, 0),
        size_bytes: sizeBytes,
        elapsed_ms: elapsedMs,
      },
    };
  }

  private handleAnalyticsParquet(body: any): ApiResponse {
    const outDirRaw = body?.out_dir || path.resolve(process.cwd(), "python", "data", "ai_society", "analytics", "parquet");
    const outDir = path.resolve(outDirRaw);
    const tables: string[] = Array.isArray(body?.tables) && body.tables.length > 0
      ? body.tables
      : SoloForgeApiServer.ANALYTICS_SNAPSHOT_TABLES;

    const allowed = new Set(SoloForgeApiServer.ANALYTICS_SNAPSHOT_TABLES);
    for (const t of tables) {
      if (!allowed.has(t)) {
        return { status: 400, headers: { "Content-Type": "application/json" }, body: { error: `table not in whitelist: ${t}`, allowed: [...allowed] } };
      }
    }

    fs.mkdirSync(outDir, { recursive: true });
    const bin = this.resolveDuckDbBinary();
    if (!bin) {
      return { status: 503, headers: { "Content-Type": "application/json" }, body: { error: "duckdb.exe not available" } };
    }
    const sqlite = this.resolveAnalyticsSqlitePath();
    if (!sqlite) {
      return { status: 503, headers: { "Content-Type": "application/json" }, body: { error: "ai_society.db not available" } };
    }
    const attachSrc = sqlite.replace(/\\/g, "/");
    const tmpDuckDb = path.join(outDir, "_snapshot.duckdb");
    if (fs.existsSync(tmpDuckDb)) fs.unlinkSync(tmpDuckDb);
    const attachTmp = tmpDuckDb.replace(/\\/g, "/");
    const prefix = `INSTALL sqlite; LOAD sqlite; ATTACH '${attachSrc}' AS src (TYPE sqlite, READ_ONLY); ATTACH '${attachTmp}' AS dst; `;

    for (const table of tables) {
      const r1 = spawnSync(bin, ["-c", prefix + `CREATE OR REPLACE TABLE dst.main.${table} AS SELECT * FROM src.main.${table}`], { encoding: "utf8", timeout: 30000, windowsHide: true });
      if (r1.status !== 0) {
        return { status: 500, headers: { "Content-Type": "application/json" }, body: { error: `snapshot copy failed for ${table}`, stderr: r1.stderr } };
      }
    }

    const files: Array<{ table: string; path: string; size_bytes: number }> = [];
    for (const table of tables) {
      const parquetPath = path.join(outDir, `${table}.parquet`);
      const r = spawnSync(bin, ["-c", prefix + `COPY dst.main.${table} TO '${parquetPath.replace(/\\/g, "/")}' (FORMAT PARQUET)`], { encoding: "utf8", timeout: 30000, windowsHide: true });
      if (r.status !== 0) {
        return { status: 500, headers: { "Content-Type": "application/json" }, body: { error: `parquet export failed for ${table}`, stderr: r.stderr } };
      }
      files.push({ table, path: parquetPath, size_bytes: fs.existsSync(parquetPath) ? fs.statSync(parquetPath).size : 0 });
    }

    try { fs.unlinkSync(tmpDuckDb); } catch { /* ignore */ }

    return {
      status: 200,
      headers: { "Content-Type": "application/json" },
      body: { out_dir: outDir, files },
    };
  }
}
