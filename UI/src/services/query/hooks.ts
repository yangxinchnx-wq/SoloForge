/**
 * hooks.ts — useQuery / useMutation（TanStack Query 兼容 API 子集）
 *
 * 用法：
 *   const { data, isLoading, error } = useQuery({
 *     queryKey: ['ast', lang, promptHash],
 *     queryFn: () => fetchAst(lang, promptHash),
 *   });
 *
 *   const mutation = useMutation({
 *     mutationFn: async (vars) => streamToAst(vars),
 *     onSuccess: (data) => queryClient.setQueryData(['ast'], data),
 *   });
 *
 *   <button onClick={() => mutation.mutate({ ... })}>
 *     {mutation.isPending ? 'Streaming...' : 'Generate'}
 *   </button>
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { getQueryClient, QueryClient, type QueryKey } from './queryClient';

export interface UseQueryOptions<T> {
  queryKey: QueryKey;
  queryFn: () => Promise<T> | T;
  enabled?: boolean;
  staleTime?: number;
}

export interface UseQueryResult<T> {
  data: T | undefined;
  error: Error | undefined;
  isLoading: boolean;
  isFetching: boolean;
  status: 'idle' | 'pending' | 'success' | 'error';
  refetch: () => Promise<void>;
}

export function useQuery<T>(opts: UseQueryOptions<T>): UseQueryResult<T> {
  const client = getQueryClient();
  const [state, setState] = useState(() => client.getQueryState<T>(opts.queryKey));
  const [isFetching, setIsFetching] = useState(false);
  const enabled = opts.enabled ?? true;
  const fnRef = useRef(opts.queryFn);
  fnRef.current = opts.queryFn;

  const execute = useCallback(async () => {
    setIsFetching(true);
    try {
      const data = await fnRef.current();
      client.setQueryData<T>(opts.queryKey, data);
      setState({ data, error: null, status: 'success', dataUpdatedAt: Date.now() });
    } catch (e) {
      const error = e instanceof Error ? e : new Error(String(e));
      setState({ data: undefined, error, status: 'error', dataUpdatedAt: Date.now() });
    } finally {
      setIsFetching(false);
    }
  }, [client, opts.queryKey]);

  useEffect(() => {
    const unsub = client.subscribe(() => {
      setState(client.getQueryState<T>(opts.queryKey));
    });
    return unsub;
  }, [client, opts.queryKey]);

  useEffect(() => {
    if (!enabled) return;
    const cur = client.getQueryState<T>(opts.queryKey);
    const stale = !cur || (opts.staleTime !== undefined && Date.now() - cur.dataUpdatedAt > opts.staleTime);
    if (stale) void execute();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, QueryClient.keyToString(opts.queryKey)]);

  return {
    data: state?.data,
    error: state?.error,
    isLoading: !state && enabled,
    isFetching,
    status: state?.status ?? 'idle',
    refetch: execute,
  };
}

export interface UseMutationOptions<TVars, TResult> {
  mutationFn: (vars: TVars) => Promise<TResult> | TResult;
  onSuccess?: (data: TResult, vars: TVars) => void;
  onError?: (error: Error, vars: TVars) => void;
  onSettled?: (data: TResult | undefined, error: Error | null, vars: TVars) => void;
}

export interface UseMutationResult<TVars, TResult> {
  mutate: (vars: TVars) => Promise<TResult | undefined>;
  mutateAsync: (vars: TVars) => Promise<TResult>;
  reset: () => void;
  data: TResult | undefined;
  error: Error | null;
  status: 'idle' | 'pending' | 'success' | 'error';
  isPending: boolean;
  isSuccess: boolean;
  isError: boolean;
}

export function useMutation<TVars, TResult>(opts: UseMutationOptions<TVars, TResult>): UseMutationResult<TVars, TResult> {
  const [data, setData] = useState<TResult | undefined>(undefined);
  const [error, setError] = useState<Error | null>(null);
  const [status, setStatus] = useState<'idle' | 'pending' | 'success' | 'error'>('idle');
  const optsRef = useRef(opts);
  optsRef.current = opts;

  const mutateAsync = useCallback(async (vars: TVars): Promise<TResult> => {
    setStatus('pending');
    setError(null);
    try {
      const result = await optsRef.current.mutationFn(vars);
      setData(result);
      setStatus('success');
      optsRef.current.onSuccess?.(result, vars);
      optsRef.current.onSettled?.(result, null, vars);
      return result;
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      setError(err);
      setStatus('error');
      optsRef.current.onError?.(err, vars);
      optsRef.current.onSettled?.(undefined, err, vars);
      throw err;
    }
  }, []);

  const mutate = useCallback(async (vars: TVars) => {
    try {
      return await mutateAsync(vars);
    } catch {
      return undefined;
    }
  }, [mutateAsync]);

  const reset = useCallback(() => {
    setData(undefined);
    setError(null);
    setStatus('idle');
  }, []);

  return {
    mutate,
    mutateAsync,
    reset,
    data,
    error,
    status,
    isPending: status === 'pending',
    isSuccess: status === 'success',
    isError: status === 'error',
  };
}

/** Re-export for consumers */
export { getQueryClient, QueryClient };
export type { QueryKey };
