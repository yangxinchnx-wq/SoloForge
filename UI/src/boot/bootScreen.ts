// ─────────────────────────────────────────────────────────────────────
// SoloForge 启动错误屏 (vanilla DOM, 不依赖 React)
// ─────────────────────────────────────────────────────────────────────
//
// 设计目标: 即便整个 React 树挂了, 这个屏依然能渲染。
// 走 document.body 顶层覆盖, 不走 React Root。
//
// 三种调用方式:
//   1. pre-React 阶段 (HTML 里 inline 脚本调用 window.__sfBoot.reportError)
//   2. 组件 mount 失败 (ErrorBoundary 调用 reportBootError)
//   3. 后端 / IPC 超时 (useEffect 探针 setTimeout 调 reportBootError)
//
// 全局只画一次屏, 重复调用只更新信息。
// ─────────────────────────────────────────────────────────────────────

import { lookupBootError } from './bootCodes';

const OVERLAY_ID = '__sf_boot_overlay__';

function escapeHtml(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildOverlayHtml(code: string, detail: string, stack: string): string {
  const meta = lookupBootError(code);
  const safeCode = escapeHtml(code);
  const safeTitle = escapeHtml(meta.title);
  const safeHint = escapeHtml(meta.hint);
  const safeDetail = escapeHtml(detail).slice(0, 4000);
  const safeStack = escapeHtml(stack).slice(0, 8000);
  return `
    <div style="
      position:fixed; inset:0; z-index:2147483647;
      background: radial-gradient(ellipse at center, #1a0a0a 0%, #0a0202 100%);
      color:#ffb4b4; font-family: -apple-system, 'Segoe UI', 'PingFang SC', monospace;
      display:flex; align-items:flex-start; justify-content:center; padding: 40px 20px;
      overflow:auto;
    ">
      <div style="max-width: 920px; width:100%;">
        <div style="
          border: 2px solid #f43f5e; border-radius: 12px; padding: 20px 24px;
          background: rgba(244, 63, 94, 0.08);
          box-shadow: 0 0 80px rgba(244, 63, 94, 0.25);
        ">
          <div style="display:flex; align-items:center; gap:14px; margin-bottom:12px;">
            <div style="
              font-size: 28px; font-weight: 800; letter-spacing: 2px;
              padding: 6px 12px; border-radius: 6px;
              background:#f43f5e; color:#0a0202;
            ">${safeCode}</div>
            <div style="font-size: 18px; font-weight: 700; color:#fff;">${safeTitle}</div>
          </div>
          <div style="font-size: 13px; color:#fda4af; margin-bottom: 16px; line-height: 1.6;">
            ${safeHint}
          </div>
          ${safeDetail ? `
            <div style="font-size: 11px; color:#fcd34d; margin-bottom: 6px; text-transform: uppercase; letter-spacing: 1px;">
              详细信息
            </div>
            <pre style="
              background: rgba(0,0,0,0.5); border: 1px solid rgba(244, 63, 94, 0.3);
              border-radius: 6px; padding: 12px; font-size: 12px; line-height: 1.5;
              color:#fecaca; white-space: pre-wrap; word-break: break-word;
              max-height: 220px; overflow:auto;
            ">${safeDetail}</pre>
          ` : ''}
          ${safeStack ? `
            <div style="font-size: 11px; color:#fcd34d; margin: 14px 0 6px; text-transform: uppercase; letter-spacing: 1px;">
              调用栈
            </div>
            <pre style="
              background: rgba(0,0,0,0.5); border: 1px solid rgba(244, 63, 94, 0.3);
              border-radius: 6px; padding: 12px; font-size: 11px; line-height: 1.45;
              color:#a3a3a3; white-space: pre-wrap; word-break: break-word;
              max-height: 280px; overflow:auto;
            ">${safeStack}</pre>
          ` : ''}
          <div style="display:flex; gap: 10px; margin-top: 18px;">
            <button onclick="location.reload()" style="
              background: #f43f5e; color:#0a0202; border:0;
              padding: 10px 18px; border-radius: 6px; font-weight: 700; cursor: pointer;
              font-size: 13px; letter-spacing: 0.5px;
            ">↻ 重新加载</button>
            <button onclick="document.getElementById('${OVERLAY_ID}')?.remove()" style="
              background: transparent; color:#ffb4b4; border: 1px solid #f43f5e;
              padding: 10px 18px; border-radius: 6px; font-weight: 600; cursor: pointer;
              font-size: 13px;
            ">关闭 (尝试继续运行)</button>
            <button onclick="
              navigator.clipboard.writeText(
                window.__sfBoot?.lastError
                  ? JSON.stringify(window.__sfBoot.lastError, null, 2)
                  : 'no error captured'
              ).then(() => this.textContent = '已复制')
            " style="
              background: transparent; color:#fcd34d; border: 1px solid #fcd34d;
              padding: 10px 18px; border-radius: 6px; font-weight: 600; cursor: pointer;
              font-size: 13px;
            ">复制错误 JSON</button>
          </div>
        </div>
        <div style="font-size: 10px; color:#52525b; text-align:center; margin-top: 16px; font-family: monospace;">
          SoloForge BootScreen · 该屏幕由 vanilla DOM 渲染, 不依赖 React / 不依赖主题
        </div>
      </div>
    </div>
  `;
}

let _shown = false;
let _last: unknown = null;

export interface BootErrorPayload {
  code: string;
  detail?: string;
  stack?: string;
  ts?: number;
  source?: string;
  extra?: Record<string, unknown>;
}

function paint(payload: BootErrorPayload) {
  if (typeof document === 'undefined') return;
  // 重入保护: 如果 paint 自己抛错, 全局捕获器会回调 reportBootError,
  // 避免无限递归
  if ((paint as any).__running) {
    // eslint-disable-next-line no-console
    console.error('[BootScreen] recursive paint, aborting', payload.code);
    return;
  }
  (paint as any).__running = true;
  try {
    // 简化: 不用大 template literal, 用 DOM 节点直接构造
    const overlayId = OVERLAY_ID;
    let el = document.getElementById(overlayId) as HTMLDivElement | null;
    if (!el) {
      el = document.createElement('div');
      el.id = overlayId;
      document.body.appendChild(el);
    }
    el.textContent = ''; // 清空, 避免 innerHTML 解析
    const meta = lookupBootError(payload.code);
    const root = document.createElement('div');
    root.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:radial-gradient(ellipse at center,#1a0a0a 0%,#0a0202 100%);color:#ffb4b4;font-family:-apple-system,Segoe UI,PingFang SC,monospace;display:flex;align-items:flex-start;justify-content:center;padding:40px 20px;overflow:auto;';
    const card = document.createElement('div');
    card.style.cssText = 'max-width:920px;width:100%;border:2px solid #f43f5e;border-radius:12px;padding:20px 24px;background:rgba(244,63,94,0.08);box-shadow:0 0 80px rgba(244,63,94,0.25);';
    const head = document.createElement('div');
    head.style.cssText = 'display:flex;align-items:center;gap:14px;margin-bottom:12px;';
    const codeBox = document.createElement('div');
    codeBox.style.cssText = 'font-size:28px;font-weight:800;letter-spacing:2px;padding:6px 12px;border-radius:6px;background:#f43f5e;color:#0a0202;';
    codeBox.textContent = payload.code;
    const titleBox = document.createElement('div');
    titleBox.style.cssText = 'font-size:18px;font-weight:700;color:#fff;';
    titleBox.textContent = meta.title;
    head.appendChild(codeBox);
    head.appendChild(titleBox);
    card.appendChild(head);

    const hint = document.createElement('div');
    hint.style.cssText = 'font-size:13px;color:#fda4af;margin-bottom:16px;line-height:1.6;';
    hint.textContent = meta.hint;
    card.appendChild(hint);

    if (payload.detail) {
      const dt = document.createElement('div');
      dt.style.cssText = 'font-size:11px;color:#fcd34d;margin-bottom:6px;text-transform:uppercase;letter-spacing:1px;';
      dt.textContent = '详细信息';
      const dp = document.createElement('pre');
      dp.style.cssText = 'background:rgba(0,0,0,0.5);border:1px solid rgba(244,63,94,0.3);border-radius:6px;padding:12px;font-size:12px;line-height:1.5;color:#fecaca;white-space:pre-wrap;word-break:break-word;max-height:220px;overflow:auto;';
      dp.textContent = String(payload.detail).slice(0, 4000);
      card.appendChild(dt);
      card.appendChild(dp);
    }
    if (payload.stack) {
      const st = document.createElement('div');
      st.style.cssText = 'font-size:11px;color:#fcd34d;margin:14px 0 6px;text-transform:uppercase;letter-spacing:1px;';
      st.textContent = '调用栈';
      const sp = document.createElement('pre');
      sp.style.cssText = 'background:rgba(0,0,0,0.5);border:1px solid rgba(244,63,94,0.3);border-radius:6px;padding:12px;font-size:11px;line-height:1.45;color:#a3a3a3;white-space:pre-wrap;word-break:break-word;max-height:280px;overflow:auto;';
      sp.textContent = String(payload.stack).slice(0, 8000);
      card.appendChild(st);
      card.appendChild(sp);
    }
    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:10px;margin-top:18px;';
    const reloadBtn = document.createElement('button');
    reloadBtn.textContent = '↻ 重新加载';
    reloadBtn.style.cssText = 'background:#f43f5e;color:#0a0202;border:0;padding:10px 18px;border-radius:6px;font-weight:700;cursor:pointer;font-size:13px;letter-spacing:0.5px;';
    reloadBtn.onclick = () => location.reload();
    const closeBtn = document.createElement('button');
    closeBtn.textContent = '关闭 (尝试继续运行)';
    closeBtn.style.cssText = 'background:transparent;color:#ffb4b4;border:1px solid #f43f5e;padding:10px 18px;border-radius:6px;font-weight:600;cursor:pointer;font-size:13px;';
    closeBtn.onclick = () => document.getElementById(overlayId)?.remove();
    const copyBtn = document.createElement('button');
    copyBtn.textContent = '复制错误 JSON';
    copyBtn.style.cssText = 'background:transparent;color:#fcd34d;border:1px solid #fcd34d;padding:10px 18px;border-radius:6px;font-weight:600;cursor:pointer;font-size:13px;';
    copyBtn.onclick = () => {
      try {
        const last = (window as any).__sfBoot?.lastError;
        navigator.clipboard.writeText(last ? JSON.stringify(last, null, 2) : 'no error').then(
          () => (copyBtn.textContent = '已复制'),
          () => (copyBtn.textContent = '复制失败')
        );
      } catch (_) {
        copyBtn.textContent = '复制失败';
      }
    };
    btnRow.appendChild(reloadBtn);
    btnRow.appendChild(closeBtn);
    btnRow.appendChild(copyBtn);
    card.appendChild(btnRow);
    root.appendChild(card);
    const footer = document.createElement('div');
    footer.style.cssText = 'font-size:10px;color:#52525b;text-align:center;margin-top:16px;font-family:monospace;';
    footer.textContent = 'SoloForge BootScreen · 该屏幕由 vanilla DOM 渲染, 不依赖 React / 不依赖主题';
    root.appendChild(footer);
    el.appendChild(root);

    _shown = true;
    _last = payload;
    // 同步到 window 方便调试 / 复制
    // 注意: 不要整体重赋值, index.html 阶段注册的 __sfBoot.report/cancelProbe 必须保留
    try {
      const existing = (window as any).__sfBoot;
      if (existing && typeof existing === 'object') {
        existing.lastError = payload;
        existing.shown = true;
      } else {
        (window as any).__sfBoot = { shown: true, lastError: payload };
      }
    } catch (err) { console.warn('[BootScreen] 同步 window.__sfBoot 失败:', err); }

    // console 也打印, 配合 DevTools (放最后, 即使抛错也完成主要工作)
    try {
      // eslint-disable-next-line no-console
      console.error(
        `[BootScreen ${payload.code}] ${payload.detail ?? ''}`,
        payload
      );
      if (payload.stack) {
        // eslint-disable-next-line no-console
        console.error(payload.stack);
      }
    } catch (err) { console.warn('[BootScreen] console.error 输出失败:', err); }
  } finally {
    (paint as any).__running = false;
  }
}

/**
 * 报告一个启动错误。立刻在屏幕上画错误码 + 详细信息 + 调用栈。
 * 可以从任何地方调用: pre-React HTML 脚本、ErrorBoundary、useEffect 探针。
 */
export function reportBootError(
  code: string,
  opts: { detail?: string; error?: Error; source?: string; extra?: Record<string, unknown> } = {}
) {
  try {
    const payload: BootErrorPayload = {
      code,
      detail: opts.detail,
      stack: opts.error?.stack,
      source: opts.source,
      ts: Date.now(),
      extra: opts.extra,
    };
    paint(payload);
  } catch (e) {
    // 最后一道保险: 如果 paint 自己炸了, console 一定留痕
    // eslint-disable-next-line no-console
    console.error('[BootScreen] paint failed for', code, e);
  }
}

/**
 * 注册全局捕获器: window.onerror / unhandledrejection → 报告 B999
 * 在 main.tsx 最早的几行调一次即可。
 */
export function installGlobalErrorTrap() {
  if (typeof window === 'undefined') return;
  if ((window as any).__sfBoot?.globalTrapInstalled) return;
  (window as any).__sfBoot = (window as any).__sfBoot ?? {};
  (window as any).__sfBoot.globalTrapInstalled = true;

  const ignoreResizeObserver = (msg: unknown) => {
    if (!msg) return false;
    const s = String(msg).toLowerCase();
    return s.includes('resizeobserver') || s.includes('undelivered notifications') || s.includes('loop limit');
  };

  window.addEventListener(
    'error',
    (ev: ErrorEvent) => {
      if (ignoreResizeObserver(ev.message)) {
        ev.stopImmediatePropagation();
        ev.preventDefault();
        return;
      }
      // 已经被 reportBootError 报过的就不再覆盖 (用 stack 字符串去重)
      if (_shown && _last && ev.error && (ev.error as Error).stack === (_last as BootErrorPayload).stack) return;
      // 过滤纯 "Script error." / 无 error 对象的资源加载失败 (Vite HMR dev 时常见, 不是真业务错误)
      if (!ev.error && (!ev.message || ev.message === 'Script error.')) return;
      if (!ev.error && ev.filename && /\.(png|jpg|jpeg|gif|svg|woff2?|ttf|otf|css|ico)(\?|$)/i.test(ev.filename)) return;
      // 已经被 paint 报过的就不再覆盖 (lastError.code 不是 B999)
      if (_shown && _last && (_last as BootErrorPayload).code !== 'B999') return;
      reportBootError('B999', {
        detail: ev.message || 'window.error',
        error: ev.error instanceof Error ? ev.error : new Error(String(ev.message || 'unknown')),
        source: 'window.error',
        extra: { filename: ev.filename, lineno: ev.lineno, colno: ev.colno },
      });
    },
    true
  );

  window.addEventListener(
    'unhandledrejection',
    (ev: PromiseRejectionEvent) => {
      const reason = ev.reason;
      const msg = reason instanceof Error ? reason.message : String(reason);
      if (ignoreResizeObserver(msg)) {
        ev.stopImmediatePropagation();
        ev.preventDefault();
        return;
      }
      reportBootError('B999', {
        detail: `unhandledrejection: ${msg}`,
        error: reason instanceof Error ? reason : new Error(msg),
        source: 'unhandledrejection',
      });
    },
    true
  );
}

/**
 * 探针: 期望在 timeoutMs 毫秒内调用 mark('ok'), 否则报对应错误码。
 * 用法:
 *   const done = bootProbe('B502', '后端 3001 健康检查超时', 5000);
 *   fetch(...).then(done.ok, done.fail);
 *
 * severity: 'fatal' (默认) = 画错误屏, 整个启动卡住
 *           'warn'         = 只在 console.warn 留痕, 不画屏 (用于非致命探测)
 */
export function bootProbe(
  code: string,
  desc: string,
  timeoutMs: number,
  severity: 'fatal' | 'warn' = 'fatal'
): { ok: () => void; fail: (e?: unknown) => void; cancel: () => void } {
  let done = false;
  const t = setTimeout(() => {
    if (done) return;
    done = true;
    if (severity === 'warn') {
      // eslint-disable-next-line no-console
      console.warn(`[BootScreen warn ${code}] ${desc} (>${timeoutMs}ms)`);
    } else {
      reportBootError(code, { detail: `${desc} (>${timeoutMs}ms)`, source: 'bootProbe' });
    }
  }, timeoutMs);
  return {
    ok: () => {
      if (done) return;
      done = true;
      clearTimeout(t);
    },
    fail: (e?: unknown) => {
      if (done) return;
      done = true;
      clearTimeout(t);
      if (severity === 'warn') {
        // eslint-disable-next-line no-console
        console.warn(`[BootScreen warn ${code}] ${desc}`, e);
      } else {
        reportBootError(code, {
          detail: desc,
          error: e instanceof Error ? e : new Error(String(e)),
          source: 'bootProbe.fail',
        });
      }
    },
    cancel: () => {
      if (done) return;
      done = true;
      clearTimeout(t);
    },
  };
}
