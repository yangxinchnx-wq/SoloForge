// ─────────────────────────────────────────────────────────────────
// SoloForge 自定义 resize 边框(替代 frame:true 的 OS 边框)
// 原因:Windows 11 在 frame:true 下 resize 时 DWM 会画白色 sizing box(用户说"放大缩小有白色长条"),
//      frame:false 才能彻底消除 DWM 画的 chrome。但 frame:false 时 OS 不再提供拖拽 resize,
//      所以我们自己在 4 边 + 4 角放 6~8px 的透明 handle,鼠标按下后通过 IPC 调 setBounds 改变窗口尺寸。
// 设计要点:
//   - 顶边不放 handle(顶边 48px 是 Header,Header 自己负责 drag-to-move)
//   - 左边 6px / 右边 6px / 底边 6px(从上到下整个高度)
//   - 4 个角各 12px × 12px(角部相交处不重叠)
//   - cursor 用 CSS 标准 resize cursor(nwse-resize / nesw-resize / ns-resize / ew-resize)
//   - WebkitAppRegion:'no-drag' 阻止父级 drag 区域吞掉 mousedown
//   - 不引入任何状态,全部走 ref + 全局 mousemove/mouseup
// ─────────────────────────────────────────────────────────────────

import React, { useEffect, useRef } from 'react';

type Edge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

// resize 手柄宽度(px)
const HANDLE = 6;
const CORNER = 12;

function getResizeApi(): {
  resizeWindow: (edge: Edge, deltaX: number, deltaY: number) => Promise<unknown>;
} {
  if (typeof window === 'undefined') {
    return { resizeWindow: async () => false };
  }
  const api = (window as any).soloforge?.resizeWindow;
  if (typeof api !== 'function') {
    return {
      resizeWindow: async () => false,
    };
  }
  return { resizeWindow: api as (edge: Edge, dx: number, dy: number) => Promise<unknown> };
}

const baseHandleStyle: React.CSSProperties = {
  position: 'fixed',
  zIndex: 9998,
  // ★ 关键:no-drag 阻止 OS/Chromium 把它当作 "拖动窗口" 处理
  WebkitAppRegion: 'no-drag',
  userSelect: 'none',
  // 防止内部元素被选中
  background: 'transparent',
  // 让命中区在 1px 边框上仍然可点
  pointerEvents: 'auto',
  // 不参与文本选择/拖动
  touchAction: 'none',
};

export const EdgeResize: React.FC = () => {
  // 记录当前正在拖拽的边 + 上次鼠标位置
  const dragRef = useRef<{ edge: Edge; lastX: number; lastY: number } | null>(null);
  const apiRef = useRef(getResizeApi());

  useEffect(() => {
    apiRef.current = getResizeApi();
  }, []);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const cur = dragRef.current;
      if (!cur) return;
      // 防止文字选中 + 防止 OS 画 drag box
      e.preventDefault();
      const dx = e.screenX - cur.lastX;
      const dy = e.screenY - cur.lastY;
      cur.lastX = e.screenX;
      cur.lastY = e.screenY;
      // 调 IPC 让 main 进程改窗口大小
      apiRef.current.resizeWindow(cur.edge, dx, dy).catch(() => {});
    };
    const onUp = () => {
      dragRef.current = null;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);

  const startDrag = (edge: Edge) => (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragRef.current = { edge, lastX: e.screenX, lastY: e.screenY };
    // 拖拽期间显示正确 cursor + 禁止文字选中(防止 Chromium 画 selection box)
    const cursorMap: Record<Edge, string> = {
      n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize',
      ne: 'nesw-resize', nw: 'nwse-resize', se: 'nwse-resize', sw: 'nesw-resize',
    };
    document.body.style.cursor = cursorMap[edge];
    document.body.style.userSelect = 'none';
  };

  // 8 个 handle
  // 顺序: nw, n, ne, e, se, s, sw, w
  // 注意:顶边不放(handle 会跟 Header 的 drag 区域冲突),所以 8 个 = 4 角 + 3 边(去顶)
  return (
    <>
      {/* 左上角 */}
      <div
        onMouseDown={startDrag('nw')}
        style={{ ...baseHandleStyle, top: 0, left: 0, width: CORNER, height: CORNER, cursor: 'nwse-resize' }}
        aria-hidden
      />
      {/* 右上角 */}
      <div
        onMouseDown={startDrag('ne')}
        style={{ ...baseHandleStyle, top: 0, right: 0, width: CORNER, height: CORNER, cursor: 'nesw-resize' }}
        aria-hidden
      />
      {/* 右下角 */}
      <div
        onMouseDown={startDrag('se')}
        style={{ ...baseHandleStyle, bottom: 0, right: 0, width: CORNER, height: CORNER, cursor: 'nwse-resize' }}
        aria-hidden
      />
      {/* 左下角 */}
      <div
        onMouseDown={startDrag('sw')}
        style={{ ...baseHandleStyle, bottom: 0, left: 0, width: CORNER, height: CORNER, cursor: 'nesw-resize' }}
        aria-hidden
      />

      {/* 左边(去掉顶部 CORNER 和底部 CORNER 区域) */}
      <div
        onMouseDown={startDrag('w')}
        style={{ ...baseHandleStyle, top: CORNER, bottom: CORNER, left: 0, width: HANDLE, cursor: 'ew-resize' }}
        aria-hidden
      />
      {/* 右边 */}
      <div
        onMouseDown={startDrag('e')}
        style={{ ...baseHandleStyle, top: CORNER, bottom: CORNER, right: 0, width: HANDLE, cursor: 'ew-resize' }}
        aria-hidden
      />
      {/* 底边(去掉左右角部) */}
      <div
        onMouseDown={startDrag('s')}
        style={{ ...baseHandleStyle, bottom: 0, left: CORNER, right: CORNER, height: HANDLE, cursor: 'ns-resize' }}
        aria-hidden
      />

      {/* 顶边不放(Header 区域已有 drag-to-move,放 resize handle 会冲突) */}
    </>
  );
};

export default EdgeResize;
