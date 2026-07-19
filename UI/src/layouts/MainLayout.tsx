// ─────────────────────────────────────────────────────────────────
// MainLayout — 主布局组件
// Path: UI/src/layouts/MainLayout.tsx
// 消费 LayoutProvider state,负责列宽 / 拖动状态
// Modal 渲染委托给 ModalRenderer（从 appStore 直接读取状态）
//
// ★ 2026-07-19 重构: 切断 App→MainLayout props 透传链, 消灭"一个部分修改全局刷新"
//   - 所有 store-derived 字段 (mainModel/secModels/mixedTasks/permissionMode/
//     selectedFile/selectedChatId/activeTab/showHistory/showCodeEditor/editorContent/
//     currentThemeId) 改由各叶子组件自己用 useAppStore(selector) 细粒度订阅
//   - bridge (useChatClickCanvasBridge) 下沉到 PreviewPanel 内部调用
//   - MainLayout 只接收非 store 数据 (稳定回调 + modelProviderMap) + 自己读布局字段
//   - 加 React.memo: App 重渲染时若 props 引用稳定则 MainLayout 不重渲染
// ─────────────────────────────────────────────────────────────────

import React, { lazy, Suspense } from 'react';
import Header from '../components/Header';
import ActivityBar from '../components/ActivityBar';
import ChatPanel from '../components/ChatPanel';
import StatusBar from '../components/StatusBar';
import { ModalRenderer } from '../components/ModalRenderer';
import { SidebarResizeHandle, HistoryResizeHandle, PreviewResizeHandle } from '../components/ResizeHandles';
import { useLayoutState, useLayoutStatus } from '../context/LayoutContext';
import { useAppStore } from '../state/appStore';

// ── 面板 lazy 化 (2026-07-18) ──────────────────────────────
// 每个 IDE 面板拆成独立 chunk,首屏只加载核心 (Header/ActivityBar/ChatPanel/StatusBar),
// 其余面板首次渲染时才请求对应 chunk。
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
  handleFileChange: (file: string) => void;
  handleEditorChange: (content: string) => void;
  handleNewFile: () => void;
  onOpenThemeCustomizer: () => void;
  onOpenSettingsModal: () => void;
  onOpenStatsModal: () => void;
  modelProviderMap: Record<string, {
    baseUrl: string; apiKey: string; model: string;
    providerName: string; enabledInSettings: boolean;
  }>;
}

export const MainLayout = React.memo(function MainLayout({
  handleFileChange, handleEditorChange, handleNewFile,
  onOpenThemeCustomizer, onOpenSettingsModal, onOpenStatsModal,
  modelProviderMap,
}: MainLayoutProps) {
  const layoutState = useLayoutState();
  const layoutStatus = useLayoutStatus();
  const { sidebarWidth } = layoutState;
  const { isResizingSidebar } = layoutStatus;
  // ★ 从 appStore 直接订阅布局所需字段 (低频变化, 不随打字/切文件刷新)
  const activeTab = useAppStore((s) => s.activeTab);
  const showHistory = useAppStore((s) => s.showHistory);
  const showCodeEditor = useAppStore((s) => s.showCodeEditor);
  const showFloatingEditor = useAppStore((s) => s.showFloatingEditor);
  // setter 引用稳定, 订阅不触发重渲染
  const setActiveTab = useAppStore((s) => s.setActiveTab);
  const setShowHistory = useAppStore((s) => s.setShowHistory);

  const sidebarVisible = activeTab === 'explorer' || activeTab === 'git' || showCodeEditor;

  return (
    <div className="flex flex-col h-screen w-screen bg-bg text-on-surface overflow-hidden select-none">
      <div className="relative z-[60]" data-theme-region="header">
        <Header
          sidebarWidth={sidebarVisible || showHistory ? sidebarWidth + 48 : 48}
          isResizingSidebar={isResizingSidebar}
        />
      </div>

      <div className="flex flex-1 overflow-hidden relative">
        {/* Column 1: Activity Bar */}
        <div data-theme-region="activity-bar" className="h-full flex shrink-0">
          <ActivityBar
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
                setEditorContent={handleEditorChange}
                onClose={() => setShowHistory(false)}
                width={sidebarWidth}
              />
            </Suspense>
          </div>
        </div>

        {showHistory && <HistoryResizeHandle />}

        {/* Column 4: Main Chat Workspace */}
        <div data-theme-region="chat-panel" className="flex-1 h-full min-w-0">
          <ChatPanel
            modelProviderMap={modelProviderMap}
          />
        </div>

        <PreviewResizeHandle />

        {/* Column 5: Preview Panel (lazy — 自包含, 自己调 bridge hook + 读 store + LayoutContext) */}
        <Suspense fallback={<PanelFallback />}>
          <PreviewPanel />
        </Suspense>
      </div>

      {/* Status Bar */}
      <div data-theme-region="status-bar" className="relative z-50">
        <StatusBar />
      </div>

      {/* Modal 渲染器 — 从 appStore 直接读取状态 */}
      <ModalRenderer
        onEditorChange={handleEditorChange}
      />
    </div>
  );
});
