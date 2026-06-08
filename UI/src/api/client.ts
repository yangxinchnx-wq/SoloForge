// ─────────────────────────────────────────────────────────────────
// SoloForge 前端 API 客户端
// - 封装 fetch，提供类型安全的接口
// - SSE 事件订阅
// - 后端连接探测
// ─────────────────────────────────────────────────────────────────

import type {
  KernelStatus, SystemStatus, DbStats, Agent, KernelEvent,
  HealthStatus, ObservationData, SchedulerStats,
} from '../types';

// 优先使用环境变量；其次 Vite 代理（同源 /api）；最后直连
// 注意：Electron 中间人模式下，5173 dev 走相对路径 → Vite 代理仍生效 → Electron webRequest 重写到 3001
function resolveApiBase(): { base: string; reason: string } {
  // 1) Vite 注入的环境变量
  const env = (import.meta as any).env;
  if (env?.VITE_API_BASE) return { base: env.VITE_API_BASE, reason: 'VITE_API_BASE env' };

  // 2) 浏览器/Electron 渲染层：走同源（Vite 代理） 或 直连后端
  if (typeof window !== 'undefined') {
    // 同源 (port 一致或反代) → '' 走相对路径
    if (window.location.port === '3001' || window.location.port === '80' || window.location.port === '') {
      return { base: '', reason: `同源 (port=${window.location.port || 'default'}) 走相对路径` };
    }
    // dev: 5173 - 走同源代理（Vite 反代 /api /metrics /ui → 3001；Electron 中间人会在 webRequest 层再确认）
    if (window.location.port === '5173') return { base: '', reason: 'dev: 5173 走 Vite 代理 → Electron 中间人' };
  }
  return { base: 'http://localhost:3001', reason: '默认 fallback' };
}

const _resolved = resolveApiBase();
export const API_BASE = _resolved.base;

// 调试输出：让用户在 DevTools Console 一眼能看到当前 API 走的是哪条路径
// 仅在开发模式（Vite dev 或 Electron dev）打印
if (typeof window !== 'undefined' && (import.meta as any).env?.DEV) {
  console.info(
    '%c[SoloForge API]%c base = %c"%s"%c  reason = %s',
    'color:#e7c35a;font-weight:bold', 'color:inherit',
    'color:#58a6ff;font-weight:bold',
    _resolved.base || '(相对路径)',
    'color:inherit',
    _resolved.reason,
  );
}

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
    ...init,
  });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new ApiError(text || `HTTP ${r.status}`, r.status);
  }
  return r.json();
}

export const api = {
  // 基础
  health:        () => request<{ status: string; uptime: number }>('/api/health'),

  // 内核
  kernelStatus:  () => request<KernelStatus>('/api/kernel/status'),
  kernelHealth:  () => request<HealthStatus>('/api/kernel/health'),
  kernelEvents:  (limit = 50) => request<KernelEvent[]>(`/api/kernel/events?limit=${limit}`),

  // 系统
  systemStatus:  () => request<SystemStatus>('/api/status'),
  databaseStats: () => request<DbStats>('/api/database/stats'),
  agents:        () => request<Agent[]>('/api/agents'),

  // 观测
  observation:   () => request<ObservationData>('/api/observation/data'),
  observationStart: () => request<{ success: boolean }>('/api/observation/start', { method: 'POST' }),
  observationStop:  () => request<{ success: boolean }>('/api/observation/stop',  { method: 'POST' }),
  observationClear: () => request<{ success: boolean }>('/api/observation/clear', { method: 'POST' }),

  // 调度器
  schedulerStats: () => request<SchedulerStats>('/api/scheduler/stats'),

  // 事件列表
  eventsList: (limit = 100) => request<{ events: KernelEvent[]; total: number; connected: boolean }>(`/api/events/list?limit=${limit}`),
};

// ─── SSE 订阅 ───
export type SseHandler = (evt: { event: string; payload: any; timestamp: number }) => void;

// SSE 直连 3001 绕开 Vite proxy / Electron 中间人
// 原因：Vite proxy 对长连接 SSE 支持不稳，Electron webRequest 重写在 SSE 流上偶尔触发 onerror
// 后端 api-server.ts 已设 Access-Control-Allow-Origin: * 不会跨域
const SSE_DIRECT = 'http://localhost:3001';

export function subscribeSse(handler: SseHandler): () => void {
  let es: EventSource | null = null;
  let closed = false;

  const connect = () => {
    if (closed) return;
    try {
      es = new EventSource(`${SSE_DIRECT}/api/events/stream`);
      es.onmessage = (e) => {
        try {
          const data = JSON.parse(e.data);
          handler(data);
        } catch { /* ignore */ }
      };
      es.onerror = () => {
        es?.close();
        es = null;
        if (!closed) {
          // 3s 后重连
          setTimeout(connect, 3000);
        }
      };
    } catch {
      if (!closed) setTimeout(connect, 3000);
    }
  };

  connect();

  return () => {
    closed = true;
    es?.close();
  };
}
