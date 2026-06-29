/**
 * Memory Persist Adapter (测试用)
 *
 * in-memory Map 实现,不接触 localStorage
 * - 用于单元测试
 * - 不支持 'storage' 事件模拟(测试需要时手动调用 _emit)
 */

import type { PersistAdapter } from '../types';

export class MemoryPersist implements PersistAdapter {
  private store: Map<string, unknown> = new Map();
  private externalListeners: Set<(key: string, value: unknown) => void> = new Set();

  readAll(): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [k, v] of this.store.entries()) {
      result[k] = v;
    }
    return result;
  }

  set(key: string, value: unknown): void {
    this.store.set(key, value);
  }

  remove(key: string): void {
    this.store.delete(key);
  }

  onExternalChange(handler: (key: string, value: unknown) => void): () => void {
    this.externalListeners.add(handler);
    return () => {
      this.externalListeners.delete(handler);
    };
  }

  // 测试辅助
  _get(key: string): unknown {
    return this.store.get(key);
  }
  _set(key: string, value: unknown): void {
    this.store.set(key, value);
  }

  /**
   * 测试用:模拟其他 source 的写入,触发外部监听
   */
  _emitExternalChange(key: string, value: unknown): void {
    if (value === undefined) {
      this.store.delete(key);
    } else {
      this.store.set(key, value);
    }
    for (const fn of this.externalListeners) {
      fn(key, value);
    }
  }

  _clear(): void {
    this.store.clear();
  }
}

/**
 * Memory Sync Adapter (测试用)
 *
 * 模拟 server 端,记录所有 PUT/GET
 * 可注入失败模拟网络问题
 */

export interface MemorySyncRecord {
  key: string;
  value: unknown;
  ts: number;
}

export class MemorySync implements SyncAdapter {
  private store: Map<string, unknown> = new Map();
  private putLog: MemorySyncRecord[] = [];
  private failNext: number = 0;
  private getAllFailNext: number = 0;

  async put(key: string, value: unknown): Promise<void> {
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error(`MemorySync: simulated PUT failure for ${key}`);
    }
    this.store.set(key, value);
    this.putLog.push({ key, value, ts: Date.now() });
  }

  async getAll(): Promise<Record<string, unknown>> {
    if (this.getAllFailNext > 0) {
      this.getAllFailNext--;
      throw new Error('MemorySync: simulated getAll failure');
    }
    const result: Record<string, unknown> = {};
    for (const [k, v] of this.store.entries()) {
      result[k] = v;
    }
    return result;
  }

  async remove(key: string): Promise<void> {
    this.store.delete(key);
  }

  // 测试辅助
  _set(key: string, value: unknown): void {
    this.store.set(key, value);
  }
  _get(key: string): unknown {
    return this.store.get(key);
  }
  _failNextPuts(n: number): void {
    this.failNext = n;
  }
  _failNextGetAll(n: number): void {
    this.getAllFailNext = n;
  }
  _putLog(): MemorySyncRecord[] {
    return [...this.putLog];
  }
  _clear(): void {
    this.store.clear();
    this.putLog = [];
    this.failNext = 0;
    this.getAllFailNext = 0;
  }
}