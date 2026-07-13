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
//   GET  /api/analytics/health     — DuckDB probe
//   GET  /api/analytics/queries    — built-in query templates
//   GET  /api/analytics/run/:name  — run named query
//   POST /api/analytics/direct     — arbitrary SQL (read-only)
//   POST /api/analytics/snapshot   — SQLite -> .duckdb
//   POST /api/analytics/parquet    — SQLite -> .parquet
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
  console.log('[Observation] Started observing civilization evolution');
  return { status: 200, headers: { 'Content-Type': 'application/json' }, body: { success: true, message: 'Observation started' } };
}

export function handleObservationStop(deps: SystemRouteDeps): ApiResponse {
  if (deps.observationState.interval) { clearInterval(deps.observationState.interval); deps.observationState.interval = null; }
  deps.observationState.isObserving = false;
  console.log('[Observation] Stopped observing');
  return { status: 200, headers: { 'Content-Type': 'application/json' }, body: { success: true, message: 'Observation stopped' } };
}

export function handleObservationClear(deps: SystemRouteDeps): ApiResponse {
  deps.observationState.observations = [];
  console.log('[Observation] Cleared observation data');
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
        document.getElementById('sysinfo').innerHTML = ['<p>Node.js: ', String(data.nodeVersion || '--'), '</p>', '<p>', String(data.platform || '--'), '</p>', '<p>CPU: ', String(data.cpu?.toFixed(1) || '--'), '%</p>', '<p>', String(data.memory?.toFixed(1) || '--'), '%</p>', '<p>', String(data.kernel?.state || '--'), '</p>'].join('');
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
 * 直接 pipe Java 的 SSE 流到客户端，不缓冲
 */
export async function handleJavaAgentSSE(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  body: any,
): Promise<void> {
  const javaUrl = 'http://127.0.0.1:8770/api/chat/stream';
  try {
    const javaRes = await fetch(javaUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });

    if (!javaRes.ok) {
      const errText = await javaRes.text();
      res.writeHead(javaRes.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: errText }));
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const reader = javaRes.body?.getReader();
    if (!reader) {
      res.write('event: error\ndata: {"error":"No response body from Java Agent"}\n\n');
      res.end();
      return;
    }

    const decoder = new TextDecoder();
    let buffer = '';

    req.on('close', () => {
      try { reader.cancel(); } catch { /* ignore */ }
    });

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.startsWith('event:') || line.startsWith('data:') || line === '') {
          res.write(line + '\n');
        }
      }
      if (buffer === '' || buffer === '\n') {
        res.write('\n');
      }
    }

    if (buffer.trim()) {
      res.write(buffer + '\n\n');
    }

    res.end();
  } catch (err: any) {
    try {
      res.writeHead(502, { 'Content-Type': 'text/event-stream; charset=utf-8' });
      res.write(`event: error\ndata: ${JSON.stringify({ error: `Java Agent service not started: ${err.message}` })}\n\n`);
      res.end();
    } catch { /* client disconnected */ }
  }
}

// ============================================================
// DuckDB Analytics
// ============================================================

export const ANALYTICS_QUERIES: Record<string, { description: string; sql: string }> = {
  governance_summary: {
    description: 'Governance compliance records aggregated by action_taken',
    sql: `SELECT action_taken, compliant, COUNT(*) AS cnt FROM db.main.governance_record GROUP BY action_taken, compliant ORDER BY cnt DESC LIMIT 20`,
  },
  top_institutions: {
    description: 'Top institutions by reputation score',
    sql: `SELECT entity_id, entity_type, score, name FROM db.main.reputation ORDER BY CAST(score AS DOUBLE) NULLS LAST LIMIT 10`,
  },
  law_violation_by_type: {
    description: 'Law violations aggregated by status',
    sql: `SELECT status, COUNT(*) AS cnt, COUNT(DISTINCT law_id) AS distinct_laws FROM db.main.law_violation GROUP BY status HAVING cnt > 0 ORDER BY cnt DESC LIMIT 20`,
  },
  memory_table_counts: {
    description: 'Row counts per business table (DuckDB view)',
    sql: `SELECT 'coalition' AS table_name, COUNT(*) AS row_count FROM db.main.coalition UNION ALL SELECT 'economy', COUNT(*) FROM db.main.economy UNION ALL SELECT 'governance', COUNT(*) FROM db.main.governance UNION ALL SELECT 'governance_record', COUNT(*) FROM db.main.governance_record UNION ALL SELECT 'law', COUNT(*) FROM db.main.law UNION ALL SELECT 'law_violation', COUNT(*) FROM db.main.law_violation UNION ALL SELECT 'reputation', COUNT(*) FROM db.main.reputation UNION ALL SELECT 'reputation_record', COUNT(*) FROM db.main.reputation_record UNION ALL SELECT 'social_memory', COUNT(*) FROM db.main.social_memory UNION ALL SELECT 'credit_transaction', COUNT(*) FROM db.main.credit_transaction UNION ALL SELECT 'economy_record', COUNT(*) FROM db.main.economy_record UNION ALL SELECT 'culture', COUNT(*) FROM db.main.culture UNION ALL SELECT 'institution', COUNT(*) FROM db.main.institution ORDER BY row_count DESC`,
  },
};

export const ANALYTICS_SNAPSHOT_TABLES: string[] = [
  'institution', 'governance', 'reputation', 'culture', 'economy', 'law',
  'law_violation', 'coalition', 'social_memory',
  'credit_transaction', 'economy_record', 'governance_record',
  'reputation_record', 'reputation_sync_log',
];

function resolveDuckDbBinary(): string | null {
  const candidates = [
    path.resolve(process.cwd(), 'bin', 'duckdb', 'duckdb.exe'),
    'C:/Users/yangx/Desktop/SoloForge/bin/duckdb/duckdb.exe',
  ];
  for (const c of candidates) { if (fs.existsSync(c)) return c; }
  return null;
}

function resolveAnalyticsSqlitePath(): string | null {
  const candidates = [
    path.resolve(process.cwd(), 'python', 'data', 'ai_society', 'ai_society.db'),
    'C:/Users/yangx/Desktop/SoloForge/python/data/ai_society/ai_society.db',
  ];
  for (const c of candidates) { if (fs.existsSync(c)) return c; }
  return null;
}

function runDuckDbQuery(sql: string, timeoutMs: number = 30000): { ok: boolean; csv: string; stderr: string; elapsedMs: number } {
  const bin = resolveDuckDbBinary();
  if (!bin) return { ok: false, csv: '', stderr: 'duckdb.exe not found', elapsedMs: 0 };
  const sqlite = resolveAnalyticsSqlitePath();
  if (!sqlite) return { ok: false, csv: '', stderr: 'ai_society.db not found', elapsedMs: 0 };
  const attach = sqlite.replace(/\\/g, '/');
  const fullSql = `INSTALL sqlite; LOAD sqlite; ATTACH '${attach}' AS db (TYPE sqlite, READ_ONLY); ${sql}`;
  const t0 = Date.now();
  const proc = spawnSync(bin, ['-csv', '-c', fullSql], { encoding: 'utf8', timeout: timeoutMs, windowsHide: true });
  return { ok: proc.status === 0, csv: proc.stdout || '', stderr: proc.stderr || '', elapsedMs: Date.now() - t0 };
}

function parseCsv(csv: string): string[][] {
  return csv.split('\n').filter((l) => l.length > 0).map((l) => l.split(','));
}

export function handleAnalyticsHealth(): ApiResponse {
  const bin = resolveDuckDbBinary();
  const sqlite = resolveAnalyticsSqlitePath();
  const versionProc = bin ? spawnSync(bin, ['-version'], { encoding: 'utf8', timeout: 5000, windowsHide: true }) : null;
  const version = versionProc?.status === 0 ? (versionProc.stdout || '').trim() : null;
  return {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    body: {
      duckdb_available: !!bin, duckdb_binary: bin, duckdb_version: version,
      sqlite_path: sqlite, sqlite_exists: !!sqlite,
      queries_defined: Object.keys(ANALYTICS_QUERIES), snapshot_tables: ANALYTICS_SNAPSHOT_TABLES,
    },
  };
}

export function handleAnalyticsQueries(): ApiResponse {
  return {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    body: { queries: Object.entries(ANALYTICS_QUERIES).map(([name, spec]) => ({ name, description: spec.description })) },
  };
}

export function handleAnalyticsRun(name: string): ApiResponse {
  const spec = ANALYTICS_QUERIES[name];
  if (!spec) return { status: 404, headers: { 'Content-Type': 'application/json' }, body: { error: `Unknown query: ${name}`, available: Object.keys(ANALYTICS_QUERIES) } };
  const r = runDuckDbQuery(spec.sql);
  if (!r.ok) return { status: 500, headers: { 'Content-Type': 'application/json' }, body: { error: 'duckdb query failed', stderr: r.stderr, query: name } };
  const rows = parseCsv(r.csv);
  return {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    body: { query_name: name, description: spec.description, row_count: Math.max(0, rows.length - 1), rows, elapsed_ms: r.elapsedMs },
  };
}

export function handleAnalyticsDirect(body: any): ApiResponse {
  const rawSql = String(body?.sql || '').trim();
  if (!rawSql) return { status: 400, headers: { 'Content-Type': 'application/json' }, body: { error: "sql is required (POST body: { sql: 'SELECT ...' })" } };
  const upper = rawSql.toUpperCase().replace(/\s+/g, ' ');
  if (/\b(DROP|TRUNCATE)\b/.test(upper) || (/\b(DELETE\s+FROM|UPDATE\s+\w+\s+SET)\b/.test(upper) && !upper.includes('WHERE'))) {
    return { status: 403, headers: { 'Content-Type': 'application/json' }, body: { error: 'destructive statement rejected' } };
  }
  const sql = rawSql.replace(/\bCAST\s*\(/gi, 'TRY_CAST(');
  const r = runDuckDbQuery(sql);
  if (!r.ok) return { status: 500, headers: { 'Content-Type': 'application/json' }, body: { error: 'duckdb query failed', stderr: r.stderr, sql: rawSql, transformed_sql: sql } };
  const rows = parseCsv(r.csv);
  return {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    body: { row_count: Math.max(0, rows.length - 1), rows, elapsed_ms: r.elapsedMs, cast_transformed: sql !== rawSql },
  };
}

export function handleAnalyticsSnapshot(body: any): ApiResponse {
  const outPathRaw = body?.out_path || path.resolve(process.cwd(), 'python', 'data', 'ai_society', 'analytics', 'snapshot.duckdb');
  const outPath = path.resolve(outPathRaw);
  const tables: string[] = Array.isArray(body?.tables) && body.tables.length > 0 ? body.tables : ANALYTICS_SNAPSHOT_TABLES;
  const allowed = new Set(ANALYTICS_SNAPSHOT_TABLES);
  for (const t of tables) {
    if (!allowed.has(t)) return { status: 400, headers: { 'Content-Type': 'application/json' }, body: { error: `table not in whitelist: ${t}`, allowed: [...allowed] } };
  }
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
  const bin = resolveDuckDbBinary();
  const sqlite = resolveAnalyticsSqlitePath();
  if (!bin || !sqlite) return { status: 503, headers: { 'Content-Type': 'application/json' }, body: { error: 'duckdb.exe or ai_society.db not available' } };
  const attachSrc = sqlite.replace(/\\/g, '/');
  const attachDst = outPath.replace(/\\/g, '/');
  const prefix = `INSTALL sqlite; LOAD sqlite; ATTACH '${attachSrc}' AS src (TYPE sqlite, READ_ONLY); ATTACH '${attachDst}' AS dst; CREATE SCHEMA IF NOT EXISTS dst.main; `;
  const t0 = Date.now();
  const results: Array<{ table: string; row_count: number }> = [];
  for (const table of tables) {
    const r1 = spawnSync(bin, ['-c', prefix + `CREATE OR REPLACE TABLE dst.main.${table} AS SELECT * FROM src.main.${table} WHERE 0`], { encoding: 'utf8', timeout: 30000, windowsHide: true });
    if (r1.status !== 0) return { status: 500, headers: { 'Content-Type': 'application/json' }, body: { error: `schema copy failed for ${table}`, stderr: r1.stderr } };
    const r2 = spawnSync(bin, ['-c', prefix + `INSERT INTO dst.main.${table} SELECT * FROM src.main.${table}`], { encoding: 'utf8', timeout: 30000, windowsHide: true });
    if (r2.status !== 0) return { status: 500, headers: { 'Content-Type': 'application/json' }, body: { error: `data copy failed for ${table}`, stderr: r2.stderr } };
    const r3 = spawnSync(bin, ['-csv', '-c', prefix + `SELECT COUNT(*) FROM dst.main.${table}`], { encoding: 'utf8', timeout: 10000, windowsHide: true });
    const cnt = parseInt((r3.stdout || '').trim().split('\n').pop() || '0', 10) || 0;
    results.push({ table, row_count: cnt });
  }
  const elapsedMs = Date.now() - t0;
  const sizeBytes = fs.existsSync(outPath) ? fs.statSync(outPath).size : 0;
  return {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    body: { out_path: outPath, tables_exported: results, total_rows: results.reduce((s, r) => s + r.row_count, 0), size_bytes: sizeBytes, elapsed_ms: elapsedMs },
  };
}

export function handleAnalyticsParquet(body: any): ApiResponse {
  const outDirRaw = body?.out_dir || path.resolve(process.cwd(), 'python', 'data', 'ai_society', 'analytics', 'parquet');
  const outDir = path.resolve(outDirRaw);
  const tables: string[] = Array.isArray(body?.tables) && body.tables.length > 0 ? body.tables : ANALYTICS_SNAPSHOT_TABLES;
  const allowed = new Set(ANALYTICS_SNAPSHOT_TABLES);
  for (const t of tables) {
    if (!allowed.has(t)) return { status: 400, headers: { 'Content-Type': 'application/json' }, body: { error: `table not in whitelist: ${t}`, allowed: [...allowed] } };
  }
  fs.mkdirSync(outDir, { recursive: true });
  const bin = resolveDuckDbBinary();
  if (!bin) return { status: 503, headers: { 'Content-Type': 'application/json' }, body: { error: 'duckdb.exe not available' } };
  const sqlite = resolveAnalyticsSqlitePath();
  if (!sqlite) return { status: 503, headers: { 'Content-Type': 'application/json' }, body: { error: 'ai_society.db not available' } };
  const attachSrc = sqlite.replace(/\\/g, '/');
  const tmpDuckDb = path.join(outDir, '_snapshot.duckdb');
  if (fs.existsSync(tmpDuckDb)) fs.unlinkSync(tmpDuckDb);
  const attachTmp = tmpDuckDb.replace(/\\/g, '/');
  const prefix = `INSTALL sqlite; LOAD sqlite; ATTACH '${attachSrc}' AS src (TYPE sqlite, READ_ONLY); ATTACH '${attachTmp}' AS dst; `;
  for (const table of tables) {
    const r1 = spawnSync(bin, ['-c', prefix + `CREATE OR REPLACE TABLE dst.main.${table} AS SELECT * FROM src.main.${table}`], { encoding: 'utf8', timeout: 30000, windowsHide: true });
    if (r1.status !== 0) return { status: 500, headers: { 'Content-Type': 'application/json' }, body: { error: `snapshot copy failed for ${table}`, stderr: r1.stderr } };
  }
  const files: Array<{ table: string; path: string; size_bytes: number }> = [];
  for (const table of tables) {
    const parquetPath = path.join(outDir, `${table}.parquet`);
    const r = spawnSync(bin, ['-c', prefix + `COPY dst.main.${table} TO '${parquetPath.replace(/\\/g, '/')}' (FORMAT PARQUET)`], { encoding: 'utf8', timeout: 30000, windowsHide: true });
    if (r.status !== 0) return { status: 500, headers: { 'Content-Type': 'application/json' }, body: { error: `parquet export failed for ${table}`, stderr: r.stderr } };
    files.push({ table, path: parquetPath, size_bytes: fs.existsSync(parquetPath) ? fs.statSync(parquetPath).size : 0 });
  }
  try { fs.unlinkSync(tmpDuckDb); } catch { /* ignore */ }
  return { status: 200, headers: { 'Content-Type': 'application/json' }, body: { out_dir: outDir, files } };
}
