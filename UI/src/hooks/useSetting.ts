/**
 * useSetting — React 集成
 *
 * 三个 hook:
 * - useSetting<T>(key)           读单 key,订阅更新(精确到 key 级别)
 * - useSettings<T>(keys[])        批量读多个 key
 * - useSettingState()             拿整个 store(写操作用)
 *
 * 底层用 useSyncExternalStore(React 18+),完全无 tearing。
 * 订阅使用 subscribeKeys:只订阅关心的 key,不响应无关 key 的变化。
 */

import { useCallback, useSyncExternalStore } from 'react';
import { getDefaultStore, type SettingsStore } from '../state/settings';

function getStore(): SettingsStore {
  return getDefaultStore();
}

/**
 * 订阅单个 key 的值 — 只在该 key 变化时触发 re-render
 */
export function useSetting<T = unknown>(key: string): T | undefined {
  const store = getStore();
  const subscribe = useCallback(
    (onChange: () => void) => store.subscribeKeys([key], onChange),
    [store, key],
  );
  const getSnapshot = useCallback(() => store.get<T>(key), [store, key]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * 批量订阅多个 key — 任一 key 变化都触发 re-render,但精准过滤
 */
export function useSettings<T = unknown>(keys: string[]): Record<string, T | undefined> {
  const store = getStore();
  const subscribe = useCallback(
    (onChange: () => void) => store.subscribeKeys(keys, onChange),
    [store, keys.join('|')],
  );
  const keyList = keys.slice().sort().join('|');
  const getSnapshot = useCallback(
    () => store.getMany<T>(keyList.split('|').filter(Boolean)),
    [store, keyList],
  );
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * 拿到 store 实例本身(用于 set / remove / setMany / listUnsynced)
 */
export function useSettingState(): SettingsStore {
  return getStore();
}
