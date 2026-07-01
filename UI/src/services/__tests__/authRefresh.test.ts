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

    let firstCall = true;
    let secondCallHeaders: Headers | null = null;
    const fetchMock = vi.fn(async (url: any, init?: any) => {
      const u = String(url);
      if (u.includes('/api/auth/bootstrap')) {
        return makeResponse(200, { token: 'token-new' });
      }
      if (firstCall) {
        firstCall = false;
        return makeResponse(401, { error: 'unauth' });
      }
      secondCallHeaders = new Headers(init?.headers);
      return makeResponse(200, { ok: true });
    });
    globalThis.fetch = fetchMock as any;

    installAuthRefreshInterceptor();
    const res = await fetch('/api/test', { method: 'GET' });

    expect(res.status).toBe(200);
    // 第一次业务请求 + bootstrap + 第二次业务请求 = 3 次
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(secondCallHeaders!.get('Authorization')).toBe('Bearer token-new');
    expect(getStoredToken()).toBe('token-new');
  });

  it('并发 401 只触发 1 次 bootstrap (单飞)', async () => {
    setStoredToken('token-old');

    let bootstrapCalls = 0;
    const fetchMock = vi.fn(async (url: any, init?: any) => {
      const u = String(url);
      if (u.includes('/api/auth/bootstrap')) {
        bootstrapCalls++;
        // 模拟慢响应, 让并发请求都进入等待
        await new Promise((r) => setTimeout(r, 20));
        return makeResponse(200, { token: 'token-new' });
      }
      return makeResponse(401, { error: 'unauth' });
    });
    globalThis.fetch = fetchMock as any;

    installAuthRefreshInterceptor();

    const [r1, r2, r3] = await Promise.all([
      fetch('/api/a', { method: 'GET' }),
      fetch('/api/b', { method: 'GET' }),
      fetch('/api/c', { method: 'GET' }),
    ]);

    expect(bootstrapCalls).toBe(1);
    // 每个业务请求 401 → bootstrap → 重发 = 2 次, 3 个请求共 6 次
    // + 1 次 bootstrap = 7 次
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(7);
    // 重发的请求, _retried 标记存在
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
      return makeResponse(401, { error: 'unauth' });
    });
    globalThis.fetch = fetchMock as any;

    installAuthRefreshInterceptor();
    const res = await fetch('/api/test', { method: 'GET' });

    expect(res.status).toBe(401);
    expect(getStoredToken()).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2); // 业务 + bootstrap
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
        return makeResponse(401, { error: 'bootstrap itself failed' });
      }
      return makeResponse(200, {});
    });
    globalThis.fetch = fetchMock as any;

    installAuthRefreshInterceptor();
    const res = await fetch('/api/auth/bootstrap', { method: 'GET' });

    expect(res.status).toBe(401);
    expect(bootstrapCalls).toBe(1); // 仅 1 次, 无递归
  });

  it('onAuthFailed 在 refresh 失败时被调用', async () => {
    setStoredToken('token-old');
    const fetchMock = vi.fn(async (url: any) => {
      const u = String(url);
      if (u.includes('/api/auth/bootstrap')) {
        return makeResponse(500, { error: 'server down' });
      }
      return makeResponse(401, { error: 'unauth' });
    });
    globalThis.fetch = fetchMock as any;

    const listener = vi.fn();
    const unsub = onAuthFailed(listener);

    installAuthRefreshInterceptor();
    await fetch('/api/test', { method: 'GET' });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0][0]).toMatch(/^bootstrap_500$/);
    unsub();
  });

  it('重复 install 是幂等的, 不重复包装 fetch', async () => {
    setStoredToken('token-x');
    const fetchMock = vi.fn(async () => makeResponse(200, {}));
    globalThis.fetch = fetchMock as any;

    installAuthRefreshInterceptor();
    installAuthRefreshInterceptor();
    installAuthRefreshInterceptor();

    await fetch('/api/test', { method: 'GET' });
    // 多次 install 只生效一次, 只调底层 fetch 1 次
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('不修改业务请求传入的 headers, 仅添加 Authorization', async () => {
    setStoredToken('token-xyz');
    const fetchMock = vi.fn(async () => makeResponse(200, {}));
    globalThis.fetch = fetchMock as any;

    installAuthRefreshInterceptor();
    await fetch('/api/test', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Request-Id': 'req-001',
      },
      body: JSON.stringify({ a: 1 }),
    });

    const sentInit = fetchMock.mock.calls[0][1] as any;
    const headers = new Headers(sentInit.headers);
    expect(headers.get('Content-Type')).toBe('application/json');
    expect(headers.get('X-Request-Id')).toBe('req-001');
    expect(headers.get('Authorization')).toBe('Bearer token-xyz');
    // body 没被破坏
    expect(JSON.parse(sentInit.body)).toEqual({ a: 1 });
  });

  it('业务请求自己已经带了 Authorization, 不覆盖', async () => {
    setStoredToken('token-from-storage');
    const fetchMock = vi.fn(async () => makeResponse(200, {}));
    globalThis.fetch = fetchMock as any;

    installAuthRefreshInterceptor();
    await fetch('/api/test', {
      method: 'GET',
      headers: { Authorization: 'Bearer token-from-caller' },
    });

    const sentInit = fetchMock.mock.calls[0][1] as any;
    const headers = new Headers(sentInit.headers);
    expect(headers.get('Authorization')).toBe('Bearer token-from-caller');
  });
});

describe('authRefresh — Electron IPC 模式', () => {
  let originalFetch: typeof fetch;
  let originalSoloforge: any;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalSoloforge = (globalThis as any).window?.soloforge;
    (globalThis as any).window = (globalThis as any).window ?? {};
    (globalThis as any).window.soloforge = {
      dispatchAgent: vi.fn(),
      onAgentEvent: vi.fn(),
    };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalSoloforge === undefined) {
      delete (globalThis as any).window?.soloforge;
    } else {
      (globalThis as any).window.soloforge = originalSoloforge;
    }
  });

  it('Electron 模式下 installAuthRefreshInterceptor 不修改 fetch', async () => {
    const userFetch = vi.fn(async () => makeResponse(200, {}));
    globalThis.fetch = userFetch as any;

    const uninstall = installAuthRefreshInterceptor();

    await fetch('/api/test', { method: 'GET' });
    // 应当直接调用原始 fetch, 没经过拦截器
    expect(userFetch).toHaveBeenCalledTimes(1);
    uninstall?.();
  });
});
