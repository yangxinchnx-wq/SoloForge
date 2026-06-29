/**
 * useAsync - 统一管理异步操作 loading / error 状态
 *
 * 用法:
 *   const { execute, loading, error, data } = useAsync(loadModel);
 *
 *   if (loading) return <Spinner />;
 *   if (error) return <ErrorBox msg={error.message} />;
 *
 *   <button onClick={() => execute('iphone_14_pro')}>加载</button>
 */

import { useState, useCallback, useRef, useEffect } from 'react';

export interface AsyncState<T> {
  loading: boolean;
  error: Error | null;
  data: T | null;
}

export interface UseAsyncResult<TArgs, TResult> extends AsyncState<TResult> {
  /** 执行异步操作, 重复调用会自动取消上一次未完成的 */
  execute: (...args: TArgs[]) => Promise<TResult | null>;
  /** 重置 state */
  reset: () => void;
  /** 是否是第一次执行 */
  isInitial: boolean;
}

export function useAsync<TArgs, TResult>(
  fn: (...args: TArgs[]) => Promise<TResult>
): UseAsyncResult<TArgs, TResult> {
  const [state, setState] = useState<AsyncState<TResult>>({
    loading: false,
    error: null,
    data: null,
  });
  const [isInitial, setIsInitial] = useState(true);
  const abortRef = useRef<{ cancelled: boolean } | null>(null);

  const execute = useCallback(
    async (...args: TArgs[]): Promise<TResult | null> => {
      // 取消上一次
      if (abortRef.current) {
        abortRef.current.cancelled = true;
      }
      const ticket = { cancelled: false };
      abortRef.current = ticket;

      setState((s) => ({ ...s, loading: true, error: null }));
      setIsInitial(false);

      try {
        const result = await fn(...args);
        if (ticket.cancelled) return null;
        setState({ loading: false, error: null, data: result });
        return result;
      } catch (e) {
        if (ticket.cancelled) return null;
        const err = e instanceof Error ? e : new Error(String(e));
        setState({ loading: false, error: err, data: null });
        return null;
      }
    },
    [fn]
  );

  const reset = useCallback((): void => {
    if (abortRef.current) abortRef.current.cancelled = true;
    setState({ loading: false, error: null, data: null });
    setIsInitial(true);
  }, []);

  // 卸载时取消
  useEffect(() => {
    return () => {
      if (abortRef.current) abortRef.current.cancelled = true;
    };
  }, []);

  return { ...state, execute, reset, isInitial };
}
