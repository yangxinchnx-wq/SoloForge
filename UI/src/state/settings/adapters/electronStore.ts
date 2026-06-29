/**
 * Electron-Store 持久化适配器 (内存 + 磁盘双层)
 *
 * 架构:
 *   1. 内存 Map — 同步读, 零延迟 (所有 get 都走这里)
 *   2. electron-store — 异步写入磁盘 (防断电/崩溃丢失)
 *   3. localStorage — Electron 不可用时的降级方案
 *
 * electron-store 通过 Electron IPC 调用主进程写入
 * 如果在浏览器环境,自动降级为 localStorage
 */

import type { PersistAdapter } from '../types';

// ============================================================
// Electron IPC 桥接 (如果 Electron 环境可用)
// ============================================================

interface ElectronBridge {
  readStore: (args: { storeName: string }) => Promise<Record<string, unknown>>;
  writeStore: (args: { storeName: string; key: string; value: unknown }) => Promise<void>;
  deleteStoreKey: (args: { storeName: string; key: string }) => Promise<void>;
}

function getElectronBridge(): ElectronBridge | null {
  if (typeof window === 'undefined') return null;
  const soloforge = (window as any).soloforge;
  if (!soloforge?.settings) return null;
  if (typeof soloforge.settings.readStore !== 'function') return null;
  return soloforge.settings;
}

// ============================================================
// IPC 写盘前清理 (结构化克隆防御)
// ============================================================
//
// Electron IPC 用 structured clone 算法序列化参数,以下类型不能 clone:
//   - Function (例如 React 组件 / 事件回调)
//   - Symbol
//   - DOM 节点 / React 元素 (有 $$typeof / nodeType 私有字段)
//   - 循环引用 (递归到一半回到原点会爆栈)
//
// 在写入前深拷贝时把这些值丢掉,避免 "An object could not be cloned" 报错.
// 设计原则:
//   1. 永不抛 — sanitize 抛了就当 {} 处理
//   2. 永不返回顶层 undefined — 至少保证有东西写出去 (或退化为 deleteStoreKey)
//   3. 第一次丢弃时 warn 一次,提醒上游修复 (相同 path 不重复 warn)

const warnedNonCloneablePaths = new Set<string>();

export function sanitizeForIPC(value: unknown, path = '', seen = new WeakSet<object>()): unknown {
  // 基础类型直接返回
  if (value === null) return null;
  if (value === undefined) return undefined;
  const t = typeof value;
  if (t === 'string' || t === 'number' || t === 'boolean') return value;
  if (t === 'bigint') return String(value);
  if (t === 'function' || t === 'symbol') {
    if (!warnedNonCloneablePaths.has(path)) {
      warnedNonCloneablePaths.add(path);
      console.warn(
        `[ElectronStorePersist] dropping non-cloneable ${t} at "${path || '(root)'}" — settings data should be JSON-serializable`,
      );
    }
    return undefined;
  }

  // object
  if (t === 'object') {
    const obj = value as object;
    if (seen.has(obj)) {
      // 循环引用: 断环, 返回 undefined 让父级丢掉这个 key
      if (!warnedNonCloneablePaths.has(path)) {
        warnedNonCloneablePaths.add(path);
        console.warn(
          `[ElectronStorePersist] dropping circular reference at "${path || '(root)'}"`,
        );
      }
      return undefined;
    }
    seen.add(obj);

    // Date → ISO 字符串 (cloneable 但存 JSON 时会丢类型)
    if (value instanceof Date) return value.toISOString();

    // Array
    if (Array.isArray(value)) {
      const out: unknown[] = [];
      for (let i = 0; i < value.length; i++) {
        const v = sanitizeForIPC(value[i], `${path}[${i}]`, seen);
        if (v !== undefined) out.push(v);
      }
      return out;
    }

    // Map / Set → plain object / array
    if (value instanceof Map) {
      const out: Record<string, unknown> = {};
      for (const [k, v] of value.entries()) {
        const sanitized = sanitizeForIPC(v, `${path}.${String(k)}`, seen);
        if (sanitized !== undefined) out[String(k)] = sanitized;
      }
      return out;
    }
    if (value instanceof Set) {
      const out: unknown[] = [];
      let i = 0;
      for (const v of value.values()) {
        const sanitized = sanitizeForIPC(v, `${path}[${i}]`, seen);
        if (sanitized !== undefined) out.push(sanitized);
        i++;
      }
      return out;
    }

    // React 元素 / DOM 节点: 有 $$typeof 或 nodeType, 不可 clone, 丢
    const v = value as Record<string, unknown>;
    if (typeof v.$$typeof !== 'undefined' || typeof v.nodeType === 'number') {
      if (!warnedNonCloneablePaths.has(path)) {
        warnedNonCloneablePaths.add(path);
        console.warn(
          `[ElectronStorePersist] dropping React element / DOM node at "${path || '(root)'}"`,
        );
      }
      return undefined;
    }

    // 普通对象
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) {
      const sanitized = sanitizeForIPC(val, path ? `${path}.${k}` : k, seen);
      if (sanitized !== undefined) out[k] = sanitized;
    }
    return out;
  }

  return undefined;
}

// 测试钩子: 重置 warn 状态, 避免测试间互相干扰
export function __resetSanitizeForIPCWarnings(): void {
  warnedNonCloneablePaths.clear();
}

// ============================================================
// 内存层 — 同步读, 零延迟
// ============================================================

interface CacheEntry {
  value: unknown;
  version: number;
}

class MemoryLayer {
  private cache: Map<string, CacheEntry> = new Map();
  private version = 0;

  get<T = unknown>(key: string): T | undefined {
    const entry = this.cache.get(key);
    return entry === undefined ? undefined : (entry.value as T);
  }

  set(key: string, value: unknown): void {
    this.version++;
    this.cache.set(key, { value, version: this.version });
  }

  delete(key: string): boolean {
    return this.cache.delete(key);
  }

  has(key: string): boolean {
    return this.cache.has(key);
  }

  getAll(): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [k, v] of this.cache.entries()) {
      result[k] = v.value;
    }
    return result;
  }

  batchSet(entries: Record<string, unknown>): void {
    for (const [k, v] of Object.entries(entries)) {
      this.set(k, v);
    }
  }

  get size(): number {
    return this.cache.size;
  }
}

// ============================================================
// 异步写入队列 (合并同 key 的连续写入)
// ============================================================

interface WriteQueueItem {
  key: string;
  value: unknown;
}

class AsyncWriteQueue {
  private pending: Map<string, WriteQueueItem> = new Map();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushed: boolean = true;

  constructor(
    private onFlush: (batch: Map<string, unknown>) => Promise<void>,
    private delayMs = 300,
  ) {}

  enqueue(key: string, value: unknown): void {
    this.pending.set(key, { key, value });
    this.scheduleFlush();
  }

  enqueueAll(entries: Record<string, unknown>): void {
    for (const [k, v] of Object.entries(entries)) {
      this.pending.set(k, { key: k, value: v });
    }
    this.scheduleFlush();
  }

  delete(key: string): void {
    this.pending.delete(key);
  }

  /** 立即 flush (退出前调用) */
  async flushNow(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.pending.size === 0) return;
    const batch = new Map<string, unknown>();
    for (const [k, item] of this.pending) {
      batch.set(k, item.value);
    }
    this.pending.clear();
    try {
      await this.onFlush(batch);
    } catch (e) {
      console.warn('[AsyncWriteQueue] flush failed:', (e as Error).message);
    }
  }

  get isIdle(): boolean {
    return this.flushed && this.pending.size === 0;
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushed = false;
    this.flushTimer = setTimeout(async () => {
      this.flushTimer = null;
      await this.flushNow();
      this.flushed = true;
    }, this.delayMs);
  }
}

// ============================================================
// 双层 PersistAdapter: 内存 + electron-store / localStorage
// ============================================================

export interface ElectronStorePersistOptions {
  storeName?: string;
}

export class ElectronStorePersist implements PersistAdapter {
  private memory: MemoryLayer;
  private electronBridge: ElectronBridge | null;
  private localStorage: Storage | null;
  private writeQueue: AsyncWriteQueue;
  private initialized = false;
  private storeName: string;

  constructor(options: ElectronStorePersistOptions = {}) {
    this.storeName = options.storeName ?? 'soloforge-app-store';
    this.memory = new MemoryLayer();
    this.electronBridge = getElectronBridge();
    this.localStorage =
      typeof window !== 'undefined' ? window.localStorage : null;

    this.writeQueue = new AsyncWriteQueue(
      (batch) => this.persistBatch(batch),
      300,
    );
  }

  // ── 初始化: 从磁盘恢复内存 ──
  async initFromDisk(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;

    try {
      if (this.electronBridge) {
        const data = await this.electronBridge.readStore({
          storeName: this.storeName,
        });
        if (data && typeof data === 'object') {
          this.memory.batchSet(data);
        }
      }
    } catch (e) {
      console.warn(
        '[ElectronStorePersist] electron-store read failed, falling back to localStorage:',
        (e as Error).message,
      );
    }

    // 同时也从 localStorage 读一份(降级 + 多 Tab 同步)
    if (this.localStorage) {
      try {
        const key = `soloforge_electron_store_${this.storeName}`;
        const raw = this.localStorage.getItem(key);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === 'object') {
            // 只补充内存中没有的 key(不覆盖 electron-store 的值)
            for (const [k, v] of Object.entries(parsed)) {
              if (!this.memory.has(k)) {
                this.memory.set(k, v);
              }
            }
          }
        }
      } catch {
        // ignore
      }
    }
  }

  // ── PersistAdapter 接口实现 ──

  readAll(): Record<string, unknown> {
    return this.memory.getAll();
  }

  set(key: string, value: unknown): void {
    this.memory.set(key, value);
    this.writeQueue.enqueue(key, value);
  }

  remove(key: string): void {
    this.memory.delete(key);
    this.writeQueue.enqueue(key, undefined);
  }

  onExternalChange(
    handler: (key: string, value: unknown) => void,
  ): () => void {
    // 多 Tab 同步: 监听 localStorage 'storage' 事件
    if (!this.localStorage) return () => {};

    const storageHandler = (e: StorageEvent) => {
      const expectedKey = `soloforge_electron_store_${this.storeName}`;
      if (e.key !== expectedKey || !e.newValue) return;

      try {
        const parsed = JSON.parse(e.newValue);
        if (parsed && typeof parsed === 'object') {
          for (const [k, v] of Object.entries(parsed)) {
            handler(k, v);
          }
        }
      } catch {
        // ignore
      }
    };

    window.addEventListener('storage', storageHandler);
    return () => {
      window.removeEventListener('storage', storageHandler);
    };
  }

  // ── 立即刷盘(退出前) ──
  async flushNow(): Promise<void> {
    await this.writeQueue.flushNow();
  }

  // ── 内部: 批量写入到磁盘 ──
  private async persistBatch(batch: Map<string, unknown>): Promise<void> {
    // 写入 electron-store (Electron 环境)
    if (this.electronBridge) {
      try {
        for (const [k, v] of batch) {
          // 清理不可 IPC 结构化克隆的值 (Function/Symbol/React 元素/循环引用)
          // 不清理会在 IPC 边界抛 "An object could not be cloned"
          let sanitized: unknown;
          try {
            sanitized = sanitizeForIPC(v);
          } catch (e) {
            console.warn(
              `[ElectronStorePersist] sanitize failed for key "${k}":`,
              (e as Error).message,
            );
            continue;
          }
          if (sanitized === undefined) {
            // 整个 value 都是不可序列化的, 走 delete 路径
            await this.electronBridge.deleteStoreKey({
              storeName: this.storeName,
              key: k,
            });
          } else {
            await this.electronBridge.writeStore({
              storeName: this.storeName,
              key: k,
              value: sanitized,
            });
          }
        }
      } catch (e) {
        console.warn(
          '[ElectronStorePersist] electron-store write failed:',
          (e as Error).message,
        );
      }
    }

    // 写入 localStorage (降级 + 多 Tab 同步)
    if (this.localStorage) {
      try {
        const allData = this.memory.getAll();
        const key = `soloforge_electron_store_${this.storeName}`;
        // localStorage 也吃 JSON, 同样需要 sanitize (不过失败也只是 warn 不会崩)
        const safeAllData: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(allData)) {
          const sanitized = sanitizeForIPC(v);
          if (sanitized !== undefined) safeAllData[k] = sanitized;
        }
        this.localStorage.setItem(key, JSON.stringify(safeAllData));
      } catch (e) {
        console.warn(
          '[ElectronStorePersist] localStorage write failed:',
          (e as Error).message,
        );
      }
    }
  }
}

// ============================================================
// 浏览器环境降级: 纯内存 + localStorage (无 electron-store)
// ============================================================

export function createBrowserPersist(
  storeName = 'soloforge-app-store',
): ElectronStorePersist {
  return new ElectronStorePersist({ storeName });
}
