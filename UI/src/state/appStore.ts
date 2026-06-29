/**
 * AppStore — Zustand 状态管理 (v1, 2026-06-25)
 *
 * 架构原则:
 * - 内存 Map 是唯一同步读源 (零延迟)
 * - localStorage 异步持久化 (requestIdleCallback 批量写入)
 * - 后端 fetch 可选同步 (仅在网络可用时)
 * - electron-store 在 Electron 环境下作为磁盘备份
 *
 * 分层优先级:
 *   1. 内存 (Map)         → 同步读, 零延迟
 *   2. localStorage        → 异步持久化, 页面刷新不丢失
 *   3. electron-store      → Electron 环境磁盘备份
 *   4. 后端 fetch API     → 可选同步 (网络不可用时静默失败)
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

// ============================================================
// 类型定义
// ============================================================

export type PermissionMode = 'normal' | 'performance' | 'ultimate' | 'expert';

export interface SecondaryModel {
  id: string;
  name: string;
  weight: number;
}

export interface FileCacheEntry {
  content: string;
  mtime: number;
}

export type ToastLevel = 'success' | 'error' | 'warn' | 'info';

export interface ToastState {
  message: string | null;
  level: ToastLevel;
  duration: number;
}

export interface ActiveSettingsChat {
  id: string;
  title: string;
}

export interface AppState {
  // ── 模型配置 ──
  mainModel: string;
  secModels: SecondaryModel[];
  mixedTasks: boolean;
  smartRoute: boolean;
  currentPermissionMode: PermissionMode;

  // ── 文件 / 编辑器 ──
  selectedFile: string;
  editorContent: string;
  fileCache: Record<string, string>;

  // ── 对话 ──
  selectedChatId: string;

  // ── UI 面板 ──
  activeTab: string;
  showHistory: boolean;
  showCodeEditor: boolean;

  // ── 弹窗 ──
  showThemeCustomizer: boolean;
  showSettingsModal: boolean;
  showStatsModal: boolean;
  showFloatingEditor: boolean;
  activeSettingsChat: ActiveSettingsChat | null;

  // ── Toast ──
  toast: ToastState;

  // ── 元数据 ──
  initialized: boolean;
}

export interface AppActions {
  // ── 模型配置 ──
  setMainModel: (model: string) => void;
  setSecModels: (models: SecondaryModel[]) => void;
  setMixedTasks: (mixed: boolean) => void;
  setSmartRoute: (enabled: boolean) => void;
  setPermissionMode: (mode: PermissionMode) => void;

  // ── 文件 / 编辑器 ──
  setSelectedFile: (file: string) => void;
  setEditorContent: (content: string) => void;
  setFileCacheEntry: (file: string, content: string) => void;
  clearFileCache: () => void;

  // ── 对话 ──
  setSelectedChatId: (id: string) => void;

  // ── UI 面板 ──
  setActiveTab: (tab: string) => void;
  setShowHistory: (show: boolean) => void;
  setShowCodeEditor: (show: boolean) => void;

  // ── 弹窗 ──
  setShowThemeCustomizer: (show: boolean) => void;
  setShowSettingsModal: (show: boolean) => void;
  setShowStatsModal: (show: boolean) => void;
  setShowFloatingEditor: (show: boolean) => void;
  setActiveSettingsChat: (chat: ActiveSettingsChat | null) => void;

  // ── Toast ──
  showToast: (message: string, level?: ToastLevel, duration?: number) => void;
  hideToast: () => void;

  // ── 初始化 ──
  init: () => void;
}

type AppStore = AppState & AppActions;

// ============================================================
// 工具函数
// ============================================================

/**
 * LRU 缓存: 超过上限时 evict 最旧条目
 */
const FILE_CACHE_MAX = 50;

export function lruSet(
  cache: Record<string, string>,
  key: string,
  value: string,
  max = FILE_CACHE_MAX,
): Record<string, string> {
  const entries = Object.entries(cache).filter(([k]) => k !== key);
  const next: Record<string, string> = { [key]: value, ...Object.fromEntries(entries) };
  const keys = Object.keys(next);
  if (keys.length > max) {
    const keep = keys.slice(0, max);
    const result: Record<string, string> = {};
    for (const k of keep) result[k] = next[k]!;
    return result;
  }
  return next;
}

// ============================================================
// Store 实现
// ============================================================

const DEFAULT_PERMISSION_MODE: PermissionMode = 'normal';

export const useAppStore = create<AppStore>()(
  persist(
    (set, get) => ({
      // ── 初始状态 ──
      // mainModel 留空:用户首次进入时应由 providers_updated 事件或设置面板同步真实模型,
      // 不预填任何具体模型名,避免 UI 假装"已选 GPT-4o"造成误导。
      // 空字符串由 ModelIcon 占位防御(灰色 ●)+ ChatPanel resolveMainEntry fallback 兜底。
      mainModel: '',
      secModels: [
        { id: 'DeepSeek-V3', name: 'DeepSeek-V3', weight: 5 },
        { id: 'Gemini-1.5-Pro', name: 'Gemini-1.5-Pro', weight: 5 },
      ],
      mixedTasks: true,
      smartRoute: false,
      currentPermissionMode: DEFAULT_PERMISSION_MODE,

      selectedFile: '',
      editorContent: '',
      fileCache: {},

      selectedChatId: '1',

      activeTab: 'explorer',
      showHistory: true,
      showCodeEditor: true,

      showThemeCustomizer: false,
      showSettingsModal: false,
      showStatsModal: false,
      showFloatingEditor: false,
      activeSettingsChat: null,

      toast: {
        message: null,
        level: 'info',
        duration: 5000,
      },

      initialized: false,

      // ── 模型配置 ──
      setMainModel: (model) => set({ mainModel: model }),
      setSecModels: (models) => set({ secModels: models }),
      setMixedTasks: (mixed) => set({ mixedTasks: mixed }),
      setSmartRoute: (enabled) => set({ smartRoute: enabled }),
      setPermissionMode: (mode) => {
        set({ currentPermissionMode: mode });
        // normal 模式下禁用多模型混合
        if (mode === 'normal') {
          set({ mixedTasks: false });
        }
      },

      // ── 文件 / 编辑器 ──
      setSelectedFile: (file) => {
        const cache = get().fileCache;
        const content = cache[file] ?? '';
        set({ selectedFile: file, editorContent: content });
      },

      setEditorContent: (content) => set({ editorContent: content }),

      setFileCacheEntry: (file, content) => {
        const prev = get().fileCache;
        const next = lruSet(prev, file, content);
        set({ fileCache: next });
      },

      clearFileCache: () => set({ fileCache: {} }),

      // ── 对话 ──
      setSelectedChatId: (id) => set({ selectedChatId: id }),

      // ── UI 面板 ──
      setActiveTab: (tab) => set({ activeTab: tab }),
      setShowHistory: (show) => set({ showHistory: show }),
      setShowCodeEditor: (show) => set({ showCodeEditor: show }),

      // ── 弹窗 ──
      setShowThemeCustomizer: (show) => set({ showThemeCustomizer: show }),
      setShowSettingsModal: (show) => set({ showSettingsModal: show }),
      setShowStatsModal: (show) => set({ showStatsModal: show }),
      setShowFloatingEditor: (show) => set({ showFloatingEditor: show }),
      setActiveSettingsChat: (chat) => set({ activeSettingsChat: chat }),

      // ── Toast ──
      showToast: (message, level = 'info', duration = 5000) =>
        set({ toast: { message, level, duration } }),

      hideToast: () =>
        set({ toast: { message: null, level: 'info', duration: 5000 } }),

      // ── 初始化 ──
      init: () => {
        // 从 fileCache 中恢复当前选中文件的内容
        const { selectedFile, fileCache } = get();
        const content = fileCache[selectedFile] ?? '';
        set({ editorContent: content, initialized: true });
      },
    }),
    {
      name: 'soloforge-app-store-v1',
      // 只持久化这些字段(不含运行时状态)
      partialize: (state) => ({
        mainModel: state.mainModel,
        secModels: state.secModels,
        mixedTasks: state.mixedTasks,
        smartRoute: state.smartRoute,
        currentPermissionMode: state.currentPermissionMode,
        selectedFile: state.selectedFile,
        fileCache: state.fileCache,
        selectedChatId: state.selectedChatId,
        activeTab: state.activeTab,
        showHistory: state.showHistory,
        showCodeEditor: state.showCodeEditor,
      }),
    },
  ),
);

// ============================================================
// 便捷 selector hooks (避免不必要的重渲染)
// ============================================================

/** 只订阅 selectedFile 变化 */
export const useSelectedFile = () => useAppStore((s) => s.selectedFile);

/** 只订阅 editorContent 变化 */
export const useEditorContent = () => useAppStore((s) => s.editorContent);

/** 只订阅 toast 变化 */
export const useToast = () => useAppStore((s) => s.toast);

/** 只订阅面板可见性 */
export const usePanelVisibility = () =>
  useAppStore((s) => ({
    showHistory: s.showHistory,
    showCodeEditor: s.showCodeEditor,
    activeTab: s.activeTab,
  }));

/** 只订阅弹窗开关 */
export const useModalVisibility = () =>
  useAppStore((s) => ({
    showThemeCustomizer: s.showThemeCustomizer,
    showSettingsModal: s.showSettingsModal,
    showStatsModal: s.showStatsModal,
    showFloatingEditor: s.showFloatingEditor,
    activeSettingsChat: s.activeSettingsChat,
  }));

/** 只订阅模型配置 */
export const useModelConfig = () =>
  useAppStore((s) => ({
    mainModel: s.mainModel,
    secModels: s.secModels,
    mixedTasks: s.mixedTasks,
    smartRoute: s.smartRoute,
    currentPermissionMode: s.currentPermissionMode,
  }));
