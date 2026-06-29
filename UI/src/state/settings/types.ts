/**
 * Settings Store — 类型定义
 *
 * 架构原则:localStorage 是唯一真权威,server 是持久化备份
 * Store 通过 PersistAdapter 和 SyncAdapter 抽象底层,业务代码只接触 Store
 */

// ========== Adapter 接口 ==========

/**
 * 持久化适配器 — 抽象底层存储(localStorage / IndexedDB / Memory)
 * 所有方法必须同步(同步读 + 同步写,因为 UI 立即需要值)
 */
export interface PersistAdapter {
  /** 同步读所有 key-value */
  readAll(): Record<string, unknown>;
  /** 同步写单个 key */
  set(key: string, value: unknown): void;
  /** 同步删除 key */
  remove(key: string): void;
  /** 监听其他 source 写入(多 tab 同步) */
  onExternalChange(handler: (key: string, value: unknown) => void): () => void;
}

/**
 * 同步适配器 — 抽象网络层(fetch / WebSocket)
 * 所有方法异步
 */
export interface SyncAdapter {
  /** 异步 PUT 单个 key */
  put(key: string, value: unknown): Promise<void>;
  /** 异步 GET 所有 settings */
  getAll(): Promise<Record<string, unknown>>;
  /** 可选:DELETE 单个 key */
  remove?(key: string): Promise<void>;
}

// ========== Store 接口 ==========

export type SyncStatus = 'synced' | 'pending' | 'failed';

/**
 * SettingsStore — 业务代码使用的接口
 */
export interface SettingsStore {
  /**
   * 同步读一个 key
   * 不为 null,可能 undefined(未设置过)
   */
  get<T = unknown>(key: string): T | undefined;

  /**
   * 同步批量读
   */
  getMany<T = unknown>(keys: string[]): Record<string, T | undefined>;

  /**
   * 同步写一个 key
   * 内部按顺序:cache 更新 → persist 写 → 入 sync queue → notify
   */
  set(key: string, value: unknown): void;

  /**
   * 同步批量写
   */
  setMany(updates: Record<string, unknown>): void;

  /**
   * 同步删除
   */
  remove(key: string): void;

  /**
   * 订阅变化(用于 useSyncExternalStore)
   * 返回 unsubscribe 函数
   */
  subscribe(listener: () => void): () => void;

  /**
   * 精确订阅指定 key 的变化 — 只在这些 key 变化时通知
   * 远比 subscribe() 高效:不订阅无关 key 的变化
   */
  subscribeKeys(keys: string[], listener: () => void): () => void;

  /**
   * 查询同步状态
   */
  getSyncStatus(key: string): SyncStatus;

  /**
   * 列出所有 unsynced 的 keys(用于 UI 提示)
   */
  listUnsynced(): string[];

  /**
   * 立即同步 flush 所有 pending persist 写入 (退出前调用)
   */
  flushSync(): void;

  /**
   * 启动初始化 — 必须在使用前调一次
   * 1. 从 persist 读所有 → 填充 cache
   * 2. 用 ssrInit 填补缺失 key(不覆盖已有)
   * 3. 启动后台 sync worker
   */
  init(ssrInit?: Record<string, unknown>): void;

  /**
   * 关闭(测试用)
   */
  dispose(): void;
}

// ========== 创建选项 ==========

export interface StoreConfig {
  /** 持久化适配器(默认 LocalStorageAdapter) */
  persist: PersistAdapter;
  /** 同步适配器(可选,没有就不持久化到 server) */
  sync?: SyncAdapter;
  /** 启动时的 SSR 注入(可选) */
  ssrInit?: Record<string, unknown>;
  /** 失败重试次数(默认 3) */
  maxRetries?: number;
  /** 重试基础延迟(ms,默认 1000) */
  retryBaseDelay?: number;
}