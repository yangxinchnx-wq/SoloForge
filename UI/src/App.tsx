import React, { useState, useEffect, useRef, useCallback, lazy, Suspense } from 'react';
import Header from './components/Header';
import ActivityBar from './components/ActivityBar';
import FileExplorer from './components/FileExplorer';
import GitPanel from './components/GitPanel';
import HistoryAndEditorPanel from './components/HistoryAndEditorPanel';
import SourceCodeEditor from './components/SourceCodeEditor';
import ChatPanel from './components/ChatPanel';
import PreviewPanel from './components/PreviewPanel';
import StatusBar from './components/StatusBar';
// Heavy modals → lazy loaded:
// 首屏只打开 Editor + Chat,ThemeModal/SettingsModal/StatsModal/AgentSettingsModal/FloatingEditor
// 每个都用单独的 chunk,主线程只在用户第一次点击时才下载,降低 TTI
const ThemeModal = lazy(() => import('./components/ThemeModal').then(m => ({ default: m.default })));
const SettingsModal = lazy(() => import('./components/SettingsModal').then(m => ({ default: m.default })));
const StatsModal = lazy(() => import('./components/StatsModal').then(m => ({ default: m.default })));
const FloatingEditorWindow = lazy(() => import('./components/FloatingEditorWindow').then(m => ({ default: m.default })));
const AgentSettingsModal = lazy(() => import('./components/AgentSettingsModal').then(m => ({ default: m.default })));
import { SecondaryModel } from './types';
import { useHotTheme, useStaticTheme, THEME_PRESETS } from './context/ThemeContext';
import { LayoutProvider, useLayoutState, useLayoutStatus } from './context/LayoutContext';
import { SidebarResizeHandle, HistoryResizeHandle, PreviewResizeHandle } from './components/ResizeHandles';
import { MountTransition } from './components/MountTransition';
import { X } from './utils/icons';
import { useChatClickCanvasBridge } from './hooks/useChatClickCanvasBridge';
import { usePreviewBridge } from './hooks/usePreviewBridge';
import { useAppStore } from './state/appStore';
import { useChatsStore } from './state/chatsStore';

const ModalFallback = () => (
  <div className="fixed inset-0 z-[200] flex items-center justify-center pointer-events-none">
    <div className="w-8 h-8 rounded-full border-2 border-[var(--color-primary)]/30 border-t-[var(--color-primary)] animate-spin" />
  </div>
);

export default function App() {
  // ==================== 全局状态（zustand appStore）====================
  // 2026-07-03 重构：原 18 个 useState 收敛到 appStore，消除 MainLayout 37 字段透传
  const {
    mainModel, setMainModel,
    secModels, setSecModels,
    mixedTasks, setMixedTasks,
    currentPermissionMode, setCurrentPermissionMode,
    selectedFile, setSelectedFile,
    fileCache, setFileCache,
    editorContent, setEditorContent,
    selectedChatId, setSelectedChatId,
    activeTab, setActiveTab,
    toastMsg, setToastMsg,
    showHistory, setShowHistory,
    showCodeEditor, setShowCodeEditor,
    showThemeCustomizer, setShowThemeCustomizer,
    showSettingsModal, setShowSettingsModal,
    showStatsModal, setShowStatsModal,
    showFloatingEditor, setShowFloatingEditor,
    activeSettingsChat, setActiveSettingsChat,
  } = useAppStore();

  // ── chatsStore → appStore 单向同步 ──────────────────────────
  // loadFromBackend 完成后 chatsStore.selectedChatId 会更新 (从后端恢复),
  // 需要同步到 appStore.selectedChatId 驱动 UI 渲染。
  // 反向同步由 HistoryAndEditorPanel.handleSelect 双调实现 (setSelectedChatId + selectChat)。
  const chatsStoreSelectedId = useChatsStore((s) => s.selectedChatId);
  useEffect(() => {
    if (chatsStoreSelectedId && chatsStoreSelectedId !== selectedChatId) {
      setSelectedChatId(chatsStoreSelectedId);
    }
  }, [chatsStoreSelectedId]); // 故意不依赖 selectedChatId, 避免循环

  // ── modelProviderMap: 从 cherry_providers_v2 构建, 传给 ChatPanel ──
  const [modelProviderMap, setModelProviderMap] = useState<Record<string, {
    baseUrl: string; apiKey: string; model: string;
    providerName: string; enabledInSettings: boolean;
  }>>({});

  useEffect(() => {
    const buildMap = () => {
      try {
        const saved = localStorage.getItem('cherry_providers_v2');
        if (!saved) return;
        const parsed = JSON.parse(saved);
        if (!Array.isArray(parsed)) return;
        const map: Record<string, {
          baseUrl: string; apiKey: string; model: string;
          providerName: string; enabledInSettings: boolean;
        }> = {};
        for (const prov of parsed) {
          if (!prov.enabled || !prov.apiKey) continue;
          const enabledInSettings = prov.status === 'success';
          // 注册该 provider 下所有启用的模型
          if (Array.isArray(prov.models)) {
            for (const m of prov.models) {
              if (m.enabled) {
                map[m.id] = {
                  baseUrl: prov.baseUrl,
                  apiKey: prov.apiKey,
                  model: m.id,
                  providerName: prov.name,
                  enabledInSettings,
                };
              }
            }
          }
          if (Array.isArray(prov.customModels)) {
            for (const cm of prov.customModels) {
              const id = typeof cm === 'string' ? cm : (cm?.id ?? '');
              if (id && (typeof cm === 'string' || cm.enabled !== false)) {
                map[id] = {
                  baseUrl: prov.baseUrl,
                  apiKey: prov.apiKey,
                  model: id,
                  providerName: prov.name,
                  enabledInSettings,
                };
              }
            }
          }
        }
        setModelProviderMap(map);
      } catch (e) {
        console.error('Error building modelProviderMap', e);
      }
    };
    buildMap();
    window.addEventListener('storage', buildMap);
    window.addEventListener('providers_updated', buildMap);
    return () => {
      window.removeEventListener('storage', buildMap);
      window.removeEventListener('providers_updated', buildMap);
    };
  }, []);

  // Synchronize multi-model mixedTasks based on the active mode (only 'normal' mode needs it disabled)
  useEffect(() => {
    if (currentPermissionMode === 'normal') {
      setMixedTasks(false);
    }
  }, [currentPermissionMode, setMixedTasks]);

  // selectedFile 切换时同步 editorContent（替代原 prevSelectedFile 衍生 state）
  const prevSelectedFileRef = useRef(selectedFile);
  if (selectedFile !== prevSelectedFileRef.current) {
    prevSelectedFileRef.current = selectedFile;
    const content = useAppStore.getState().fileCache[selectedFile] !== undefined
      ? useAppStore.getState().fileCache[selectedFile]
      : '';
    setEditorContent(content);
  }

  // P0: 画布 → chat 自动桥接 (按需画布)
  //   - 监听 selectedChatId 变化 → 拉取该 chat 上次访问的画布
  //   - 若从未访问过, 不自动创建 (allowCreate=false)
  //   - 用户通过 CanvasResourceBar 的 + 按钮或待机状态手动创建
  //   - 把解析出的 canvasId 传给 PreviewPanel; null 时显示待机闪电
  const bridge = useChatClickCanvasBridge({
    chatId: selectedChatId,
    allowCreate: false,
    defaultDescription: '默认画布',
  });
  const activeCanvasId = bridge.canvasId;

  // 2026-07-06 阶段3: AST 预览流桥接 — 监听聊天发送事件, 触发 streamPreviewForChat
  usePreviewBridge();

  const {
    primaryColor,
    primaryColorTargets,
    currentThemeId,
    activeTheme,
    setPrimaryColor,
    setPrimaryColorTargets,
    setCurrentThemeId,
    syncTheme,
  } = useHotTheme();
  const { addCustomFont, setSelectedFont } = useStaticTheme();

  // Unique stable state tracking references to avoid stale closures and infinite loop triggers
  const selectedFileRef = useRef(selectedFile);
  const editorContentRef = useRef(editorContent);
  const fileCacheRef = useRef(fileCache);
  const currentThemeIdRef = useRef(currentThemeId);
  const primaryColorRef = useRef(primaryColor);
  const primaryColorTargetsRef = useRef(primaryColorTargets);

  selectedFileRef.current = selectedFile;
  editorContentRef.current = editorContent;
  fileCacheRef.current = fileCache;
  currentThemeIdRef.current = currentThemeId;
  primaryColorRef.current = primaryColor;
  primaryColorTargetsRef.current = primaryColorTargets;

  // Ref for the debouncing auto-save timer
  const saveTimeoutRef = useRef<any>(null);

  // 稳定的 setter 引用 — 让 memo 过的子组件 (ActivityBar 等) 不被频繁重建
  const onOpenThemeCustomizer = useCallback(() => setShowThemeCustomizer(true), []);
  const onOpenSettingsModal = useCallback(() => setShowSettingsModal(true), []);
  const onOpenStatsModal = useCallback(() => setShowStatsModal(true), []);

  // Clear timeout on unmount
  useEffect(() => {
    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }
    };
  }, []);

  // Interactive Resizing Panel States
  // 2026-07-02 性能修复: sidebarWidth / previewWidth / isResizing* / dragStart* 从顶层 useState
  //   迁移到 LayoutProvider (context/LayoutContext.tsx), 拖动时只重渲染消费 state 的列容器 + handle
  //   App 树其余部分 (Header / FileExplorer / ChatPanel / StatusBar / 3D 画布等) 不再被每帧 60+ 次 setState 拖累
  // mousemove 监听器也搬到 LayoutProvider 里 (附 rAF 节流), 此处不再持有相关 effect

  // Check if we are in popout mode
  const isPopout = typeof window !== 'undefined' && window.location.search.includes('popout=editor');

  // Sync selected file persistence
  // ==========================================
  // 【后端对接提示 - 主会话状态持久化与文件加载】
  // 原先直接通过 localStorage 保存当前选中的文件路径并在本地进行匹配读取。
  // 1. 后端接口设计: GET /api/files/read?path=xxx
  // 2. 切换选定文件时，发起异步请求读取宿主端物理磁盘真实文件：
  //    fetch(`/api/files/read?path=${encodeURIComponent(selectedFile)}`)
  // 3. 将拉取到的真实字符串内容 set 至 editorContent 驱动视图
  // ==========================================
  useEffect(() => {
    if (typeof window !== 'undefined') {
      localStorage.setItem('soloforge_selectedFile', selectedFile);
    }
  }, [selectedFile]);

  // Keep cache updated when user types in editor
  // ==========================================
  // 【后端对接提示 - 代码持久化同步与版本暂存】
  // 原通过内存 fileCache 与 localStorage 来进行本地草稿管理。
  // 后期对接真实文件系统或数据库持久化：
  // 1. 可以设计自动保存机制 (Auto-Save, 比如防抖 debounce 300ms 触发写盘操作)
  // 2. 接口设计: POST /api/files/save, 载荷: { path: selectedFile, content: newContent }
  // 3. 此时可在后端执行真正的物理磁盘写入操作
  // ==========================================
  const handleEditorChange = (newContent: string) => {
    // 立即更新内存中的编辑器状态和缓存，保证打字及界面无任何延迟且文件切换正常
    setEditorContent(newContent);
    const updatedCache = {
      ...fileCache,
      [selectedFile]: newContent
    };
    setFileCache(updatedCache);

    // 清理之前的自动保存定时器实现防抖
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }

    // 设置 1 秒（1000 毫秒）的防抖定时器
    saveTimeoutRef.current = setTimeout(() => {
      if (typeof window !== 'undefined') {
        const latestCache = fileCacheRef.current;
        const latestFile = selectedFileRef.current;
        const latestContent = latestCache[latestFile] || '';

        // 将编辑器内容存入 localStorage
        localStorage.setItem('soloforge_fileCache', JSON.stringify(latestCache));
        
        // 广播保存事件 (驱动状态栏等处的保存就绪状态)
        window.dispatchEvent(new CustomEvent('soloforge-file-saved'));

        // 广播同步事件
        try {
          const channel = new BroadcastChannel('soloforge-editor-sync-channel');
          channel.postMessage({
            type: 'EDIT',
            file: latestFile,
            content: latestContent
          });
          channel.close();
        } catch (e) {
          console.warn(e);
        }
      }
    }, 1000);
  };

  // Broadcast file switching
  const handleFileChange = (file: string) => {
    setSelectedFile(file);
    
    // Check if the switched file is a local font resource Clicked from File Explorer
    const isFont = file.toLowerCase().endsWith('.ttf') || 
                   file.toLowerCase().endsWith('.otf') || 
                   file.toLowerCase().endsWith('.woff') || 
                   file.toLowerCase().endsWith('.woff2');
                   
    if (isFont) {
      const filename = file.substring(file.lastIndexOf('/') + 1);
      const fontNameDisplay = filename.replace(/\.[^/.]+$/, "") + " (Local)";
      const rawContent = fileCacheRef.current[file] || '';
      
      // Seed base64 / dataUrl if not already a data uri
      const fontUrl = rawContent.startsWith('data:') 
        ? rawContent 
        : `data:font/woff2;base64,${btoa(rawContent || 'mock-binary-font-package-data')}`;
      
      addCustomFont(fontNameDisplay, fontUrl);
      setSelectedFont(fontNameDisplay);
      setToastMsg(`已自动从资源管理器加载本地字体「${fontNameDisplay}」并设为激活！`);
    }

    const content = fileCacheRef.current[file] !== undefined ? fileCacheRef.current[file] : '';
    if (typeof window !== 'undefined') {
      try {
        const channel = new BroadcastChannel('soloforge-editor-sync-channel');
        channel.postMessage({
          type: 'FILE_SELECT',
          file: file,
          content: content
        });
        channel.close();
      } catch (e) {
        console.warn(e);
      }
    }
  };

  // Add event listener to support file switching from the breadcrumb navigation bar
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handleCustomChangeFile = (e: Event) => {
      const customEvent = e as CustomEvent;
      if (customEvent.detail && customEvent.detail.file) {
        handleFileChange(customEvent.detail.file);
        setActiveTab('explorer'); // Make sure Explorer is visible!
        setShowHistory(false); // Close overlapping history list on explicit file switch!
      }
    };
    const handleOpenFloatingEditor = () => {
      setShowFloatingEditor(true);
    };
    const handleOpenAgentSettings = (e: Event) => {
      const customEvent = e as CustomEvent;
      if (customEvent.detail && customEvent.detail.id) {
        setActiveSettingsChat({
          id: customEvent.detail.id,
          title: customEvent.detail.title || ''
        });
      }
    };
    const handleGlobalToast = (e: Event) => {
      const customEvent = e as CustomEvent;
      if (customEvent.detail && customEvent.detail.message) {
        setToastMsg(customEvent.detail.message);
      }
    };
    window.addEventListener('soloforge-change-file', handleCustomChangeFile);
    window.addEventListener('soloforge-open-floating-editor', handleOpenFloatingEditor);
    window.addEventListener('soloforge-open-agent-settings', handleOpenAgentSettings);
    window.addEventListener('soloforge-toast', handleGlobalToast);
    return () => {
      window.removeEventListener('soloforge-change-file', handleCustomChangeFile);
      window.removeEventListener('soloforge-open-floating-editor', handleOpenFloatingEditor);
      window.removeEventListener('soloforge-open-agent-settings', handleOpenAgentSettings);
      window.removeEventListener('soloforge-toast', handleGlobalToast);
    };
  }, []);

  // Clear toast after a short period
  useEffect(() => {
    if (toastMsg) {
      const timer = setTimeout(() => {
        setToastMsg(null);
      }, 5000);
      return () => clearTimeout(timer);
    }
  }, [toastMsg]);

  // Synchronize popout window and main tab active sessions dynamically
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const channel = new BroadcastChannel('soloforge-editor-sync-channel');

      const handleMessage = (event: MessageEvent) => {
        const msg = event.data;
        if (!msg) return;

        if (msg.type === 'REQUEST_SYNC') {
          channel.postMessage({
            type: 'RESPONSE_SYNC',
            file: selectedFileRef.current,
            content: editorContentRef.current,
            cache: fileCacheRef.current,
            color: primaryColorRef.current,
            themeId: currentThemeIdRef.current,
            targets: primaryColorTargetsRef.current
          });
        } else if (msg.type === 'RESPONSE_SYNC') {
          if (msg.file && msg.file !== selectedFileRef.current) {
            setSelectedFile(msg.file);
          }
          if (msg.content !== undefined && msg.content !== editorContentRef.current) {
            setEditorContent(msg.content);
          }
          if (msg.themeId || msg.color || msg.targets) {
            syncTheme(
              msg.themeId || currentThemeIdRef.current,
              msg.color || primaryColorRef.current,
              msg.targets || primaryColorTargetsRef.current
            );
          }
          if (msg.cache) {
            const sPrev = JSON.stringify(fileCacheRef.current);
            const sNext = JSON.stringify(msg.cache);
            if (sPrev !== sNext) {
              setFileCache(msg.cache);
              localStorage.setItem('soloforge_fileCache', sNext);
            }
          }
        } else if (msg.type === 'FILE_SELECT') {
          if (msg.file && msg.file !== selectedFileRef.current) {
            setSelectedFile(msg.file);
          }
          if (msg.content !== undefined && msg.content !== editorContentRef.current) {
            setEditorContent(msg.content);
          }
        } else if (msg.type === 'EDIT') {
          setFileCache(prev => {
            const currentVal = prev[msg.file];
            if (currentVal === msg.content) return prev;
            const updated = { ...prev, [msg.file]: msg.content };
            localStorage.setItem('soloforge_fileCache', JSON.stringify(updated));
            return updated;
          });
          if (msg.file === selectedFileRef.current && msg.content !== editorContentRef.current) {
            setEditorContent(msg.content);
          }
        } else if (msg.type === 'THEME_SELECT' || msg.type === 'THEME_SYNC') {
          if (msg.themeId || msg.color || msg.targets) {
            syncTheme(
              msg.themeId || currentThemeIdRef.current,
              msg.color || primaryColorRef.current,
              msg.targets || primaryColorTargetsRef.current
            );
          }
        } else if (msg.type === 'JUMP_TO_EXPLORER') {
          setActiveTab('explorer');
          if (msg.toast) {
            setToastMsg(msg.toast);
          }
        }
      };

      channel.addEventListener('message', handleMessage);

      if (window.location.search.includes('popout=editor')) {
        channel.postMessage({ type: 'REQUEST_SYNC' });
      }

      return () => {
        channel.removeEventListener('message', handleMessage);
        channel.close();
      };
    } catch (e) {
      console.warn('BroadcastChannel initialization warning:', e);
    }
  }, []);

  const handleNewFile = () => {
    const fileName = prompt('请输入新文件名:', 'index.html');
    if (fileName) {
      alert(`已成功在 workspace 中虚拟创建文件: ${fileName}`);
    }
  };

  if (isPopout) {
    // Popout 窗口也走 LayoutProvider — 保持拖动行为与主窗口一致
    return (
      <LayoutProvider>
        <PopoutLayout
          selectedFile={selectedFile}
          handleFileChange={handleFileChange}
          handleNewFile={handleNewFile}
          editorContent={editorContent}
          handleEditorChange={handleEditorChange}
          primaryColorTargets={primaryColorTargets}
        />
      </LayoutProvider>
    );
  }

  return (
    <LayoutProvider>
    <MainLayout
      mainModel={mainModel}
      setMainModel={setMainModel}
      secModels={secModels}
      setSecModels={setSecModels}
      mixedTasks={mixedTasks}
      setMixedTasks={setMixedTasks}
      currentPermissionMode={currentPermissionMode}
      setCurrentPermissionMode={setCurrentPermissionMode}
      selectedFile={selectedFile}
      setSelectedFile={setSelectedFile}
      selectedChatId={selectedChatId}
      setSelectedChatId={setSelectedChatId}
      activeTab={activeTab}
      setActiveTab={setActiveTab}
      toastMsg={toastMsg}
      setToastMsg={setToastMsg}
      showHistory={showHistory}
      setShowHistory={setShowHistory}
      showCodeEditor={showCodeEditor}
      setShowCodeEditor={setShowCodeEditor}
      showThemeCustomizer={showThemeCustomizer}
      setShowThemeCustomizer={setShowThemeCustomizer}
      showSettingsModal={showSettingsModal}
      setShowSettingsModal={setShowSettingsModal}
      showStatsModal={showStatsModal}
      setShowStatsModal={setShowStatsModal}
      showFloatingEditor={showFloatingEditor}
      setShowFloatingEditor={setShowFloatingEditor}
      activeSettingsChat={activeSettingsChat}
      setActiveSettingsChat={setActiveSettingsChat}
      primaryColor={primaryColor}
      primaryColorTargets={primaryColorTargets}
      currentThemeId={currentThemeId}
      activeTheme={activeTheme}
      setPrimaryColor={setPrimaryColor}
      setPrimaryColorTargets={setPrimaryColorTargets}
      setCurrentThemeId={setCurrentThemeId}
      handleFileChange={handleFileChange}
      handleEditorChange={handleEditorChange}
      handleNewFile={handleNewFile}
      editorContent={editorContent}
      bridge={bridge}
      activeCanvasId={activeCanvasId}
      onOpenThemeCustomizer={onOpenThemeCustomizer}
      onOpenSettingsModal={onOpenSettingsModal}
      onOpenStatsModal={onOpenStatsModal}
      modelProviderMap={modelProviderMap}
    />
    </LayoutProvider>
  );
}

// ─────────────────────────────────────────────────────────────────
// MainLayout — 消费 LayoutProvider state,负责列宽 / previewWidth / 拖动状态
//   拆成子组件的目的: 让 LayoutProvider 的 state 改变时,App() 函数 (持有一堆
//   与拖动无关的 state) 不参与重渲染, 整树更省
// ─────────────────────────────────────────────────────────────────
interface MainLayoutProps {
  mainModel: string;
  setMainModel: (v: string) => void;
  secModels: SecondaryModel[];
  setSecModels: (v: SecondaryModel[]) => void;
  mixedTasks: boolean;
  setMixedTasks: (v: boolean) => void;
  currentPermissionMode: 'normal' | 'performance' | 'ultimate' | 'expert';
  setCurrentPermissionMode: (v: 'normal' | 'performance' | 'ultimate' | 'expert') => void;
  selectedFile: string;
  setSelectedFile: (v: string) => void;
  selectedChatId: string;
  setSelectedChatId: (v: string) => void;
  activeTab: string;
  setActiveTab: (v: string) => void;
  toastMsg: string | null;
  setToastMsg: (v: string | null) => void;
  showHistory: boolean;
  setShowHistory: (v: boolean) => void;
  showCodeEditor: boolean;
  setShowCodeEditor: (v: boolean) => void;
  showThemeCustomizer: boolean;
  setShowThemeCustomizer: (v: boolean) => void;
  showSettingsModal: boolean;
  setShowSettingsModal: (v: boolean) => void;
  showStatsModal: boolean;
  setShowStatsModal: (v: boolean) => void;
  showFloatingEditor: boolean;
  setShowFloatingEditor: (v: boolean) => void;
  activeSettingsChat: { id: string; title: string } | null;
  setActiveSettingsChat: (v: { id: string; title: string } | null) => void;
  primaryColor: string;
  primaryColorTargets: any;
  currentThemeId: string;
  activeTheme: any;
  setPrimaryColor: (v: string) => void;
  setPrimaryColorTargets: (v: any) => void;
  setCurrentThemeId: (v: string) => void;
  handleFileChange: (file: string) => void;
  handleEditorChange: (content: string) => void;
  handleNewFile: () => void;
  editorContent: string;
  bridge: any;
  activeCanvasId: string | null;
  onOpenThemeCustomizer: () => void;
  onOpenSettingsModal: () => void;
  onOpenStatsModal: () => void;
  modelProviderMap: Record<string, {
    baseUrl: string; apiKey: string; model: string;
    providerName: string; enabledInSettings: boolean;
  }>;
}

const MainLayout: React.FC<MainLayoutProps> = ({
  mainModel, setMainModel, secModels, setSecModels, mixedTasks, setMixedTasks,
  currentPermissionMode, setCurrentPermissionMode,
  selectedFile, setSelectedFile, selectedChatId, setSelectedChatId,
  activeTab, setActiveTab, toastMsg, setToastMsg,
  showHistory, setShowHistory, showCodeEditor, setShowCodeEditor,
  showThemeCustomizer, setShowThemeCustomizer,
  showSettingsModal, setShowSettingsModal, showStatsModal, setShowStatsModal,
  showFloatingEditor, setShowFloatingEditor,
  activeSettingsChat, setActiveSettingsChat,
  primaryColor, primaryColorTargets, currentThemeId, activeTheme,
  setPrimaryColor, setPrimaryColorTargets, setCurrentThemeId,
  handleFileChange, handleEditorChange, handleNewFile, editorContent,
  bridge, activeCanvasId,
  onOpenThemeCustomizer, onOpenSettingsModal, onOpenStatsModal,
  modelProviderMap,
}) => {
  const layoutState = useLayoutState();
  const layoutStatus = useLayoutStatus();
  const { sidebarWidth, previewWidth } = layoutState;
  const { isResizingSidebar, isResizingPreview, dragStartSidebarWidth, dragStartPreviewWidth } = layoutStatus;

  return (
    <div
      className="flex flex-col h-screen w-screen bg-bg text-on-surface overflow-hidden select-none"
    >
      <div
        className="relative z-[60]"
        data-theme-region="header"
      >
        <Header
          mainModel={mainModel}
          setMainModel={setMainModel}
          secModels={secModels}
          setSecModels={setSecModels}
          mixedTasks={mixedTasks}
          setMixedTasks={setMixedTasks}
          permissionMode={currentPermissionMode}
          sidebarWidth={activeTab === 'explorer' || activeTab === 'git' || showCodeEditor || showHistory ? sidebarWidth + 48 : 48}
          isResizingSidebar={isResizingSidebar}
          selectedFile={selectedFile}
          setSelectedFile={setSelectedFile}
        />
      </div>

      <div className="flex flex-1 overflow-hidden relative">
        {/* Column 1: Vertical Narrow Activity Bar */}
        <div data-theme-region="activity-bar" className="h-full flex shrink-0">
          <ActivityBar
            activeTab={activeTab}
            setActiveTab={setActiveTab}
            showHistory={showHistory}
            setShowHistory={setShowHistory}
            showCodeEditor={showCodeEditor}
            setShowCodeEditor={setShowCodeEditor}
            onOpenThemeCustomizer={onOpenThemeCustomizer}
            onOpenSettingsModal={onOpenSettingsModal}
            onOpenStatsModal={onOpenStatsModal}
          />
        </div>

        {/* Column 2: File Explorer & Source Code Editor stacked (If active) */}
        <div
          data-theme-region="editor-explorer"
          className="h-full bg-surface flex flex-col shrink-0 overflow-hidden select-none border-r border-[var(--color-primary)]/20"
          style={{
            // 2026-07-02 性能修复: 拖动期间不要直接改 column width, 否则 313 元素子树 layout 100ms+
            //   - isResizingSidebar 期间 width 锁在 dragStartSidebarWidth (不变), 用 transform 视觉偏移
            //   - mouseup 时 width 才真正变为 sidebarWidth (commit 一次 layout)
            //   - transform 走 GPU 合成层, 完全跳过 layout/paint
            // 2026-07-03 主题优化: --color-primary 改由 data-theme-region + :root dataset 驱动,
            //   primaryColorTargets 变化不再触发 React 重渲染 (CSS 变量级联)
            width: (activeTab === 'explorer' || activeTab === 'git' || showCodeEditor)
              ? (isResizingSidebar ? `${dragStartSidebarWidth}px` : `${sidebarWidth}px`)
              : '0px',
            transform: isResizingSidebar
              ? `translate3d(${sidebarWidth - dragStartSidebarWidth}px, 0, 0)`
              : undefined,
            willChange: isResizingSidebar ? 'transform' : 'auto',
            opacity: (activeTab === 'explorer' || activeTab === 'git' || showCodeEditor) ? 1 : 0,
            pointerEvents: (activeTab === 'explorer' || activeTab === 'git' || showCodeEditor) ? 'auto' : 'none',
            transition: isResizingSidebar ? 'none' : 'width 250ms cubic-bezier(0.16, 1, 0.3, 1), opacity 200ms ease-out',
          } as React.CSSProperties}
        >
          <div
            style={{
              width: isResizingSidebar ? `${dragStartSidebarWidth}px` : '100%',
              height: '100%',
              display: 'flex',
              flexDirection: 'column',
              flexShrink: 0,
              overflow: 'hidden'
            }}
          >
            {/* Conditional Sub-panels */}
            {activeTab === 'explorer' ? (
              <div className="flex-1 flex flex-col overflow-hidden">
                <FileExplorer 
                  selectedFile={selectedFile} 
                  setSelectedFile={handleFileChange}
                  onNewFile={handleNewFile}
                  onClose={() => setActiveTab('')}
                  isFloatingEditorOpen={showFloatingEditor}
                />
              </div>
            ) : activeTab === 'git' ? (
              <div className="flex-grow flex flex-col overflow-hidden">
                <GitPanel onClose={() => setActiveTab('')} />
              </div>
            ) : null}

            {/* Source Code Editor (Bottom half or master panel, optional) */}
            {activeTab !== 'git' && showCodeEditor && (
              <div className={`${activeTab === 'explorer' ? 'h-[340px] border-t border-[var(--color-primary)]/50' : 'flex-1'} flex flex-col overflow-hidden bg-surface`}>
                <SourceCodeEditor 
                  selectedFile={selectedFile}
                  editorContent={editorContent}
                  setEditorContent={handleEditorChange}
                />
              </div>
            )}
          </div>
        </div>

        {/* Drag Resizer for Left Sidebar */}
        {(activeTab === 'explorer' || activeTab === 'git' || showCodeEditor) && (
          <SidebarResizeHandle />
        )}

        {/* Column 3: History Dialogues List */}
        <div
          data-theme-region="editor-explorer"
          className="absolute left-[48px] top-0 bottom-0 z-40 flex flex-col overflow-hidden border-r border-[var(--color-primary)]/20 shadow-[4px_0_15px_rgba(0,0,0,0.22)]"
          style={{
            // 2026-07-02 性能修复: 拖动期间 History 面板 width 锁在 dragStart, 用 transform 偏移
            //   - width 变化 → HistoryPanel 内部所有消息重新 layout, 大列表尤其卡
            //   - transform 走 GPU 合成层, 不触发 layout
            // 2026-07-03 主题优化: --color-primary 由 data-theme-region 驱动 (CSS 变量级联)
            width: showHistory
              ? (isResizingSidebar ? `${dragStartSidebarWidth}px` : `${sidebarWidth}px`)
              : '0px',
            transform: isResizingSidebar
              ? `translate3d(${sidebarWidth - dragStartSidebarWidth}px, 0, 0)`
              : undefined,
            willChange: isResizingSidebar ? 'transform' : 'auto',
            opacity: showHistory ? 1 : 0,
            pointerEvents: showHistory ? 'auto' : 'none',
            transition: isResizingSidebar ? 'none' : 'width 250ms cubic-bezier(0.16, 1, 0.3, 1), opacity 200ms ease-out',
          } as React.CSSProperties}
        >
          <div
            style={{
              width: isResizingSidebar ? `${dragStartSidebarWidth}px` : '100%',
              height: '100%',
              display: 'flex',
              flexDirection: 'column',
              flexShrink: 0,
              overflow: 'hidden'
            }}
          >
            <HistoryAndEditorPanel 
              isResizing={isResizingSidebar}
              selectedFile={selectedFile}
              selectedChatId={selectedChatId}
              setSelectedChatId={setSelectedChatId}
              editorContent={editorContent}
              setEditorContent={handleEditorChange}
              onClose={() => setShowHistory(false)}
              width={sidebarWidth}
              parentPermissionMode={currentPermissionMode}
              onPermissionChange={setCurrentPermissionMode}
              isFloatingEditorOpen={showFloatingEditor}
            />
          </div>
        </div>

        {/* Drag Resizer for absolute History Panel */}
        {showHistory && <HistoryResizeHandle />}

        {/* Column 4: Main Chat Workspace Output Pane + Terminal Logs */}
        <div data-theme-region="chat-panel" className="flex-1 h-full min-w-0">
          <ChatPanel 
            permissionMode={currentPermissionMode} 
            setPermissionMode={setCurrentPermissionMode} 
            primaryColorTargets={primaryColorTargets}
            selectedChatId={selectedChatId}
            mainModel={mainModel}
            secModels={secModels}
            mixedTasks={mixedTasks}
            selectedFile={selectedFile}
            editorContent={editorContent}
            modelProviderMap={modelProviderMap}
          />
        </div>

        {/* Right Drag Resizer for Preview Panel */}
        <PreviewResizeHandle />

        {/* Column 5: Right Column Interactive Preview Web Application */}
        <PreviewPanel
          width={previewWidth}
          isResizing={isResizingPreview}
          dragStartWidth={dragStartPreviewWidth}
          selectedChatId={selectedChatId}
          canvasId={activeCanvasId}
          canvasReady={bridge.ready}
          canvases={bridge.canvases}
          maxCanvases={bridge.maxCanvases}
          onSelectCanvas={(id) => bridge.selectCanvas(id)}
          onCreateCanvas={() => bridge.createCanvasForChat()}
          onRenameCanvas={(id, desc) => bridge.renameCanvas(id, desc)}
        />
      </div>

      {/* Micro Status Bar indicator at the very bottom */}
      <div
        data-theme-region="status-bar"
        className="relative z-50"
      >
        <StatusBar
          currentThemeId={currentThemeId}
          setCurrentThemeId={setCurrentThemeId}
        />
      </div>

      {/* Theme Customizer modal pop-over */}
      <Suspense fallback={<ModalFallback />}>
        {showThemeCustomizer && (
          <ThemeModal
            onClose={() => setShowThemeCustomizer(false)}
            primaryColor={primaryColor}
            setPrimaryColor={setPrimaryColor}
            currentThemeId={currentThemeId}
            setCurrentThemeId={setCurrentThemeId}
            primaryColorTargets={primaryColorTargets}
            setPrimaryColorTargets={setPrimaryColorTargets}
          />
        )}
      </Suspense>

      {/* Geek Settings Modal (13 Core Modules) */}
      <MountTransition show={showSettingsModal} variant="fade" className="fixed inset-0 z-[1000]">
        <Suspense fallback={<ModalFallback />}>
          {showSettingsModal && (
            <SettingsModal
              onClose={() => setShowSettingsModal(false)}
              permissionMode={currentPermissionMode}
            />
          )}
        </Suspense>
      </MountTransition>

      {/* AI & Token Audit statistics popup */}
      <MountTransition show={showStatsModal} variant="fade-scale" className="fixed inset-0 z-[1000]">
        <Suspense fallback={<ModalFallback />}>
          {showStatsModal && (
            <StatsModal
              onClose={() => setShowStatsModal(false)}
            />
          )}
        </Suspense>
      </MountTransition>

      {/* Floating Draggable & Pinnable Code Editor Window */}
      <MountTransition show={showFloatingEditor} variant="fade-scale" duration={220}>
        <Suspense fallback={<ModalFallback />}>
          {showFloatingEditor && (
            <FloatingEditorWindow
              selectedFile={selectedFile}
              editorContent={editorContent}
              setEditorContent={handleEditorChange}
              onClose={() => setShowFloatingEditor(false)}
            />
          )}
        </Suspense>
      </MountTransition>

      {/* Global Exclusive Agent Settings Customizer Overlay */}
      <MountTransition show={!!activeSettingsChat} variant="fade-scale">
        <Suspense fallback={<ModalFallback />}>
          {activeSettingsChat && (
            <AgentSettingsModal
              chatId={activeSettingsChat.id}
              chatTitle={activeSettingsChat.title}
              onClose={() => setActiveSettingsChat(null)}
            />
          )}
        </Suspense>
      </MountTransition>

      {/* Premium Toast Notification Banner */}
      <MountTransition show={!!toastMsg} variant="slide-up" duration={250}>
        {toastMsg && (
          <div
            style={{ left: '50%', transform: 'translateX(-50%)' }}
            className="fixed top-6 z-[9999] bg-[#17181c] border border-[var(--color-primary)]/30 rounded-xl px-4 py-3 shadow-[0_12px_40px_rgba(0,0,0,0.5)] flex items-center gap-3 max-w-md w-max"
          >
            <div className="flex flex-col min-w-0 pr-1 select-text">
              <span className="text-[11px] font-bold text-white tracking-wide">工作区跳转定位通知</span>
              <p className="text-[10px] text-on-surface/75 leading-relaxed">{toastMsg}</p>
            </div>
            <button
              onClick={() => setToastMsg(null)}
              className="text-on-surface/40 hover:text-white transition-colors p-1"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
      </MountTransition>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// PopoutLayout — 弹出窗口视图 (独立 Editor 窗口), 走 LayoutProvider
//   复用 SidebarResizeHandle / state.sidebarWidth, 拖动行为与主窗口一致
// ─────────────────────────────────────────────────────────────────
interface PopoutLayoutProps {
  selectedFile: string;
  handleFileChange: (file: string) => void;
  handleNewFile: () => void;
  editorContent: string;
  handleEditorChange: (content: string) => void;
  primaryColorTargets: any;
}

const PopoutLayout: React.FC<PopoutLayoutProps> = ({
  selectedFile, handleFileChange, handleNewFile,
  editorContent, handleEditorChange, primaryColorTargets,
}) => {
  const layoutState = useLayoutState();
  const layoutStatus = useLayoutStatus();
  const { sidebarWidth } = layoutState;
  const { isResizingSidebar, dragStartSidebarWidth } = layoutStatus;

  return (
    <div
      className="flex flex-col h-screen w-screen bg-bg text-on-surface overflow-hidden select-none font-sans"
    >
      {/* Dynamic Custom Top-Bar for Popout Window */}
      <div className="h-10 border-b border-[var(--color-primary)]/20 bg-surface px-4 flex items-center justify-between shrink-0 select-none">
        <div className="flex items-center gap-2">
          <div className="w-2.5 h-2.5 rounded-full bg-amber-400 shrink-0" />
          <span className="text-[12px] font-bold text-[var(--color-primary)] tracking-wider uppercase">SoloForge IDE - 编程视图 (窗口模式)</span>
        </div>
        <div className="text-[10px] text-on-surface/40 font-mono flex items-center gap-2">
          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded bg-emerald-500/15 text-emerald-400 font-sans text-[9px] font-bold tracking-wide border border-emerald-500/25">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
            双向工作区实时通信已建立
          </span>
        </div>
      </div>

      {/* Core Layout split pane */}
      <div className="flex flex-1 overflow-hidden relative">
        {/* File Explorer sidebar */}
        <div
          className="h-full bg-surface flex flex-col shrink-0 overflow-hidden"
          style={{
            width: `${sidebarWidth}px`,
            transition: isResizingSidebar ? 'none' : 'width 250ms cubic-bezier(0.16, 1, 0.3, 1)',
          }}
        >
          <div
            data-theme-region="editor-explorer"
            className="flex-grow h-full w-full overflow-hidden"
          >
            <FileExplorer
              selectedFile={selectedFile}
              setSelectedFile={handleFileChange}
              onNewFile={handleNewFile}
            />
          </div>
        </div>

        {/* Drag Resizer for Sidebar — 走 SidebarResizeHandle,共享 LayoutProvider state */}
        <SidebarResizeHandle />

        {/* Source Code Editor */}
        <div
          data-theme-region="editor-explorer"
          className="flex-1 h-full overflow-hidden bg-surface flex flex-col"
        >
          <SourceCodeEditor
            selectedFile={selectedFile}
            editorContent={editorContent}
            setEditorContent={handleEditorChange}
            isPopoutView={true}
          />
        </div>
      </div>
    </div>
  );
};
