import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import { ThemeProvider, DEFAULT_FONT_URL, preloadFontByUrl } from './context/ThemeContext';
import { installStreamDevHooks } from './state/streamingStore';
import { installWorkdirSyncChannel } from './components/terminal';

// 2026-07-02: 挂载 streaming dev hook 到 window (perf test / 控制台调试)
// 始终启用, 体积小 (~几百字节), 暴露 applyEvent / getTask / createTask
if (typeof window !== 'undefined') {
  installStreamDevHooks();
  installWorkdirSyncChannel();

  // 2026-07-04 拖动窗口时, 主进程推送 drag-state 事件
  // 渲染器在 <html> 上加 .is-dragging class, CSS 临时禁用所有 backdrop-filter
  // 原因: transparent:true 窗口移动时, backdrop-filter 让 Chromium 重新采样合成
  //   → 拖动卡顿 + 风扇起飞。拖动期间临时禁用可大幅降低合成开销
  const sf = (window as any).soloforge;
  if (sf?.onDragState) {
    sf.onDragState((isDragging: boolean) => {
      document.documentElement.classList.toggle('is-dragging', !!isDragging);
    });
  }

  // 2026-07-04 诊断: 全局 mousedown 捕获器 (capture 阶段), 看事件到底被谁吃了
  // 用于排查 Header 某些区域点击无响应的问题
  window.addEventListener('mousedown', (e: MouseEvent) => {
    const t = e.target as HTMLElement;
    const tag = t.tagName.toLowerCase();
    const cls = (t.className || '').toString().slice(0, 80);
    const edge = t.getAttribute('data-edge') || t.closest('[data-edge]')?.getAttribute('data-edge');
    const winCtrl = !!t.closest('[data-window-controls]');
    console.log('[global-mdown]', { tag, cls, edge, winCtrl, x: e.clientX, y: e.clientY });
  }, true);  // capture: true - 在事件到达任何元素之前先打印
}

// Suppress harmless 'ResizeObserver loop completed with undelivered notifications' browser engine warnings
if (typeof window !== 'undefined') {
  const isResizeObserverError = (msg: any): boolean => {
    if (!msg) return false;
    const str = String(msg).toLowerCase();
    return str.includes('resizeobserver') || 
           str.includes('resize observer') || 
           str.includes('loop limit') ||
           str.includes('undelivered notifications');
  };

  const ignoreResizeObserverError = (e: ErrorEvent) => {
    const msg = e.message || (e.error && e.error.message);
    if (isResizeObserverError(msg)) {
      e.stopImmediatePropagation();
      e.preventDefault();
    }
  };

  window.addEventListener('error', ignoreResizeObserverError, true);

  // Suppress in window.onerror as well
  const originalOnError = window.onerror;
  window.onerror = function (message, source, lineno, colno, error) {
    if (isResizeObserverError(message) || (error && isResizeObserverError(error.message))) {
      return true; // Suppress reporting
    }
    if (originalOnError) {
      return originalOnError.apply(this, arguments as any);
    }
    return false;
  };

  // Suppress in unhandled promise rejections
  window.addEventListener('unhandledrejection', (e: PromiseRejectionEvent) => {
    const msg = e.reason?.message || e.reason;
    if (isResizeObserverError(msg)) {
      e.stopImmediatePropagation();
      e.preventDefault();
    }
  }, true);
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider>
      <App />
    </ThemeProvider>
  </StrictMode>,
);

// 启动时预取默认字体（OPPOSans）。等 ThemeProvider 把 @font-face 注入 <head> 后，
// 浏览器已经看到 <link rel="preload" as="font">，会优先下载，避免首屏中文先以 Inter 渲染再回弹
if (typeof window !== 'undefined' && DEFAULT_FONT_URL) {
  preloadFontByUrl(DEFAULT_FONT_URL);
}
