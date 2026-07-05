import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import { ThemeProvider, DEFAULT_FONT_URL, preloadFontByUrl } from './context/ThemeContext';
import { installStreamDevHooks } from './state/streamingStore';
import { installWorkdirSyncChannel } from './components/terminal';
import { useChatsStore, initChatsEventBridge } from './state/chatsStore';
import { useChatStore } from './state/useChatStore';

// ── 一次性清理: 移除旧版占位 mock 数据 (v1 → v2 迁移) ──────────
// 旧版在 localStorage 里写入了 6 条硬编码假对话 (id 1~6),
// 新版已清空这些占位数据, 需要在启动时把残留清掉
if (typeof window !== 'undefined') {
  const MIGRATION_KEY = 'soloforge_data_version';
  if (localStorage.getItem(MIGRATION_KEY) !== '2') {
    const OLD_TITLES = ['电商平台原型开发', '用户认证 system 设计', 'API 接口文档生成',
      '数据库表结构设计', '支付模块集成方案', '优化建议'];
    // 清理 chats list — 如果里面全是旧占位条目就整个清掉
    try {
      const raw = localStorage.getItem('soloforge_chats_list');
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0
          && parsed.every((c: any) => OLD_TITLES.includes(c.title))) {
          localStorage.removeItem('soloforge_chats_list');
        }
      }
    } catch {}
    // 清理 conversations — 旧占位对话只有 id 1~6
    try {
      const raw = localStorage.getItem('soloforge_conversations');
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          const keys = Object.keys(parsed);
          if (keys.length > 0 && keys.every(k => ['1','2','3','4','5','6'].includes(k))) {
            localStorage.removeItem('soloforge_conversations');
          }
        }
      }
    } catch {}
    // 清理 chat configs — 同理
    try {
      const raw = localStorage.getItem('soloforge_chat_configs');
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          const keys = Object.keys(parsed);
          if (keys.length > 0 && keys.every(k => ['1','2','3','4','5','6'].includes(k))) {
            localStorage.removeItem('soloforge_chat_configs');
          }
        }
      }
    } catch {}
    localStorage.setItem(MIGRATION_KEY, '2');
  }
}

// ── 对话列表 + 消息内容后端化: 启动时从后端加载 ──────────────
// initChatsEventBridge: 让旧的 soloforge-chats-updated / soloforge-selected-chat-changed
//   事件仍能正常分发 (ChatPanel / AgentSettingsModal 等仍订阅这些事件)
// loadFromBackend: 从 /api/chats/list 拉取后端持久化的对话列表
// loadConversationsFromBackend: 从 /api/conversations 拉取所有对话消息 + 配置
//   两者失败都不阻塞 UI, store 降级为空状态
if (typeof window !== 'undefined') {
  initChatsEventBridge();
  useChatsStore.getState().loadFromBackend();
  useChatStore.getState().loadConversationsFromBackend();
}

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
