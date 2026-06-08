// ─────────────────────────────────────────────────────────────────
// 中心化 API 调用 hook (P0-3)
// - 统一 loading / error / data 三态
// - 自动重试 (网络/5xx 一次)
// - 组件用 const { data, loading, error, refetch } = useApi(fn)
// ─────────────────────────────────────────────────────────────────

import { useState, useCallback, useEffect, useRef } from 'react';
import { ApiError } from '../api/client';

export interface ApiState<T> {
  data: T | null;
  loading: boolean;
  error: Error | null;
  /** 上次成功时间 (ms) */
  lastSuccess: number | null;
  refetch: () => Promise<void>;
}

export interface UseApiOptions {
  /** 是否立即触发 (默认 true) */
  immediate?: boolean;
  /** 重试次数 (默认 1) */
  retries?: number;
  /** 重试间隔 ms (默认 800) */
  retryDelay?: number;
  /** 依赖数组,变化时自动 refetch */
  deps?: ReadonlyArray<unknown>;
}

export function useApi<T>(
  fetcher: () => Promise<T>,
  opts: UseApiOptions = {},
): ApiState<T> {
  const { immediate = true, retries = 1, retryDelay = 800, deps = [] } = opts;
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState<boolean>(immediate);
  const [error, setError] = useState<Error | null>(null);
  const [lastSuccess, setLastSuccess] = useState<number | null>(null);
  const mountedRef = useRef(true);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const run = useCallback(async () => {
    if (!mountedRef.current) return;
    setLoading(true);
    setError(null);
    let lastErr: Error | null = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const result = await fetcherRef.current();
        if (!mountedRef.current) return;
        setData(result);
        setLastSuccess(Date.now());
        setLoading(false);
        return;
      } catch (e) {
        lastErr = e instanceof Error ? e : new Error(String(e));
        // 4xx 不重试
        if (e instanceof ApiError && e.status >= 400 && e.status < 500) break;
        if (attempt < retries) {
          await new Promise((r) => setTimeout(r, retryDelay));
        }
      }
    }
    if (!mountedRef.current) return;
    setError(lastErr);
    setLoading(false);
  }, [retries, retryDelay]);

  useEffect(() => {
    mountedRef.current = true;
    if (immediate) run();
    return () => { mountedRef.current = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { data, loading, error, lastSuccess, refetch: run };
}

/** 把 ApiError 翻译成用户可读的中文消息 */
export function apiErrorMessage(err: Error | null): string {
  if (!err) return '';
  if (err instanceof ApiError) {
    if (err.status === 0 || err.status === 504) return '无法连接到后端,请检查后端服务';
    if (err.status === 401) return '未授权,请重新登录';
    if (err.status === 403) return '权限不足';
    if (err.status === 404) return '资源不存在';
    if (err.status >= 500) return `服务器错误 (${err.status})`;
    return err.message || `请求失败 (${err.status})`;
  }
  return err.message || '未知错误';
}
