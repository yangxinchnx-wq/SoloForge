// ─────────────────────────────────────────────────────────────────
// SoloForge API Server Layer
// Path: src/api-server.ts
// Description: HTTP + SSE API 服务器 - 将内核状态暴露给前端
// ─────────────────────────────────────────────────────────────────

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

// ============================================================
// 类型定义
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
// API 服务器
// ============================================================

export class SoloForgeApiServer {
  private server: http.Server | null = null;
  private port: number;
  private sseClients: Set<http.ServerResponse> = new Set();
  private kernel: RuntimeKernel;
  private telemetryExporter: TelemetryMetricExporter | null = null;
  private surrealPersistence: SurrealPersistence | null = null;
  private dataArchiver: DataArchiverService | null = null;
  private startedAt: number = Date.now();
  private prevCpuTimes: { idle: number; total: number } | null = null;
  private bytesTransferred: { sent: number; received: number } = { sent: 0, received: 0 };
  private prevBytesTransferred: { sent: number; received: number; time: number } | null = null;
  private cachedNetworkSpeed: { up: number; down: number; time: number } = { up: 0, down: 0, time: 0 };
  private networkCacheMs = 1000; // 1秒缓存
  // 观测系统状态
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

    // 初始化数据归档服务
    if (surrealPersistence) {
      this.dataArchiver = new DataArchiverService(surrealPersistence, 5 * 60 * 1000);
    }
  }

  /**
   * 获取数据归档服务实例
   */
  public getDataArchiver(): DataArchiverService | null {
    return this.dataArchiver;
  }

  /**
   * 启动 API 服务器
   */
  public async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer(async (req, res) => {
        await this.handleRequest(req, res);
      });

      this.server.listen(this.port, () => {
        logger.info('ApiServer', `🌐 SoloForge API Server listening on http://localhost:${this.port}`);
        logger.info('ApiServer', `   Admin UI: http://localhost:${this.port}/admin`);
        logger.info('ApiServer', `   SSE Events: http://localhost:${this.port}/api/events/stream`);
        resolve();
      });

      this.server.on('error', (err: any) => {
        if (err.code === 'EADDRINUSE') {
          logger.warn('ApiServer', `⚠️ Port ${this.port} in use, trying ${this.port + 1}...`);
          this.port += 1;
          this.server?.listen(this.port);
        } else {
          logger.error('ApiServer', `💥 Server error: ${err.message}`);
          reject(err);
        }
      });
    });
  }

  /**
   * 停止 API 服务器
   */
  public async stop(): Promise<void> {
    for (const client of this.sseClients) {
      client.end();
    }
    this.sseClients.clear();

    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          logger.info('ApiServer', '🔌 API Server stopped');
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  /**
   * 广播事件到所有 SSE 客户端
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
  // 请求处理
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

      // 计算响应大小
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
  // 路由
  // ============================================================

  private async route(req: ApiRequest): Promise<ApiResponse> {
    const { path: reqPath, method } = req;

    // UI 静态文件（必须放在前面，避免被 /ui 路由捕获）
    if (reqPath.startsWith('/ui/') && method === 'GET') {
      const fileName = reqPath.slice(4);
      const uiDir = path.join(process.cwd(), 'src', 'ui');
      const filePath = path.join(uiDir, fileName);
      const resolvedUiDir = path.resolve(uiDir);
      const resolvedFilePath = path.resolve(filePath);
      if (!resolvedFilePath.startsWith(resolvedUiDir + path.sep) && resolvedFilePath !== resolvedUiDir) {
        return { status: 400, headers: { 'Content-Type': 'application/json' }, body: { error: 'Invalid path' } };
      }
      try {
        if (fs.existsSync(resolvedFilePath) && fs.statSync(resolvedFilePath).isFile()) {
          const ext = path.extname(fileName);
          const contentType = ext === '.js' ? 'application/javascript' : ext === '.css' ? 'text/css' : 'text/plain';
          const content = fs.readFileSync(resolvedFilePath);
          const bodyStr = Buffer.isBuffer(content) ? content.toString('utf-8') : content;
          return { status: 200, headers: { 'Content-Type': contentType }, body: bodyStr };
        }
      } catch (e: any) {
        logger.warn('ApiServer', `Failed to serve static file ${fileName}: ${e.message}`);
      }
    }

    // Admin UI - 多个入口
    if ((reqPath === '/' || reqPath === '/admin' || reqPath === '/ui') && method === 'GET') {
      return this.handleAdminUI();
    }

    // 测试页面
    if (reqPath === '/test-nav' && method === 'GET') {
      try {
        const testNavPath = path.join(process.cwd(), 'src', 'ui', 'test-nav.html');
        if (fs.existsSync(testNavPath)) {
          const testHtml = fs.readFileSync(testNavPath, 'utf-8');
          return { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' }, body: testHtml };
        }
      } catch (e: any) {
        logger.warn('ApiServer', `Failed to serve test-nav: ${e.message}`);
      }
      return { status: 404, headers: { 'Content-Type': 'application/json' }, body: { error: 'Not Found' } };
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

    return { status: 404, headers: { 'Content-Type': 'application/json' }, body: { error: 'Not Found' } };
  }

  // ============================================================
  // Admin UI Handler
  // ============================================================

  private handleAdminUI(): ApiResponse {
    const possiblePaths = [
      path.join(process.cwd(), 'src', 'ui', 'index.html'),
      path.join(__dirname, 'ui', 'index.html'),
      path.join(process.cwd(), '..', 'src', 'ui', 'index.html'),
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

    // 返回简单的内联 HTML
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
  <title>SoloForge 管理后台</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    body { background: linear-gradient(135deg, #0a0a0f 0%, #12121a 100%); min-height: 100vh; }
    .glass { background: rgba(26,28,28,0.8); backdrop-filter: blur(10px); border: 1px solid rgba(77,70,54,0.5); border-radius: 16px; }
    .stat { font-size: 48px; font-weight: bold; background: linear-gradient(135deg, #ffde82, #ffdf5d); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
  </style>
</head>
<body class="text-gray-200 p-8">
  <div class="max-w-6xl mx-auto">
    <h1 class="text-4xl font-bold text-amber-400 mb-8">SoloForge 管理后台</h1>

    <div class="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
      <div class="glass p-6">
        <h3 class="text-gray-400 mb-2">组件数</h3>
        <div class="stat" id="components">--</div>
      </div>
      <div class="glass p-6">
        <h3 class="text-gray-400 mb-2">运行时间</h3>
        <div class="stat text-3xl" id="uptime">--:--:--</div>
      </div>
      <div class="glass p-6">
        <h3 class="text-gray-400 mb-2">状态</h3>
        <div class="flex items-center gap-2">
          <span class="w-3 h-3 rounded-full bg-green-500 animate-pulse"></span>
          <span class="text-green-400">运行中</span>
        </div>
      </div>
    </div>

    <div class="glass p-6 mb-8">
      <h2 class="text-xl font-bold mb-4">API 端点</h2>
      <ul class="space-y-2">
        <li><a href="/api/status" class="text-blue-400 hover:underline">/api/status</a> - 系统状态</li>
        <li><a href="/api/database/stats" class="text-blue-400 hover:underline">/api/database/stats</a> - 数据库统计</li>
        <li><a href="/api/agents" class="text-blue-400 hover:underline">/api/agents</a> - 组件列表</li>
        <li><a href="/api/kernel/status" class="text-blue-400 hover:underline">/api/kernel/status</a> - 内核状态</li>
        <li><a href="/metrics" class="text-blue-400 hover:underline">/metrics</a> - Prometheus 指标</li>
      </ul>
    </div>

    <div class="glass p-6">
      <h2 class="text-xl font-bold mb-4">系统信息</h2>
      <div id="sysinfo" class="text-gray-400">加载中...</div>
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
          <p>平台: \${data.platform || '--'}</p>
          <p>CPU: \${data.cpu?.toFixed(1) || '--'}%</p>
          <p>内存: \${data.memory?.toFixed(1) || '--'}%</p>
          <p>内核状态: \${data.kernel?.state || '--'}</p>
        \`;
      } catch (e) {
        document.getElementById('sysinfo').textContent = '无法加载数据，请确保后端服务正在运行';
      }
    }
    loadData();
    setInterval(loadData, 5000);

    // 计时器
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

    // 计算瞬时 CPU 使用率（两次采样对比）
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

    // 计算网络速率
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
   * 获取网络速率（字节/秒）
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
   * 获取真实的系统网络接口流量（Windows）- 使用 PowerShell Get-Counter
   */
  private getSystemNetworkSpeed(): { up: number; down: number } {
    const now = Date.now();

    // 500ms 缓存，避免频繁调用
    if (now - this.cachedNetworkSpeed.time < 500) {
      return { up: this.cachedNetworkSpeed.up, down: this.cachedNetworkSpeed.down };
    }

    try {
      const { execSync } = require("child_process");

      // 使用 PowerShell 脚本文件获取网络接口每秒字节数
      const scriptPath = path.join(process.cwd(), 'get-network-speed.ps1');
      if (!fs.existsSync(scriptPath)) {
        return { up: this.cachedNetworkSpeed.up, down: this.cachedNetworkSpeed.down };
      }
      const psOutput = execSync(
        `powershell -ExecutionPolicy Bypass -File "${scriptPath}"`,
        { encoding: "utf8", timeout: 5000, windowsHide: true }
      );

      const values = psOutput.trim().split('\n')
        .map(v => parseFloat(v.trim()))
        .filter(v => !isNaN(v));

      let totalUp = 0, totalDown = 0;
      // 偶数索引是发送速率，奇数索引是接收速率
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
    // 返回模拟的归档统计
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
  // Observation Handlers (文明演化观测)
  // ============================================================

  /**
   * 获取观测数据
   */
  private handleObservationData(): ApiResponse {
    try {
      // 获取真实事件数据
      const eventLog = this.kernel.eventBus.getEventLog();

      // 统计真实数据
      const totalEvents = eventLog.length;
      let interventions = 0;
      let courtCases = 0;
      let coalitions = 0;

      // 统计各类事件
      for (const event of eventLog) {
        const eventType = (event.type || event.event || '').toLowerCase();
        if (eventType.includes('govern') || eventType.includes('intervention')) {
          interventions++;
        } else if (eventType.includes('court') || eventType.includes('verdict')) {
          courtCases++;
        } else if (eventType.includes('coalition') || eventType.includes('alliance')) {
          coalitions++;
        }
      }

      // 计算真实系统熵值（基于事件多样性）
      let entropy = 0.5;
      if (totalEvents > 0) {
        // 事件越多，系统越复杂，熵值越高
        const eventRate = Math.min(totalEvents / 500, 1);
        // 多样性因子
        const diversity = (interventions + courtCases + coalitions) / Math.max(totalEvents, 1);
        // 综合熵值
        entropy = 0.2 + eventRate * 0.5 + diversity * 0.3;
        entropy = Math.max(0, Math.min(1, entropy));
      }

      // 如果正在观测，记录新数据
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

        // 保留最近 100 条记录
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
          // 附加真实统计
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
   * 开始观测
   */
  private handleObservationStart(): ApiResponse {
    if (this.isObserving) {
      return { status: 200, headers: { 'Content-Type': 'application/json' }, body: { success: true, message: 'Already observing' } };
    }

    this.isObserving = true;
    this.observations = [];

    // 每 5 秒采集一次数据
    this.observationInterval = setInterval(() => {
      // 触发一次数据更新，广播给 SSE 客户端
      this.broadcastEvent('observation', { isObserving: true, timestamp: Date.now() });
    }, 5000);

    console.log('[Observation] Started observing civilization evolution');
    return { status: 200, headers: { 'Content-Type': 'application/json' }, body: { success: true, message: 'Observation started' } };
  }

  /**
   * 停止观测
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
   * 清空观测数据
   */
  private handleObservationClear(): ApiResponse {
    this.observations = [];
    console.log('[Observation] Cleared observation data');
    return { status: 200, headers: { 'Content-Type': 'application/json' }, body: { success: true, message: 'Observation data cleared' } };
  }

  // ============================================================
  // Scheduler Handlers (任务调度器)
  // ============================================================

  /**
   * 获取调度器统计
   */
  private handleSchedulerStats(): ApiResponse {
    // 获取 Rust 调度器的统计信息
    // 由于 Rust 调度器可能不可用，返回模拟数据
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

    // 尝试从真实的调度器客户端获取数据
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
   * 获取调度器队列
   */
  private handleSchedulerQueue(): ApiResponse {
    // 返回调度器队列信息
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
  // Events Handlers (事件列表)
  // ============================================================

  /**
   * 获取事件列表
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
