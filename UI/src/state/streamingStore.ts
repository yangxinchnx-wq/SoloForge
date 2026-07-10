/**
 * streamingStore — 流送区控制流元数据 store
 *
 * 阶段 A-D 迁移后职责:
 *   - streamTaskMeta: rootTaskId / subTaskIds / userInput / mode (控制流)
 *   - agentsMap: 子 Agent 池 (控制流)
 *
 * 显示数据全部从 uiMessageStore.parts 派生 (useStreamSummary / useRootTaskFromParts)
 * 事件分发由 dispatchStreamEvent (actorIntegration.ts) 处理, 本 store 不再参与事件处理
 */
import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import type {
  SubAgent,
  PermissionMode,
} from '../types/streaming';
import { promptCardPool } from '../services/promptCardPool';

interface StreamTaskMeta {
  rootTaskId: string;
  subTaskIds: Map<number, string>;
  userInput: string;
  mode: PermissionMode;
}

interface StreamingState {
  // 流送任务元数据 (按 chatId 隔离, 替代组件级 streamTaskRef)
  // 存储 workerIdx -> subTaskId 的映射, 多 chat 并发时不会串台
  streamTaskMeta: Record<string, StreamTaskMeta>;

  // R1.1: 子Agent 池 (按 chatId 索引)
  agentsMap: Record<string, SubAgent[]>;

  // 动作
  createTask: (chatId: string, userInput: string, mode: PermissionMode) => { id: string; chatId: string; phase: 'CLARIFY' };
  clearChat: (chatId: string) => void;

  // 流送元数据管理
  bindSubTask: (chatId: string, workerIdx: number, subTaskId: string) => void;
  getSubTaskId: (chatId: string, workerIdx: number) => string | undefined;
  getStreamTaskMeta: (chatId: string) => StreamTaskMeta | undefined;

  // R1.1: 子 Agent 池管理
  addAgent: (chatId: string, agent: SubAgent) => void;
  removeAgent: (chatId: string, agentId: string) => void;
  getAgents: (chatId: string) => SubAgent[];
  renameAgent: (chatId: string, agentId: string, newName: string, newAvatar?: string) => void;

  // R1.4: 测试用 — 一键重置整个 store 到初始空状态
  __reset: () => void;
}

// R3.3: 用 crypto.randomUUID() 替代模块级计数器
// 优势: 跨 HMR 不重置、跨测试不重置、跨 iframe/worker 不冲突
function uid(prefix: string): string {
  // 浏览器 + Node 19+ 都有 crypto.randomUUID
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  // 退化方案: 时间戳 + 随机后缀 (旧环境兜底)
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export const useStreamingStore = create<StreamingState>((set, get) => ({
  streamTaskMeta: {},
  agentsMap: {},

  createTask: (chatId: string, userInput: string, mode: PermissionMode) => {
    const id = uid('task');
    const handle = { id, chatId, phase: 'CLARIFY' as const };
    set(s => ({
      streamTaskMeta: {
        ...s.streamTaskMeta,
        [chatId]: { rootTaskId: id, subTaskIds: new Map(), userInput, mode },
      },
    }));
    return handle;
  },

  clearChat: (chatId: string) => {
    set(s => {
      if (!s.streamTaskMeta[chatId] && !s.agentsMap[chatId]) return s;
      const { [chatId]: _meta, ...restMeta } = s.streamTaskMeta;
      const { [chatId]: _agents, ...restAgents } = s.agentsMap;
      // 同步清掉 promptCardPool 里同 chatId 的所有卡片
      promptCardPool.clearChat(chatId);
      return {
        streamTaskMeta: restMeta,
        agentsMap: restAgents,
      };
    });
  },

  // ============== 流送元数据管理 ==============

  bindSubTask: (chatId: string, workerIdx: number, subTaskId: string) => {
    set(s => {
      const cur = s.streamTaskMeta[chatId];
      if (!cur) return s;
      const nextMap = new Map(cur.subTaskIds);
      nextMap.set(workerIdx, subTaskId);
      return {
        streamTaskMeta: {
          ...s.streamTaskMeta,
          [chatId]: { ...cur, subTaskIds: nextMap },
        },
      };
    });
  },

  getSubTaskId: (chatId: string, workerIdx: number) => {
    return get().streamTaskMeta[chatId]?.subTaskIds.get(workerIdx);
  },

  getStreamTaskMeta: (chatId: string) => {
    return get().streamTaskMeta[chatId];
  },

  // ============== R1.1: 子 Agent 池管理 ==============

  addAgent: (chatId: string, agent: SubAgent) => {
    set(s => {
      const list = s.agentsMap[chatId] ?? [];
      // 同 id 重复添加时, 更新 lastActiveAt
      const existing = list.findIndex(a => a.id === agent.id);
      const next = existing >= 0
        ? list.map((a, i) => i === existing ? { ...a, ...agent, lastActiveAt: agent.lastActiveAt } : a)
        : [...list, agent];
      return { agentsMap: { ...s.agentsMap, [chatId]: next } };
    });
  },

  removeAgent: (chatId: string, agentId: string) => {
    set(s => {
      const list = s.agentsMap[chatId];
      if (!list) return s;
      const next = list.filter(a => a.id !== agentId);
      if (next.length === 0) {
        const { [chatId]: _removed, ...rest } = s.agentsMap;
        return { agentsMap: rest };
      }
      return { agentsMap: { ...s.agentsMap, [chatId]: next } };
    });
  },

  getAgents: (chatId: string) => {
    return get().agentsMap[chatId] ?? [];
  },

  renameAgent: (chatId: string, agentId: string, newName: string, newAvatar?: string) => {
    set(s => {
      const list = s.agentsMap[chatId];
      if (!list) return s;
      const next = list.map(a => a.id === agentId
        ? { ...a, name: newName, ...(newAvatar !== undefined ? { avatar: newAvatar } : {}) }
        : a
      );
      return { agentsMap: { ...s.agentsMap, [chatId]: next } };
    });
  },

  // R1.4: 重置整个 store 到初始空状态 (测试用, HMR 用)
  __reset: () => {
    set(() => ({
      streamTaskMeta: {},
      agentsMap: {},
    }));
  },
}));

// R3.4: dev 模式全局 hook, 给控制台手测用
//   window.__soloForgeStream.getState() / .createTask() / .__reset()
export function installStreamDevHooks(): void {
  if (typeof window === 'undefined') return;
  (window as any).__soloForgeStream = {
    getState: () => useStreamingStore.getState(),
    setState: useStreamingStore.setState,
    createTask: (chatId: string, input = 'dev task', mode: PermissionMode = 'normal') =>
      useStreamingStore.getState().createTask(chatId, input, mode),
    __reset: () => useStreamingStore.getState().__reset(),
  };
}

// ==================== 选择器 hooks ====================
// 显示数据派生已迁移到 usePartsDerived.ts / useStreamSummary.ts (从 uiMessageStore.parts 派生)

/** 保留: 子 Agent 池订阅 (控制流字段) */
export const useAgentsByChatId = (chatId: string | null | undefined) =>
  useStreamingStore(useShallow((s) => (chatId ? s.agentsMap[chatId] ?? [] : [])));

/** 按 agentId 实时查询 agent 名字 — agent 改名后自动响应式更新 */
export const useAgentName = (chatId: string | null | undefined, agentId: string | null | undefined): string | undefined => {
  return useStreamingStore((s) => {
    if (!chatId || !agentId) return undefined;
    return s.agentsMap[chatId]?.find(a => a.id === agentId)?.name;
  });
};

/** 实时查询 agent 头像 — agent 改头像后自动响应式更新 */
export const useAgentAvatar = (chatId: string | null | undefined, agentId: string | null | undefined): string | undefined => {
  return useStreamingStore((s) => {
    if (!chatId || !agentId) return undefined;
    return s.agentsMap[chatId]?.find(a => a.id === agentId)?.avatar;
  });
};
