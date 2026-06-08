// ─────────────────────────────────────────────────────────────────
// 可拖拽分隔条
// 水平拖动改变相邻两个面板的宽度比例
// ─────────────────────────────────────────────────────────────────

import { useState, useCallback, useRef, useEffect } from 'react';

interface Props {
  /** 拖动时回调 (offsetX 为鼠标相对屏幕移动量) */
  onDrag: (offsetX: number) => void;
  /** 拖动结束 */
  onDragEnd?: () => void;
  /** 方向: vertical(水平拖动) | horizontal(垂直拖动) */
  orientation?: 'vertical' | 'horizontal';
  /** 受控当前位置 / 大小(用于 active 高亮) */
  active?: boolean;
}

export function Splitter({ onDrag, onDragEnd, orientation = 'vertical', active }: Props) {
  const [dragging, setDragging] = useState(false);
  const startRef = useRef(0);

  const handleDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setDragging(true);
    startRef.current = orientation === 'vertical' ? e.clientX : e.clientY;
  }, [orientation]);

  useEffect(() => {
    if (!dragging) return;
    let lastPos = 0;
    const onMove = (e: MouseEvent) => {
      const cur = orientation === 'vertical' ? e.clientX : e.clientY;
      const delta = cur - startRef.current;
      startRef.current = cur;
      lastPos += delta;
      onDrag(delta);
    };
    const onUp = () => {
      setDragging(false);
      onDragEnd?.();
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    document.body.style.cursor = orientation === 'vertical' ? 'col-resize' : 'row-resize';
    document.body.style.userSelect = 'none';
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [dragging, orientation, onDrag, onDragEnd]);

  const isVert = orientation === 'vertical';
  return (
    <div
      onMouseDown={handleDown}
      onDoubleClick={onDragEnd}
      className={`relative shrink-0 group ${
        isVert ? 'w-1 cursor-col-resize' : 'h-1 cursor-row-resize'
      } ${dragging || active ? 'bg-primary' : 'bg-transparent hover:bg-primary/30'} transition-colors`}
    >
      {/* 视觉提示:中间一条线 + 两侧 hover 把手 */}
      <div
        className={`absolute ${
          isVert ? 'top-0 bottom-0 left-1/2 -translate-x-1/2 w-px' : 'left-0 right-0 top-1/2 -translate-y-1/2 h-px'
        } ${dragging || active ? 'bg-primary' : 'bg-border group-hover:bg-primary/60'}`}
      />
      <div
        className={`absolute ${
          isVert ? 'top-1/2 -translate-y-1/2 left-1/2 -translate-x-1/2' : 'left-1/2 -translate-x-1/2 top-1/2 -translate-y-1/2'
        } w-1 h-8 rounded-full ${dragging ? 'bg-primary scale-125' : 'bg-primary/0 group-hover:bg-primary/40'} transition-all flex items-center justify-center`}
      >
        {dragging && <span className="w-0.5 h-4 rounded-full bg-on-primary" />}
      </div>
    </div>
  );
}
