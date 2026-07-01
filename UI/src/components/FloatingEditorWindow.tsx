import React, { useState, useEffect, useRef } from 'react';
import { Pin, X, Code, Maximize2, Minimize2 } from 'lucide-react';
import { useTheme } from '../context/ThemeContext';
import SourceCodeEditor from './SourceCodeEditor';

interface FloatingEditorWindowProps {
  selectedFile: string;
  editorContent: string;
  setEditorContent: (content: string) => void;
  onClose: () => void;
}

export default function FloatingEditorWindow({
  selectedFile,
  editorContent,
  setEditorContent,
  onClose,
}: FloatingEditorWindowProps) {
  const { activeTheme } = useTheme();

  // Settings: Pinned (always on top) and isMaximized
  const [isPinned, setIsPinned] = useState(false);
  const [size, setSize] = useState({ width: 850, height: 600 });
  const [position, setPosition] = useState({ x: 80, y: 50 });

  // Dynamically position in screen center on mount
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const initX = Math.max(30, (window.innerWidth - size.width) / 2);
      const initY = Math.max(30, (window.innerHeight - size.height) / 2);
      setPosition({ x: initX, y: initY });
    }
  }, []);

  // Handle Dragging
  const handleMouseDown = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    // Don't drag when selecting or typing in code areas, scroll bars or interactive inputs
    const isInteractive = target.closest('button, input, textarea, select, [role="button"], a, .cm-editor, pre, code') !== null;
    const isScrollable = target.closest('.overflow-x-auto, .overflow-y-auto') !== null;

    if (isInteractive || isScrollable) {
      return;
    }

    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    const startPosX = position.x;
    const startPosY = position.y;

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const deltaX = moveEvent.clientX - startX;
      const deltaY = moveEvent.clientY - startY;

      const nextX = Math.max(0, Math.min(window.innerWidth - size.width, startPosX + deltaX));
      const nextY = Math.max(0, Math.min(window.innerHeight - size.height, startPosY + deltaY));

      setPosition({ x: nextX, y: nextY });
    };

    const handleMouseUp = () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  };

  // Handle resizing corners
  type Corner = 'tl' | 'tr' | 'bl' | 'br';
  const handleResizeStart = (corner: Corner, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    const startX = e.clientX;
    const startY = e.clientY;
    const startWidth = size.width;
    const startHeight = size.height;
    const startPosX = position.x;
    const startPosY = position.y;

    const minWidth = 550;
    const minHeight = 400;
    const maxWidth = window.innerWidth - 40;
    const maxHeight = window.innerHeight - 40;

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const deltaX = moveEvent.clientX - startX;
      const deltaY = moveEvent.clientY - startY;

      let nextWidth = startWidth;
      let nextHeight = startHeight;
      let nextX = startPosX;
      let nextY = startPosY;

      if (corner === 'br') {
        nextWidth = Math.max(minWidth, Math.min(maxWidth, startWidth + deltaX));
        nextHeight = Math.max(minHeight, Math.min(maxHeight, startHeight + deltaY));
      } else if (corner === 'bl') {
        const potentialWidth = startWidth - deltaX;
        nextWidth = Math.max(minWidth, Math.min(maxWidth, potentialWidth));
        nextHeight = Math.max(minHeight, Math.min(maxHeight, startHeight + deltaY));
        if (potentialWidth >= minWidth && potentialWidth <= maxWidth) {
          nextX = startPosX + deltaX;
        }
      } else if (corner === 'tr') {
        nextWidth = Math.max(minWidth, Math.min(maxWidth, startWidth + deltaX));
        const potentialHeight = startHeight - deltaY;
        nextHeight = Math.max(minHeight, Math.min(maxHeight, potentialHeight));
        if (potentialHeight >= minHeight && potentialHeight <= maxHeight) {
          nextY = startPosY + deltaY;
        }
      } else if (corner === 'tl') {
        const potentialWidth = startWidth - deltaX;
        nextWidth = Math.max(minWidth, Math.min(maxWidth, potentialWidth));
        const potentialHeight = startHeight - deltaY;
        nextHeight = Math.max(minHeight, Math.min(maxHeight, potentialHeight));
        if (potentialWidth >= minWidth && potentialWidth <= maxWidth) {
          nextX = startPosX + deltaX;
        }
        if (potentialHeight >= minHeight && potentialHeight <= maxHeight) {
          nextY = startPosY + deltaY;
        }
      }

      setSize({ width: nextWidth, height: nextHeight });
      setPosition({ x: nextX, y: nextY });
    };

    const handleMouseUp = () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  };

  // Keyboard shortcut listener for Esc to close (unless typing in editor)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        const activeNode = document.activeElement;
        const isEditing = activeNode && (activeNode.tagName === 'INPUT' || activeNode.tagName === 'TEXTAREA' || activeNode.classList.contains('cm-content'));
        if (!isEditing) {
          onClose();
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [onClose]);

  return (
    <div 
      className="fixed inset-0 pointer-events-none select-none overflow-hidden animate-fadeIn"
      style={{ zIndex: isPinned ? 200 : 95 }}
    >
      <div
        style={{
          position: 'absolute',
          left: `${position.x}px`,
          top: `${position.y}px`,
          width: `${size.width}px`,
          height: `${size.height}px`,
          backgroundColor: activeTheme.surface,
          borderColor: activeTheme.outline,
        }}
        className="sf-anim sf-anim-fade-scale pointer-events-auto border rounded-xl shadow-[0_24px_60px_rgba(0,0,0,0.85)] overflow-hidden flex flex-col cursor-default relative backdrop-blur bg-opacity-95"
        onMouseDown={handleMouseDown}
      >
        {/* Resize Handlers */}
        <div 
          onMouseDown={(e) => handleResizeStart('tl', e)} 
          className="absolute top-0 left-0 w-6 h-6 cursor-nwse-resize z-50 pointer-events-auto group/corner select-none"
        >
          <div className="absolute top-1.5 left-1.5 w-3 h-3 border-t-2 border-l-2 border-primary/45 group-hover/corner:border-primary group-hover/corner:scale-110 transition-all pointer-events-none rounded-tl-sm" />
        </div>
        <div 
          onMouseDown={(e) => handleResizeStart('tr', e)} 
          className="absolute top-0 right-0 w-6 h-6 cursor-nesw-resize z-50 pointer-events-auto group/corner select-none"
        >
          <div className="absolute top-1.5 right-1.5 w-3 h-3 border-t-2 border-r-2 border-primary/45 group-hover/corner:border-primary group-hover/corner:scale-110 transition-all pointer-events-none rounded-tr-sm" />
        </div>
        <div 
          onMouseDown={(e) => handleResizeStart('bl', e)} 
          className="absolute bottom-0 left-0 w-6 h-6 cursor-nesw-resize z-50 pointer-events-auto group/corner select-none"
        >
          <div className="absolute bottom-1.5 left-1.5 w-3 h-3 border-b-2 border-l-2 border-primary/45 group-hover/corner:border-primary group-hover/corner:scale-110 transition-all pointer-events-none rounded-bl-sm" />
        </div>
        <div 
          onMouseDown={(e) => handleResizeStart('br', e)} 
          className="absolute bottom-0 right-0 w-6 h-6 cursor-nwse-resize z-50 pointer-events-auto group/corner select-none"
        >
          <div className="absolute bottom-1.5 right-1.5 w-3 h-3 border-b-2 border-r-2 border-primary/45 group-hover/corner:border-primary group-hover/corner:scale-110 transition-all pointer-events-none rounded-br-sm" />
        </div>

        {/* Modal Draggable Header Card */}
        <div className="h-12 border-b border-outline/35 bg-surface/90 backdrop-blur px-4 flex items-center justify-between shrink-0 select-none">
          <div className="flex items-center gap-2 min-w-0 flex-1">
            <div className="p-1 px-1.5 rounded bg-primary/10 text-primary shrink-0">
              <Code className="w-3.5 h-3.5" />
            </div>
            <div className="min-w-0 flex items-center gap-1.5">
              <span className="text-xs font-bold text-on-surface">代码编辑器</span>
              <span className="text-on-surface/40 text-[10px] truncate max-w-[280px] font-mono">({selectedFile})</span>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {/* Pin to top toggle button */}
            <button
              onClick={() => setIsPinned(!isPinned)}
              className={`p-1.5 rounded cursor-pointer transition-all ${
                isPinned 
                  ? 'bg-primary/20 text-primary font-bold shadow-sm' 
                  : 'text-on-surface/40 hover:text-on-surface hover:bg-surface-bright'
              }`}
              title={isPinned ? '取消固定在最前端' : '固定编辑器在最前端 (锁定最上层)'}
            >
              <Pin className={`w-3.5 h-3.5 transform transition-transform duration-150 ${isPinned ? 'rotate-45 text-primary scale-110' : ''}`} />
            </button>

            {/* Close Button */}
            <button
              onClick={onClose}
              className="p-1.5 hover:bg-surface-bright rounded text-on-surface/40 hover:text-white cursor-pointer"
              title="关闭编辑器窗口"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* Floating Editor Container Body */}
        <div className="flex-1 w-full overflow-hidden bg-bg/50 relative">
          <SourceCodeEditor
            selectedFile={selectedFile}
            editorContent={editorContent}
            setEditorContent={setEditorContent}
            isPopoutView={true}
          />
        </div>
      </div>
    </div>
  );
}
