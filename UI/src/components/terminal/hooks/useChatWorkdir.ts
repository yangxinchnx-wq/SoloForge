/**
 * useChatWorkdir — 订阅当前 chat 的 workdir + 自动 resolveOrCreate
 *
 * 用法:
 *   const { workdir, setWorkdir, isReady } = useChatWorkdir(activeChatId);
 *
 * 行为:
 *   - chatId 变化 → 立即 resolveOrCreate (新 chat 自动派生, 旧 chat 复用)
 *   - workdir 更新 → 组件 re-render (selector 订阅 byChatId[chatId])
 *   - setWorkdir 输入新路径 → 调用 store (含 mkdir + 校验 + 反向索引 + broadcast)
 */
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { useChatWorkdirStore } from '../store/chatWorkdirStore';
import type { ChatWorkdirEntry } from '../types';

const noopEntry: ChatWorkdirEntry = {
  chatId: '',
  workdir: '',
  source: 'auto',
  updatedAt: 0,
};

export function useChatWorkdir(chatId: string | null | undefined): {
  chatId: string;
  workdir: string;
  entry: ChatWorkdirEntry;
  isReady: boolean;
  setWorkdir: (workdir: string, opts?: { source?: 'auto' | 'manual' | 'inherited'; alias?: string }) => ChatWorkdirEntry;
  listByPath: (workdir: string) => string[];
} {
  const resolvedId = chatId ?? '';

  // 副作用: chatId 变化 → resolveOrCreate (确保 pathIndex + 磁盘目录都已就绪)
  useEffect(() => {
    if (!resolvedId) return;
    try {
      useChatWorkdirStore.getState().resolveOrCreate(resolvedId);
    } catch (err) {
      if (typeof console !== 'undefined') console.warn('[useChatWorkdir] resolveOrCreate failed:', err);
    }
  }, [resolvedId]);

  // 用 useSyncExternalStore 订阅 store, 只在当前 chat 的 entry 变化时 re-render
  const subscribe = useMemo(
    () => (cb: () => void) =>
      useChatWorkdirStore.subscribe(
        (s) => ({ entry: s.byChatId[resolvedId] }),
        () => cb(),
        { equalityFn: shallowEq, fireImmediately: false },
      ),
    [resolvedId],
  );
  const getSnap = () => useChatWorkdirStore.getState().byChatId[resolvedId] ?? noopEntry;
  const entry = useSyncExternalStore(subscribe, getSnap, getSnap) as ChatWorkdirEntry;

  return {
    chatId: resolvedId,
    workdir: entry.workdir,
    entry,
    isReady: Boolean(entry.workdir),
    setWorkdir: (workdir, opts) => useChatWorkdirStore.getState().setWorkdir(resolvedId, workdir, opts),
    listByPath: (workdir: string) => useChatWorkdirStore.getState().listByPath(workdir),
  };
}

function shallowEq<T extends object>(a: T, b: T): boolean {
  if (a === b) return true;
  const ka = Object.keys(a) as (keyof T)[];
  const kb = Object.keys(b) as (keyof T)[];
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (a[k] !== (b as any)[k]) return false;
  return true;
}
