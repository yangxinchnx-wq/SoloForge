/**
 * LocalStorage Persist Adapter
 *
 * 实现 PersistAdapter,基于 window.localStorage
 * 处理:
 * - 同步读写
 * - unwrapStringified 防嵌套 JSON 字符串
 * - 'storage' 事件监听(多 tab 同步)
 * - JSON 解析失败容错
 */

import type { PersistAdapter } from '../types';

/**
 * 检测 value 是否是被 JSON.stringify 过的字符串
 * 如果是,解套成真实值
 */
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

export class LocalStoragePersist implements PersistAdapter {
  private storage: Storage;
  private externalListeners: Set<(key: string, value: unknown) => void> = new Set();
  private storageHandler: ((e: StorageEvent) => void) | null = null;

  constructor(storage?: Storage) {
    this.storage = storage ?? (typeof window !== 'undefined' ? window.localStorage : (null as any));
  }

  readAll(): Record<string, unknown> {
    if (!this.storage) return {};
    const result: Record<string, unknown> = {};
    try {
      for (let i = 0; i < this.storage.length; i++) {
        const key = this.storage.key(i);
        if (!key) continue;
        const raw = this.storage.getItem(key);
        if (raw === null) continue;
        try {
          let parsed: unknown = JSON.parse(raw);
          // 防嵌套:解套
          parsed = unwrapStringified(parsed);
          result[key] = parsed;
        } catch {
          // 不是合法 JSON — 可能是新格式下写入的 raw string(如 'dark')
          // 也可能是用户通过 console 写入的脏数据
          // 直接把 raw 字符串作为 value(再走 unwrap 防历史嵌套)
          result[key] = unwrapStringified(raw);
        }
      }
    } catch (e) {
      console.warn('[LocalStoragePersist] readAll failed:', (e as Error).message);
    }
    return result;
  }

  set(key: string, value: unknown): void {
    if (!this.storage) return;
    try {
      // 对 string 类型的 value 直接存 raw string(不 JSON.stringify)
      // 原因:index.html 的 inline script 直接读 localStorage.getItem(key),
      // 如果是 '"dark"'(嵌套 JSON 字符串)而不是 'dark',inline script 会拿错值导致主题闪烁
      // 对 number/boolean/object/array 仍走 JSON.stringify 以保持结构化
      const serialized = typeof value === 'string' ? value : JSON.stringify(value);
      this.storage.setItem(key, serialized);
    } catch (e) {
      console.warn('[LocalStoragePersist] set failed:', key, (e as Error).message);
    }
  }

  remove(key: string): void {
    if (!this.storage) return;
    try {
      this.storage.removeItem(key);
    } catch (e) {
      console.warn('[LocalStoragePersist] remove failed:', key, (e as Error).message);
    }
  }

  onExternalChange(handler: (key: string, value: unknown) => void): () => void {
    if (typeof window === 'undefined') return () => {};
    this.externalListeners.add(handler);

    if (!this.storageHandler) {
      this.storageHandler = (e: StorageEvent) => {
        if (!e.key || !e.storageArea) return;
        if (e.newValue === null) {
          // 其他 tab 删了
          this.notifyListeners(e.key, undefined);
          return;
        }
        try {
          const parsed = JSON.parse(e.newValue);
          const unwrapped = unwrapStringified(parsed);
          this.notifyListeners(e.key, unwrapped);
        } catch {
          // 非 JSON — 可能是 raw string(如 'dark'),直接当 string 处理
          this.notifyListeners(e.key, unwrapStringified(e.newValue));
        }
      };
      window.addEventListener('storage', this.storageHandler);
    }

    return () => {
      this.externalListeners.delete(handler);
    };
  }

  private notifyListeners(key: string, value: unknown): void {
    for (const fn of this.externalListeners) {
      try {
        fn(key, value);
      } catch (e) {
        console.warn('[LocalStoragePersist] external handler failed:', (e as Error).message);
      }
    }
  }
}