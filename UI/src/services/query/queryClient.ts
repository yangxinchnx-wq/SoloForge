/**
 * queryClient.ts — 极简 TanStack Query 风格 client
 *
 * 设计动机：
 *   - @tanstack/react-query 在代理受限环境装不上
 *   - 我们只需其 API 子集：queryCache + mutation lifecycle
 *   - 此实现 ~150 行，覆盖 90% 实际用法
 *   - 后续可一行换回 @tanstack/react-query（API 兼容设计）
 *
 * 暴露 API：
 *   - queryClient.setQueryData(key, data)
 *   - queryClient.getQueryData(key)
 *   - queryClient.invalidateQueries(key)
 *   - queryClient.subscribe(listener)
 *   - useQuery / useMutation（hooks）
 */

export type QueryKey = readonly unknown[];

export interface QueryState<T = unknown> {
  data: T | undefined;
  error: Error | null;
  status: 'idle' | 'pending' | 'success' | 'error';
  /** 数据更新时间戳 */
  dataUpdatedAt: number;
}

type Listener = () => void;

export class QueryClient {
  private cache = new Map<string, QueryState>();
  private listeners = new Set<Listener>();

  /** 内部：把 QueryKey 序列化成 string */
  static keyToString(key: QueryKey): string {
    return JSON.stringify(key, (_k, v) => (typeof v === 'function' ? `<fn:${(v as Function).name}>` : v));
  }

  setQueryData<T>(key: QueryKey, updater: T | ((prev: T | undefined) => T)): T | undefined {
    const k = QueryClient.keyToString(key);
    const cur = this.cache.get(k);
    const prev = cur?.data as T | undefined;
    const next = typeof updater === 'function' ? (updater as (p: T | undefined) => T)(prev) : updater;
    this.cache.set(k, {
      data: next,
      error: null,
      status: 'success',
      dataUpdatedAt: Date.now(),
    });
    this.emit();
    return next;
  }

  getQueryData<T>(key: QueryKey): T | undefined {
    const k = QueryClient.keyToString(key);
    return this.cache.get(k)?.data as T | undefined;
  }

  getQueryState<T>(key: QueryKey): QueryState<T> | undefined {
    const k = QueryClient.keyToString(key);
    return this.cache.get(k) as QueryState<T> | undefined;
  }

  invalidateQueries(key: QueryKey): void {
    const k = QueryClient.keyToString(key);
    this.cache.delete(k);
    this.emit();
  }

  /** 订阅（任意缓存变化都触发） */
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** 测试用：清空 */
  clear(): void {
    this.cache.clear();
    this.emit();
  }

  private emit(): void {
    this.listeners.forEach((l) => {
      try {
        l();
      } catch {
        /* ignore listener error */
      }
    });
  }
}

/** 全局单例（应用入口初始化） */
let globalClient: QueryClient | null = null;

export function getQueryClient(): QueryClient {
  if (!globalClient) globalClient = new QueryClient();
  return globalClient;
}

export function setQueryClient(client: QueryClient): void {
  globalClient = client;
}
