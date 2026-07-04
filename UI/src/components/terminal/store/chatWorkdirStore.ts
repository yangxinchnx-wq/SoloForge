/**
 * chatWorkdirStore — 每个会话 ↔ 工作目录 一对一 绑定
 *
 * 数据形态 (双索引):
 *   byChatId: chatId → entry                 // 主索引, O(1) 拿
 *   pathIndex: normalizedWorkdir → chatId[]  // 反向, 用于 "同路径多 chat 共享" 检测
 *
 * 持久化: zustand/persist → localStorage key 'soloforge_chat_workdirs'
 *   不持久化 sibling 缓存 (每次启动现场算即可)
 *
 * 同步: BroadcastChannel 'soloforge-editor-sync-channel' 复用已有的多窗口通道
 *   新增消息 type: 'WORKDIR_SWITCH' | 'WORKDIR_SET'
 */
import { create } from 'zustand';
import { persist, subscribeWithSelector } from 'zustand/middleware';
import type {
  ChatWorkdirEntry,
  ChatWorkdirPersisted,
  ResolveOrCreateOptions,
  SetWorkdirOptions,
  WorkdirSource,
} from '../types';
import {
  deriveDefaultWorkdir,
  ensureDirExists,
  normalizeForIndex,
  validateWorkdir,
} from '../service/chatWorkdirService';

const STORAGE_KEY = 'soloforge_chat_workdirs';
const WS_EVENT_SET = 'WORKDIR_SET';
const WS_EVENT_REMOVE = 'WORKDIR_REMOVE';

interface ChatWorkdirState extends ChatWorkdirPersisted {
  setWorkdir: (chatId: string, workdir: string, opts?: SetWorkdirOptions) => ChatWorkdirEntry;
  getWorkdir: (chatId: string) => ChatWorkdirEntry | undefined;
  /**
   * 智能取/建: 已有 → 返回; 目录被删 → 重建; 否则用派生规则新建
   * 这是 UI 层 / E2BService 的统一入口
   */
  resolveOrCreate: (chatId: string, opts?: ResolveOrCreateOptions) => ChatWorkdirEntry;
  remove: (chatId: string) => void;
  listByPath: (workdir: string) => string[];
  setWorkspaceRoot: (root: string) => void;
  /** 测试/外部注入用 */
  _hydrate: (p: Partial<ChatWorkdirPersisted>) => void;
}

function emptyState(): ChatWorkdirPersisted {
  return { byChatId: {}, pathIndex: {}, workspaceRoot: '' };
}

function addToPathIndex(idx: Record<string, string[]>, key: string, chatId: string): void {
  if (!idx[key]) idx[key] = [];
  if (!idx[key].includes(chatId)) idx[key].push(chatId);
}

function removeFromPathIndex(idx: Record<string, string[]>, key: string, chatId: string): void {
  if (!idx[key]) return;
  idx[key] = idx[key].filter(id => id !== chatId);
  if (idx[key].length === 0) delete idx[key];
}

function broadcast(type: string, payload: any): void {
  if (typeof window === 'undefined') return;
  try {
    const ch = new BroadcastChannel('soloforge-editor-sync-channel');
    ch.postMessage({ type, ...payload });
    ch.close();
  } catch {
    /* ignore */
  }
}

export const useChatWorkdirStore = create<ChatWorkdirState>()(
  subscribeWithSelector(
    persist(
      (set, get) => ({
        ...emptyState(),

        setWorkspaceRoot: (root) => {
          const v = validateWorkdir(root);
          if (!v.ok) {
            if (typeof console !== 'undefined') console.warn(`[workdir] invalid workspaceRoot: ${v.reason}`);
            return;
          }
          set({ workspaceRoot: root });
        },

        setWorkdir: (chatId, workdir, opts) => {
          const v = validateWorkdir(workdir);
          if (!v.ok) throw new Error(`[workdir] ${v.reason}`);
          const ensured = ensureDirExists(workdir);
          const key = normalizeForIndex(workdir);
          const entry: ChatWorkdirEntry = {
            chatId,
            workdir: ensured,
            source: opts?.source ?? 'manual',
            alias: opts?.alias,
            updatedAt: Date.now(),
          };

          set((state) => {
            const prev = state.byChatId[chatId];
            const byChatId = { ...state.byChatId, [chatId]: entry };
            const pathIndex = { ...state.pathIndex };
            if (prev) removeFromPathIndex(pathIndex, normalizeForIndex(prev.workdir), chatId);
            addToPathIndex(pathIndex, key, chatId);
            return { byChatId, pathIndex };
          });

          broadcast(WS_EVENT_SET, { chatId, workdir: ensured });
          return entry;
        },

        getWorkdir: (chatId) => {
          return get().byChatId[chatId];
        },

        resolveOrCreate: (chatId, opts) => {
          const state = get();
          const existing = state.byChatId[chatId];
          if (existing) {
            // 路径被外部删了 → 重建
            try {
              ensureDirExists(existing.workdir);
            } catch {
              // re-create under workspaceRoot
              const root = state.workspaceRoot || defaultWorkspaceRootSafe(state);
              const fresh = ensureDirExists(deriveDefaultWorkdir({
                chatId,
                workspaceRoot: root,
                siblings: Object.values(state.byChatId),
                inheritFromSibling: opts?.inheritFromSibling,
              }));
              const entry: ChatWorkdirEntry = {
                chatId,
                workdir: fresh,
                source: opts?.source ?? 'inherited',
                updatedAt: Date.now(),
              };
              const key = normalizeForIndex(fresh);
              set((s) => {
                const pathIndex = { ...s.pathIndex };
                if (s.byChatId[chatId]) removeFromPathIndex(pathIndex, normalizeForIndex(s.byChatId[chatId].workdir), chatId);
                addToPathIndex(pathIndex, key, chatId);
                return { byChatId: { ...s.byChatId, [chatId]: entry }, pathIndex };
              });
              broadcast(WS_EVENT_SET, { chatId, workdir: fresh });
              return entry;
            }
            // 触发现存条目的 updatedAt (LRU 排序友好)
            const touched: ChatWorkdirEntry = { ...existing, updatedAt: Date.now() };
            set((s) => ({ byChatId: { ...s.byChatId, [chatId]: touched } }));
            return touched;
          }

          // 全新 chat
          const root = state.workspaceRoot || defaultWorkspaceRootSafe(state);
          const candidate = ensureDirExists(deriveDefaultWorkdir({
            chatId,
            workspaceRoot: root,
            siblings: Object.values(state.byChatId),
            inheritFromSibling: opts?.inheritFromSibling,
          }));
          const entry: ChatWorkdirEntry = {
            chatId,
            workdir: candidate,
            source: opts?.source ?? 'auto',
            updatedAt: Date.now(),
          };
          const key = normalizeForIndex(candidate);
          set((s) => {
            const pathIndex = { ...s.pathIndex, [key]: [...(s.pathIndex[key] ?? []), chatId] };
            return { byChatId: { ...s.byChatId, [chatId]: entry }, pathIndex };
          });
          broadcast(WS_EVENT_SET, { chatId, workdir: candidate });
          return entry;
        },

        remove: (chatId) => {
          set((state) => {
            const prev = state.byChatId[chatId];
            if (!prev) return state;
            const byChatId = { ...state.byChatId };
            delete byChatId[chatId];
            const pathIndex = { ...state.pathIndex };
            removeFromPathIndex(pathIndex, normalizeForIndex(prev.workdir), chatId);
            return { byChatId, pathIndex };
          });
          broadcast(WS_EVENT_REMOVE, { chatId });
        },

        listByPath: (workdir) => {
          const key = normalizeForIndex(workdir);
          return get().pathIndex[key] ?? [];
        },

        _hydrate: (p) => set((s) => ({ ...s, ...p })),
      }),
      {
        name: STORAGE_KEY,
        version: 1,
        partialize: (state): ChatWorkdirPersisted => ({
          byChatId: state.byChatId,
          pathIndex: state.pathIndex,
          workspaceRoot: state.workspaceRoot,
        }),
        merge: (persisted, current) => {
          const p = (persisted ?? {}) as Partial<ChatWorkdirPersisted>;
          return {
            ...current,
            byChatId: p.byChatId ?? {},
            pathIndex: p.pathIndex ?? {},
            workspaceRoot: p.workspaceRoot ?? current.workspaceRoot,
          };
        },
      },
    ),
  ),
);

function defaultWorkspaceRootSafe(_state: ChatWorkdirState): string {
  if (typeof localStorage !== 'undefined') {
    const saved = localStorage.getItem('soloforge_workspaceRoot');
    if (saved) return saved;
  }
  // 浏览器端 no fs / no path — 用 ~ 表示
  return '~/SoloForge';
}

/**
 * 监听 BroadcastChannel 让多窗口工作目录同步
 * (在 main.tsx mount 时调用一次即可)
 */
export function installWorkdirSyncChannel(): () => void {
  if (typeof window === 'undefined') return () => {};
  let ch: BroadcastChannel | null = null;
  try {
    ch = new BroadcastChannel('soloforge-editor-sync-channel');
  } catch {
    return () => {};
  }
  const handler = (ev: MessageEvent) => {
    const msg = ev.data;
    if (!msg || !msg.type) return;
    if (msg.type === WS_EVENT_SET && msg.chatId && msg.workdir) {
      try {
        useChatWorkdirStore.getState().setWorkdir(msg.chatId, msg.workdir, { source: 'manual' });
      } catch {
        /* ignore (validate may fail in non-node env) */
      }
    } else if (msg.type === WS_EVENT_REMOVE && msg.chatId) {
      useChatWorkdirStore.getState().remove(msg.chatId);
    }
  };
  ch.addEventListener('message', handler);
  return () => {
    ch?.removeEventListener('message', handler);
    ch?.close();
  };
}
