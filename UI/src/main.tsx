import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import { ThemeProvider, DEFAULT_FONT_URL, preloadFontByUrl } from './context/ThemeContext';
import { installStreamDevHooks } from './state/streamingStore';

// 2026-07-02: 挂载 streaming dev hook 到 window (perf test / 控制台调试)
// 始终启用, 体积小 (~几百字节), 暴露 applyEvent / getTask / createTask
if (typeof window !== 'undefined') {
  installStreamDevHooks();
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
