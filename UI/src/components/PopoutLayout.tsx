// ─────────────────────────────────────────────────────────────────
// PopoutLayout — 弹出窗口视图 (独立 Editor 窗口)
// Path: UI/src/components/PopoutLayout.tsx
// 从 App.tsx 拆分，复用 SidebarResizeHandle / LayoutProvider state
// ─────────────────────────────────────────────────────────────────

import React from 'react';
import FileExplorer from './FileExplorer';
import SourceCodeEditor from './SourceCodeEditor';
import { SidebarResizeHandle } from './ResizeHandles';
import { useLayoutState, useLayoutStatus } from '../context/LayoutContext';

interface PopoutLayoutProps {
  selectedFile: string;
  handleFileChange: (file: string) => void;
  handleNewFile: () => void;
  editorContent: string;
  handleEditorChange: (content: string) => void;
}

/**
 * 弹出窗口视图
 * 独立 Editor 窗口，走 LayoutProvider 共享拖动 state
 */
export const PopoutLayout: React.FC<PopoutLayoutProps> = ({
  selectedFile, handleFileChange, handleNewFile,
  editorContent, handleEditorChange,
}) => {
  const layoutState = useLayoutState();
  const layoutStatus = useLayoutStatus();
  const { sidebarWidth } = layoutState;
  const { isResizingSidebar } = layoutStatus;

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
