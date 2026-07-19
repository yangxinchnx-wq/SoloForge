/**
 * ResizableBubble — 可拖拽改变高度的消息气泡容器
 *
 * ★ 2026-07-19 新增
 *
 * 功能:
 *   - 右下角拖拽手柄, 向下拖增大可见区域, 向上拖减小
 *   - 设置 maxHeight 后内容超出则滚动 (overflow-y: auto)
 *   - 双击手柄恢复自适应 (清除 maxHeight)
 *   - 默认无 maxHeight (内容自适应, 与原行为一致)
 *
 * 交互细节:
 *   - mousedown 记录起始 Y + 当前 offsetHeight + scrollHeight
 *   - mousemove 计算 delta, newHeight = startHeight + delta
 *   - newHeight >= scrollHeight 时清除 maxHeight (恢复自适应)
 *   - 拖拽期间禁用文本选择 (user-select: none)
 *   - hover 时手柄淡入显示, 离开淡出
 */
import React, { memo, useState, useCallback, useRef, useEffect } from 'react';

interface ResizableBubbleProps {
  children: React.ReactNode;
  className?: string;
  onContextMenu?: (e: React.MouseEvent) => void;
}

export const ResizableBubble = memo(function ResizableBubble({
  children,
  className = '',
  onContextMenu,
}: ResizableBubbleProps) {
  const [maxHeight, setMaxHeight] = useState<number | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  const bubbleRef = useRef<HTMLDivElement>(null);
  const startYRef = useRef(0);
  const startHeightRef = useRef(0);
  const fullHeightRef = useRef(0);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    // 只响应左键
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();

    const el = bubbleRef.current;
    startYRef.current = e.clientY;
    // offsetHeight = 当前可见高度 (有 maxHeight 时 = maxHeight, 无时 = 内容高度)
    startHeightRef.current = el?.offsetHeight ?? 0;
    // scrollHeight = 完整内容高度 (不受 maxHeight 影响)
    fullHeightRef.current = el?.scrollHeight ?? 0;

    setIsDragging(true);
  }, []);

  const handleDoubleClick = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setMaxHeight(null);
  }, []);

  useEffect(() => {
    if (!isDragging) return;

    const handleMouseMove = (e: MouseEvent) => {
      const delta = e.clientY - startYRef.current;
      const newHeight = Math.max(60, startHeightRef.current + delta);
      const full = fullHeightRef.current;

      if (newHeight >= full) {
        // 拖到超过完整内容高度 → 恢复自适应
        setMaxHeight(null);
      } else {
        setMaxHeight(newHeight);
      }
    };

    const handleMouseUp = () => {
      setIsDragging(false);
    };

    // 拖拽期间禁用文本选择
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.body.style.userSelect = '';
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging]);

  return (
    <div
      ref={bubbleRef}
      className={`resizable-bubble ${className}`}
      onContextMenu={onContextMenu}
      style={
        maxHeight !== null
          ? { maxHeight: `${maxHeight}px`, overflowY: 'auto' }
          : undefined
      }
    >
      {children}
      {/* 拖拽手柄 — 右下角 */}
      <div
        className="resize-handle"
        onMouseDown={handleMouseDown}
        onDoubleClick={handleDoubleClick}
        title={maxHeight !== null ? '双击恢复自适应高度' : '拖拽调整高度'}
      />
    </div>
  );
});
