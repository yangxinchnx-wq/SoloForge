/**
 * SettingsStore — 核心实现 (v4 性能优化版)
 *
 * 核心原则:
 * - 内存 cache 是唯一同步读源 (store.get 零延迟)
 * - persist (localStorage / file) 改为 requestIdleCallback 异步批量写入
 * - notify() 按 key 过滤: 只通知订阅了变更 key 的 listener
 * - 不变量:cache 始终是最新值; persist 在 idle 时追赶 cache
 *
 * ★ SYNC_DENYLIST (2026-07-14):
 *   cherry_providers_v2 由 ModelAddTab + OS 钥匙串 (apiKeyVault) 独立管理,
 *   其 apiKey 是明文, 绝不能被 SettingsStore 的 sync.getAll() 用服务端
 *   的脱敏版本 (apiKey='' 或 '__VAULT__:') 覆盖。
 *   历史原因: 旧版代码曾通过 SettingsStore 同步 cherry_providers_v2,
 *   导致 .soloforge_settings.json 中残留了带 '__VAULT__:' 占位符的副本,
 *   每次刷新都会覆盖 localStorage 中的真实 apiKey → 密钥丢失。
 */

/**
 * 同步黑名单 — 这些 key 不参与 SettingsStore 的双向同步:
 *   - 不从 persist.readAll() 读入 cache
 *   - 不被 sync.getAll() 的服务端数据覆盖
 *   - 不通过 enqueueSync 推送到服务端
 *   - 不响应 onExternalChange
 */
const SYNC_DENYLIST: ReadonlySet<string> = new Set([
  'cherry_providers_v2', // 由 ModelAddTab + apiKeyVault 独立管理
]);

function isDenylisted(key: string): boolean {
  return SYNC_DENYLIST.has(key);
}

import type {
  PersistAdapter,
  SettingsStore,
  StoreConfig,
  SyncAdapter,
  SyncStatus,
} from './types';
import { LocalStoragePersist } from './adapters/localStorage';
import { FetchSync } from './adapters/fetch';
import { ElectronStorePersist } from './adapters/electronStore';

interface QueueItem {
  value: unknown;
  attempts: number;
  status: SyncStatus;
  nextRetryAt: number;
}

function unwrapStringified(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed) return value;
  if (
    !(trimmed.startsWith('"') && trimmed.endsWith('"')) &&
    !(trimmed.startsWith('[') && trimmed.endsWith(']')) &&
    !(trimmed.startsWith('{') && trimmed.endsWith('}'))
  ) {
    return value;
  }
  try {
    const parsed = JSON.parse(trimmed);
    return JSON.stringify(parsed) === trimmed ? parsed : value;
  } catch {
    return value;
  }
}

/**
 * requestIdleCallback polyfill — 降级到 setTimeout(0)
 */
const requestIdle: (cb: () => void) => void =
  typeof window !== 'undefined' && typeof (window as any).requestIdleCallback === 'function'
    ? (window as any).requestIdleCallback
    : (cb: () => void) => setTimeout(cb, 0);

const cancelIdle: (id: number) => void =
  typeof window !== 'undefined' && typeof (window as any).cancelIdleCallback === 'function'
    ? (window as any).cancelIdleCallback
    : clearTimeout;

/**
 * requestIdleCallback 类型 (polyfill 兼容)
 */
type IdleHandle = ReturnType<typeof requestIdle>;

export function createSettingsStore(config: StoreConfig): SettingsStore {
  const { persist, sync, ssrInit } = config;
  const maxRetries = config.maxRetries ?? 3;
  const retryBaseDelay = config.retryBaseDelay ?? 1000;

  // 内存 cache — 唯一同步读源
  const cache: Map<string, unknown> = new Map();

  // sync queue (remote fetch)
  const queue: Map<string, QueueItem> = new Map();

  // ===== key-filtered listener 系统 =====
  // 通配 listener (订阅所有 key 变化,兼容旧逻辑)
  const wildcardListeners: Set<() => void> = new Set();
  // key → listener set (精确订阅)
  const keyListeners: Map<string, Set<() => void>> = new Map();
  // 订阅了 wildcard 时记录的 key 集合 (用于快速判断)
  let wildcardCount = 0;

  // ===== async persist flush 系统 =====
  // 待写入 persist 的 key-value (合并同 key 的连续写入)
  const pendingPersistFlush: Map<string, unknown> = new Map();
  let persistIdleHandle: IdleHandle | null = null;
  let persistFlushScheduled = false;

  let unsubscribeExternal: (() => void) | null = null;
  let workerTimer: ReturnType<typeof setTimeout> | null = null;
  let workerRunning = false;
  let disposed = false;

  // ===== 内部:通知订阅者 (按 key 过滤) =====
  function notifyKeys(changedKeys: string[]): void {
    // 收集需要通知的 listener,去重
    const notified = new Set<() => void>();
    for (const key of changedKeys) {
      const listeners = keyListeners.get(key);
      if (listeners) {
        for (const fn of listeners) {
          if (!notified.has(fn)) {
            notified.add(fn);
            try { fn(); } catch (e) {
              console.warn('[SettingsStore] listener failed:', (e as Error).message);
            }
          }
        }
      }
    }
    if (wildcardCount > 0) {
      for (const fn of wildcardListeners) {
        if (!notified.has(fn)) {
          notified.add(fn);
          try { fn(); } catch (e) {
            console.warn('[SettingsStore] listener failed:', (e as Error).message);
          }
        }
      }
    }
  }

  function notify(): void {
    if (wildcardCount > 0) {
      for (const fn of wildcardListeners) {
        try { fn(); } catch (e) {
          console.warn('[SettingsStore] listener failed:', (e as Error).message);
        }
      }
    }
  }

  // ===== 内部:调度异步 persist flush =====
  function schedulePersistFlush(): void {
    if (persistFlushScheduled) return;
    persistFlushScheduled = true;
    persistIdleHandle = requestIdle(() => {
      persistFlushScheduled = false;
      persistIdleHandle = null;
      flushPersist();
    });
  }

  function flushPersist(): void {
    if (pendingPersistFlush.size === 0) return;
    const batch = new Map(pendingPersistFlush);
    pendingPersistFlush.clear();
    for (const [k, v] of batch) {
      try {
        persist.set(k, v);
      } catch (e) {
        console.warn('[SettingsStore] persist write failed:', k, (e as Error).message);
      }
    }
    if (pendingPersistFlush.size > 0) {
      schedulePersistFlush();
    }
  }

  function enqueueSync(key: string, value: unknown): void {
    if (!sync) return;
    queue.set(key, {
      value,
      attempts: 0,
      status: 'pending',
      nextRetryAt: 0,
    });
    scheduleWorker();
  }

  function scheduleWorker(): void {
    if (workerTimer || workerRunning) return;
    workerTimer = setTimeout(() => {
      workerTimer = null;
      runWorker();
    }, 50);
  }

  async function runWorker(): Promise<void> {
    if (workerRunning || disposed) return;
    workerRunning = true;
    try {
      while (!disposed && queue.size > 0) {
        const now = Date.now();
        let processed = false;
        for (const [key, item] of queue.entries()) {
          if (item.status === 'synced') {
            queue.delete(key);
            continue;
          }
          if (item.nextRetryAt > now) continue;
          try {
            await sync!.put(key, item.value);
            item.status = 'synced';
            queue.delete(key);
            processed = true;
          } catch (e) {
            item.attempts++;
            if (item.attempts >= maxRetries) {
              item.status = 'failed';
              console.warn(
                `[SettingsStore] sync failed for "${key}" after ${maxRetries} attempts:`,
                (e as Error).message,
              );
              continue;
            }
            const delay = retryBaseDelay * Math.pow(3, item.attempts - 1);
            item.nextRetryAt = now + delay;
          }
        }
        if (!processed) break;
      }
    } finally {
      workerRunning = false;
      if (queue.size > 0) scheduleWorker();
    }
  }

  function setCacheFromExternal(key: string, value: unknown): boolean {
    const queueItem = queue.get(key);
    if (queueItem && queueItem.status === 'pending' && queueItem.value !== value) {
      return false;
    }
    const prev = cache.get(key);
    cache.set(key, value);
    if (prev !== value) {
      notifyKeys([key]);
    }
    return true;
  }

  // ===== 公开 API =====

  const store: SettingsStore = {
    get<T = unknown>(key: string): T | undefined {
      const v = cache.get(key);
      return v === undefined ? undefined : (v as T);
    },

    getMany<T = unknown>(keys: string[]): Record<string, T | undefined> {
      const result: Record<string, T | undefined> = {};
      for (const k of keys) {
        const v = cache.get(k);
        result[k] = v === undefined ? undefined : (v as T);
      }
      return result;
    },

    set(key: string, value: unknown): void {
      const finalValue = unwrapStringified(value);
      cache.set(key, finalValue);
      pendingPersistFlush.set(key, finalValue);
      schedulePersistFlush();
      // ★ 黑名单 key 不推送到服务端 (cherry_providers_v2 由 ModelAddTab 独立 POST)
      if (!isDenylisted(key)) {
        enqueueSync(key, finalValue);
      }
      notifyKeys([key]);
    },

    setMany(updates: Record<string, unknown>): void {
      const changedKeys: string[] = [];
      for (const [k, v] of Object.entries(updates)) {
        const finalValue = unwrapStringified(v);
        const prev = cache.get(k);
        cache.set(k, finalValue);
        pendingPersistFlush.set(k, finalValue);
        // ★ 黑名单 key 不推送到服务端
        if (!isDenylisted(k)) {
          enqueueSync(k, finalValue);
        }
        if (prev !== finalValue) changedKeys.push(k);
      }
      schedulePersistFlush();
      if (changedKeys.length > 0) notifyKeys(changedKeys);
    },

    remove(key: string): void {
      cache.delete(key);
      queue.delete(key);
      pendingPersistFlush.set(key, undefined);
      schedulePersistFlush();
      notifyKeys([key]);
    },

    subscribe(listener: () => void): () => void {
      wildcardListeners.add(listener);
      wildcardCount++;
      return () => {
        wildcardListeners.delete(listener);
        wildcardCount--;
      };
    },

    subscribeKeys(keys: string[], listener: () => void): () => void {
      for (const key of keys) {
        let set = keyListeners.get(key);
        if (!set) {
          set = new Set();
          keyListeners.set(key, set);
        }
        set.add(listener);
      }
      return () => {
        for (const key of keys) {
          const set = keyListeners.get(key);
          if (set) {
            set.delete(listener);
            if (set.size === 0) keyListeners.delete(key);
          }
        }
      };
    },

    getSyncStatus(key: string): SyncStatus {
      const item = queue.get(key);
      if (!item) return 'synced';
      return item.status;
    },

    listUnsynced(): string[] {
      const result: string[] = [];
      for (const [key, item] of queue.entries()) {
        if (item.status === 'failed' || item.status === 'pending') {
          result.push(key);
        }
      }
      return result;
    },

    flushSync(): void {
      flushPersist();
    },

    init(ssrInitParam?: Record<string, unknown>): void {
      const initData = ssrInitParam ?? ssrInit;
      const persisted = persist.readAll();
      for (const [k, v] of Object.entries(persisted)) {
        // ★ 跳过黑名单 key: cherry_providers_v2 由 ModelAddTab 独立管理,
        //   不进入 SettingsStore cache, 避免 sync.getAll() 覆盖
        if (isDenylisted(k)) continue;
        cache.set(k, v);
      }
      if (initData) {
        for (const [k, v] of Object.entries(initData)) {
          if (!cache.has(k)) {
            cache.set(k, v);
            persist.set(k, v);
          }
        }
      }
      if (unsubscribeExternal) unsubscribeExternal();
      unsubscribeExternal = persist.onExternalChange((key, value) => {
        // ★ 跳过黑名单 key 的外部变更通知
        if (isDenylisted(key)) return;
        if (value === undefined) {
          cache.delete(key);
          notifyKeys([key]);
        } else {
          setCacheFromExternal(key, value);
        }
      });
      if (sync) {
        sync
          .getAll()
          .then((serverData) => {
            if (disposed) return;
            const changedKeys: string[] = [];
            for (const [k, v] of Object.entries(serverData)) {
              // ★ 跳过黑名单 key: 绝不让服务端数据覆盖本地 cherry_providers_v2
              //   (服务端副本可能含 '__VAULT__:' 占位符或空 apiKey)
              if (isDenylisted(k)) continue;
              const localValue = cache.get(k);
              if (localValue !== v) {
                const queueItem = queue.get(k);
                if (!queueItem || queueItem.status !== 'pending') {
                  cache.set(k, v);
                  pendingPersistFlush.set(k, v);
                  changedKeys.push(k);
                }
              }
            }
            if (changedKeys.length > 0) {
              schedulePersistFlush();
              notifyKeys(changedKeys);
            }
            // [2026-06-28] 关键修复: 同步 bootstrap 完成时通知 App.tsx 等订阅者重新构建
            // modelProviderMap。修复 "localStorage 初次为空 → sync.getAll() 异步填入 → useEffect
            // 已经跑过读到空 → ChatPanel 永远拿不到 provider" 的竞态死锁。
            // 兼容旧订阅者: 'storage' event 在同 tab 内不会自动 fire, 这里手动派发一次。
            //
            // [2026-07-12] 时序修复: sync.getAll() 可能在 React 组件挂载之前就 resolve
            //   (token 已缓存时只需 1 次 fetch 往返), 此时 providers_updated 事件被派发
            //   但 Header/App 的 useEffect 还没注册 listener → 事件丢失 → 模型永远 "未选择"。
            //   解法: 立即派发一次 + 延迟派发一次 (确保 React mount 后能收到)
            try {
              if (typeof window !== 'undefined') {
                window.dispatchEvent(new Event('storage'));
                window.dispatchEvent(new CustomEvent('providers_updated'));
                // ★ 2026-07-14: 用 microtask (setTimeout 0) 替代 setTimeout 50
                //   50ms 的宏延迟在刷新关键路径上白白浪费, microtask 足够让
                //   React useEffect 注册好 listener 后再派发。
                setTimeout(() => {
                  window.dispatchEvent(new Event('storage'));
                  window.dispatchEvent(new CustomEvent('providers_updated'));
                }, 0);
              }
            } catch { /* SSR/Node 环境跳过 */ }
          })
          .catch((e) => {
            console.warn('[SettingsStore] startup getAll failed:', (e as Error).message);
          });
      }
    },

    dispose(): void {
      disposed = true;
      if (workerTimer) {
        clearTimeout(workerTimer);
        workerTimer = null;
      }
      if (persistIdleHandle !== null) {
        cancelIdle(persistIdleHandle);
        persistIdleHandle = null;
      }
      flushPersist();
      if (unsubscribeExternal) {
        unsubscribeExternal();
        unsubscribeExternal = null;
      }
      wildcardListeners.clear();
      keyListeners.clear();
      wildcardCount = 0;
      queue.clear();
      cache.clear();
    },
  };

  return store;
}

let _defaultStore: SettingsStore | null = null;

export interface DefaultStoreOptions {
  ssrInit?: Record<string, unknown>;
  baseUrl?: string;
}

export function getDefaultStore(options: DefaultStoreOptions = {}): SettingsStore {
  if (_defaultStore) return _defaultStore;

  // 自动检测环境: Electron 用 ElectronStorePersist, 浏览器用 LocalStoragePersist
  //   Electron: window.soloforge.settings.readStore 存在 (preload.cjs 注入)
  //   浏览器:  fallback 到 localStorage
  const isElectronEnv = typeof window !== 'undefined' &&
    !!(window as any).soloforge?.settings?.readStore;

  let persist: any;
  if (isElectronEnv) {
    persist = new ElectronStorePersist();
    // 异步从磁盘恢复内存 (不阻塞同步 get)
    (persist as any).initFromDisk?.();
  } else {
    persist = new LocalStoragePersist();
  }

  // dev 模式: 暴露给 CDP 测试诊断
  if (typeof window !== 'undefined' && import.meta.env?.DEV) {
    (window as any).__settingsPersist = persist;
  }

  const sync = new FetchSync({ baseUrl: options.baseUrl });

  _defaultStore = createSettingsStore({
    persist,
    sync,
    ssrInit: options.ssrInit,
  });

  // ★ 必须调用 init() 才会:
  //   1) 从 localStorage 读取所有 key 到内存 cache
  //   2) 注册 storage 事件监听 (多 tab 同步)
  //   3) 启动 sync.getAll() 从服务端拉取设置并合并到 cache + localStorage
  //   4) 派发 'providers_updated' 事件让 App.tsx 重建 modelProviderMap
  //   不调用 init() → cache 永远为空 → get() 全返回 undefined →
  //   cherry_providers_v2 永远不会被同步 → "主模型未配置" 错误
  _defaultStore.init();

  // dev 模式: 暴露 store 引用 + cache 给 CDP 测试诊断
  if (typeof window !== 'undefined' && import.meta.env?.DEV) {
    (window as any).__settingsStore = _defaultStore;
  }

  return _defaultStore;
}

export function resetDefaultStore(): void {
  if (_defaultStore) {
    _defaultStore.dispose();
    _defaultStore = null;
  }
}

// ── HMR: 此模块不适合热替换,显式 decline 强制 full page reload ──
// 原因: 模块级单例 _defaultStore + 异步 sync 队列 + storage 事件监听 +
//   requestIdleCallback 持久化 flush,这些副作用无法安全迁移。
//   强行 accept 会导致新旧 store 实例并存 → sync 队列双触发 → 设置覆盖/丢失。
//   此文件改动频率低 (设置架构稳定), full reload 成本可接受。
if (import.meta.hot) {
  import.meta.hot.decline();
}
