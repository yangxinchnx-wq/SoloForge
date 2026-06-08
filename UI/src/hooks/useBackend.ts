// ─────────────────────────────────────────────────────────────────
// 后端数据 Hooks
// 优先通过 WebSocket 接收 state.snapshot 推送,WS 不可达时回退到 HTTP 轮询
// - useBackend:首屏 state.snapshot 即时填充,5s 兜底轮询
// - useObservation:2s 轮询(暂时保持,后续可加 obs.subscribe)
// - useScheduler:3s 轮询(同上)
// ─────────────────────────────────────────────────────────────────

import { useEffect, useState, useCallback, useRef } from 'react';
import { api } from '../api/client';
import { getWsClient } from '../api/ws';
import type {
  KernelStatus, SystemStatus, DbStats, Agent, KernelEvent,
  HealthStatus, ObservationData, SchedulerStats,
} from '../types';

export interface BackendState {
  connected: boolean;
  lastUpdate: string;
  error: string | null;
  refresh: () => Promise<void>;
}

const FALLBACK_POLL_MS = 5000;

/** 把 state.snapshot.data 映射成对应类型 */
function snapshotToKernel(d: any): KernelStatus {
  return {
    state: d.status ?? d.state ?? 'UNKNOWN',
    mode: d.mode ?? 'normal',
    version: d.version ?? 0,
    currentTick: d.currentTick ?? 0,
    startedAt: d.startedAt ?? 0,
    uptime: d.uptime ?? 0,
  };
}
function snapshotToSystem(d: any): SystemStatus {
  return {
    cpu: d.cpu ?? 0,
    memory: d.memUsed ?? 0,
    memoryUsed: `${d.memUsed ?? 0} MB`,
    memoryTotal: `${d.memTotal ?? 0} MB`,
    uptime: d.uptime ?? 0,
    platform: d.platform ?? 'unknown',
    nodeVersion: d.nodeVersion ?? '',
    network: d.network ?? { up: 0, down: 0 },
    kernel: d.kernel ?? { state: 'UNKNOWN', version: 0 },
    agents: d.agents ?? { active: 0, total: 0 },
    loadAvg: d.load1 !== undefined ? [d.load1, d.load5, d.load15] : undefined,
  };
}
function snapshotToDb(d: any): DbStats {
  return {
    garnet: d.garnet ?? { sessions: 0, tasks: 0, counters: 0, connected: false, healthy: false },
    surrealdb: d.surreal
      ? {
          records: 0,
          hot: 0,
          connected: !!d.surreal.ready,
          healthy: !!d.surreal.ready,
          tables: (d.tables as string[])?.reduce<Record<string, number>>((m, t) => { m[t] = 0; return m; }, {}),
        }
      : { records: 0, hot: 0, connected: false, healthy: false },
    jsonl: { records: 0, size: '0 B', healthy: true },
  };
}
function snapshotToAgents(d: any): Agent[] {
  if (Array.isArray(d.list)) return d.list as Agent[];
  return [];
}
function snapshotToEvents(d: any): KernelEvent[] {
  if (!Array.isArray(d.recent)) return [];
  return d.recent.map((e: any) => ({
    event: e.type,
    payload: e.payload,
    timestamp: e.ts,
  }));
}

export function useBackend() {
  const [kernel, setKernel] = useState<KernelStatus | null>(null);
  const [system, setSystem] = useState<SystemStatus | null>(null);
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [db, setDb] = useState<DbStats | null>(null);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [events, setEvents] = useState<KernelEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const [lastUpdate, setLastUpdate] = useState('--');
  const [error, setError] = useState<string | null>(null);
  const [retryAttempt, setRetryAttempt] = useState(0);
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [channel, setChannel] = useState<'ws' | 'http' | null>(null);
  const stopRef = useRef(false);
  const lastEventTsRef = useRef<number>(0);

  // ─── 1) WS state.snapshot 订阅 ───
  useEffect(() => {
    const ws = getWsClient();
    ws.start();

    const offs: Array<() => void> = [];
    offs.push(ws.on('*', (msg: any) => {
      if (msg.type === 'connected') {
        // 订阅 5 个 key
        ws.send('state.subscribe', { keys: ['kernel', 'system', 'db', 'agents', 'events'] });
        return;
      }
      if (msg.type === 'disconnected') {
        if (channel === 'ws') setConnected(false);
        return;
      }
      if (msg.type === 'state.snapshot' && msg.payload) {
        const key = msg.payload.key;
        const data = msg.payload.data;
        switch (key) {
          case 'kernel': setKernel(snapshotToKernel(data)); break;
          case 'system': setSystem(snapshotToSystem(data)); break;
          case 'db':     setDb(snapshotToDb(data)); break;
          case 'agents': setAgents(snapshotToAgents(data)); break;
          case 'events': {
            const evs = snapshotToEvents(data);
            setEvents(prev => {
              const newOnes = evs.filter(e => (e.timestamp || 0) > lastEventTsRef.current);
              if (newOnes.length > 0) {
                lastEventTsRef.current = Math.max(
                  lastEventTsRef.current,
                  ...newOnes.map(e => e.timestamp || 0)
                );
                return [...newOnes, ...prev].slice(0, 200);
              }
              return prev;
            });
            break;
          }
        }
        setLastUpdate(new Date().toLocaleTimeString('zh-CN'));
        setConnected(true);
        setChannel('ws');
        setError(null);
        setRetryAttempt(0);
      }
    }));

    return () => offs.forEach(off => off());
  }, []);

  // ─── 2) HTTP 兜底轮询(WS 不可达时) ───
  const refresh = useCallback(async () => {
    if (stopRef.current) return;
    const t0 = performance.now();
    const results = await Promise.allSettled([
      api.kernelStatus(),
      api.systemStatus(),
      api.kernelHealth(),
      api.databaseStats(),
      api.agents(),
      api.kernelEvents(50),
    ]);
    if (stopRef.current) return;
    let anyOk = false;
    const [k, s, h, d, a, e] = results;
    if (k.status === 'fulfilled') { setKernel(k.value); anyOk = true; }
    if (s.status === 'fulfilled') { setSystem(s.value); anyOk = true; }
    if (h.status === 'fulfilled') { setHealth(h.value); anyOk = true; }
    if (d.status === 'fulfilled') { setDb(d.value); anyOk = true; }
    if (a.status === 'fulfilled') { setAgents(a.value); anyOk = true; }
    if (e.status === 'fulfilled') {
      const incoming = e.value;
      setEvents(prev => {
        const newOnes = incoming.filter((ev: any) => (ev.timestamp || 0) > lastEventTsRef.current);
        if (newOnes.length > 0) {
          lastEventTsRef.current = Math.max(
            lastEventTsRef.current,
            ...newOnes.map((ev: any) => ev.timestamp || 0)
          );
          return [...newOnes, ...prev].slice(0, 200);
        }
        return prev;
      });
      anyOk = true;
    }
    setLastUpdate(new Date().toLocaleTimeString('zh-CN'));
    setLatencyMs(Math.round(performance.now() - t0));
    if (anyOk) {
      setChannel('http');
      setError(null);
      setRetryAttempt(0);
    } else {
      setError('后端不可达');
      setRetryAttempt(a => a + 1);
    }
  }, []);

  useEffect(() => {
    stopRef.current = false;
    refresh();
    // 只有 WS 没建立时才轮询
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = () => {
      if (stopRef.current) return;
      const wsState = getWsClient().state();
      if (wsState.connected && channel === 'ws') {
        // WS 通道已建立,等下一个 30s 体检
        timer = setTimeout(tick, 30_000);
        return;
      }
      refresh().finally(() => {
        const backoff = Math.min(30_000, 3000 * Math.pow(1.5, retryAttempt));
        timer = setTimeout(tick, backoff);
      });
    };
    tick();
    return () => {
      stopRef.current = true;
      if (timer) clearTimeout(timer);
    };
  }, [refresh, channel, retryAttempt]);

  return {
    kernel, system, health, db, agents, events,
    connected, lastUpdate, error, retryAttempt, latencyMs, refresh, channel,
  };
}

// ─── 观测数据 ───
export function useObservation() {
  const [data, setData] = useState<ObservationData | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const d = await api.observation();
      setData(d);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 2000);
    return () => clearInterval(t);
  }, [refresh]);

  const start = useCallback(async () => { setLoading(true); try { await api.observationStart(); } finally { setLoading(false); refresh(); } }, [refresh]);
  const stop  = useCallback(async () => { setLoading(true); try { await api.observationStop();  } finally { setLoading(false); refresh(); } }, [refresh]);
  const clear = useCallback(async () => { setLoading(true); try { await api.observationClear(); } finally { setLoading(false); refresh(); } }, [refresh]);

  return { data, refresh, start, stop, clear, loading };
}

// ─── 调度器统计 ───
export function useScheduler() {
  const [stats, setStats] = useState<SchedulerStats | null>(null);
  const refresh = useCallback(async () => {
    try { setStats(await api.schedulerStats()); } catch { /* ignore */ }
  }, []);
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, [refresh]);
  return { stats, refresh };
}
