/**
 * AgentStore — 实时 agent 池状态 (Electron IPC 实时推送驱动)
 *
 * 数据来源:
 *   - 初始:  window.soloforge.agent.snapshot() (HTTP 调用后端)
 *   - 增量:  window.soloforge.agent.on('*') 订阅 WebSocket 推送
 *   - 控制:  window.soloforge.agent.dispatch / dispute (IPC)
 *
 * 与传统 zustand store 的区别:
 *   - 不持久化到 localStorage (实时状态, 重连即可恢复)
 *   - 不使用 persist middleware (会引入 100ms 写入延迟)
 *   - 所有更新走 IPC 事件, 避免 HTTP 轮询
 */

import { create } from 'zustand';

// ============================================================
// 类型 — 与后端 src/core/agent/agent-registry.ts AgentSnapshot 对齐
// ============================================================

export interface AgentEntry {
  agentId: string;
  strategyType: string;
  reputationScore: number;
  evidenceCount: number;
  totalExecutions: number;
  totalDisputes: number;
  totalWins: number;
  totalLosses: number;
  // 前端增量字段
  lastUpdateTs: number;
  lastDelta?: number;
  lastDeltaReason?: string;
}

export interface AgentEventLog {
  id: number;
  type: string;
  payload: any;
  ts: number;
}

export interface AgentBridgeStatus {
  connected: boolean;
  lastCloseAt: number;
  backendWsUrl: string;
}

export interface AgentState {
  // ── 池状态 ──
  agents: Record<string, AgentEntry>;
  agentIds: string[];  // 保持有序 (后端插入顺序)
  cpuLoad: number;

  // ── 实时事件流 (最近 N 条) ──
  eventLog: AgentEventLog[];  // 最多保留 100 条
  eventLogMaxSize: number;

  // ── 桥接状态 ──
  bridge: AgentBridgeStatus;

  // ── 加载状态 ──
  isLoading: boolean;
  lastError: string | null;
  lastDispatchResult: any | null;
  lastDisputeResult: any | null;

  // ── Actions ──
  hydrateFromSnapshot: (data: { agents: AgentEntry[]; cpuLoad?: number }) => void;
  applyEvent: (msg: { type: string; payload: any; ts: number }) => void;
  refreshSnapshot: () => Promise<void>;
  dispatchPacket: (payload: any) => Promise<any>;
  raiseDispute: (payload: any) => Promise<any>;
  setBridgeStatus: (status: Partial<AgentBridgeStatus>) => void;
  clearError: () => void;
  reset: () => void;
}

const INITIAL: Pick<AgentState, 'agents' | 'agentIds' | 'cpuLoad' | 'eventLog' | 'eventLogMaxSize' | 'bridge' | 'isLoading' | 'lastError' | 'lastDispatchResult' | 'lastDisputeResult'> = {
  agents: {},
  agentIds: [],
  cpuLoad: 0.3,
  eventLog: [],
  eventLogMaxSize: 100,
  bridge: { connected: false, lastCloseAt: 0, backendWsUrl: '' },
  isLoading: false,
  lastError: null,
  lastDispatchResult: null,
  lastDisputeResult: null,
};

// ============================================================
// 桥接口 (window.soloforge.agent) — 弱类型, 缺失时静默退化
// ============================================================

interface AgentBridge {
  on: (eventType: string, callback: (msg: { type: string; payload: any; ts: number }) => void) => () => void;
  dispatch: (payload: any) => Promise<any>;
  dispute: (payload: any) => Promise<any>;
  snapshot: () => Promise<any>;
  bridgeStatus: () => Promise<any>;
}

function getBridge(): AgentBridge | null {
  if (typeof window === 'undefined') return null;
  const sf = (window as any).soloforge;
  return sf?.agent ?? null;
}

// ============================================================
// Store
// ============================================================

export const useAgentStore = create<AgentState>((set, get) => ({
  ...INITIAL,

  hydrateFromSnapshot: (data) => {
    const agents: Record<string, AgentEntry> = {};
    const ids: string[] = [];
    const ts = Date.now();
    for (const a of data.agents || []) {
      agents[a.agentId] = { ...a, lastUpdateTs: ts };
      ids.push(a.agentId);
    }
    set({ agents, agentIds: ids, cpuLoad: data.cpuLoad ?? 0.3, isLoading: false, lastError: null });
  },

  applyEvent: (msg) => {
    const { type, payload, ts } = msg;
    const state = get();
    const next = { ...state.agents };

    switch (type) {
      case 'agent.task.dispatched': {
        // 不修改 agent 池, 只在 eventLog 留痕
        break;
      }
      case 'agent.task.executed': {
        const e = next[payload.agentId];
        if (e) next[payload.agentId] = { ...e, totalExecutions: e.totalExecutions + 1, lastUpdateTs: ts };
        break;
      }
      case 'agent.reputation.updated': {
        const e = next[payload.agentId];
        if (e) {
          next[payload.agentId] = {
            ...e,
            reputationScore: payload.newScore ?? e.reputationScore,
            lastDelta: payload.delta,
            lastDeltaReason: payload.reason,
            totalWins: payload.reason === 'court_victory' ? e.totalWins + 1 : e.totalWins,
            totalLosses: payload.reason === 'court_defeat' ? e.totalLosses + 1 : e.totalLosses,
            lastUpdateTs: ts,
          };
        }
        break;
      }
      case 'agent.dispute.raised': {
        const e = next[payload.agentId];
        if (e) next[payload.agentId] = { ...e, totalDisputes: e.totalDisputes + 1, lastUpdateTs: ts };
        break;
      }
      case 'agent.snapshot': {
        // 初始全量快照 (连接建立时由 hub 推送)
        const agents = (payload?.agents || []) as AgentEntry[];
        const ids: string[] = [];
        for (const a of agents) {
          next[a.agentId] = { ...a, lastUpdateTs: ts };
          ids.push(a.agentId);
        }
        set({ agents: next, agentIds: ids, cpuLoad: payload?.cpuLoad ?? get().cpuLoad });
        return;
      }
      case 'court.arbitration.decided': {
        // 法院裁决: 不直接改 agent 池 (由后端 AgentEventHub 紧接着推 agent.reputation.updated)
        break;
      }
      case 'court.claim.submitted':
      case 'court.deadlock.detected':
      default: {
        // 其他事件只入 eventLog
        break;
      }
    }

    // 滚动 eventLog (最多 N 条, 头部插入)
    const newLog: AgentEventLog[] = [
      { id: ts, type, payload, ts },
      ...state.eventLog,
    ].slice(0, state.eventLogMaxSize);

    set({ agents: next, eventLog: newLog });
  },

  refreshSnapshot: async () => {
    const bridge = getBridge();
    if (!bridge) {
      set({ lastError: 'AgentBridge not available (run inside Electron)' });
      return;
    }
    set({ isLoading: true });
    try {
      const resp = await bridge.snapshot();
      if (resp?.ok && resp.body) {
        get().hydrateFromSnapshot(resp.body);
      } else {
        set({ lastError: resp?.error || 'snapshot failed', isLoading: false });
      }
    } catch (e: any) {
      set({ lastError: e.message, isLoading: false });
    }
  },

  dispatchPacket: async (payload) => {
    const bridge = getBridge();
    if (!bridge) {
      set({ lastError: 'AgentBridge not available' });
      return { ok: false, error: 'no bridge' };
    }
    set({ isLoading: true });
    try {
      const resp = await bridge.dispatch(payload);
      if (resp?.ok) {
        set({ lastDispatchResult: resp.body, isLoading: false, lastError: null });
        return resp.body;
      } else {
        set({ lastError: resp?.error || 'dispatch failed', isLoading: false });
        return resp;
      }
    } catch (e: any) {
      set({ lastError: e.message, isLoading: false });
      return { ok: false, error: e.message };
    }
  },

  raiseDispute: async (payload) => {
    const bridge = getBridge();
    if (!bridge) {
      set({ lastError: 'AgentBridge not available' });
      return { ok: false, error: 'no bridge' };
    }
    set({ isLoading: true });
    try {
      const resp = await bridge.dispute(payload);
      if (resp?.ok) {
        set({ lastDisputeResult: resp.body, isLoading: false, lastError: null });
        return resp.body;
      } else {
        set({ lastError: resp?.error || 'dispute failed', isLoading: false });
        return resp;
      }
    } catch (e: any) {
      set({ lastError: e.message, isLoading: false });
      return { ok: false, error: e.message };
    }
  },

  setBridgeStatus: (status) => {
    set({ bridge: { ...get().bridge, ...status } });
  },

  clearError: () => set({ lastError: null }),
  reset: () => set({ ...INITIAL }),
}));

// ============================================================
// Selectors (避免组件 re-render 整个 agents 树)
// ============================================================

export const selectAgentById = (agentId: string) => (s: AgentState) => s.agents[agentId];
export const selectSortedAgents = (s: AgentState) =>
  s.agentIds.map((id) => s.agents[id]).filter(Boolean).sort((a, b) => b.reputationScore - a.reputationScore);
export const selectRecentEvents = (n: number) => (s: AgentState) => s.eventLog.slice(0, n);

// ── HMR 边界:改 store 代码时热替换 store 实例,不触发 full page reload ──
// React 组件树保持挂载,agent 池/eventLog 会重置为初始值 (实时 IPC 数据,重连即可恢复)。
// 注意: IPC 订阅 (window.soloforge.agent.on) 在组件 useEffect 中注册,不在 store 模块顶层,
//   store 模块重新加载不会创建重复订阅,无需 dispose。
if (import.meta.hot) {
  import.meta.hot.accept((m) => {
    if (m) useAgentStore.setState(m.useAgentStore.getState(), true);
  });
}
