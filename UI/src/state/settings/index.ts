/**
 * Settings Module — 统一出口
 *
 * 用法:
 *   import { useSetting, useSettingState } from '@/hooks/useSetting';
 *   import { getDefaultStore, createSettingsStore } from '@/state/settings';
 *
 * 业务代码优先用 hook(useSetting),不要直接 import store
 */

// ===== 类型 =====
export type {
  PersistAdapter,
  SyncAdapter,
  SyncStatus,
  SettingsStore,
  StoreConfig,
} from './types';

// ===== Factory + Singleton =====
export { createSettingsStore, getDefaultStore, resetDefaultStore } from './store';

// ===== 默认 Adapter =====
export { LocalStoragePersist } from './adapters/localStorage';
export { FetchSync } from './adapters/fetch';
export { ElectronStorePersist } from './adapters/electronStore';

// ===== 测试 Adapter =====
export { MemoryPersist, MemorySync } from './adapters/memory';
