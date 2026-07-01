/**
 * authRefresh.ts — 全局 401 自动 refresh 拦截器（单飞模式）
 *
 * 设计动机:
 *   - 后端 API token 会定期轮换, 客户端缓存的 token 随时可能失效
 *   - 不拦截会导致: 一个组件 token 过期 → 全 App 雪崩 401
 *   - 业界标准解法: axios/fetch 拦截器 + 单飞 (singleflight)
 *
 * 关键设计:
 *   1. 单飞 (Singleflight): N 个并发 401 只触发 1 次 refresh
 *      多个 await 同一个 Promise, 避免 refresh 风暴
 *
 *   2. _retried 标记: 同请求最多重试 1 次
 *      第二次 401 直接放弃, 避免死循环
 *
 *   3. 保护特殊端点:
 *      - /api/auth/bootstrap (refresh 本身) → 不能拦截
 *      - /api/auth/bootstrap 401 → 视为 refresh 失败, 不再重试
 *      - SSE (EventSource) 不走 fetch, 不需要保护
 *      - Electron IPC 走 window.soloforge.*, 不需要保护
 *
 *   4. 401 命中条件:
 *      - 仅业务端点 (与 /api/auth/bootstrap 同源同前缀)
 *      - 响应状态 === 401
 *      - 仅在浏览器模式 (非 Electron renderer)
 *
 * 协议:
 *   POST /api/auth/bootstrap   (无 body, 无 Authorization 头)
 *   → 200 { token: string, count, source }
 *
 * 用法:
 *   // main.tsx 顶部第一行调用
 *   import { installAuthRefreshInterceptor } from './services/authRefresh';
 *   installAuthRefreshInterceptor();
 *
 *   // 监听 refresh 失败 (用于重定向登录/提示用户)
 *   import { onAuthFailed } from './services/authRefresh';
 *   onAuthFailed((reason) => { window.location.href = '/login'; });
 */

const TOKEN_STORAGE_KEY = 'soloforge_backend_token';
const BOOTSTRAP_PATH = '/api/auth/bootstrap';

type FetchFn = typeof fetch;

function getGlobal(): any {
  if (typeof window !== 'undefined') return window as any;
  if (typeof globalThis !== 'undefined') return globalThis as any;
  return undefined;
}

function getLocationHref(): string {
  const g = getGlobal();
  return g?.location?.href ?? 'http://localhost/';
}

function getGlobalFetch(): FetchFn | undefined {
  const g = getGlobal();
  return g?.fetch;
}

// ─── 单飞状态 ────────────────────────────────────────────────────────
let inFlightRefresh: Promise<string | null> | null = null;
let authFailedListeners: Array<(reason: string) => void> = [];

// ─── Token 存储 ──────────────────────────────────────────────────────
function readToken(): string | null {
  const g = getGlobal();
  if (!g) return null;
  try {
    return g.sessionStorage?.getItem?.(TOKEN_STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
}

function writeToken(token: string | null): void {
  const g = getGlobal();
  if (!g?.sessionStorage) return;
  try {
    if (token) {
      g.sessionStorage.setItem(TOKEN_STORAGE_KEY, token);
    } else {
      g.sessionStorage.removeItem(TOKEN_STORAGE_KEY);
    }
  } catch {
    /* sessionStorage 不可用 */
  }
}

// ─── 公开 API ────────────────────────────────────────────────────────
export function getStoredToken(): string | null {
  return readToken();
}

export function setStoredToken(token: string | null): void {
  writeToken(token);
}

export function onAuthFailed(cb: (reason: string) => void): () => void {
  authFailedListeners.push(cb);
  return () => {
    authFailedListeners = authFailedListeners.filter((l) => l !== cb);
  };
}

function notifyAuthFailed(reason: string): void {
  for (const cb of authFailedListeners) {
    try {
      cb(reason);
    } catch (err) {
      console.error('[authRefresh] listener threw:', err);
    }
  }
  const g = getGlobal();
  if (g?.dispatchEvent) {
    g.dispatchEvent(new CustomEvent('soloforge:auth-failed', { detail: { reason } }));
  }
}

// ─── 单飞 Refresh ────────────────────────────────────────────────────
async function refreshOnce(): Promise<string | null> {
  const fetchFn = getGlobalFetch();
  if (!fetchFn) {
    notifyAuthFailed('bootstrap_no_fetch');
    return null;
  }
  try {
    const res = await fetchFn(BOOTSTRAP_PATH, {
      method: 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) {
      writeToken(null);
      notifyAuthFailed(`bootstrap_${res.status}`);
      return null;
    }
    const data = await res.json().catch(() => null);
    const token = data?.token;
    if (typeof token !== 'string' || token.length === 0) {
      writeToken(null);
      notifyAuthFailed('bootstrap_empty_token');
      return null;
    }
    writeToken(token);
    return token;
  } catch (err) {
    writeToken(null);
    notifyAuthFailed(`bootstrap_network_${(err as Error)?.message ?? 'unknown'}`);
    return null;
  }
}

function singleflightRefresh(): Promise<string | null> {
  if (!inFlightRefresh) {
    inFlightRefresh = refreshOnce().finally(() => {
      inFlightRefresh = null;
    });
  }
  return inFlightRefresh;
}

// ─── 拦截器 ──────────────────────────────────────────────────────────
function isProtectedPath(url: string): boolean {
  try {
    const u = new URL(url, getLocationHref());
    return u.pathname === BOOTSTRAP_PATH || u.pathname.startsWith(BOOTSTRAP_PATH + '/');
  } catch {
    return false;
  }
}

function isElectronIpc(): boolean {
  const g = getGlobal();
  return typeof g?.soloforge?.dispatchAgent === 'function';
}

function withAuthHeader(init: RequestInit | undefined, token: string | null): RequestInit {
  if (!token) return init ?? {};
  const headers = new Headers(init?.headers ?? undefined);
  if (!headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  return { ...init, headers };
}

interface RetriedInit extends RequestInit {
  __soloforgeRetried?: boolean;
}

export function installAuthRefreshInterceptor(): () => void {
  const g = getGlobal();
  if (!g) return () => {};
  if (isElectronIpc()) {
    return () => {};
  }
  const target = g as { __soloforgeFetchPatched?: boolean; fetch?: FetchFn };
  if (target.__soloforgeFetchPatched) return () => {};
  const originalFetch = target.fetch;
  if (typeof originalFetch !== 'function') return () => {};
  target.__soloforgeFetchPatched = true;

  const patchedFetch: FetchFn = async function patchedFetch(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const reqInit = init as RetriedInit | undefined;
    const url = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;

    // 1) bootstrap 自己 + 已重试过的请求: 不拦截, 直传
    if (reqInit?.__soloforgeRetried || isProtectedPath(url)) {
      return originalFetch.call(target, input as any, init);
    }

    // 2) 非 http(s) (如 data:, blob:) 不拦截
    const href = getLocationHref();
    if (!/^https?:/i.test(url) && !url.startsWith('/') && !url.startsWith(href)) {
      return originalFetch.call(target, input as any, init);
    }

    // 3) 首次发送: 注入当前 token
    const firstInit = withAuthHeader(init, readToken());
    const firstRes = await originalFetch.call(target, input as any, firstInit as any);

    // 4) 非 401 → 直接返回
    if (firstRes.status !== 401) return firstRes;

    // 5) 401: 单飞 refresh (N 个并发请求只触发 1 次)
    const newToken = await singleflightRefresh();
    if (!newToken) return firstRes;

    // 6) 重发原请求 (带新 token, _retried=true 防死循环)
    const retryHeaders = new Headers(init?.headers ?? undefined);
    retryHeaders.set('Authorization', `Bearer ${newToken}`);
    const retryInit: RetriedInit = {
      ...init,
      __soloforgeRetried: true,
      headers: retryHeaders,
    };
    return originalFetch.call(target, input as any, retryInit as any);
  };

  target.fetch = patchedFetch;

  return () => {
    if (target.__soloforgeFetchPatched) {
      target.fetch = originalFetch;
      target.__soloforgeFetchPatched = false;
    }
  };
}

// ─── 测试/调试辅助 ───────────────────────────────────────────────────
declare global {
  interface WindowEventMap {
    'soloforge:auth-failed': CustomEvent<{ reason: string }>;
  }
}
