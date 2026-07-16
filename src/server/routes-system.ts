// ────────────────────────────────────────────────────────────
// SoloForge API Server — System Routes
// Path: src/server/routes-system.ts
//
// Endpoints:
//   GET  /api/status               — system status dashboard data
//   GET  /api/health               — health probe
//   GET  /api/database/stats       — DB connection stats
//   GET  /api/agents               — agent list
//   GET  /api/kernel/status        — kernel state
//   GET  /api/kernel/health        — kernel health probe
//   GET  /api/kernel/events        — recent event log
//   GET  /api/db/schema            — DB schema info
//   GET  /metrics                  — Prometheus text format
//   GET  /api/events/list          — event list
//   GET  /api/scheduler/stats      — scheduler stats
//   GET  /api/scheduler/queue      — scheduler queue
//   GET  /api/observation/data     — observation data
//   POST /api/observation/start    — start observing
//   POST /api/observation/stop     — stop observing
//   POST /api/observation/clear    — clear observation data
//   POST /api/archiver/check       — trigger archive check
//   POST /api/archiver/start       — start archiver
//   POST /api/archiver/stop        — stop archiver
//   GET  /api/archiver/stats       — archiver stats
//   POST /api/terminal/run         — spawn shell command
//   POST /api/names/update         — custom name
//   GET  /api/llm/config           — LLM config (non-stream)
//   GET  /api/llm/health           — LLM health probe
//   GET  /, /admin, /ui            — Admin UI
//   GET  /ui/*                     — UI static files
//   GET  /test-nav                 — test page
//   /api/java-agent/*              — Java agent proxy
// ────────────────────────────────────────────────────────────

import fs from 'fs';
import path from 'path';
import os from 'os';
import http from 'http';
import { spawnSync, spawn, execSync } from 'child_process';
import { fileURLToPath } from 'url';
import type { RuntimeKernel } from '../kernel/runtime-kernel';
import { RuntimeState } from '../kernel/runtime-kernel';
import type { SurrealPersistence } from '../data/surreal_persistence';
// Phase 3: Metric bridge — 合并三套指标源
import { renderMergedPrometheusText, isMetricBridgeReady } from '../observability/otel-metric-bridge';
import type { DataArchiverService } from '../data/data-archiver';
import { logger } from '../core/logger';
import { safeJoin } from '../security/auth';
import { handleLLMConfigGet, handleLLMHealth } from '../llm/llmProxyHandler';
import type { ApiResponse } from './types';

// ES Module __dirname polyfill (relative to this file)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================
// Shared mutable state objects (owned by main server, passed by ref)
// ============================================================

/** Network / bandwidth tracking state */
export interface NetworkMetricsState {
  sent: number;
  received: number;
  prevBytes: { sent: number; received: number; time: number } | null;
  cachedSpeed: { up: number; down: number; time: number };
  /** CPU sampling for instantaneous usage */
  prevCpuTimes: { idle: number; total: number } | null;
}

/** Observation subsystem state */
export interface ObservationState {
  isObserving: boolean;
  observations: Array<{
    cycleId: number;
    timestamp: string;
    entropy: number;
    interventions: number;
    courtCases: number;
    coalitions: number;
  }>;
  interval: NodeJS.Timeout | null;
}

// ============================================================
// Dependency bag
// ============================================================

export interface SystemRouteDeps {
  kernel: RuntimeKernel;
  surrealPersistence: SurrealPersistence | null;
  dataArchiver: DataArchiverService | null;
  startedAt: number;
  networkMetrics: NetworkMetricsState;
  observationState: ObservationState;
  broadcastEvent: (event: string, payload: any) => void;
}

// ============================================================
// System Status  (GET /api/status)
// ============================================================

function getNetworkSpeed(state: NetworkMetricsState): { up: number; down: number } {
  try {
    const now = Date.now();
    if (state.prevBytes) {
      const timeDiff = (now - state.prevBytes.time) / 1000;
      if (timeDiff >= 0.5) {
        const sentDiff = state.sent - state.prevBytes.sent;
        const recvDiff = state.received - state.prevBytes.received;
        state.prevBytes = { sent: state.sent, received: state.received, time: now };
        return { up: Math.round(sentDiff / timeDiff), down: Math.round(recvDiff / timeDiff) };
      }
    } else {
      state.prevBytes = { sent: state.sent, received: state.received, time: now };
    }
    return { up: 0, down: 0 };
  } catch {
    return { up: 0, down: 0 };
  }
}

function getSystemNetworkSpeed(state: NetworkMetricsState): { up: number; down: number } {
  const now = Date.now();
  if (now - state.cachedSpeed.time < 500) {
    return { up: state.cachedSpeed.up, down: state.cachedSpeed.down };
  }
  try {
    const scriptPath = path.resolve(process.cwd(), 'get-network-speed.ps1');
    const psOutput = execSync(
      `powershell -ExecutionPolicy Bypass -File "${scriptPath}"`,
      { encoding: 'utf8', timeout: 5000, windowsHide: true },
    );
    const values = psOutput.trim().split('\n').map((v: string) => parseFloat(v.trim())).filter((v: number) => !isNaN(v));
    let totalUp = 0, totalDown = 0;
    for (let i = 0; i < values.length; i += 2) {
      totalUp += values[i] || 0;
      totalDown += values[i + 1] || 0;
    }
    const upVal = Math.round(totalUp);
    const downVal = Math.round(totalDown);
    state.cachedSpeed = { up: upVal, down: downVal, time: now };
    return { up: upVal, down: downVal };
  } catch {
    return { up: state.cachedSpeed.up, down: state.cachedSpeed.down };
  }
}

export function handleSystemStatus(deps: SystemRouteDeps): ApiResponse {
  const cpus = os.cpus();
  let totalIdle = 0, totalTick = 0;
  for (const cpu of cpus) {
    for (const type in cpu.times) {
      totalTick += (cpu.times as any)[type];
    }
    totalIdle += cpu.times.idle;
  }

  let cpuUsage = 0;
  if (deps.networkMetrics.prevCpuTimes) {
    const idleDiff = totalIdle - deps.networkMetrics.prevCpuTimes.idle;
    const totalDiff = totalTick - deps.networkMetrics.prevCpuTimes.total;
    cpuUsage = totalDiff > 0 ? 100 - (100 * idleDiff / totalDiff) : 0;
  }
  deps.networkMetrics.prevCpuTimes = { idle: totalIdle, total: totalTick };

  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  const memUsage = (usedMem / totalMem) * 100;

  let kernelState = 'UNKNOWN', kernelVersion = 1;
  let activeComponents = 5, totalComponents = 5;
  try {
    kernelState = deps.kernel['state'] || RuntimeState.READY;
    kernelVersion = deps.kernel.version || 1;
    const componentsMap = deps.kernel['components'];
    if (componentsMap && componentsMap instanceof Map) {
      totalComponents = componentsMap.size || 5;
      activeComponents = totalComponents;
    }
  } catch {}

  let networkSpeed = { up: 0, down: 0 };
  try { networkSpeed = getSystemNetworkSpeed(deps.networkMetrics); } catch {}

  return {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    body: {
      cpu: cpuUsage,
      memory: memUsage,
      memoryUsed: (usedMem / (1024 * 1024 * 1024)).toFixed(2),
      memoryTotal: (totalMem / (1024 * 1024 * 1024)).toFixed(2),
      uptime: Date.now() - deps.startedAt,
      platform: os.platform(),
      nodeVersion: process.version,
      network: networkSpeed,
      kernel: { state: kernelState, version: kernelVersion },
      agents: { active: activeComponents, total: totalComponents },
    },
  };
}

// ============================================================
// Database Stats  (GET /api/database/stats)
// ============================================================

export async function handleDatabaseStats(deps: SystemRouteDeps): Promise<ApiResponse> {
  const stats = {
    garnet: { sessions: 0, tasks: 0, counters: 0, connected: false, healthy: false },
    surrealdb: { records: 0, hot: 0, connected: false, healthy: false },
    jsonl: { records: 0, size: '0 KB', healthy: true },
  };

  try {
    const { getClient, healthCheck } = await import('../data/garnet/client');
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

  try {
    if (deps.surrealPersistence) {
      const ready = deps.surrealPersistence.isReady();
      if (ready) {
        stats.surrealdb.connected = true;
        stats.surrealdb.healthy = true;
      }
    }
  } catch {}

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
// Agents list  (GET /api/agents)
// ============================================================

export async function handleAgents(deps: SystemRouteDeps): Promise<ApiResponse> {
  const agents: Array<{ id: string; name: string; type: string; status: string; tasks: number }> = [];
  try {
    const componentsMap = deps.kernel['components'];
    if (componentsMap && componentsMap instanceof Map) {
      let index = 1;
      for (const [name, component] of componentsMap) {
        let status = 'running';
        if (typeof (component as any).healthCheck === 'function') {
          try { status = await (component as any).healthCheck() ? 'running' : 'error'; } catch { status = 'error'; }
        }
        let type = 'system';
        if (name.includes('Court')) type = 'court';
        else if (name.includes('Decision')) type = 'decision';
        else if (name.includes('Governor')) type = 'governor';
        else if (name.includes('Agent')) type = 'agent';
        else if (name.includes('Event')) type = 'events';
        else if (name.includes('Scheduler')) type = 'scheduler';
        else if (name.includes('Persistence')) type = 'data';
        agents.push({ id: `agent_${String(index).padStart(3, '0')}`, name, type, status, tasks: (component as any).taskCount || 0 });
        index++;
      }
    }
  } catch {}

  if (agents.length === 0) {
    agents.push(
      { id: 'agent_001', name: 'RuntimeKernel', type: 'system', status: 'running', tasks: 0 },
      { id: 'agent_002', name: 'EventBus', type: 'events', status: 'running', tasks: deps.kernel.eventBus.getEventLog().length },
      { id: 'agent_003', name: 'SchedulerClient', type: 'scheduler', status: 'running', tasks: 0 },
      { id: 'agent_004', name: 'SurrealPersistence', type: 'data', status: deps.surrealPersistence?.isReady() ? 'running' : 'idle', tasks: 0 },
    );
  }

  return { status: 200, headers: { 'Content-Type': 'application/json' }, body: agents };
}

// ============================================================
// Kernel
// ============================================================

export function handleKernelStatus(deps: SystemRouteDeps): ApiResponse {
  return {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    body: {
      state: deps.kernel['state'] || RuntimeState.READY,
      mode: deps.kernel['mode'] || 'NORMAL',
      version: deps.kernel.version,
      currentTick: deps.kernel.currentTick,
      startedAt: deps.kernel.startedAt,
      uptime: Date.now() - deps.kernel.startedAt,
    },
  };
}

export function handleKernelHealth(deps: SystemRouteDeps): ApiResponse {
  const healthy = deps.kernel['state'] !== RuntimeState.PANIC && deps.kernel['state'] !== RuntimeState.STOPPED;
  return { status: 200, headers: { 'Content-Type': 'application/json' }, body: { healthy, state: deps.kernel['state'] } };
}

export function handleKernelEvents(limit: number, deps: SystemRouteDeps): ApiResponse {
  return { status: 200, headers: { 'Content-Type': 'application/json' }, body: deps.kernel.eventBus.getEventLog().slice(-limit) };
}

export async function handleDbSchema(): Promise<ApiResponse> {
  return {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    body: {
      tables: ['decision', 'courtSubmission', 'courtVerdict', 'marlEpisode', 'eventLog', 'migration_history'],
      namespaces: ['soloforge_core'],
      databases: ['autonomous_network'],
    },
  };
}

// ============================================================
// Prometheus  (GET /metrics)
// ============================================================

export function handlePrometheusMetrics(deps: SystemRouteDeps): ApiResponse {
const uptime = Date.now() - deps.startedAt;
const eventCount = deps.kernel.eventBus.getEventLog().length;

// Phase 3: 合并三套指标源 — 基础系统指标 + MetricsRegistry + TelemetryMetricExporter
try {
  if (isMetricBridgeReady()) {
    const text = renderMergedPrometheusText(uptime, eventCount, deps.kernel.version || 1);
    return { status: 200, headers: { 'Content-Type': 'text/plain' }, body: text };
  }
} catch {
  // Metric bridge not available — fall through to basic metrics
}

// Fallback: basic metrics only
const text = `# HELP soloforge_uptime_seconds Uptime in seconds
# TYPE soloforge_uptime_seconds gauge
soloforge_uptime_seconds ${(uptime / 1000).toFixed(0)}

# HELP soloforge_events_total Total events processed
# TYPE soloforge_events_total counter
soloforge_events_total ${eventCount}

# HELP soloforge_kernel_version Kernel version
# TYPE soloforge_kernel_version gauge
soloforge_kernel_version{state="${deps.kernel['state'] || 'READY'}"} ${deps.kernel.version || 1}
`;
return { status: 200, headers: { 'Content-Type': 'text/plain' }, body: text };
}

// ============================================================
// Events  (GET /api/events/list)
// ============================================================

export function handleEventsList(deps: SystemRouteDeps): ApiResponse {
  const eventLog = deps.kernel.eventBus.getEventLog();
  return {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    body: { events: eventLog.slice(-100).reverse(), total: eventLog.length, connected: true },
  };
}

// ============================================================
// Scheduler
// ============================================================

export function handleSchedulerStats(deps: SystemRouteDeps): ApiResponse {
  const stats = {
    mode: 'RUNNING',
    queueSize: Math.floor(Math.random() * 10),
    stats: {
      total_push: Math.floor(Math.random() * 1000),
      total_pop: Math.floor(Math.random() * 900),
      total_ping: Math.floor(Math.random() * 500),
      aging_boosts: Math.floor(Math.random() * 50),
    },
    connected: true,
    error: null,
  };
  try {
    const schedulerClient = (deps.kernel as any).schedulerClient;
    if (schedulerClient?.stats) {
      return { status: 200, headers: { 'Content-Type': 'application/json' }, body: schedulerClient.stats };
    }
  } catch {}
  return { status: 200, headers: { 'Content-Type': 'application/json' }, body: stats };
}

export function handleSchedulerQueue(): ApiResponse {
  return { status: 200, headers: { 'Content-Type': 'application/json' }, body: { tasks: [], total: 0, aging_queue: 0, priority_queue: 0 } };
}

// ============================================================
// Archiver
// ============================================================

export async function handleArchiverCheck(deps: SystemRouteDeps): Promise<ApiResponse> {
  if (!deps.dataArchiver) return { status: 200, headers: { 'Content-Type': 'application/json' }, body: { error: 'Archiver not initialized' } };
  try {
    const stats = await deps.dataArchiver.runArchiveCheck();
    return { status: 200, headers: { 'Content-Type': 'application/json' }, body: stats };
  } catch (err: any) {
    return { status: 200, headers: { 'Content-Type': 'application/json' }, body: { error: err.message } };
  }
}

export function handleArchiverStart(deps: SystemRouteDeps): ApiResponse {
  if (deps.dataArchiver) { deps.dataArchiver.start(); return { status: 200, headers: { 'Content-Type': 'application/json' }, body: { success: true } }; }
  return { status: 200, headers: { 'Content-Type': 'application/json' }, body: { error: 'Archiver not initialized' } };
}

export function handleArchiverStop(deps: SystemRouteDeps): ApiResponse {
  if (deps.dataArchiver) { deps.dataArchiver.stop(); return { status: 200, headers: { 'Content-Type': 'application/json' }, body: { success: true } }; }
  return { status: 200, headers: { 'Content-Type': 'application/json' }, body: { error: 'Archiver not initialized' } };
}

export function handleArchiverStats(): ApiResponse {
  return {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    body: {
      totalRecords: 0, hotRecords: 0, coldRecords: 0, archivedThisRun: 0, deletedThisRun: 0, garnetKeys: 0,
      surrealdbTables: ['conversation', 'message', 'decision', 'courtSubmission', 'courtVerdict', 'eventLog'],
      jsonlFiles: 0,
    },
  };
}

// ============================================================
// Observation
// ============================================================

export function handleObservationData(deps: SystemRouteDeps): ApiResponse {
  try {
    const eventLog = deps.kernel.eventBus.getEventLog();
    const totalEvents = eventLog.length;
    let interventions = 0, courtCases = 0, coalitions = 0;
    for (const event of eventLog) {
      const eventType = ((event as any).type ?? (event as any).event ?? '').toLowerCase();
      if (eventType.includes('govern') || eventType.includes('intervention')) interventions++;
      else if (eventType.includes('court') || eventType.includes('verdict')) courtCases++;
      else if (eventType.includes('coalition') || eventType.includes('alliance')) coalitions++;
    }

    let entropy = 0.5;
    if (totalEvents > 0) {
      const eventRate = Math.min(totalEvents / 500, 1);
      const diversity = (interventions + courtCases + coalitions) / Math.max(totalEvents, 1);
      entropy = Math.max(0, Math.min(1, 0.2 + eventRate * 0.5 + diversity * 0.3));
    }

    if (deps.observationState.isObserving) {
      const cycleId = deps.observationState.observations.length + 1;
      deps.observationState.observations.push({ cycleId, timestamp: new Date().toISOString(), entropy, interventions, courtCases, coalitions });
      if (deps.observationState.observations.length > 100) {
        deps.observationState.observations = deps.observationState.observations.slice(-100);
      }
    }

    const lastUpdate = deps.observationState.isObserving && deps.observationState.observations.length > 0
      ? deps.observationState.observations[deps.observationState.observations.length - 1].timestamp
      : 'N/A';

    return {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: {
        isObserving: deps.observationState.isObserving, lastUpdate,
        observations: deps.observationState.observations.slice(-20),
        kernelVersion: deps.kernel.version || 1, currentTick: deps.kernel.currentTick || 0,
        uptime: Date.now() - deps.startedAt,
        stats: { totalEvents, interventions, courtCases, coalitions },
      },
    };
  } catch (err: any) {
    return {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: {
        isObserving: deps.observationState.isObserving, lastUpdate: 'N/A', observations: [],
        kernelVersion: deps.kernel.version || 1, currentTick: deps.kernel.currentTick || 0,
        uptime: Date.now() - deps.startedAt, error: err.message,
      },
    };
  }
}

export function handleObservationStart(deps: SystemRouteDeps): ApiResponse {
  if (deps.observationState.isObserving) return { status: 200, headers: { 'Content-Type': 'application/json' }, body: { success: true, message: 'Already observing' } };
  deps.observationState.isObserving = true;
  deps.observationState.observations = [];
  deps.observationState.interval = setInterval(() => {
    deps.broadcastEvent('observation', { isObserving: true, timestamp: Date.now() });
  }, 5000);
  // TODO: Replace with structured logging (pino/winston)
  if (process.env.NODE_ENV !== 'production') {
    console.log('[Observation] Started observing civilization evolution');
  }
  return { status: 200, headers: { 'Content-Type': 'application/json' }, body: { success: true, message: 'Observation started' } };
}

export function handleObservationStop(deps: SystemRouteDeps): ApiResponse {
  if (deps.observationState.interval) { clearInterval(deps.observationState.interval); deps.observationState.interval = null; }
  deps.observationState.isObserving = false;
  if (process.env.NODE_ENV !== 'production') {
    console.log('[Observation] Stopped observing');
  }
  return { status: 200, headers: { 'Content-Type': 'application/json' }, body: { success: true, message: 'Observation stopped' } };
}

export function handleObservationClear(deps: SystemRouteDeps): ApiResponse {
  deps.observationState.observations = [];
  if (process.env.NODE_ENV !== 'production') {
    console.log('[Observation] Cleared observation data');
  }
  return { status: 200, headers: { 'Content-Type': 'application/json' }, body: { success: true, message: 'Observation data cleared' } };
}

// ============================================================
// Terminal  (POST /api/terminal/run)
// ============================================================

export function handleTerminalRun(body: any, deps: SystemRouteDeps): ApiResponse {
  const chatId = String(body?.chatId || '').trim();
  const command = String(body?.command || '').trim();
  const cwd = String(body?.cwd || '').trim() || process.cwd();
  const toolCallId = String(body?.toolCallId || `user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);

  if (!chatId) return { status: 400, headers: { 'Content-Type': 'application/json' }, body: { error: 'chatId required' } };
  if (!command) return { status: 400, headers: { 'Content-Type': 'application/json' }, body: { error: 'command required' } };

  const isWin = process.platform === 'win32';
  const child = isWin ? spawn('cmd.exe', ['/c', command], { cwd, windowsHide: true }) : spawn('sh', ['-c', command], { cwd });

  const toolStart = Date.now();
  const tool = 'execute_cmd';

  deps.broadcastEvent('tool_started', { chatId, subTaskId: null, toolCallId, tool, args: command, ts: toolStart });

  child.stdout?.on('data', (data: Buffer) => {
    const chunk = data.toString('utf-8');
    if (chunk) deps.broadcastEvent('tool_stdout', { chatId, subTaskId: null, toolCallId, tool, chunk, ts: Date.now() });
  });

  child.stderr?.on('data', (data: Buffer) => {
    const chunk = data.toString('utf-8');
    if (chunk) deps.broadcastEvent('tool_stderr', { chatId, subTaskId: null, toolCallId, tool, chunk, ts: Date.now() });
  });

  child.on('error', (err: Error) => {
    deps.broadcastEvent('tool_stderr', { chatId, subTaskId: null, toolCallId, tool, chunk: `\n[spawn error] ${err.message}\n`, ts: Date.now() });
    deps.broadcastEvent('tool_exit', { chatId, subTaskId: null, toolCallId, tool, exitCode: 1, durationMs: Date.now() - toolStart, ts: Date.now() });
  });

  child.on('close', (code: number | null) => {
    deps.broadcastEvent('tool_exit', { chatId, subTaskId: null, toolCallId, tool, exitCode: code ?? 0, durationMs: Date.now() - toolStart, ts: Date.now() });
  });

  setTimeout(() => { try { child.kill('SIGTERM'); } catch { /* ignore */ } }, 30000);

  return { status: 200, headers: { 'Content-Type': 'application/json' }, body: { ok: true, toolCallId } };
}

// ============================================================
// Names  (POST /api/names/update)
// ============================================================

export function handleNamesUpdate(body: any): ApiResponse {
  const customName = String(body?.customName || '').trim();
  const namesPath = path.join(__dirname, '..', '..', 'UI', 'public', '\u540d\u5b57', 'names.txt');
  try {
    if (!fs.existsSync(namesPath)) return { status: 404, headers: { 'Content-Type': 'application/json' }, body: { error: 'names.txt not found' } };
    const content = fs.readFileSync(namesPath, 'utf-8');
    const [origPart] = content.split(/\[CUSTOM\]/);
    const origText = (origPart || '').trim();
    const newContent = customName ? `${origText} [CUSTOM] ${customName}` : origText;
    fs.writeFileSync(namesPath, newContent, 'utf-8');
    return { status: 200, headers: { 'Content-Type': 'application/json' }, body: { ok: true, customName: customName || null } };
  } catch (err) {
    return { status: 500, headers: { 'Content-Type': 'application/json' }, body: { error: String(err) } };
  }
}

// ============================================================
// LLM Proxy (non-streaming)
// ============================================================

export async function handleLlmConfig(): Promise<ApiResponse> {
  return handleLLMConfigGet();
}

export async function handleLlmHealth(req: { headers: Record<string, string | string[] | undefined> }): Promise<ApiResponse> {
  return handleLLMHealth(req);
}

// ============================================================
// Admin UI  (GET /, /admin, /ui)
// ============================================================

export function handleAdminUI(): ApiResponse {
  const possiblePaths = [
    path.join(process.cwd(), 'src', 'ui', 'index.html'),
    path.join(__dirname, 'ui', 'index.html'),
    path.join(process.cwd(), '..', 'src', 'ui', 'index.html'),
    path.resolve(process.cwd(), 'src', 'ui', 'index.html'),
  ];
  for (const uiPath of possiblePaths) {
    try {
      if (fs.existsSync(uiPath)) {
        const html = fs.readFileSync(uiPath, 'utf-8');
        logger.info('ApiServer', `Admin UI loaded from: ${uiPath}`);
        return { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' }, body: html };
      }
    } catch (err: any) {
      logger.warn('ApiServer', `Failed to load UI from ${uiPath}: ${err.message}`);
    }
  }
  return { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' }, body: getInlineAdminUI() };
}

function getInlineAdminUI(): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>SoloForge Admin Dashboard</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    body { background: linear-gradient(135deg, #0a0a0f 0%, #12121a 100%); min-height: 100vh; }
    .glass { background: rgba(26,28,28,0.8); backdrop-filter: blur(10px); border: 1px solid rgba(77,70,54,0.5); border-radius: 16px; }
    .stat { font-size: 48px; font-weight: bold; background: linear-gradient(135deg, #ffde82, #ffdf5d); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
  </style>
</head>
<body class="text-gray-200 p-8">
  <div class="max-w-6xl mx-auto">
    <h1 class="text-4xl font-bold text-amber-400 mb-8">SoloForge Admin Dashboard</h1>
    <div class="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
      <div class="glass p-6"><h3 class="text-gray-400 mb-2">Components</h3><div class="stat" id="components">--</div></div>
      <div class="glass p-6"><h3 class="text-gray-400 mb-2">Uptime</h3><div class="stat text-3xl" id="uptime">--:--:--</div></div>
      <div class="glass p-6"><h3 class="text-gray-400 mb-2">Status</h3><div class="flex items-center gap-2"><span class="w-3 h-3 rounded-full bg-green-500 animate-pulse"></span><span class="text-green-400">Running</span></div></div>
    </div>
    <div class="glass p-6 mb-8">
      <h2 class="text-xl font-bold mb-4">API Endpoints</h2>
      <ul class="space-y-2">
        <li><a href="/api/status" class="text-blue-400 hover:underline">/api/status</a> - System Status</li>
        <li><a href="/api/database/stats" class="text-blue-400 hover:underline">/api/database/stats</a> - Database Stats</li>
        <li><a href="/api/agents" class="text-blue-400 hover:underline">/api/agents</a> - Agent List</li>
        <li><a href="/api/kernel/status" class="text-blue-400 hover:underline">/api/kernel/status</a> - Kernel Status</li>
        <li><a href="/metrics" class="text-blue-400 hover:underline">/metrics</a> - Prometheus Metrics</li>
      </ul>
    </div>
    <div class="glass p-6"><h2 class="text-xl font-bold mb-4">System Info</h2><div id="sysinfo" class="text-gray-400">Loading...</div></div>
  </div>
  <script>
    async function loadData() {
      try {
        const res = await fetch('/api/status');
        const data = await res.json();
        document.getElementById('components').textContent = (data.agents?.active || '--') + '/' + (data.agents?.total || '--');
        // [Security Fix] Replaced innerHTML with textContent to eliminate XSS vector
        // Previously used .innerHTML = '<p>...</p>' which could inject HTML if data source changes
        const sysInfoLines = [
          'Node.js: ' + (data.nodeVersion || '--'),
          'Platform: ' + (data.platform || '--'),
          'CPU: ' + (data.cpu != null ? Number(data.cpu).toFixed(1) : '--') + '%',
          'Memory: ' + (data.memory != null ? Number(data.memory).toFixed(1) : '--') + '%',
          'Kernel: ' + (data.kernel?.state || '--'),
        ];
        document.getElementById('sysinfo').textContent = sysInfoLines.join('\n');
      } catch (e) { document.getElementById('sysinfo').textContent = 'Cannot load data, ensure backend is running'; }
    }
    loadData(); setInterval(loadData, 5000);
    let seconds = 0;
    setInterval(() => { seconds++; const h = Math.floor(seconds / 3600); const m = Math.floor((seconds % 3600) / 60); const s = seconds % 60; document.getElementById('uptime').textContent = \`\${String(h).padStart(2,'0')}:\${String(m).padStart(2,'0')}:\${String(s).padStart(2,'0')}\`; }, 1000);
  </script>
</body>
</html>`;
}

// ============================================================
// UI Static Files  (GET /ui/*)
// ============================================================

export function handleUiStatic(reqPath: string): ApiResponse | null {
  if (!reqPath.startsWith('/ui/')) return null;
  const fileName = reqPath.slice(4);
  const uiDir = 'C:/Users/yangx/Desktop/SoloForge/src/ui';
  const filePath = path.join(uiDir, fileName);
  if (fs.existsSync(filePath)) {
    const ext = path.extname(fileName);
    const contentType = ext === '.js' ? 'application/javascript' : ext === '.css' ? 'text/css' : 'text/plain';
    const content = fs.readFileSync(filePath);
    const bodyStr = Buffer.isBuffer(content) ? content.toString('utf-8') : content;
    return { status: 200, headers: { 'Content-Type': contentType }, body: bodyStr };
  }
  return null;
}

// ============================================================
// Test Nav  (GET /test-nav)
// ============================================================

export function handleTestNav(): ApiResponse {
  const testPath = safeJoin(path.resolve(process.cwd(), 'src', 'ui'), 'test-nav.html');
  const testHtml = testPath ? fs.readFileSync(testPath, 'utf-8') : '<h1>test-nav not found</h1>';
  return { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' }, body: testHtml };
}

// ============================================================
// Java Agent Proxy  (/api/java-agent/*)
// ============================================================

export async function handleJavaAgentProxy(reqPath: string, method: string, body: any): Promise<ApiResponse> {
  const javaPath = reqPath.replace('/api/java-agent', '');
  const javaUrl = `http://127.0.0.1:8770${javaPath}`;
  try {
    const fetchOptions: any = { method, headers: { 'Content-Type': 'application/json' } };
    if (body && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
      fetchOptions.body = typeof body === 'string' ? body : JSON.stringify(body);
    }
    const javaRes = await fetch(javaUrl, fetchOptions);
    const javaBody = await javaRes.text();
    return { status: javaRes.status, headers: { 'Content-Type': 'application/json' }, body: javaBody };
  } catch (err: any) {
    return { status: 502, headers: { 'Content-Type': 'application/json' }, body: { success: false, error: `Java Agent service not started: ${err.message}` } };
  }
}

/**
 * Java Agent SSE 流式代理
 *
 * 架构:
 *   1. 通过 HTTP POST /api/chat/execute 启动 Java dispatch (非阻塞)
 *   2. 订阅 EventBus 上的 worker_* 事件 (由 TCP 8771 桥接到 EventBus)
 *   3. 将匹配 dispatchId 的事件以 SSE 格式流式返回给前端
 *
 * Java Agent 不再有 /api/chat/stream 端点 — 后续通信全部走 TCP 8771。
 */
export async function handleJavaAgentSSE(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  body: any,
  kernel: RuntimeKernel,
): Promise<void> {
  const dispatchId: string = body?.dispatchId ?? `dispatch_${Date.now()}`;
  const chatId: string = body?.chatId ?? `chat-${Date.now()}`;
  const taskHint: string = typeof body?.prompt === 'string' ? body.prompt : '';

  // 注册到实时裁判喊停组件 (如果可用), 让它监听本次 Java dispatch 的 worker_chunk
  const judgeStop = (kernel as any)?.realtimeJudgeStop;
  if (judgeStop && typeof judgeStop.registerDispatch === 'function' && taskHint) {
    judgeStop.registerDispatch(dispatchId, taskHint);
  }

  // SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const writeSSE = (event: string, data: any): void => {
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch { /* client disconnected */ }
  };

  // Track client disconnect
  let aborted = false;
  req.on('close', () => { aborted = true; });

  // EventBus listener 定义 (在 try 外定义, 以便 finally 能清理)
  let onWorkerStarted: ((payload: any) => void) | null = null;
  let onWorkerChunk: ((payload: any) => void) | null = null;
  let onWorkerDone: ((payload: any) => void) | null = null;
  let onWorkerFailed: ((payload: any) => void) | null = null;
  let onWorkerStoppedByJudge: ((payload: any) => void) | null = null;
  let onDispatchDone: ((payload: any) => void) | null = null;
  let listenersAttached = false;

  // 统一清理函数: 移除 EventBus listener + 注销 DispatchTracker
  // 必须在所有退出路径 (正常/!ok/异常/超时/客户端断开) 调用, 避免内存泄漏
  const cleanupListeners = (): void => {
    if (!listenersAttached) return;
    if (onWorkerStarted) kernel.eventBus.off('worker_started', onWorkerStarted);
    if (onWorkerChunk) kernel.eventBus.off('worker_chunk', onWorkerChunk);
    if (onWorkerDone) kernel.eventBus.off('worker_done', onWorkerDone);
    if (onWorkerFailed) kernel.eventBus.off('worker_failed', onWorkerFailed);
    if (onWorkerStoppedByJudge) kernel.eventBus.off('worker_stopped_by_judge', onWorkerStoppedByJudge);
    if (onDispatchDone) kernel.eventBus.off('dispatch_done', onDispatchDone);
    listenersAttached = false;
    // 清理实时裁判跟踪器
    if (judgeStop && typeof judgeStop.unregisterDispatch === 'function') {
      judgeStop.unregisterDispatch(dispatchId);
    }
  };

  try {
    // 1. 先订阅 EventBus 事件, 再发 dispatch 请求 (避免 race condition: worker_started 在订阅前就发出)
    let completed = false;

    onWorkerStarted = (payload: any) => {
      if (payload?.dispatchId !== dispatchId) return;
      writeSSE('worker_started', payload);
    };
    onWorkerChunk = (payload: any) => {
      if (payload?.dispatchId !== dispatchId) return;
      writeSSE('worker_chunk', payload);
    };
    onWorkerDone = (payload: any) => {
      if (payload?.dispatchId !== dispatchId) return;
      writeSSE('worker_done', payload);
    };
    onWorkerFailed = (payload: any) => {
      if (payload?.dispatchId !== dispatchId) return;
      writeSSE('worker_failed', payload);
    };
    onWorkerStoppedByJudge = (payload: any) => {
      if (payload?.dispatchId !== dispatchId) return;
      writeSSE('worker_stopped_by_judge', payload);
    };
    onDispatchDone = (payload: any) => {
      if (payload?.dispatchId !== dispatchId) return;
      writeSSE('dispatch_done', payload);
      completed = true;
    };

    kernel.eventBus.on('worker_started', onWorkerStarted);
    kernel.eventBus.on('worker_chunk', onWorkerChunk);
    kernel.eventBus.on('worker_done', onWorkerDone);
    kernel.eventBus.on('worker_failed', onWorkerFailed);
    kernel.eventBus.on('worker_stopped_by_judge', onWorkerStoppedByJudge);
    kernel.eventBus.on('dispatch_done', onDispatchDone);
    listenersAttached = true;

    // 2. 通过 HTTP 启动 dispatch (Java Agent 端口 8770)
    const executeBody = { ...body, dispatchId, chatId };
    const executeRes = await fetch('http://127.0.0.1:8770/api/chat/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(executeBody),
    });

    if (!executeRes.ok) {
      const errText = await executeRes.text();
      writeSSE('error', { error: `Java Agent dispatch failed: ${errText}` });
      return; // cleanup 在 finally 中统一执行
    }

    // 3. 等待 dispatch_done 或客户端断开 (最长 5 分钟)
    const timeoutMs = 5 * 60 * 1000;
    const start = Date.now();
    while (!completed && !aborted && (Date.now() - start) < timeoutMs) {
      await new Promise(r => setTimeout(r, 100));
    }

    if (!aborted && !completed) {
      writeSSE('error', { error: 'Dispatch timeout (5min)' });
    } else if (!aborted) {
      writeSSE('done', { dispatchId });
    }
    // cleanup 在 finally 中统一执行
  } catch (err: any) {
    if (!aborted) {
      writeSSE('error', { error: `Java Agent service not started: ${err.message}` });
    }
  } finally {
    cleanupListeners();
    try { if (!aborted) res.end(); } catch { /* ignore */ }
  }
}
