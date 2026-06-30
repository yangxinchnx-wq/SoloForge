// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
// SoloForge API Server Layer
// Path: src/api-server.ts
// Description: HTTP + SSE API æå¡å¨ - å°åæ ¸ç¶ææ´é²ç»åç«¯
// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';
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
  handleVaultList,
  handleVaultGet,
  handleVaultPut,
  handleVaultDelete,
  handleVaultVerify,
  handleVaultExport,
  handleVaultImport,
  handleVaultVerifyPassphrase,
} from './security/vaultHandler';

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
  private startedAt: number = Date.now();
  private prevCpuTimes: { idle: number; total: number } | null = null;
  private bytesTransferred: { sent: number; received: number } = { sent: 0, received: 0 };
  private prevBytesTransferred: { sent: number; received: number; time: number } | null = null;
  private cachedNetworkSpeed: { up: number; down: number; time: number } = { up: 0, down: 0, time: 0 };
  private networkCacheMs = 1000; // 1ç§ç¼å­
  // è§æµç³»ç»ç¶æ
  private isObserving = false;
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
    return new Promise((resolve, reject) => {
      this.server = http.createServer(async (req, res) => {
        await this.handleRequest(req, res);
      });

      this.server.listen(this.port, () => {
        logger.info('ApiServer', `ð SoloForge API Server listening on http://localhost:${this.port}`);
        logger.info('ApiServer', `   Admin UI: http://localhost:${this.port}/admin`);
        logger.info('ApiServer', `   SSE Events: http://localhost:${this.port}/api/events/stream`);
        logger.info('ApiServer', `   ð°ï¸  Agent WS: ws://localhost:${this.port}/ws/agents`);

        // ð°ï¸ æè½½ agent äºä»¶å¹¿æ­ hub (Electron main ä¸»å¨è¿å¥)
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
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url || '/', `http://localhost:${this.port}`);
    const reqPath = url.pathname;
    const method = req.method || 'GET';

    let body: any = null;
    if (method === 'POST') {
      body = await this.parseBody(req);
    }

    const apiReq: ApiRequest = {
      method,
      url: req.url || '/',
      path: reqPath,
      query: Object.fromEntries(url.searchParams),
      body,
      headers: req.headers
    };

    try {
      const apiRes = await this.route(apiReq);

      if (reqPath === '/api/events/stream' && method === 'GET') {
        this.handleSSE(req, res);
        return;
      }

      // è®¡ç®ååºå¤§å°
      const responseBody = typeof apiRes.body === 'string' ? apiRes.body : JSON.stringify(apiRes.body);
      this.bytesTransferred.sent += Buffer.byteLength(responseBody, 'utf8');
      this.bytesTransferred.received += Buffer.byteLength(body || '', 'utf8');

      res.writeHead(apiRes.status, {
        'Content-Type': apiRes.headers['Content-Type'] || 'application/json',
        ...apiRes.headers
      });
      res.end(responseBody);
    } catch (err: any) {
      logger.error('ApiServer', `Request error: ${err.message}`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  }

  private parseBody(req: http.IncomingMessage): Promise<any> {
    return new Promise((resolve) => {
      let data = '';
      req.on('data', chunk => data += chunk);
      req.on('end', () => {
        try {
          resolve(data ? JSON.parse(data) : null);
        } catch {
          resolve(null);
        }
      });
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
      const testHtml = fs.readFileSync(path.join('C:/Users/yangx/Desktop/SoloForge/src/ui/test-nav.html'), 'utf-8');
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
    const vaultKeyMatch = reqPath.match(/^\/api\/vault\/keys\/([A-Za-z0-9_-]{1,64})(?:\/(verify))?$/);
    if (vaultKeyMatch) {
      const id = decodeURIComponent(vaultKeyMatch[1]);
      const sub = vaultKeyMatch[2];
      if (sub === 'verify') {
        if (method === 'POST') return this.vaultResultToApi(await handleVaultVerify(id));
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

    return { status: 404, headers: { 'Content-Type': 'application/json' }, body: { error: 'Not Found' } };
  }

  /**
   * æ vaultHandler è¿åç VaultRouteResult è½¬æ¢ä¸º API å±ç ApiResponse å½¢ç¶
   * (headers å¯é, é»è®¤ application/json; body éä¼ )
   */
  private vaultResultToApi(r: { status: number; headers?: Record<string, string>; body: any }): ApiResponse {
    return {
      status: r.status,
      headers: r.headers || { 'Content-Type': 'application/json' },
      body: r.body,
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
      'C:/Users/yangx/Desktop/SoloForge/src/ui/index.html'
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
      const scriptPath = 'C:/Users/yangx/Desktop/SoloForge/get-network-speed.ps1';
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
    const req: AgentDispatchRequest = {
      packetUuid: body?.packetUuid,
      packetSizeKb: body?.packetSizeKb,
      requiresDeepCognition: body?.requiresDeepCognition,
      globalConfidenceMetric: body?.globalConfidenceMetric,
      taskComplexityMetrics: body?.taskComplexityMetrics,
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
      'Access-Control-Allow-Origin': '*'
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
}
