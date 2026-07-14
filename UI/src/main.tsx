import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import { ThemeProvider, DEFAULT_FONT_URL, preloadFontByUrl } from './context/ThemeContext';
import { installStreamDevHooks } from './state/streamingStore';
import { installWorkdirSyncChannel } from './components/terminal';
import { useChatsStore, initChatsEventBridge } from './state/chatsStore';
import { useChatStore } from './state/useChatStore';
import { initActorSystem } from './services/actorIntegration';
import { installAuthRefreshInterceptor, ensureToken } from './services/authRefresh';
import { getDefaultStore } from './state/settings';

// ── 认证拦截器: 必须在所有其他代码之前安装 ──────────────────────
// patch fetch 以自动注入 auth token, 并在 401 时自动刷新。
// 不安装此拦截器 → /api/settings 等 protected 端点全部 401 →
// 设置无法同步 → cherry_providers_v2 为空 → "主模型未配置" 错误。
if (typeof window !== 'undefined') {
  installAuthRefreshInterceptor();
  // 尽早启动 token 预获取 (单飞, 不阻塞)。
  // patchedFetch 中的 await ensureToken() 会等待此 Promise,
  // 确保所有业务请求在 token 就绪后才发出, 消除首次 401 刷屏。
  ensureToken();
  // 立即初始化设置存储, 触发服务端 → localStorage 同步。
  // 同步完成后会派发 'providers_updated' 事件, App.tsx 据此重建 modelProviderMap。
  getDefaultStore();
}

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

  // ★ 2026-07-14: 并行发起 chats list + conversations 加载
  //   原来是两个独立的异步调用 (各自内部 await), 但由于 patchedFetch 的
  //   ensureToken() 单飞门控, 它们实际是并行的。这里显式用 Promise.allSettled
  //   确保两者都完成后才标记 ready, 便于后续可能的 UI 优化。
  Promise.allSettled([
    useChatsStore.getState().loadFromBackend(),
    useChatStore.getState().loadConversationsFromBackend(),
  ]).then(([chatResult, convResult]) => {
    if (chatResult.status === 'rejected') {
      console.warn('[main] chats list 加载失败:', chatResult.reason);
    }
    if (convResult.status === 'rejected') {
      console.warn('[main] conversations 加载失败:', convResult.reason);
    }
  });

  // 2026-07-10: 初始化 Actor 系统 + 持久化恢复 (P3 集成)
  //   - 从 IndexedDB/localStorage 恢复热状态 (tasks, actors, messages)
  //   - 注册监督策略错误回调
  //   - 失败不阻塞 UI, 降级为纯 streamingStore 模式
  initActorSystem().catch((e) => {
    console.warn('[main] Actor 系统初始化失败, 降级为纯 streamingStore 模式', e);
  });
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

  // ★ 2026-07-14: 移除全局 mousedown 捕获器
  //   原来用于排查 Header 点击问题, 但每次鼠标点击都会 console.log + 序列化 DOM,
  //   在 Electron 中 console.log 走 IPC 到主进程, 高频输出阻塞渲染进程。
  //   问题已修复, 不再需要此诊断探针。
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

// ── 退出前 flush: 确保 SettingsStore 的 pending 写入落盘 ──────────
// Electron 的 localStorage (leveldb) 在异常退出 (kill / crash / 断电) 时
// 可能丢失最后几条写入。beforeunload / pagehide 时主动 flush, 最大化持久化成功率。
// 场景: 用户在设置页输入 apiKey → 关闭窗口 → leveldb 未落盘 → 重启后丢失
if (typeof window !== 'undefined') {
  const flushSettings = () => {
    try {
      getDefaultStore().flushSync();
    } catch {}
  };
  window.addEventListener('beforeunload', flushSettings, { capture: true });
  window.addEventListener('pagehide', flushSettings, { capture: true });
}

// 启动时预取默认字体（OPPOSans）。等 ThemeProvider 把 @font-face 注入 <head> 后，
// 浏览器已经看到 <link rel="preload" as="font">，会优先下载，避免首屏中文先以 Inter 渲染再回弹
if (typeof window !== 'undefined' && DEFAULT_FONT_URL) {
  preloadFontByUrl(DEFAULT_FONT_URL);
}
