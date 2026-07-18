/**
 * LRU 缓存辅助
 *
 * 2026-06-24 性能优化:
 *   - fileCache 之前用 Record<string,string> 无限累积
 *   - 编辑 100+ 大文件时,1MB × 100 = 100MB 长期驻留
 *   - 这里提供 LRU 上限辅助,evict 最久未访问的条目
 *
 * 设计:
 *   - 用 Map 内部维护顺序(JS Map 按插入顺序迭代)
 *   - get 时把 key 移到队尾 (most recently used)
 *   - set 时如果超 cap,evict 队首 (least recently used)
 *   - 对外暴露 Record<string,T> 兼容现有调用代码
 */

export const FILE_CACHE_MAX = 50;

/**
 * 把 key 移到队尾,返回新 cache(若 key 不存在返回原 cache)
 *  - 用 Map 内部排序,Object.fromEntries 转回 Record
 *  - 不修改入参
 */
export function lruTouch<T>(cache: Record<string, T>, key: string): Record<string, T> {
  if (!(key in cache)) return cache;
  const next = new Map<string, T>();
  for (const [k, v] of Object.entries(cache)) {
    if (k !== key) next.set(k, v);
  }
  next.set(key, cache[key]);
  return Object.fromEntries(next);
}

/**
 * 设置 key=value,超 cap 时 evict 队首
 *  - 写完后,key 在队尾 (most recently used)
 *  - 不修改入参
 */
export function lruSet<T>(cache: Record<string, T>, key: string, value: T, maxSize: number = FILE_CACHE_MAX): Record<string, T> {
  const next = new Map<string, T>();
  for (const [k, v] of Object.entries(cache)) {
    if (k !== key) next.set(k, v);
  }
  next.set(key, value);
  while (next.size > maxSize) {
    const oldest = next.keys().next().value;
    if (oldest === undefined) break;
    next.delete(oldest);
  }
  return Object.fromEntries(next);
}

// ── HMR: 纯函数模块,自接受热更新,不触发 full page reload ──
if (import.meta.hot) import.meta.hot.accept();
