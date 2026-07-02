/**
 * 删除确认弹窗
 * 严格遵守 AGENTS.md 浮动面板设计标准:
 * - 直接 width/height 控制
 * - 4 角触控把手 (resize handles)
 * - 响应式 cursor 反馈
 * - 与主色调保持一致
 */

import React, { useState, useRef, useEffect } from 'react';
import { MountTransition } from './MountTransition';
import { X, AlertTriangle, Trash2 } from 'lucide-react';
import { useHotTheme } from '../context/ThemeContext';

interface DeleteConfirmModalProps {
  open: boolean;
  deviceId: string;
  modelKey: string;
  modelLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}

type Corner = 'tl' | 'tr' | 'bl' | 'br';

export default function DeleteConfirmModal({
  open,
  deviceId,
  modelKey,
  modelLabel,
  onConfirm,
  onCancel,
}: DeleteConfirmModalProps) {
  const { activeTheme } = useHotTheme();
  const [size, setSize] = useState({ width: 380, height: 220 });
  // 关键:lazy initial state 直接计算居中位置,避免第一帧在 (0, 0) 闪烁
  const [position, setPosition] = useState(() => {
    if (typeof window === 'undefined') return { x: 0, y: 0 };
    return {
      x: Math.max(0, (window.innerWidth - 380) / 2),
      y: Math.max(0, (window.innerHeight - 220) / 2),
    };
  });
  const [isResizing, setIsResizing] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const dragStartRef = useRef<{
    x: number;
    y: number;
    startX: number;
    startY: number;
    startW: number;
    startH: number;
    corner?: Corner;
  } | null>(null);

  // 居中
  useEffect(() => {
    if (open && typeof window !== 'undefined') {
      setPosition({
        x: Math.max(0, (window.innerWidth - 380) / 2),
        y: Math.max(0, (window.innerHeight - 220) / 2),
      });
    }
  }, [open]);

  // ESC 关闭
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onCancel]);

  // 拖动
  const handleDragStart = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('.resize-handle')) return;
    e.preventDefault();
    setIsDragging(true);
    dragStartRef.current = {
      x: e.clientX,
      y: e.clientY,
      startX: position.x,
      startY: position.y,
      startW: size.width,
      startH: size.height,
    };
  };

  // Resize
  const handleResizeStart = (corner: Corner, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsResizing(true);
    dragStartRef.current = {
      x: e.clientX,
      y: e.clientY,
      startX: position.x,
      startY: position.y,
      startW: size.width,
      startH: size.height,
      corner,
    };
  };

  useEffect(() => {
    if (!isDragging && !isResizing) return;
    const onMove = (e: MouseEvent) => {
      if (!dragStartRef.current) return;
      const ds = dragStartRef.current;
      const dx = e.clientX - ds.x;
      const dy = e.clientY - ds.y;

      if (isDragging) {
        setPosition({
          x: Math.max(0, Math.min(window.innerWidth - 100, ds.startX + dx)),
          y: Math.max(0, Math.min(window.innerHeight - 50, ds.startY + dy)),
        });
      } else if (isResizing && ds.corner) {
        const minW = 300, minH = 180;
        let nw = ds.startW, nh = ds.startH, nx = ds.startX, ny = ds.startY;
        if (ds.corner === 'br') { nw = ds.startW + dx; nh = ds.startH + dy; }
        if (ds.corner === 'tr') { nw = ds.startW + dx; nh = ds.startH + dy; ny = ds.startY + dy; }
        if (ds.corner === 'bl') { nw = ds.startW + dx; nh = ds.startH + dy; nx = ds.startX + dx; }
        if (ds.corner === 'tl') { nw = ds.startW + dx; nh = ds.startH + dy; nx = ds.startX + dx; ny = ds.startY + dy; }
        nw = Math.max(minW, nw);
        nh = Math.max(minH, nh);
        setSize({ width: nw, height: nh });
        setPosition({ x: nx, y: ny });
      }
    };
    const onUp = () => {
      setIsDragging(false);
      setIsResizing(false);
      dragStartRef.current = null;
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
  }, [isDragging, isResizing]);

  return (
    <>
      <MountTransition show={open} variant="fade" duration={180}>
        <div
          className="fixed inset-0 z-[199] bg-black/40"
          onClick={onCancel}
        />
      </MountTransition>
      <MountTransition show={open} variant="fade-scale" duration={180}>
        <div
          style={{
            position: 'fixed',
            left: `${position.x}px`,
            top: `${position.y}px`,
            width: `${size.width}px`,
            height: `${size.height}px`,
            backgroundColor: activeTheme.surface,
            borderColor: activeTheme.outline,
          }}
          className="z-[200] border rounded-xl shadow-2xl select-none flex flex-col"
        >
            {/* Title bar (draggable) */}
            <div
              onMouseDown={handleDragStart}
              className={`px-4 py-3 border-b flex items-center justify-between ${
                isDragging ? 'cursor-grabbing' : 'cursor-grab'
              }`}
              style={{ borderColor: activeTheme.outline + '50' }}
            >
              <div className="flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 text-amber-500" />
                <span className="font-display font-semibold text-sm">确认删除</span>
              </div>
              <button
                onClick={onCancel}
                className="p-1 rounded hover:bg-surface-bright text-on-surface/60 hover:text-on-surface"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Body */}
            <div className="flex-1 px-4 py-3 overflow-hidden flex flex-col gap-2">
              <p className="text-sm text-on-surface/90">
                确定要删除 <span className="font-mono font-semibold text-red-500">{modelLabel}</span> 吗？
              </p>
              <p className="text-[11px] text-on-surface/60 font-mono">
                ID: {deviceId}
              </p>
              <p className="text-[11px] text-on-surface/50 mt-auto">
                此操作会从画布中移除该设备模型。删除前请确认。
              </p>
            </div>

            {/* Footer */}
            <div
              className="px-4 py-3 border-t flex items-center justify-end gap-2"
              style={{ borderColor: activeTheme.outline + '50' }}
            >
              <button
                onClick={onCancel}
                className="px-3 py-1.5 text-xs font-mono rounded bg-surface-bright hover:bg-surface-bright/70 text-on-surface/80"
              >
                取消
              </button>
              <button
                onClick={onConfirm}
                className="px-3 py-1.5 text-xs font-mono rounded bg-red-500/90 hover:bg-red-500 text-white flex items-center gap-1.5"
              >
                <Trash2 className="w-3 h-3" />
                确认删除
              </button>
            </div>

            {/* 4 corner resize handles */}
            {(['tl', 'tr', 'bl', 'br'] as Corner[]).map((corner) => {
              const pos: Record<Corner, React.CSSProperties> = {
                tl: { top: 0, left: 0, cursor: 'nwse-resize' },
                tr: { top: 0, right: 0, cursor: 'nesw-resize' },
                bl: { bottom: 0, left: 0, cursor: 'nesw-resize' },
                br: { bottom: 0, right: 0, cursor: 'nwse-resize' },
              };
              const borderClasses: Record<Corner, string> = {
                tl: 'border-t-2 border-l-2 rounded-tl-xl',
                tr: 'border-t-2 border-r-2 rounded-tr-xl',
                bl: 'border-b-2 border-l-2 rounded-bl-xl',
                br: 'border-b-2 border-r-2 rounded-br-xl',
              };
              return (
                <div
                  key={corner}
                  onMouseDown={(e) => handleResizeStart(corner, e)}
                  className={`absolute w-4 h-4 ${borderClasses[corner]} resize-handle`}
                  style={{ ...pos[corner], zIndex: 100, borderColor: 'transparent' }}
                  onMouseEnter={(e) => (e.currentTarget.style.borderColor = activeTheme.primary)}
                  onMouseLeave={(e) => (e.currentTarget.style.borderColor = 'transparent')}
                />
              );
            })}
        </div>
      </MountTransition>
    </>
  );
}
