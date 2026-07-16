/**
 * appStore — 应用全局状态单一数据源（替代 App.tsx 18 个 useState）
 *
 * 设计要点：
 * - subscribeWithSelector：允许组件按字段精准订阅，避免全树重渲染
 * - 持久化字段（selectedFile / fileCache）的 lazy initializer 与原 App.tsx 行为一致
 * - 复杂业务逻辑（防抖保存、字体加载、BroadcastChannel 同步）留在组件层，
 *   通过 setter 调用本 store；store 只负责 state + 简单 setter
 * - 不使用 persist middleware：保持现有 localStorage 读写行为（在 App.tsx effect 中）
 * - 与 chatsStore 平级，chatsStore 管后端权威会话列表，appStore 管 UI 当前选中
 *
 * 重构历史：2026-07-03 由原 App.tsx 的 useState 收敛而来
 */
import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import type { SecondaryModel } from '../types';
import type { PermissionMode } from '../types/streaming';

const DEFAULT_FILE = 'BlogSystem/src/App.vue';

function loadSelectedFile(): string {
  if (typeof window !== 'undefined') {
    return localStorage.getItem('soloforge_selectedFile') || DEFAULT_FILE;
  }
  return DEFAULT_FILE;
}

function loadFileCache(): Record<string, string> {
  if (typeof window !== 'undefined') {
    try {
      const saved = localStorage.getItem('soloforge_fileCache');
      return saved ? JSON.parse(saved) : {};
    } catch {
      return {};
    }
  }
  return {};
}

function loadEditorContent(): string {
  const file = loadSelectedFile();
  const cache = loadFileCache();
  return cache[file] !== undefined ? cache[file] : '';
}

interface AppState {
  // ==================== 模型配置 ====================
  mainModel: string;
  secModels: SecondaryModel[];
  mixedTasks: boolean;
  currentPermissionMode: PermissionMode;

  // ==================== 文件编辑 ====================
  selectedFile: string;
  fileCache: Record<string, string>;
  editorContent: string;

  // ==================== 对话 ====================
  selectedChatId: string;

  // ==================== UI 面板 ====================
  activeTab: string;
  showHistory: boolean;
  showCodeEditor: boolean;

  // ==================== 模态 / toast ====================
  showThemeCustomizer: boolean;
  showSettingsModal: boolean;
  showStatsModal: boolean;
  showLocalLLMPage: boolean;
  showFloatingEditor: boolean;
  activeSettingsChat: { id: string; title: string } | null;
  toastMsg: string | null;

  // ==================== setters ====================
  setMainModel: (v: string) => void;
  setSecModels: (v: SecondaryModel[]) => void;
  setMixedTasks: (v: boolean) => void;
  setCurrentPermissionMode: (v: PermissionMode) => void;
  setSelectedFile: (v: string) => void;
  setFileCache: (
    v: Record<string, string> | ((prev: Record<string, string>) => Record<string, string>),
  ) => void;
  setEditorContent: (v: string) => void;
  setSelectedChatId: (v: string) => void;
  setActiveTab: (v: string) => void;
  setShowHistory: (v: boolean) => void;
  setShowCodeEditor: (v: boolean) => void;
  setShowThemeCustomizer: (v: boolean) => void;
  setShowSettingsModal: (v: boolean) => void;
  setShowStatsModal: (v: boolean) => void;
  setShowLocalLLMPage: (v: boolean) => void;
  setShowFloatingEditor: (v: boolean) => void;
  setActiveSettingsChat: (v: { id: string; title: string } | null) => void;
  setToastMsg: (v: string | null) => void;
}

export const useAppStore = create<AppState>()(
  subscribeWithSelector((set) => ({
    // ---------- 初始值 ----------
    // mainModel 初始为空字符串，等 Header 读取 cherry_providers_v2 后自动选第一个可用模型
    mainModel: '',
    secModels: [],
    mixedTasks: false,
    currentPermissionMode: 'normal',

    selectedFile: loadSelectedFile(),
    fileCache: loadFileCache(),
    editorContent: loadEditorContent(),

    selectedChatId: '1',

    activeTab: 'explorer',
    showHistory: true,
    showCodeEditor: true,

    showThemeCustomizer: false,
    showSettingsModal: false,
    showStatsModal: false,
    showLocalLLMPage: false,
    showFloatingEditor: false,
    activeSettingsChat: null,
    toastMsg: null,

    // ---------- setters ----------
    setMainModel: (v) => set({ mainModel: v }),
    setSecModels: (v) => set({ secModels: v }),
    setMixedTasks: (v) => set({ mixedTasks: v }),
    setCurrentPermissionMode: (v) => set({ currentPermissionMode: v }),
    setSelectedFile: (v) => set({ selectedFile: v }),
    setFileCache: (v) =>
      set((state) => ({
        fileCache: typeof v === 'function' ? (v as (p: Record<string, string>) => Record<string, string>)(state.fileCache) : v,
      })),
    setEditorContent: (v) => set({ editorContent: v }),
    setSelectedChatId: (v) => set({ selectedChatId: v }),
    setActiveTab: (v) => set({ activeTab: v }),
    setShowHistory: (v) => set({ showHistory: v }),
    setShowCodeEditor: (v) => set({ showCodeEditor: v }),
    setShowThemeCustomizer: (v) => set({ showThemeCustomizer: v }),
    setShowSettingsModal: (v) => set({ showSettingsModal: v }),
    setShowStatsModal: (v) => set({ showStatsModal: v }),
    setShowLocalLLMPage: (v) => set({ showLocalLLMPage: v }),
    setShowFloatingEditor: (v) => set({ showFloatingEditor: v }),
    setActiveSettingsChat: (v) => set({ activeSettingsChat: v }),
    setToastMsg: (v) => set({ toastMsg: v }),
  })),
);
