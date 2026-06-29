/**
 * chatsStore — 历史会话列表单一数据源
 *
 * 设计要点：
 * - 后端权威 (.soloforge/chats.json) + 内存镜像，前端只负责渲染与乐观更新
 * - 所有写操作乐观更新本地状态，后台同步到 /api/chats/*；失败时回滚
 * - liveStates 实时反映 LLM 流式状态 (生成中 / phase / token)
 * - 不订阅 ThemeContext (主题切换不重渲染)
 * - 不持久化到 localStorage (统一走后端，避免多端分裂)
 */
import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';

export type ChatTag = 'VUE' | 'AUTH' | 'AI' | 'DB' | 'PAY' | 'HELP' | 'NEW' | 'WINDOWS' | 'HARMONY';
export type ChatPermission = 'normal' | 'performance' | 'ultimate' | 'expert';

export interface ChatItem {
  id: string;
  title: string;
  tag: ChatTag;
  tagBg: string;
  tagText: string;
  permission: ChatPermission;
  createdAt: number;
  updatedAt: number;
  time?: string;
  lastMessagePreview?: string;
}

export interface ChatLiveState {
  chatId: string;
  isStreaming: boolean;
  phase?: string;
  progress?: number;
  modelName?: string;
  tokens?: number;
  lastActivityAt: number;
}

export const TAG_STYLES: Record<ChatTag, { bg: string; text: string }> = {
  VUE:     { bg: 'bg-blue-500/10 border-blue-500/20',       text: 'text-blue-400' },
  AUTH:    { bg: 'bg-emerald-500/10 border-emerald-500/20', text: 'text-emerald-400' },
  AI:      { bg: 'bg-purple-500/10 border-purple-500/20',   text: 'text-purple-400' },
  DB:      { bg: 'bg-yellow-500/10 border-yellow-500/20',   text: 'text-yellow-400' },
  PAY:     { bg: 'bg-indigo-500/10 border-indigo-500/20',   text: 'text-indigo-400' },
  HELP:    { bg: 'bg-pink-500/10 border-pink-500/20',       text: 'text-pink-400' },
  NEW:     { bg: 'bg-amber-500/10 border-amber-500/20',     text: 'text-amber-400' },
  WINDOWS: { bg: 'bg-sky-500/10 border-sky-500/20',         text: 'text-sky-400' },
  HARMONY: { bg: 'bg-red-500/10 border-red-500/20',         text: 'text-red-400' },
};

interface ChatsState {
  chats: ChatItem[];
  selectedChatId: string | null;
  liveStates: Record<string, ChatLiveState>;
  loading: boolean;
  backendAvailable: boolean;
  lastSyncedAt: number;
  pendingMutations: number;

  // ===== 数据加载 / 同步 =====
  loadFromBackend: () => Promise<void>;
  refresh: () => Promise<void>;

  // ===== 写操作 (乐观更新 + 后端同步) =====
  createChat: (title?: string, permission?: ChatPermission) => Promise<ChatItem | null>;
  updateChat: (id: string, patch: Partial<Pick<ChatItem, 'title' | 'tag' | 'permission' | 'lastMessagePreview'>>) => Promise<void>;
  deleteChat: (id: string) => Promise<void>;
  reorderChats: (orderedIds: string[]) => Promise<void>;
  selectChat: (id: string | null) => Promise<void>;

  // ===== 实时流式状态 (供 ChatPanel 上报) =====
  setLiveState: (state: ChatLiveState) => void;
  clearLiveState: (chatId: string) => void;

  // ===== 工具方法 =====
  getChat: (id: string | null | undefined) => ChatItem | undefined;
  getPermission: (id: string | null | undefined) => ChatPermission;
}

const API_BASE = '';

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const resp = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  const text = await resp.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { success: false, error: 'invalid_json' }; }
  if (!resp.ok || (data && data.success === false)) {
    throw new Error(data?.error || `HTTP ${resp.status}`);
  }
  return data as T;
}

export const useChatsStore = create<ChatsState>()(subscribeWithSelector((set, get) => ({
  chats: [],
  selectedChatId: null,
  liveStates: {},
  loading: false,
  backendAvailable: true,
  lastSyncedAt: 0,
  pendingMutations: 0,

  loadFromBackend: async () => {
    if (get().loading) return;
    set({ loading: true });
    try {
      const data = await apiFetch<{
        success: boolean;
        chats: ChatItem[];
        selectedId: string | null;
        liveStates: Record<string, ChatLiveState>;
      }>('/api/chats/list');
      set({
        chats: Array.isArray(data.chats) ? data.chats : [],
        selectedChatId: data.selectedId ?? null,
        liveStates: data.liveStates && typeof data.liveStates === 'object' ? data.liveStates : {},
        loading: false,
        backendAvailable: true,
        lastSyncedAt: Date.now(),
      });
    } catch (e) {
      console.warn('[chatsStore] 后端加载失败，标记为不可达:', (e as Error).message);
      set({ loading: false, backendAvailable: false });
    }
  },

  refresh: async () => {
    await get().loadFromBackend();
  },

  createChat: async (title, permission = 'normal') => {
    const tempId = `temp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const optimistic: ChatItem = {
      id: tempId,
      title: title || '新对话',
      tag: 'NEW',
      tagBg: TAG_STYLES.NEW.bg,
      tagText: TAG_STYLES.NEW.text,
      permission,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    };
    set((s) => ({
      chats: [optimistic, ...s.chats],
      selectedChatId: tempId,
      pendingMutations: s.pendingMutations + 1,
    }));
    try {
      const data = await apiFetch<{ success: boolean; chat: ChatItem; selectedId: string }>(
        '/api/chats',
        { method: 'POST', body: JSON.stringify({ title: optimistic.title, permission }) }
      );
      set((s) => ({
        chats: s.chats.map((c) => (c.id === tempId ? data.chat : c)),
        selectedChatId: data.selectedId,
        pendingMutations: Math.max(0, s.pendingMutations - 1),
      }));
      return data.chat;
    } catch (e) {
      console.error('[chatsStore] 创建失败，回滚:', (e as Error).message);
      set((s) => ({
        chats: s.chats.filter((c) => c.id !== tempId),
        selectedChatId: s.chats.find((c) => c.id !== tempId)?.id ?? null,
        pendingMutations: Math.max(0, s.pendingMutations - 1),
        backendAvailable: false,
      }));
      return null;
    }
  },

  updateChat: async (id, patch) => {
    const before = get().chats.find((c) => c.id === id);
    if (!before) return;
    const after: ChatItem = {
      ...before,
      ...patch,
      updatedAt: Date.now(),
    };
    if (patch.tag && patch.tag in TAG_STYLES) {
      after.tagBg = TAG_STYLES[patch.tag].bg;
      after.tagText = TAG_STYLES[patch.tag].text;
    }
    set((s) => ({
      chats: s.chats.map((c) => (c.id === id ? after : c)),
      pendingMutations: s.pendingMutations + 1,
    }));
    try {
      await apiFetch(`/api/chats/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      });
      set((s) => ({ pendingMutations: Math.max(0, s.pendingMutations - 1) }));
    } catch (e) {
      console.error('[chatsStore] 更新失败，回滚:', (e as Error).message);
      set((s) => ({
        chats: s.chats.map((c) => (c.id === id ? before : c)),
        pendingMutations: Math.max(0, s.pendingMutations - 1),
        backendAvailable: false,
      }));
    }
  },

  deleteChat: async (id) => {
    const before = get().chats;
    const removed = before.find((c) => c.id === id);
    if (!removed) return;
    const next = before.filter((c) => c.id !== id);
    const nextSelected = get().selectedChatId === id
      ? (next[0]?.id ?? null)
      : get().selectedChatId;
    set({
      chats: next,
      selectedChatId: nextSelected,
      liveStates: Object.fromEntries(Object.entries(get().liveStates).filter(([k]) => k !== id)),
      pendingMutations: get().pendingMutations + 1,
    });
    try {
      const data = await apiFetch<{ success: boolean; selectedId: string | null }>(
        `/api/chats/${encodeURIComponent(id)}`,
        { method: 'DELETE' }
      );
      set((s) => ({
        selectedChatId: data.selectedId ?? s.selectedChatId,
        pendingMutations: Math.max(0, s.pendingMutations - 1),
      }));
    } catch (e) {
      console.error('[chatsStore] 删除失败，回滚:', (e as Error).message);
      set((s) => ({
        chats: before,
        selectedChatId: s.selectedChatId === nextSelected ? id : s.selectedChatId,
        pendingMutations: Math.max(0, s.pendingMutations - 1),
        backendAvailable: false,
      }));
    }
  },

  reorderChats: async (orderedIds) => {
    const before = get().chats;
    const byId = new Map(before.map((c) => [c.id, c] as const));
    const next: ChatItem[] = [];
    const seen = new Set<string>();
    for (const id of orderedIds) {
      const c = byId.get(id);
      if (c && !seen.has(id)) { next.push(c); seen.add(id); }
    }
    for (const c of before) {
      if (!seen.has(c.id)) next.push(c);
    }
    if (next.length === before.length && next.every((c, i) => c.id === before[i].id)) {
      return;
    }
    set({ chats: next, pendingMutations: get().pendingMutations + 1 });
    try {
      await apiFetch('/api/chats/reorder', {
        method: 'POST',
        body: JSON.stringify({ order: orderedIds }),
      });
      set((s) => ({ pendingMutations: Math.max(0, s.pendingMutations - 1) }));
    } catch (e) {
      console.error('[chatsStore] 重排失败，回滚:', (e as Error).message);
      set({ chats: before, pendingMutations: Math.max(0, get().pendingMutations - 1), backendAvailable: false });
    }
  },

  selectChat: async (id) => {
    const before = get().selectedChatId;
    set({ selectedChatId: id });
    try {
      await apiFetch('/api/chats/select', {
        method: 'POST',
        body: JSON.stringify({ id }),
      });
    } catch (e) {
      console.warn('[chatsStore] select 上报失败 (本地状态已生效):', (e as Error).message);
      set({ backendAvailable: false });
      // 本地状态不回滚 — 选中态是纯前端选择
      void before;
    }
  },

  setLiveState: (state) => {
    set((s) => ({ liveStates: { ...s.liveStates, [state.chatId]: state } }));
    if (!get().backendAvailable) return;
    fetch(`${API_BASE}/api/chats/${encodeURIComponent(state.chatId)}/state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(state),
    }).catch(() => { /* 上报失败不重试，下次会再触发 */ });
  },

  clearLiveState: (chatId) => {
    set((s) => {
      if (!s.liveStates[chatId]) return s;
      const next = { ...s.liveStates };
      delete next[chatId];
      return { liveStates: next };
    });
    if (!get().backendAvailable) return;
    fetch(`${API_BASE}/api/chats/${encodeURIComponent(chatId)}/state`, {
      method: 'DELETE',
    }).catch(() => {});
  },

  getChat: (id) => (id ? get().chats.find((c) => c.id === id) : undefined),
  getPermission: (id) => get().chats.find((c) => c.id === id)?.permission ?? 'normal',
})));

/**
 * 事件桥：让旧的 soloforge-chats-updated 监听者仍能工作
 * (ChatPanel / AgentSettingsModal 等仍订阅此事件做跨组件同步)
 */
let bridgeInitialized = false;
export function initChatsEventBridge(): void {
  if (bridgeInitialized || typeof window === 'undefined') return;
  bridgeInitialized = true;
  let prevChats = useChatsStore.getState().chats;
  let prevSelected = useChatsStore.getState().selectedChatId;
  useChatsStore.subscribe(
    (s) => ({ chats: s.chats, selectedChatId: s.selectedChatId }),
    (curr) => {
      const chatsChanged = curr.chats !== prevChats;
      const selectedChanged = curr.selectedChatId !== prevSelected;
      prevChats = curr.chats;
      prevSelected = curr.selectedChatId;
      if (chatsChanged) {
        window.dispatchEvent(new CustomEvent('soloforge-chats-updated', { detail: { chats: curr.chats } }));
      }
      if (selectedChanged) {
        window.dispatchEvent(new CustomEvent('soloforge-selected-chat-changed', { detail: { id: curr.selectedChatId } }));
      }
    },
    {
      equalityFn: (a, b) => a.chats === b.chats && a.selectedChatId === b.selectedChatId,
    }
  );
}