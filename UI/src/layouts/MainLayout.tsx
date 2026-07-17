// ─────────────────────────────────────────────────────────────────
// MainLayout — 主布局组件
// Path: UI/src/layouts/MainLayout.tsx
// 消费 LayoutProvider state,负责列宽 / 拖动状态
// Modal 渲染委托给 ModalRenderer（从 appStore 直接读取状态）
// ─────────────────────────────────────────────────────────────────

import React, { lazy, Suspense } from 'react';
import Header from '../components/Header';
import ActivityBar from '../components/ActivityBar';
import ChatPanel from '../components/ChatPanel';
import StatusBar from '../components/StatusBar';
import { ModalRenderer } from '../components/ModalRenderer';
import { SidebarResizeHandle, HistoryResizeHandle, PreviewResizeHandle } from '../components/ResizeHandles';
import { useHotTheme } from '../context/ThemeContext';
import { useLayoutState, useLayoutStatus } from '../context/LayoutContext';
import { useChatClickCanvasBridge } from '../hooks/useChatClickCanvasBridge';
import { useAppStore } from '../state/appStore';
import type { SecondaryModel } from '../types';

// ── 面板 lazy 化 (2026-07-18) ──────────────────────────────
// 每个 IDE 面板拆成独立 chunk,首屏只加载核心 (Header/ActivityBar/ChatPanel/StatusBar),
// 其余面板首次渲染时才请求对应 chunk。
// 收益:
//   - 主 bundle 体积大幅减小 (PreviewPanel 依赖链含 three.js ~600KB+)
//   - React 先渲染应用骨架,面板 chunk 并行加载,感知性能更好
//   - 修改单个面板只影响该 chunk,浏览器缓存命中率更高
const FileExplorer = lazy(() => import('../components/FileExplorer'));
const GitPanel = lazy(() => import('../components/GitPanel'));
const HistoryAndEditorPanel = lazy(() => import('../components/HistoryAndEditorPanel'));
const SourceCodeEditor = lazy(() => import('../components/SourceCodeEditor'));
const PreviewPanel = lazy(() => import('../components/PreviewPanel'));

// 面板加载中的轻量占位 (避免黑屏闪烁)
const PanelFallback = () => (
  <div className="flex items-center justify-center h-full w-full bg-surface/50">
    <div className="w-5 h-5 rounded-full border-2 border-[var(--color-primary)]/20 border-t-[var(--color-primary)] animate-spin" />
  </div>
);

export interface MainLayoutProps {
  mainModel: string;
  setMainModel: (v: string) => void;
  secModels: SecondaryModel[];
  setSecModels: (v: SecondaryModel[]) => void;
  mixedTasks: boolean;
  setMixedTasks: (v: boolean) => void;
  currentPermissionMode: 'normal' | 'performance' | 'ultimate' | 'expert';
  setCurrentPermissionMode: (v: 'normal' | 'performance' | 'ultimate' | 'expert') => void;
  selectedFile: string;
  selectedChatId: string;
  setSelectedChatId: (v: string) => void;
  activeTab: string;
  setActiveTab: (v: string) => void;
  setShowHistory: (v: boolean) => void;
  setShowCodeEditor: (v: boolean) => void;
  showHistory: boolean;
  showCodeEditor: boolean;
  handleFileChange: (file: string) => void;
  handleEditorChange: (content: string) => void;
  handleNewFile: () => void;
  bridge: ReturnType<typeof useChatClickCanvasBridge>;
  onOpenThemeCustomizer: () => void;
  onOpenSettingsModal: () => void;
  onOpenStatsModal: () => void;
  modelProviderMap: Record<string, {
    baseUrl: string; apiKey: string; model: string;
    providerName: string; enabledInSettings: boolean;
  }>;
  onEditorChange: (content: string) => void;
  currentThemeId: string;
  setCurrentThemeId: (v: string) => void;
  editorContent: string;
}

export const MainLayout: React.FC<MainLayoutProps> = ({
  mainModel, setMainModel, secModels, setSecModels, mixedTasks, setMixedTasks,
  currentPermissionMode, setCurrentPermissionMode,
  selectedFile, selectedChatId, setSelectedChatId,
  activeTab, setActiveTab, setShowHistory, setShowCodeEditor, showHistory, showCodeEditor,
  handleFileChange, handleEditorChange, handleNewFile,
  bridge, onOpenThemeCustomizer, onOpenSettingsModal, onOpenStatsModal,
  modelProviderMap, onEditorChange, currentThemeId, setCurrentThemeId, editorContent,
}) => {
  const layoutState = useLayoutState();
  const layoutStatus = useLayoutStatus();
  const { sidebarWidth, previewWidth } = layoutState;
  const { isResizingSidebar, isResizingPreview, dragStartPreviewWidth } = layoutStatus;
  const showFloatingEditor = useAppStore((s) => s.showFloatingEditor);
  const { primaryColorTargets } = useHotTheme();

  const sidebarVisible = activeTab === 'explorer' || activeTab === 'git' || showCodeEditor;

  return (
    <div className="flex flex-col h-screen w-screen bg-bg text-on-surface overflow-hidden select-none">
      <div className="relative z-[60]" data-theme-region="header">
        <Header
          mainModel={mainModel}
          setMainModel={setMainModel}
          secModels={secModels}
          setSecModels={setSecModels}
          mixedTasks={mixedTasks}
          setMixedTasks={setMixedTasks}
          permissionMode={currentPermissionMode}
          sidebarWidth={sidebarVisible || showHistory ? sidebarWidth + 48 : 48}
          isResizingSidebar={isResizingSidebar}
          selectedFile={selectedFile}
          setSelectedFile={handleFileChange}
        />
      </div>

      <div className="flex flex-1 overflow-hidden relative">
        {/* Column 1: Activity Bar */}
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

        {/* Column 2: File Explorer & Source Code Editor */}
        <div
          data-theme-region="editor-explorer"
          className="h-full bg-surface flex flex-col shrink-0 overflow-hidden select-none border-r border-[var(--color-primary)]/20"
          style={{
            width: sidebarVisible ? `${sidebarWidth}px` : '0px',
            opacity: sidebarVisible ? 1 : 0,
            pointerEvents: sidebarVisible ? 'auto' : 'none',
            transition: isResizingSidebar ? 'none' : 'opacity 200ms ease-out',
          } as React.CSSProperties}
        >
          <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', flexShrink: 0, overflow: 'hidden' }}>
            {activeTab === 'explorer' ? (
              <div className="flex-1 flex flex-col overflow-hidden">
                <Suspense fallback={<PanelFallback />}>
                  <FileExplorer
                    selectedFile={selectedFile}
                    setSelectedFile={handleFileChange}
                    onNewFile={handleNewFile}
                    onClose={() => setActiveTab('')}
                    isFloatingEditorOpen={showFloatingEditor}
                  />
                </Suspense>
              </div>
            ) : activeTab === 'git' ? (
              <div className="flex-grow flex flex-col overflow-hidden">
                <Suspense fallback={<PanelFallback />}>
                  <GitPanel onClose={() => setActiveTab('')} />
                </Suspense>
              </div>
            ) : null}

            {activeTab !== 'git' && showCodeEditor && (
              <div className={`${activeTab === 'explorer' ? 'h-[340px] border-t border-[var(--color-primary)]/50' : 'flex-1'} flex flex-col overflow-hidden bg-surface`}>
                <Suspense fallback={<PanelFallback />}>
                  <SourceCodeEditor
                    selectedFile={selectedFile}
                    editorContent={editorContent}
                    setEditorContent={handleEditorChange}
                  />
                </Suspense>
              </div>
            )}
          </div>
        </div>

        {sidebarVisible && <SidebarResizeHandle />}

        {/* Column 3: History Dialogues List */}
        <div
          data-theme-region="editor-explorer"
          className="absolute left-[48px] top-0 bottom-0 z-40 flex flex-col overflow-hidden border-r border-[var(--color-primary)]/20 shadow-[3px_0_18px_rgba(0,0,0,0.32),1px_0_0_rgba(255,255,255,0.02)]"
          style={{
            width: showHistory ? `${sidebarWidth}px` : '0px',
            opacity: showHistory ? 1 : 0,
            pointerEvents: showHistory ? 'auto' : 'none',
            transition: isResizingSidebar ? 'none' : 'opacity 200ms ease-out',
          } as React.CSSProperties}
        >
          <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', flexShrink: 0, overflow: 'hidden' }}>
            <Suspense fallback={<PanelFallback />}>
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
            </Suspense>
          </div>
        </div>

        {showHistory && <HistoryResizeHandle />}

        {/* Column 4: Main Chat Workspace */}
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

        <PreviewResizeHandle />

        {/* Column 5: Preview Panel (lazy — 依赖链含 three.js ~600KB+,首屏延迟加载) */}
        <Suspense fallback={<PanelFallback />}>
          <PreviewPanel
            width={previewWidth}
            isResizing={isResizingPreview}
            dragStartWidth={dragStartPreviewWidth}
            selectedChatId={selectedChatId}
            canvasId={bridge.canvasId}
            canvasReady={bridge.ready}
            canvases={bridge.canvases}
            maxCanvases={bridge.maxCanvases}
            onSelectCanvas={bridge.selectCanvas}
            onCreateCanvas={bridge.createCanvasForChat}
            onRenameCanvas={bridge.renameCanvas}
          />
        </Suspense>
      </div>

      {/* Status Bar */}
      <div data-theme-region="status-bar" className="relative z-50">
        <StatusBar
          currentThemeId={currentThemeId}
          setCurrentThemeId={setCurrentThemeId}
        />
      </div>

      {/* Modal 渲染器 — 从 appStore 直接读取状态 */}
      <ModalRenderer
        onEditorChange={onEditorChange}
        selectedFile={selectedFile}
        editorContent={editorContent}
      />
    </div>
  );
};
