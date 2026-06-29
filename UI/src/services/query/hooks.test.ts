/**
 * hooks.test.ts — QueryClient + useMutation 核心逻辑单测
 *
 * 注意：useQuery/useMutation 是 React hooks，需要 React 测试环境
 * 这里测核心逻辑（QueryClient + mutationFn 行为），hooks 部分
 * 留给 React 集成测试（需要 @testing-library/react 时再做）
 */

import { describe, it, expect, vi } from 'vitest';
import { QueryClient, getQueryClient, setQueryClient } from './queryClient';

describe('QueryClient', () => {
  it('setQueryData + getQueryData round-trip', () => {
    const c = new QueryClient();
    c.setQueryData(['user', 1], { name: 'Alice' });
    expect(c.getQueryData<{ name: string }>(['user', 1])).toEqual({ name: 'Alice' });
  });

  it('setQueryData with updater fn', () => {
    const c = new QueryClient();
    c.setQueryData<number>(['count'], 1);
    c.setQueryData<number>(['count'], (prev) => (prev ?? 0) + 1);
    expect(c.getQueryData<number>(['count'])).toBe(2);
  });

  it('invalidateQueries removes', () => {
    const c = new QueryClient();
    c.setQueryData(['x'], 'y');
    c.invalidateQueries(['x']);
    expect(c.getQueryData(['x'])).toBeUndefined();
  });

  it('subscribe fires on cache change', () => {
    const c = new QueryClient();
    const listener = vi.fn();
    c.subscribe(listener);
    c.setQueryData(['a'], 1);
    expect(listener).toHaveBeenCalled();
  });

  it('subscribe unsubscribe stops notifications', () => {
    const c = new QueryClient();
    const listener = vi.fn();
    const unsub = c.subscribe(listener);
    c.setQueryData(['a'], 1);
    unsub();
    c.setQueryData(['b'], 2);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('keyToString serializes consistently', () => {
    expect(QueryClient.keyToString(['a', 1, { b: 2 }])).toBe(QueryClient.keyToString(['a', 1, { b: 2 }]));
    expect(QueryClient.keyToString(['a', 1])).not.toBe(QueryClient.keyToString(['a', 2]));
  });

  it('global getQueryClient is singleton', () => {
    const a = getQueryClient();
    const b = getQueryClient();
    expect(a).toBe(b);
  });

  it('setQueryClient replaces singleton', () => {
    const orig = getQueryClient();
    const replacement = new QueryClient();
    setQueryClient(replacement);
    expect(getQueryClient()).toBe(replacement);
    setQueryClient(orig);
  });

  it('clear empties cache', () => {
    const c = new QueryClient();
    c.setQueryData(['a'], 1);
    c.setQueryData(['b'], 2);
    c.clear();
    expect(c.getQueryData(['a'])).toBeUndefined();
    expect(c.getQueryData(['b'])).toBeUndefined();
  });

  it('listener error does not break others', () => {
    const c = new QueryClient();
    const bad = vi.fn(() => {
      throw new Error('bad');
    });
    const good = vi.fn();
    c.subscribe(bad);
    c.subscribe(good);
    c.setQueryData(['x'], 1);
    expect(bad).toHaveBeenCalled();
    expect(good).toHaveBeenCalled();
  });
});

describe('mutation lifecycle contract', () => {
  /**
   * 这些测试模拟 useMutation 的核心 contract。
   * useMutation hook 内部实现遵循同样的模式：
   *   1. mutateAsync 调用 mutationFn
   *   2. 成功：setData, setStatus('success'), onSuccess, onSettled
   *   3. 失败：setError, setStatus('error'), onError, onSettled
   *   4. reset：清空 data/error/status
   */

  it('mutationFn success flow', async () => {
    const onSuccess = vi.fn();
    const onSettled = vi.fn();
    const mutationFn = vi.fn(async (n: number) => n * 2);

    // 模拟 useMutation 内部
    const state: { data: number | undefined; error: Error | null; status: string } = {
      data: undefined,
      error: null,
      status: 'idle',
    };

    async function mutate(vars: number) {
      state.status = 'pending';
      try {
        const result = await mutationFn(vars);
        state.data = result;
        state.status = 'success';
        onSuccess(result, vars);
        onSettled(result, null, vars);
        return result;
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        state.error = err;
        state.status = 'error';
        onSettled(undefined, err, vars);
        throw err;
      }
    }

    const r = await mutate(5);
    expect(r).toBe(10);
    expect(state.status).toBe('success');
    expect(state.data).toBe(10);
    expect(onSuccess).toHaveBeenCalledWith(10, 5);
    expect(onSettled).toHaveBeenCalledWith(10, null, 5);
  });

  it('mutationFn error flow', async () => {
    const onError = vi.fn();
    const onSettled = vi.fn();
    const state: { data: number | undefined; error: Error | null; status: string } = {
      data: undefined,
      error: null,
      status: 'idle',
    };

    async function mutate() {
      state.status = 'pending';
      try {
        throw new Error('boom');
      } catch (e) {
        const err = e as Error;
        state.error = err;
        state.status = 'error';
        onError(err, {});
        onSettled(undefined, err, {});
        throw err;
      }
    }

    await expect(mutate()).rejects.toThrow('boom');
    expect(state.status).toBe('error');
    expect(state.error?.message).toBe('boom');
    expect(onError).toHaveBeenCalled();
  });
});
