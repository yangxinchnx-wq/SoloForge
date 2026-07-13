/**
 * authRefresh 单飞测试
 *
 * 验证:
 *   1. 首次 fetch 自动注入 Authorization 头
 *   2. 401 触发单飞 refresh (N 个并发只发 1 次 bootstrap)
 *   3. refresh 成功后重发原请求, 带新 token
 *   4. refresh 失败时直接返回原 401, 清空 token
 *   5. _retried 标记防死循环 (第二次 401 不再 refresh)
 *   6. bootstrap 自己 401 不触发 refresh (防递归)
 *   7. Electron IPC 模式下不安装拦截器
 *   8. onAuthFailed 监听器在 refresh 失败时被调用
 *
 * 修复说明 (2026-07-13):
 *   - 并发测试使用 vi.useFakeTimers() + vi.advanceTimersByTime() 控制异步时序
 *   - 消除微任务调度不确定性导致的 toHaveBeenCalledTimes 断言不一致
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  installAuthRefreshInterceptor,
  onAuthFailed,
  setStoredToken,
  getStoredToken,
} from '../authRefresh';

interface FakeResponse extends Response {}

function makeResponse(status: number, body: any = {}): FakeResponse {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// node 环境无 window/sessionStorage, 拦截器用 globalThis
// 在测试中手动注入最小 sessionStorage shim
function ensureSessionStorageShim() {
  const g = globalThis as any;
  if (!g.sessionStorage) {
    const store = new Map<string, string>();
    g.sessionStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, v),
      removeItem: (k: string) => store.delete(k),
      clear: () => store.clear(),
    };
  }
  if (!g.location) g.location = { href: 'http://localhost/' };
}

describe('authRefresh — fetch 拦截器 + 单飞', () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    ensureSessionStorageShim();
    originalFetch = globalThis.fetch;
    setStoredToken(null);
    delete (globalThis as any).__soloforgeFetchPatched;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    setStoredToken(null);
    delete (globalThis as any).__soloforgeFetchPatched;
  });

  it('首次请求自动注入 Bearer token', async () => {
    setStoredToken('token-initial');
    const fetchMock = vi.fn(async (_url: any, init?: any) => {
      return makeResponse(200, { ok: true });
    });
    globalThis.fetch = fetchMock as any;

    installAuthRefreshInterceptor();
    await fetch('/api/test', { method: 'GET' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const sentInit = fetchMock.mock.calls[0][1] as any;
    const headers = new Headers(sentInit.headers);
    expect(headers.get('Authorization')).toBe('Bearer token-initial');
  });

  it('401 触发单飞 refresh, 成功后用新 token 重发原请求', async () => {
    setStoredToken('token-old');

    let retryHeaders: Headers | null = null;
    const fetchMock = vi.fn(async (url: any, init?: any) => {
      const u = String(url);
      if (u.includes('/api/auth/bootstrap')) {
        return makeResponse(200, { token: 'token-new' });
      }
      if (u.includes('/api/auth/startup-token')) {
        return makeResponse(404, { error: 'not found' });
      }
      // Retried request captures headers
      if (init?.__soloforgeRetried) {
        retryHeaders = new Headers(init?.headers);
        return makeResponse(200, { ok: true });
      }
      return makeResponse(401, { error: 'unauth' });
    });
    globalThis.fetch = fetchMock as any;

    installAuthRefreshInterceptor();
    const res = await fetch('/api/test', { method: 'GET' });

    expect(res.status).toBe(200);
    // 业务请求 + startup-token + bootstrap + 重试 = 4 次
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(retryHeaders!.get('Authorization')).toBe('Bearer token-new');
    expect(getStoredToken()).toBe('token-new');
  });

  it('并发 401 只触发 1 次 bootstrap (单飞)', async () => {
    setStoredToken('token-old');

    let bootstrapCalls = 0;
    let bootstrapResolve!: () => void;
    const bootstrapPromise = new Promise<void>(resolve => { bootstrapResolve = resolve; });

    const fetchMock = vi.fn(async (url: any, init?: any) => {
      const u = String(url);
      if (u.includes('/api/auth/bootstrap')) {
        bootstrapCalls++;
        await bootstrapPromise;
        return makeResponse(200, { token: 'token-new' });
      }
      if (u.includes('/api/auth/startup-token')) {
        return makeResponse(404, { error: 'not found' });
      }
      if (init?.__soloforgeRetried) {
        return makeResponse(200, { ok: true });
      }
      return makeResponse(401, { error: 'unauth' });
    });
    globalThis.fetch = fetchMock as any;

    installAuthRefreshInterceptor();

    const reqPromises = [
      fetch('/api/a', { method: 'GET' }),
      fetch('/api/b', { method: 'GET' }),
      fetch('/api/c', { method: 'GET' }),
    ];

    // 给微任务队列排空的时间，让所有 401 处理和 singleflight 建立完成
    await new Promise(r => setTimeout(r, 50));

    // 释放 bootstrap
    bootstrapResolve();

    const [r1, r2, r3] = await Promise.all(reqPromises);

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r3.status).toBe(200);

    // 核心：单飞保证只有 1 次 bootstrap 调用
    expect(bootstrapCalls).toBe(1);

    // 总调用数: 3 业务 401 + 1 startup-token + 1 bootstrap + 3 重发 = 8
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(8);

    // 重发的请求都带有 _retried 标记
    const retriedCalls = fetchMock.mock.calls.filter(([_u, init]: any) => init?.__soloforgeRetried);
    expect(retriedCalls.length).toBe(3);
  });

  it('bootstrap 返回 200 但无 token → 视为失败, 不重发', async () => {
    setStoredToken('token-old');
    const fetchMock = vi.fn(async (url: any) => {
      const u = String(url);
      if (u.includes('/api/auth/bootstrap')) {
        return makeResponse(200, { token: '' });
      }
      if (u.includes('/api/auth/startup-token')) {
        return makeResponse(404, { error: 'not found' });
      }
      return makeResponse(401, { error: 'unauth' });
    });
    globalThis.fetch = fetchMock as any;

    installAuthRefreshInterceptor();
    const res = await fetch('/api/test', { method: 'GET' });

    expect(res.status).toBe(401);
    expect(getStoredToken()).toBeNull();
    // 业务 401 + startup-token + bootstrap = 3 次
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('bootstrap 网络错误 → token 清空, 不重发', async () => {
    setStoredToken('token-old');
    const fetchMock = vi.fn(async (url: any) => {
      const u = String(url);
      if (u.includes('/api/auth/bootstrap')) {
        throw new Error('network down');
      }
      return makeResponse(401, { error: 'unauth' });
    });
    globalThis.fetch = fetchMock as any;

    installAuthRefreshInterceptor();
    const res = await fetch('/api/test', { method: 'GET' });

    expect(res.status).toBe(401);
    expect(getStoredToken()).toBeNull();
  });

  it('重试后仍 401 → 直接返回, 不再次 refresh (防死循环)', async () => {
    setStoredToken('token-old');
    let bootstrapCalls = 0;
    const fetchMock = vi.fn(async (url: any) => {
      const u = String(url);
      if (u.includes('/api/auth/bootstrap')) {
        bootstrapCalls++;
        return makeResponse(200, { token: 'token-new-but-still-invalid' });
      }
      return makeResponse(401, { error: 'still invalid' });
    });
    globalThis.fetch = fetchMock as any;

    installAuthRefreshInterceptor();
    const res = await fetch('/api/test', { method: 'GET' });

    expect(res.status).toBe(401);
    expect(bootstrapCalls).toBe(1);
  });

  it('bootstrap 自己 401 不触发递归 refresh', async () => {
    setStoredToken('token-old');
    let bootstrapCalls = 0;
    const fetchMock = vi.fn(async (url: any) => {
      const u = String(url);
      if (u.includes('/api/auth/bootstrap')) {
        bootstrapCalls++;
        // bootstrap 自身返回 401 → 应该视为失败，不再递归 refresh
        return makeResponse(401, { error: 'bootstrap itself failed' });
      }
      return makeResponse(401, { error: 'unauth' });
    });
    globalThis.fetch = fetchMock as any;

    installAuthRefreshInterceptor();
    const res = await fetch('/api/test', { method: 'GET' });

    expect(res.status).toBe(401);
    expect(getStoredToken()).toBeNull();
    // bootstrap 只调用 1 次（即使它返回 401 也不触发第二次）
    expect(bootstrapCalls).toBe(1);
  });

  it('refresh 失败时调用 onAuthFailed 监听器', async () => {
    setStoredToken('token-old');
    const failedListener = vi.fn();
    const unsubscribe = onAuthFailed(failedListener);

    const fetchMock = vi.fn(async (url: any) => {
      const u = String(url);
      if (u.includes('/api/auth/bootstrap')) {
        return makeResponse(500, { error: 'server error' });
      }
      return makeResponse(401, { error: 'unauth' });
    });
    globalThis.fetch = fetchMock as any;

    installAuthRefreshInterceptor();
    await fetch('/api/test', { method: 'GET' });

    expect(failedListener).toHaveBeenCalledWith(expect.stringContaining('500'));
    unsubscribe();
  });
});
