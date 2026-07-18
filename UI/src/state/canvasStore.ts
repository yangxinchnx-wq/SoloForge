/**
 * canvasStore — 多画布会话标签状态管理
 *
 * 设计:
 * - 每个 tab = 一个 canvas session, 与 chatId 一一绑定
 * - activeTabId = 当前可见的 tab
 * - 切 tab = 切 activeTabId; 画布 process 调度由 PreviewPanel 负责
 * - LLM 工具可通过 enableCanvas(chatId) 启用 / 创建 tab
 *
 * 注意:
 * - 这里**只**存 UI 层元数据 (哪些 tab 存在、谁是 active、显示状态)
 * - 画布 process 状态 (running / paused / idle / error / port/pid) 由 PreviewPanel
 *   内部维护,因为它需要与 IPC 生命周期强绑定
 */

import { create } from 'zustand';

export type CanvasTabStatus = 'idle' | 'starting' | 'running' | 'paused' | 'error';

export interface CanvasTabMeta {
  id: string;        // sessionId (= "canvas-{chatId}")
  chatId: string;
  index: number;     // 序号,从 1 起,与对话序号一致
  hint?: string;     // 原始对话标题(tooltip)
  status: CanvasTabStatus;
}

interface CanvasStoreState {
  tabs: CanvasTabMeta[];
  activeTabId: string | null;
  nextIndex: number;  // 下一个新建 tab 的序号

  /** LLM 调用入口:启用或激活某 chat 的画布 tab */
  enableCanvas: (chatId: string, hint?: string) => string;
  /** 用户主动新建 tab */
  createTab: (chatId: string, hint?: string) => string;
  /** 关闭 tab */
  closeTab: (id: string) => void;
  /** 切换 active */
  selectTab: (id: string) => void;
  /** 更新 tab 状态 (从 PreviewPanel 反馈) */
  setStatus: (id: string, status: CanvasTabStatus) => void;
  /** 同步外部 chat 序号 (避免删除对话后序号错乱) */
  rebuildIndex: (orderedChatIds: string[]) => void;
}

export const useCanvasStore = create<CanvasStoreState>((set, get) => ({
  tabs: [],
  activeTabId: null,
  nextIndex: 1,

  enableCanvas: (chatId, hint) => {
    const sessionId = `canvas-${chatId}`;
    const existing = get().tabs.find((t) => t.id === sessionId);
    if (existing) {
      // 已存在 → 切到它
      set({ activeTabId: existing.id });
      return sessionId;
    }
    // 不存在 → 新建
    const newTab: CanvasTabMeta = {
      id: sessionId,
      chatId,
      index: get().nextIndex,
      hint,
      status: 'idle',
    };
    set((s) => ({
      tabs: [...s.tabs, newTab],
      activeTabId: newTab.id,
      nextIndex: s.nextIndex + 1,
    }));
    return sessionId;
  },

  createTab: (chatId, hint) => {
    const sessionId = `canvas-${chatId}`;
    const newTab: CanvasTabMeta = {
      id: sessionId,
      chatId,
      index: get().nextIndex,
      hint,
      status: 'idle',
    };
    set((s) => ({
      tabs: [...s.tabs, newTab],
      activeTabId: newTab.id,
      nextIndex: s.nextIndex + 1,
    }));
    return sessionId;
  },

  closeTab: (id) => {
    set((s) => {
      const idx = s.tabs.findIndex((t) => t.id === id);
      if (idx < 0) return s;
      const newTabs = s.tabs.filter((t) => t.id !== id);
      let newActive = s.activeTabId;
      if (s.activeTabId === id) {
        // 选邻居:优先下一个,否则上一个
        newActive = newTabs[idx]?.id ?? newTabs[idx - 1]?.id ?? null;
      }
      return { tabs: newTabs, activeTabId: newActive };
    });
  },

  selectTab: (id) => {
    if (get().tabs.some((t) => t.id === id)) {
      set({ activeTabId: id });
    }
  },

  setStatus: (id, status) => {
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === id ? { ...t, status } : t)),
    }));
  },

  rebuildIndex: (orderedChatIds) => {
    set((s) => {
      const chatIdToNewIndex = new Map(orderedChatIds.map((cid, i) => [cid, i + 1]));
      const newTabs = s.tabs
        .map((t) => {
          const newIdx = chatIdToNewIndex.get(t.chatId);
          return newIdx ? { ...t, index: newIdx } : null;
        })
        .filter((t): t is CanvasTabMeta => t !== null)
        .sort((a, b) => a.index - b.index);
      return { tabs: newTabs, nextIndex: newTabs.length + 1 };
    });
  },
}));

// 暴露到 window 供 LLM 工具调用 (后续可在 tool 注册处直接 import)
if (typeof window !== 'undefined') {
  (window as any).__canvasStore = useCanvasStore;
  // LLM 工具可调用的简洁入口(返回 sessionId)
  (window as any).__enableCanvas = (chatId: string, hint?: string): string => {
    return useCanvasStore.getState().enableCanvas(chatId, hint);
  };
}

// ── HMR 边界:改 store 代码时热替换 store 实例,不触发 full page reload ──
// React 组件树保持挂载,tabs/activeTabId 会重置为初始空值 (后端权威数据,重新 enableCanvas 即可恢复)。
if (import.meta.hot) {
  import.meta.hot.accept((m) => {
    if (m) useCanvasStore.setState(m.useCanvasStore.getState(), true);
  });
}
