/**
 * streamPersistence — 流送状态持久化与恢复
 *
 * 设计参考:
 *   - Vercel AI SDK 5: useChat 的 persistence 选项
 *   - Redux-Persist: store → storage 的序列化/反序列化层
 *   - Erlang/OTP: 状态快照 + 事件日志 (WAL)
 *
 * 持久化策略:
 *   1. 热状态 (streamingStore): 完整 RootTask 对象 → localStorage (快速恢复)
 *   2. 消息流 (uiMessageStore): UIMessage[] → IndexedDB (大容量, 异步)
 *   3. Actor 快照 (taskActorSystem): ActorStateSnapshot[] → localStorage
 *   4. 事件日志 (eventBuffer): 最近 N 条 StreamEvent → IndexedDB (回放用)
 *
 * 恢复策略:
 *   1. 页面加载时: 从 localStorage 恢复热状态 (同步, 快)
 *   2. React mount 后: 从 IndexedDB 恢复消息流 (异步, 慢)
 *   3. 冲突处理: 持久化数据 < 当前内存状态时, 以内存为准
 *
 * 2026-07-10: P3-3 实现
 */

import type { RootTask, StreamEvent, SubAgent } from '../types/streaming';
import type { UIMessage } from '../types/messages';
import type { ActorStateSnapshot } from './taskActor';

// ==================== 存储键 ====================

const STORAGE_PREFIX = 'soloforge:stream:';
const KEYS = {
  tasks: `${STORAGE_PREFIX}tasks`,
  textBuffers: `${STORAGE_PREFIX}textBuffers`,
  agents: `${STORAGE_PREFIX}agents`,
  actorSnapshots: `${STORAGE_PREFIX}actorSnapshots`,
  messages: `${STORAGE_PREFIX}messages`,
  // IndexedDB store names
  dbMessages: 'messages',
  dbEventLog: 'eventLog',
} as const;

// ==================== 持久化数据类型 ====================

interface PersistedState {
  tasks: Record<string, RootTask>;
  textBuffers: Record<string, string>;
  agents: Record<string, SubAgent[]>;
  actorSnapshots: ActorStateSnapshot[];
  /** P0: uiMessageStore 的 messages (替代 tasks + textBuffers) */
  messages?: Record<string, UIMessage[]>;
  /** 持久化时间戳 */
  savedAt: number;
  /** schema 版本 (未来迁移用) */
  version: number;
}

// ==================== localStorage (热状态) ====================

class LocalStorageAdapter {
  private isEnabled: boolean;

  constructor() {
    this.isEnabled = typeof localStorage !== 'undefined';
  }

  read<T>(key: string): T | null {
    if (!this.isEnabled) return null;
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return null;
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  write(key: string, value: unknown): boolean {
    if (!this.isEnabled) return false;
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch {
      // localStorage 满 或 被禁用
      return false;
    }
  }

  remove(key: string): void {
    if (!this.isEnabled) return;
    try {
      localStorage.removeItem(key);
    } catch {
      // ignore
    }
  }

  setEnabled(enabled: boolean): void {
    this.isEnabled = enabled && typeof localStorage !== 'undefined';
  }
}

// ==================== IndexedDB (大容量) ====================

interface IDBAdapter {
  open(): Promise<void>;
  readMessages(chatId: string): Promise<UIMessage[] | null>;
  writeMessages(chatId: string, messages: UIMessage[]): Promise<void>;
  readEventLog(chatId: string): Promise<StreamEvent[] | null>;
  appendEventLog(chatId: string, events: StreamEvent[], maxLogSize: number): Promise<void>;
  clearChat(chatId: string): Promise<void>;
  clearAll(): Promise<void>;
}

// 内存降级方案 (IndexedDB 不可用时)
class MemoryIDBAdapter implements IDBAdapter {
  private messages = new Map<string, UIMessage[]>();
  private eventLogs = new Map<string, StreamEvent[]>();

  async open(): Promise<void> { /* no-op */ }

  async readMessages(chatId: string): Promise<UIMessage[] | null> {
    return this.messages.get(chatId) ?? null;
  }

  async writeMessages(chatId: string, messages: UIMessage[]): Promise<void> {
    this.messages.set(chatId, messages);
  }

  async readEventLog(chatId: string): Promise<StreamEvent[] | null> {
    return this.eventLogs.get(chatId) ?? null;
  }

  async appendEventLog(chatId: string, events: StreamEvent[], maxLogSize: number): Promise<void> {
    const existing = this.eventLogs.get(chatId) ?? [];
    const combined = [...existing, ...events];
    // 保留最后 maxLogSize 条
    this.eventLogs.set(chatId, combined.slice(-maxLogSize));
  }

  async clearChat(chatId: string): Promise<void> {
    this.messages.delete(chatId);
    this.eventLogs.delete(chatId);
  }

  async clearAll(): Promise<void> {
    this.messages.clear();
    this.eventLogs.clear();
  }
}

// IndexedDB 适配器 (浏览器环境)
class BrowserIDBAdapter implements IDBAdapter {
  private db: IDBDatabase | null = null;
  private dbName = 'soloforge-stream';
  private dbVersion = 1;

  async open(): Promise<void> {
    if (this.db) return;
    if (typeof indexedDB === 'undefined') throw new Error('IndexedDB not available');

    return new Promise((resolve, reject) => {
      const req = indexedDB.open(this.dbName, this.dbVersion);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(KEYS.dbMessages)) {
          db.createObjectStore(KEYS.dbMessages, { keyPath: 'chatId' });
        }
        if (!db.objectStoreNames.contains(KEYS.dbEventLog)) {
          db.createObjectStore(KEYS.dbEventLog, { keyPath: 'chatId' });
        }
      };
      req.onsuccess = () => {
        this.db = req.result;
        resolve();
      };
      req.onerror = () => reject(req.error);
    });
  }

  async readMessages(chatId: string): Promise<UIMessage[] | null> {
    if (!this.db) await this.open();
    if (!this.db) return null;
    return new Promise((resolve) => {
      const tx = this.db!.transaction(KEYS.dbMessages, 'readonly');
      const store = tx.objectStore(KEYS.dbMessages);
      const req = store.get(chatId);
      req.onsuccess = () => resolve(req.result?.messages ?? null);
      req.onerror = () => resolve(null);
    });
  }

  async writeMessages(chatId: string, messages: UIMessage[]): Promise<void> {
    if (!this.db) await this.open();
    if (!this.db) return;
    return new Promise((resolve) => {
      const tx = this.db!.transaction(KEYS.dbMessages, 'readwrite');
      const store = tx.objectStore(KEYS.dbMessages);
      store.put({ chatId, messages });
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  }

  async readEventLog(chatId: string): Promise<StreamEvent[] | null> {
    if (!this.db) await this.open();
    if (!this.db) return null;
    return new Promise((resolve) => {
      const tx = this.db!.transaction(KEYS.dbEventLog, 'readonly');
      const store = tx.objectStore(KEYS.dbEventLog);
      const req = store.get(chatId);
      req.onsuccess = () => resolve(req.result?.events ?? null);
      req.onerror = () => resolve(null);
    });
  }

  async appendEventLog(chatId: string, events: StreamEvent[], maxLogSize: number): Promise<void> {
    if (!this.db) await this.open();
    if (!this.db) return;
    return new Promise((resolve) => {
      const tx = this.db!.transaction(KEYS.dbEventLog, 'readwrite');
      const store = tx.objectStore(KEYS.dbEventLog);
      const getReq = store.get(chatId);
      getReq.onsuccess = () => {
        const existing: StreamEvent[] = getReq.result?.events ?? [];
        const combined = [...existing, ...events].slice(-maxLogSize);
        store.put({ chatId, events: combined });
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  }

  async clearChat(chatId: string): Promise<void> {
    if (!this.db) await this.open();
    if (!this.db) return;
    return new Promise((resolve) => {
      const tx = this.db!.transaction([KEYS.dbMessages, KEYS.dbEventLog], 'readwrite');
      tx.objectStore(KEYS.dbMessages).delete(chatId);
      tx.objectStore(KEYS.dbEventLog).delete(chatId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  }

  async clearAll(): Promise<void> {
    if (!this.db) await this.open();
    if (!this.db) return;
    return new Promise((resolve) => {
      const tx = this.db!.transaction([KEYS.dbMessages, KEYS.dbEventLog], 'readwrite');
      tx.objectStore(KEYS.dbMessages).clear();
      tx.objectStore(KEYS.dbEventLog).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  }
}

// ==================== 持久化管理器 ====================

export interface PersistenceConfig {
  /** 是否启用持久化 */
  enabled: boolean;
  /** 热状态写入节流间隔 (毫秒) */
  hotFlushInterval: number;
  /** 事件日志最大条数 (每个 chatId) */
  maxEventLogSize: number;
  /** 恢复时是否自动重启 Actor */
  restartActors: boolean;
}

class StreamPersistenceManager {
  private config: PersistenceConfig;
  private ls = new LocalStorageAdapter();
  private idb: IDBAdapter;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingFlush: Partial<PersistedState> = {};
  private idbReady = false;

  constructor(config: Partial<PersistenceConfig> = {}) {
    this.config = {
      enabled: true,
      hotFlushInterval: 2000,
      maxEventLogSize: 1000,
      restartActors: true,
      ...config,
    };

    // 选择 IDB 适配器
    if (typeof indexedDB !== 'undefined') {
      this.idb = new BrowserIDBAdapter();
    } else {
      this.idb = new MemoryIDBAdapter();
    }
  }

  /** 初始化 (打开 IndexedDB) */
  async init(): Promise<void> {
    if (!this.config.enabled) return;
    try {
      await this.idb.open();
      this.idbReady = true;
    } catch {
      // IndexedDB 不可用, 降级到内存
      this.idb = new MemoryIDBAdapter();
      await this.idb.open();
      this.idbReady = true;
    }
  }

  // ============== 热状态 (localStorage) ==============

  /**
   * 保存热状态 (节流写入)
   * 多次调用只会触发一次定时写入
   */
  scheduleFlush(state: Partial<PersistedState>): void {
    if (!this.config.enabled) return;
    this.pendingFlush = { ...this.pendingFlush, ...state };

    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flushNow();
    }, this.config.hotFlushInterval);
  }

  /** 立即写入 (不等待节流) */
  flushNow(): void {
    if (!this.config.enabled) return;
    if (Object.keys(this.pendingFlush).length === 0) return;

    const state: PersistedState = {
      tasks: this.pendingFlush.tasks ?? this.ls.read<Record<string, RootTask>>(KEYS.tasks) ?? {},
      textBuffers: this.pendingFlush.textBuffers ?? this.ls.read<Record<string, string>>(KEYS.textBuffers) ?? {},
      agents: this.pendingFlush.agents ?? this.ls.read<Record<string, SubAgent[]>>(KEYS.agents) ?? {},
      actorSnapshots: this.pendingFlush.actorSnapshots ?? this.ls.read<ActorStateSnapshot[]>(KEYS.actorSnapshots) ?? [],
      messages: this.pendingFlush.messages ?? this.ls.read<Record<string, UIMessage[]>>(KEYS.messages) ?? {},
      savedAt: Date.now(),
      version: 1,
    };

    this.ls.write(KEYS.tasks, state.tasks);
    this.ls.write(KEYS.textBuffers, state.textBuffers);
    this.ls.write(KEYS.agents, state.agents);
    this.ls.write(KEYS.actorSnapshots, state.actorSnapshots);
    if (state.messages) this.ls.write(KEYS.messages, state.messages);

    this.pendingFlush = {};
  }

  /**
   * 从 localStorage 恢复热状态
   * 同步执行 (localStorage 是同步 API)
   */
  restoreHotState(): Partial<PersistedState> | null {
    if (!this.config.enabled) return null;

    // P0: 优先恢复 messages (新路径), 回退到 tasks (旧路径)
    const messages = this.ls.read<Record<string, UIMessage[]>>(KEYS.messages);
    const tasks = this.ls.read<Record<string, RootTask>>(KEYS.tasks);
    if (!messages && (!tasks || Object.keys(tasks).length === 0)) return null;

    return {
      tasks: tasks ?? {},
      textBuffers: this.ls.read<Record<string, string>>(KEYS.textBuffers) ?? {},
      agents: this.ls.read<Record<string, SubAgent[]>>(KEYS.agents) ?? {},
      actorSnapshots: this.ls.read<ActorStateSnapshot[]>(KEYS.actorSnapshots) ?? [],
      messages: messages ?? undefined,
    };
  }

  // ============== 消息流 (IndexedDB) ==============

  /** 异步保存消息流到 IndexedDB */
  async saveMessages(chatId: string, messages: UIMessage[]): Promise<void> {
    if (!this.config.enabled || !this.idbReady) return;
    await this.idb.writeMessages(chatId, messages);
  }

  /** 异步从 IndexedDB 恢复消息流 */
  async restoreMessages(chatId: string): Promise<UIMessage[] | null> {
    if (!this.config.enabled || !this.idbReady) return null;
    return this.idb.readMessages(chatId);
  }

  // ============== 事件日志 (IndexedDB) ==============

  /** 追加事件到日志 */
  async appendEvents(chatId: string, events: StreamEvent[]): Promise<void> {
    if (!this.config.enabled || !this.idbReady) return;
    await this.idb.appendEventLog(chatId, events, this.config.maxEventLogSize);
  }

  /** 读取事件日志 (用于回放) */
  async readEventLog(chatId: string): Promise<StreamEvent[] | null> {
    if (!this.config.enabled || !this.idbReady) return null;
    return this.idb.readEventLog(chatId);
  }

  // ============== 清理 ==============

  /** 清除指定 chatId 的所有持久化数据 */
  async clearChat(chatId: string): void {
    this.ls.remove(KEYS.tasks); // 热状态是全量的, 不按 chatId 分
    await this.idb.clearChat(chatId);
  }

  /** 清除所有持久化数据 */
  async clearAll(): void {
    this.ls.remove(KEYS.tasks);
    this.ls.remove(KEYS.textBuffers);
    this.ls.remove(KEYS.agents);
    this.ls.remove(KEYS.actorSnapshots);
    await this.idb.clearAll();
  }

  // ============== 配置 ==============

  updateConfig(partial: Partial<PersistenceConfig>): void {
    this.config = { ...this.config, ...partial };
  }

  getConfig(): PersistenceConfig {
    return { ...this.config };
  }
}

// ==================== 单例导出 ====================

export const streamPersistence = new StreamPersistenceManager();

// ==================== 恢复 Hook ====================

/**
 * 从持久化存储恢复完整的流送状态
 * 在应用启动时调用
 *
 * @returns 恢复的 chatId 列表 (有未完成任务的)
 */
export async function restoreStreamingState(): Promise<string[]> {
  const hotState = streamPersistence.restoreHotState();
  if (!hotState) return [];

  const restoredChatIds: string[] = [];

  // 返回有未完成任务的 chatId 列表
  if (hotState.tasks) {
    for (const [chatId, task] of Object.entries(hotState.tasks)) {
      if (task.phase !== 'DONE' && task.phase !== 'ERROR') {
        restoredChatIds.push(chatId);
      }
    }
  }

  return restoredChatIds;
}
