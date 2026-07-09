// ────────────────────────────────────────────────────────────
// SoloForge API Server Layer
// Path: src/api-server.ts
// Description: HTTP + SSE API server — exposes kernel state to frontend
//
// Refactored into modules under src/server/:
//   types.ts         — shared ApiRequest / ApiResponse
//   middleware.ts     — auth, rate-limit, tenant pipeline
//   routes-agent.ts  — /api/agents/*, /api/test/*
//   routes-system.ts — /api/status, /api/kernel/*, analytics, SSE, etc.
//   routes-vault.ts  — /api/vault/*, /api/audit/*, /api/auth/*
//   ws-manager.ts    — SSE client + AgentEventHub management
// ────────────────────────────────────────────────────────────

import http from 'http';
import crypto from 'crypto';
import { RuntimeKernel } from './kernel/runtime-kernel';
import { TelemetryMetricExporter } from './kernel/observability/telemetry-exporter';
import { SurrealPersistence } from './data/surreal_persistence';
import { DataArchiverService } from './data/data-archiver';
import { logger } from './core/logger';
import { AgentRegistry } from './core/agent/agent-registry';
import { AgentDecisionOrchestrator } from './core/agent/agent-decision-orchestrator';
import {
  defaultAuthConfig,
  AuthConfig,
  RateLimiter,
  defaultRateLimit,
  strictRateLimit,
  defaultAuditSink,
  AuditSink,
} from './security/auth';
import { createAuditSinkFromSurreal } from './security/auditSinkSurreal';
import { parseBindings, type TenantContextConfig } from './security/tenantContext';
import { handleLLMStreamProxy } from './llm/llmProxyHandler';

// --- Module imports ---
import type { ApiResponse } from './server/types';
import {
  handleCanvasRelayPushUi,
  handleCanvasPortRegister,
  handleCanvasPortUnregister,
} from './server/routes-canvas';
import { runMiddleware } from './server/middleware';
import { SseManager, AgentEventHubManager } from './server/ws-manager';
import type { AgentRouteDeps } from './server/routes-agent';
import {
  handleAgentSnapshot,
  handleAgentDispatch,
  handleAgentDispatchSSE,
  handleAgentDispute,
  handleAgentBindSubTask,
  handleExperienceFeedback,
  handleTestReputationBridgeStatus,
  handleTestReputationEnqueue,
} from './server/routes-agent';
import type { SystemRouteDeps, NetworkMetricsState, ObservationState } from './server/routes-system';
import {
  handleSystemStatus,
  handleDatabaseStats,
  handleAgents,
  handleKernelStatus,
  handleKernelHealth,
  handleKernelEvents,
  handleDbSchema,
  handlePrometheusMetrics,
  handleEventsList,
  handleSchedulerStats,
  handleSchedulerQueue,
  handleArchiverCheck,
  handleArchiverStart,
  handleArchiverStop,
  handleArchiverStats,
  handleObservationData,
  handleObservationStart,
  handleObservationStop,
  handleObservationClear,
  handleTerminalRun,
  handleNamesUpdate,
  handleLlmConfig,
  handleLlmHealth,
  handleAdminUI,
  handleUiStatic,
  handleTestNav,
  handleJavaAgentProxy,
  handleAnalyticsHealth,
  handleAnalyticsQueries,
  handleAnalyticsRun,
  handleAnalyticsDirect,
  handleAnalyticsSnapshot,
  handleAnalyticsParquet,
} from './server/routes-system';
import type { VaultRouteDeps } from './server/routes-vault';
import {
  handleAuthBootstrap,
  handleAuditList,
  handleAuditStats,
  handleAuditSinks,
  handleAuditSinksConfig,
  handleVaultKeysList,
  handleVaultKeyGet,
  handleVaultKeyPut,
  handleVaultKeyDelete,
  handleVaultKeyVerify,
  handleVaultKeyReveal,
  handleVaultExport,
  handleVaultImport,
  handleVaultVerifyPassphrase,
} from './server/routes-vault';

// ============================================================
// API Server
// ============================================================

export class SoloForgeApiServer {
  private server: http.Server | null = null;
  private port: number;
  private kernel: RuntimeKernel;
  private telemetryExporter: TelemetryMetricExporter | null = null;
  private surrealPersistence: SurrealPersistence | null = null;
  private dataArchiver: DataArchiverService | null = null;
  private agentRegistry: AgentRegistry | null = null;
  private agentOrchestrator: AgentDecisionOrchestrator | null = null;
  private reputationOutboxBridge: any = null;
  private startedAt: number = Date.now();

  // Auth / security
  private authConfig: AuthConfig = defaultAuthConfig;
  private readonly rateLimiter = new RateLimiter(defaultRateLimit);
  private readonly strictRateLimiter = new RateLimiter(strictRateLimit);
  private audit: AuditSink = defaultAuditSink;
  private readonly piiSalt = process.env.SOLOFORGE_PII_SALT || crypto.randomBytes(16).toString('hex');
  private auditSinkSurreal: import('./security/auditSinkSurreal').AuditSinkSurreal | null = null;
  private auditChangeFeed: any = null;

  // Multi-tenant config
  private tenantCtxConfig: TenantContextConfig = {
    headerName: process.env.SOLOFORGE_TENANT_HEADER || 'X-Tenant-Id',
    pathPrefix: process.env.SOLOFORGE_TENANT_PATH_PREFIX || '/api/t/',
    defaultTenant: process.env.SOLOFORGE_TENANT_DEFAULT || '_default',
    bindings: parseBindings(process.env.SOLOFORGE_TENANT_BINDINGS),
  };
  private getTenantBindings(): Record<string, string[]> {
    return this.tenantCtxConfig.bindings ?? {};
  }

  // Network metrics (shared by ref with system routes)
  private networkMetrics: NetworkMetricsState = {
    sent: 0, received: 0,
    prevBytes: null,
    cachedSpeed: { up: 0, down: 0, time: 0 },
    prevCpuTimes: null,
  };

  // Observation state (shared by ref with system routes)
  private observationState: ObservationState = {
    isObserving: false,
    observations: [],
    interval: null,
  };

  // SSE + WS managers
  private sseManager = new SseManager();
  private agentEventHubManager = new AgentEventHubManager();

  // ---- Public setters (kept for backward compat) ----
  public setAuthConfig(cfg: AuthConfig): void { this.authConfig = cfg; }
  public setAgentRegistry(registry: AgentRegistry): void { this.agentRegistry = registry; }
  public setAgentOrchestrator(orchestrator: AgentDecisionOrchestrator): void { this.agentOrchestrator = orchestrator; }
  public setAuditSink(sink: AuditSink): void { this.audit = sink; }
  public setPiiSalt(s: string): void { (this as any).piiSalt = s; }

  constructor(
    kernel: RuntimeKernel,
    telemetryExporter?: TelemetryMetricExporter,
    surrealPersistence?: SurrealPersistence,
    port: number = 3001,
  ) {
    this.kernel = kernel;
    this.telemetryExporter = telemetryExporter || null;
    this.surrealPersistence = surrealPersistence || null;
    this.port = parseInt(process.env.API_PORT || String(port), 10);

    if (!process.env.SOLOFORGE_PII_SALT) {
      console.warn('[ApiServer] WARNING: SOLOFORGE_PII_SALT not set. Using random salt — PII hashes will differ across restarts.');
    }

    if (surrealPersistence) {
      this.dataArchiver = new DataArchiverService(surrealPersistence, 5 * 60 * 1000);
    }
  }

  public getDataArchiver(): DataArchiverService | null { return this.dataArchiver; }
  public getPort(): number { return this.port; }

  // ---- SSE broadcast (public, used by kernel event listeners) ----
  public broadcastEvent(event: string, payload: any): void {
    this.sseManager.broadcast(event, payload);
  }

  // ============================================================
  // Lifecycle
  // ============================================================

  public async start(): Promise<void> {
    // Load tokens
    const { loadApiTokensAsync } = await import('./security/auth');
    const tokens = await loadApiTokensAsync();
    this.authConfig = { ...this.authConfig, apiTokens: tokens };
    logger.info('ApiServer', `[auth] ${tokens.length} API token(s) loaded`);

    // Token rotation worker
    if (process.env.SOLOFORGE_ROTATION_DISABLED !== '1') {
      try {
        const { getTokenRotationService } = await import('./security/tokenRotationService');
        const svc = getTokenRotationService();
        svc.start();
        void svc.tickOnce().catch((e) => logger.warn('TokenRotation', `startup tick failed: ${(e as Error).message}`));
        logger.info('ApiServer', 'Token rotation worker started');
      } catch (e) {
        logger.warn('ApiServer', `Token rotation worker not started: ${(e as Error).message}`);
      }
    }

    // Audit Sink -> SurrealDB
    if (this.surrealPersistence) {
      try {
        this.auditSinkSurreal = createAuditSinkFromSurreal(this.surrealPersistence, {
          mirrorToStdout: true, fallbackToStdout: true, flushThreshold: 50, flushIntervalMs: 5000,
        });
        this.setAuditSink(this.auditSinkSurreal.asSink());
        logger.info('ApiServer', 'Audit sink -> SurrealDB httpAuditLog');

        // Audit Change Feed -> Kafka
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
              logger.info('ApiServer', `Audit change feed -> Kafka brokers=[${brokers.join(',')}] topic=${topic}`);
            } catch (e) {
              logger.warn('ApiServer', `Change feed not started: ${(e as Error).message}`);
            }
          }
        }
      } catch (e) {
        logger.warn('ApiServer', `Audit sink surreal not mounted: ${(e as Error).message}`);
      }
    }

    return new Promise((resolve, reject) => {
      this.server = http.createServer(async (req, res) => {
        await this.handleRequest(req, res);
      });

      this.server.listen(this.port, () => {
        logger.info('ApiServer', `SoloForge API Server listening on http://localhost:${this.port}`);
        logger.info('ApiServer', `   Admin UI: http://localhost:${this.port}/admin`);
        logger.info('ApiServer', `   SSE Events: http://localhost:${this.port}/api/events/stream`);
        logger.info('ApiServer', `   Agent WS: ws://localhost:${this.port}/ws/agents`);

        // ReputationOutboxBridge
        if (this.kernel && this.surrealPersistence && !this.reputationOutboxBridge) {
          import('./kernel/orchestration/reputation-outbox-bridge').then(({ ReputationOutboxBridge }) => {
            this.reputationOutboxBridge = new ReputationOutboxBridge(this.kernel, this.surrealPersistence);
            this.reputationOutboxBridge.start().catch((e: any) => {
              logger.error('ApiServer', `ReputationOutboxBridge start failed: ${e.message}`);
            });
          });
        }

        // AgentEventHub
        if (this.kernel && this.server) {
          this.agentEventHubManager.ensureAttached(this.kernel, this.server);
        }

        resolve();
      });

      this.server.on('error', (err: any) => {
        if (err.code === 'EADDRINUSE') {
          logger.warn('ApiServer', `Port ${this.port} in use, trying ${this.port + 1}...`);
          this.port += 1;
          this.server?.listen(this.port);
        } else {
          logger.error('ApiServer', `Server error: ${err.message}`);
          reject(err);
        }
      });
    });
  }

  public async stop(): Promise<void> {
    this.sseManager.closeAll();

    if (this.auditChangeFeed) {
      try { this.auditChangeFeed.stop(); } catch { /* ignore */ }
      this.auditChangeFeed = null;
    }

    if (this.auditSinkSurreal) {
      try {
        await Promise.race([
          this.auditSinkSurreal.close(),
          new Promise((r) => setTimeout(r, 5000)),
        ]);
        logger.info('ApiServer', 'Audit sink closed');
      } catch (e) {
        logger.warn('ApiServer', `Audit sink close failed: ${(e as Error).message}`);
      }
    }

    // Stop observation interval
    if (this.observationState.interval) {
      clearInterval(this.observationState.interval);
      this.observationState.interval = null;
    }

    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => { logger.info('ApiServer', 'API Server stopped'); resolve(); });
      } else {
        resolve();
      }
    });
  }

  // ============================================================
  // Request handler (thin orchestrator)
  // ============================================================

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // --- Middleware pipeline ---
    const mwResult = await runMiddleware(req, res, {
      port: this.port,
      authConfig: this.authConfig,
      rateLimiter: this.rateLimiter,
      strictRateLimiter: this.strictRateLimiter,
      piiSalt: this.piiSalt,
      audit: this.audit,
      tenantCtxConfig: this.tenantCtxConfig,
      getTenantBindings: () => this.getTenantBindings(),
    });

    if (mwResult.done) {
      const r = mwResult.response;
      const responseBody = typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
      res.writeHead(r.status, { 'Content-Type': r.headers['Content-Type'] || 'application/json', ...r.headers });
      res.end(responseBody);
      return;
    }

    // Narrowed to { done: false, ctx: MiddlewareContext }
    const ctx = (mwResult as { done: false; ctx: import('./server/types').MiddlewareContext }).ctx;
    const { reqPath, method, requestId, ipHash, userAgent, effectiveTenantId } = ctx;
    const apiReq = ctx.apiReq;
    const isSensitive = reqPath.startsWith('/api/vault') || reqPath.startsWith('/api/admin');
    const guard = { principal: apiReq.principal };

    try {
      // LLM SSE stream (must write directly to res)
      if (reqPath === '/api/llm/stream' && method === 'POST') {
        const llmResult = await handleLLMStreamProxy(req, res, apiReq.body);
        if (!llmResult.stream) {
          const errBody = typeof llmResult.body === 'string' ? llmResult.body : JSON.stringify(llmResult.body);
          res.writeHead(llmResult.status, { 'Content-Type': llmResult.headers['Content-Type'] || 'application/json', ...llmResult.headers });
          res.end(errBody);
        }
        return;
      }

      // SSE stream
      if (reqPath === '/api/events/stream' && method === 'GET') {
        this.sseManager.handleConnection(req, res, this.authConfig);
        return;
      }

      // Agent dispatch SSE — RACER path with real-time phase streaming
      if (reqPath === '/api/agents/dispatch' && method === 'POST') {
        const acceptHeader = String(req.headers['accept'] || '');
        if (acceptHeader.includes('text/event-stream')) {
          await handleAgentDispatchSSE(req, res, apiReq.body, {
            kernel: this.kernel,
            agentRegistry: this.agentRegistry,
            agentOrchestrator: this.agentOrchestrator,
            reputationOutboxBridge: this.reputationOutboxBridge,
          });
          return;
        }
      }

      // --- Route dispatch ---
      const apiRes = await this.route(apiReq);

      const responseBody = typeof apiRes.body === 'string' ? apiRes.body : JSON.stringify(apiRes.body);
      this.networkMetrics.sent += Buffer.byteLength(responseBody, 'utf8');
      this.networkMetrics.received += Buffer.byteLength(typeof apiReq.body === 'string' ? apiReq.body : (apiReq.body ? JSON.stringify(apiReq.body) : ''), 'utf8');
      res.writeHead(apiRes.status, { 'Content-Type': apiRes.headers['Content-Type'] || 'application/json', ...apiRes.headers });
      res.end(responseBody);

      this.audit({
        id: requestId, timestamp: Date.now(),
        principal: guard.principal, action: isSensitive ? 'sensitive.ok' : 'request.ok',
        route: reqPath, method, status: apiRes.status,
        remoteAddress: ipHash, userAgent, tenantId: effectiveTenantId,
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

  // ============================================================
  // Route dispatcher
  // ============================================================

  private async route(req: { method: string; path: string; body: any; query: Record<string, string>; headers: http.IncomingHttpHeaders }): Promise<ApiResponse> {
    const { path: reqPath, method } = req;

    // --- Agent routes ---
    const agentDeps: AgentRouteDeps = {
      kernel: this.kernel,
      agentRegistry: this.agentRegistry,
      agentOrchestrator: this.agentOrchestrator,
      reputationOutboxBridge: this.reputationOutboxBridge,
    };

    if (reqPath === '/api/agents/snapshot' && method === 'GET') return handleAgentSnapshot(agentDeps);
    if (reqPath === '/api/agents/dispatch' && method === 'POST') return handleAgentDispatch(req.body, agentDeps);
    if (reqPath === '/api/agents/dispute' && method === 'POST') return handleAgentDispute(req.body, agentDeps);
    if (reqPath === '/api/agents/bindSubTask' && method === 'POST') return handleAgentBindSubTask(req.body, agentDeps);
    if (reqPath === '/api/agents/experience/feedback' && method === 'POST') return handleExperienceFeedback(req.body, agentDeps);
    if (reqPath === '/api/test/reputation-enqueue' && method === 'POST' && process.env.SOLOFORGE_ENABLE_TEST_HOOK === '1') return handleTestReputationEnqueue(req.body, agentDeps);
    if (reqPath === '/api/test/reputation-bridge-status' && method === 'GET' && process.env.SOLOFORGE_ENABLE_TEST_HOOK === '1') return handleTestReputationBridgeStatus(agentDeps);

    // --- Vault / Admin / Audit routes ---
    const vaultDeps: VaultRouteDeps = {
      surrealPersistence: this.surrealPersistence,
      authConfig: this.authConfig,
      auditSinkSurreal: this.auditSinkSurreal,
      auditChangeFeed: this.auditChangeFeed,
      tenantCtxConfig: this.tenantCtxConfig,
    };

    if (reqPath === '/api/auth/bootstrap' && method === 'GET') return handleAuthBootstrap(vaultDeps);
    if (reqPath === '/api/audit/list' && method === 'GET') return handleAuditList(req.query, vaultDeps);
    if (reqPath === '/api/audit/stats' && method === 'GET') return handleAuditStats(vaultDeps);
    if (reqPath === '/api/audit/sinks' && method === 'GET') return handleAuditSinks(vaultDeps);
    if (reqPath === '/api/audit/sinks/config' && method === 'POST') return handleAuditSinksConfig(req.body, vaultDeps);
    if (reqPath === '/api/vault/keys' && method === 'GET') return handleVaultKeysList();
    const vaultKeyMatch = reqPath.match(/^\/api\/vault\/keys\/([A-Za-z0-9_-]{1,64})(?:\/(verify|reveal))?$/);
    if (vaultKeyMatch) {
      const id = decodeURIComponent(vaultKeyMatch[1]);
      const sub = vaultKeyMatch[2];
      if (sub === 'verify' && method === 'POST') return handleVaultKeyVerify(id);
      if (sub === 'reveal' && method === 'GET') return handleVaultKeyReveal(id);
      if (!sub && method === 'GET') return handleVaultKeyGet(id);
      if (!sub && method === 'PUT') return handleVaultKeyPut(id, req.body);
      if (!sub && method === 'DELETE') return handleVaultKeyDelete(id);
    }
    if (reqPath === '/api/vault/export' && method === 'POST') return handleVaultExport(req.body);
    if (reqPath === '/api/vault/import' && method === 'POST') return handleVaultImport(req.body);
    if (reqPath === '/api/vault/verify-passphrase' && method === 'POST') return handleVaultVerifyPassphrase(req.body);

    // --- System routes ---
    const sysDeps: SystemRouteDeps = {
      kernel: this.kernel,
      surrealPersistence: this.surrealPersistence,
      dataArchiver: this.dataArchiver,
      startedAt: this.startedAt,
      networkMetrics: this.networkMetrics,
      observationState: this.observationState,
      broadcastEvent: (event, payload) => this.sseManager.broadcast(event, payload),
    };

    // Java agent proxy
    if (reqPath.startsWith('/api/java-agent/')) return handleJavaAgentProxy(reqPath, method, req.body);

    // ── 画布中转端点 (2026-07-09 新增) ──
    // Java Agent / 外部进程不能直接访问 Flutter canvas (端口由 Electron 动态分配)
    // 通过此中转端点查询端口并转发 DSL 到 Flutter /render
    if (reqPath === '/api/canvas/relay/push-ui' && method === 'POST') {
      return handleCanvasRelayPushUi(req.body);
    }
    // Electron 主进程在画布启动/停止时注册/注销端口
    if (reqPath === '/api/canvas/relay/register-port' && method === 'POST') {
      return handleCanvasPortRegister(req.body);
    }
    if (reqPath === '/api/canvas/relay/unregister-port' && method === 'POST') {
      return handleCanvasPortUnregister(req.body);
    }

    // ── 模型能力端点 (2026-07-09 新增) ──
    // 前端探针完成后自动保存结果到后端, 供 agent 调用时查询
    if (reqPath === '/api/capabilities/save' && method === 'POST') {
      try {
        const { saveProbeResult } = await import('./llm/modelCapabilities');
        const { modelId, capabilities } = req.body || {};
        if (!modelId || !capabilities) {
          return { status: 400, headers: {}, body: { error: 'modelId and capabilities required' } };
        }
        saveProbeResult(modelId, capabilities);
        return { status: 200, headers: {}, body: { success: true } };
      } catch (err: any) {
        return { status: 500, headers: {}, body: { error: err.message } };
      }
    }
    if (reqPath === '/api/capabilities/query' && method === 'GET') {
      try {
        const { getModelCapabilities, getAllCapabilities } = await import('./llm/modelCapabilities');
        const modelId = req.query.model;
        if (modelId) {
          return { status: 200, headers: {}, body: getModelCapabilities(modelId) };
        }
        return { status: 200, headers: {}, body: getAllCapabilities() };
      } catch (err: any) {
        return { status: 500, headers: {}, body: { error: err.message } };
      }
    }

    // UI static files
    if (reqPath.startsWith('/ui/') && method === 'GET') {
      const staticResult = handleUiStatic(reqPath);
      if (staticResult) return staticResult;
    }

    // Admin UI
    if ((reqPath === '/' || reqPath === '/admin' || reqPath === '/ui') && method === 'GET') return handleAdminUI();

    // Test nav
    if (reqPath === '/test-nav' && method === 'GET') return handleTestNav();

    // Kernel
    if (reqPath === '/api/kernel/status' && method === 'GET') return handleKernelStatus(sysDeps);
    if (reqPath === '/api/kernel/health' && method === 'GET') return handleKernelHealth(sysDeps);
    if (reqPath === '/api/kernel/events' && method === 'GET') return handleKernelEvents(parseInt(req.query.limit || '50', 10), sysDeps);
    if (reqPath === '/api/db/schema' && method === 'GET') return handleDbSchema();

    // Prometheus
    if (reqPath === '/metrics' && method === 'GET') return handlePrometheusMetrics(sysDeps);

    // Health
    if (reqPath === '/api/health' && method === 'GET') {
      return { status: 200, headers: { 'Content-Type': 'application/json' }, body: { status: 'ok', uptime: Date.now() - this.startedAt } };
    }

    // Dashboard
    if (reqPath === '/api/status' && method === 'GET') return handleSystemStatus(sysDeps);
    if (reqPath === '/api/database/stats' && method === 'GET') return handleDatabaseStats(sysDeps);
    if (reqPath === '/api/agents' && method === 'GET') return handleAgents(sysDeps);

    // Archiver
    if (reqPath === '/api/archiver/check' && method === 'POST') return handleArchiverCheck(sysDeps);
    if (reqPath === '/api/archiver/start' && method === 'POST') return handleArchiverStart(sysDeps);
    if (reqPath === '/api/archiver/stop' && method === 'POST') return handleArchiverStop(sysDeps);
    if (reqPath === '/api/archiver/stats' && method === 'GET') return handleArchiverStats();

    // Scheduler
    if (reqPath === '/api/scheduler/stats' && method === 'GET') return handleSchedulerStats(sysDeps);
    if (reqPath === '/api/scheduler/queue' && method === 'GET') return handleSchedulerQueue();

    // Events
    if (reqPath === '/api/events/list' && method === 'GET') return handleEventsList(sysDeps);

    // Observation
    if (reqPath === '/api/observation/data' && method === 'GET') return handleObservationData(sysDeps);
    if (reqPath === '/api/observation/start' && method === 'POST') return handleObservationStart(sysDeps);
    if (reqPath === '/api/observation/stop' && method === 'POST') return handleObservationStop(sysDeps);
    if (reqPath === '/api/observation/clear' && method === 'POST') return handleObservationClear(sysDeps);

    // Analytics
    if (reqPath === '/api/analytics/health' && method === 'GET') return handleAnalyticsHealth();
    if (reqPath === '/api/analytics/queries' && method === 'GET') return handleAnalyticsQueries();
    const analyticsRunMatch = reqPath.match(/^\/api\/analytics\/run\/([A-Za-z0-9_-]{1,64})$/);
    if (analyticsRunMatch && method === 'GET') return handleAnalyticsRun(decodeURIComponent(analyticsRunMatch[1]));
    if (reqPath === '/api/analytics/direct' && method === 'POST') return handleAnalyticsDirect(req.body);
    if (reqPath === '/api/analytics/snapshot' && method === 'POST') return handleAnalyticsSnapshot(req.body);
    if (reqPath === '/api/analytics/parquet' && method === 'POST') return handleAnalyticsParquet(req.body);

    // LLM proxy (non-stream)
    if (reqPath === '/api/llm/config' && method === 'GET') return handleLlmConfig();
    if (reqPath === '/api/llm/health' && method === 'GET') return handleLlmHealth(req);

    // Terminal
    if (reqPath === '/api/terminal/run' && method === 'POST') return handleTerminalRun(req.body, sysDeps);

    // Names
    if (reqPath === '/api/names/update' && method === 'POST') return handleNamesUpdate(req.body);

    return { status: 404, headers: { 'Content-Type': 'application/json' }, body: { error: 'Not Found' } };
  }
}
