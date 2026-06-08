// ─────────────────────────────────────────────────────────────────
// 持久化 state hook (P0-5 起步)
// - 替代散落在各处的 localStorage.getItem/setItem
// - 统一命名空间: soloforge.<scope>.<key>
// - 新代码请用 usePersistedState,旧代码逐步迁移
// ─────────────────────────────────────────────────────────────────

import { useState, useEffect, useCallback } from 'react';

const PREFIX = 'soloforge';

function fullKey(scope: string, key: string): string {
  return `${PREFIX}.${scope}.${key}`;
}

function read<T>(scope: string, key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(fullKey(scope, key));
    if (raw === null) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function write<T>(scope: string, key: string, value: T): void {
  try {
    localStorage.setItem(fullKey(scope, key), JSON.stringify(value));
  } catch { /* 容量满 / 隐私模式 */ }
}

export function usePersistedState<T>(
  scope: string,
  key: string,
  initial: T,
): [T, (v: T | ((prev: T) => T)) => void, () => void] {
  const [value, setValue] = useState<T>(() => read(scope, key, initial));

  useEffect(() => {
    write(scope, key, value);
  }, [scope, key, value]);

  const reset = useCallback(() => {
    setValue(initial);
  }, [initial]);

  return [value, setValue, reset];
}

/** 同步读取 (供非组件代码用,如事件 handler 里查配置) */
export function readPersisted<T>(scope: string, key: string, fallback: T): T {
  return read(scope, key, fallback);
}

/** 同步写入 */
export function writePersisted<T>(scope: string, key: string, value: T): void {
  write(scope, key, value);
}

/** 列出一个 scope 下所有键 (供调试/迁移用) */
export function listScopeKeys(scope: string): string[] {
  const prefix = `${PREFIX}.${scope}.`;
  const out: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith(prefix)) out.push(k.slice(prefix.length));
  }
  return out;
}
