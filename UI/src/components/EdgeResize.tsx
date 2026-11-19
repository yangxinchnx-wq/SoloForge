// ─────────────────────────────────────────────────────────────────
// EdgeResize — frame:false 模式下的窗口边缘缩放
// Electron frameless 窗口没有原生 WS_THICKFRAME 边框, 由本组件在窗口
// 四周绘制 8 个热区 (4 边 + 4 角), mousedown 后增量计算最终 rect,
// 经 window:resize-to IPC → 主进程 PS worker SetWindowPos 执行。
// 相关历史: main.cjs 注释 "frame:false → 无 snap flyout; maximize()/
// unmaximize() → 无 DWM resize tooltip"。thickframe (titleBarStyle:'hidden')
// 模式下最大化/还原时 DWM 会画白色尺寸 tooltip, 故整体切换 frame:false。
// ─────────────────────────────────────────────────────────────────

import React, { useCallback, useEffect, useRef, useState } from 'react';

const EDGE = 6;          // 边热区厚度 (px)
const CORNER = 14;       // 角热区边长 (px)
const MIN_W = 1024;      // 与主进程 window:resize-to 的下限一致
const MIN_H = 640;

type Dir = 'n' | 's' | 'e' | 'w' | 'nw' | 'ne' | 'sw' | 'se';

const noopWindowApi = {
  resizeWindow: (_x: number, _y: number, _w: number, _h: number) => Promise.resolve(false),
  isMaximized: () => Promise.resolve(false),
  onMaximizeStateChange: (_h: (v: boolean) => void) => () => {},
};

function getWindowApi() {
  if (typeof window === 'undefined') return noopWindowApi;
  const sf = (window as any).soloforge;
  // 注意: resizeWindow 在 preload 中是顶层 API (soloforge.resizeWindow),
  // 而不是 soloforge.window.resizeWindow — 历史上这里读错位置导致通道从未生效
  return {
    resizeWindow: sf?.resizeWindow ?? sf?.window?.resizeWindow ?? noopWindowApi.resizeWindow,
    isMaximized: sf?.window?.isMaximized ?? noopWindowApi.isMaximized,
    onMaximizeStateChange: sf?.window?.onMaximizeStateChange ?? noopWindowApi.onMaximizeStateChange,
  };
}

const zoneStyle = (dir: Dir): React.CSSProperties => {
  const base: React.CSSProperties = { position: 'fixed', zIndex: 2147483000 };
  // 全部用 CSS 锚点定位 (不用 innerWidth/Height), 窗口尺寸变化时热区始终贴合
  switch (dir) {
    case 'n': return { ...base, top: 0, left: CORNER, right: CORNER, height: EDGE, cursor: 'ns-resize' };
    case 's': return { ...base, bottom: 0, left: CORNER, right: CORNER, height: EDGE, cursor: 'ns-resize' };
    case 'w': return { ...base, left: 0, top: CORNER, bottom: CORNER, width: EDGE, cursor: 'ew-resize' };
    case 'e': return { ...base, right: 0, top: CORNER, bottom: CORNER, width: EDGE, cursor: 'ew-resize' };
    case 'nw': return { ...base, top: 0, left: 0, width: CORNER, height: CORNER, cursor: 'nwse-resize' };
    case 'ne': return { ...base, top: 0, right: 0, width: CORNER, height: CORNER, cursor: 'nesw-resize' };
    case 'sw': return { ...base, bottom: 0, left: 0, width: CORNER, height: CORNER, cursor: 'nesw-resize' };
    case 'se': return { ...base, bottom: 0, right: 0, width: CORNER, height: CORNER, cursor: 'nwse-resize' };
  }
};

export const EdgeResize: React.FC = () => {
  const api = useRef(getWindowApi());
  const [maximized, setMaximized] = useState(false);
  const dragging = useRef(false);
  const raf = useRef(0);

  useEffect(() => {
    let cancelled = false;
    api.current.isMaximized().then((v: boolean) => { if (!cancelled) setMaximized(!!v); }).catch(() => {});
    const off = api.current.onMaximizeStateChange((v: boolean) => setMaximized(!!v));
    return () => { cancelled = true; if (typeof off === 'function') off(); };
  }, []);

  const onZoneMouseDown = useCallback((dir: Dir, e: React.MouseEvent) => {
    if (maximized || e.button !== 0) return;
    e.preventDefault();
    dragging.current = true;

    const startX = e.screenX;
    const startY = e.screenY;
    const rect = { x: window.screenX, y: window.screenY, w: window.outerWidth, h: window.outerHeight };

    const apply = (cx: number, cy: number) => {
      const dx = cx - startX;
      const dy = cy - startY;
      let { x, y, w, h } = rect;
      if (dir.includes('e')) w = Math.max(MIN_W, rect.w + dx);
      if (dir.includes('s')) h = Math.max(MIN_H, rect.h + dy);
      if (dir.includes('w')) {
        w = Math.max(MIN_W, rect.w - dx);
        x = rect.x + rect.w - w;
      }
      if (dir.includes('n')) {
        h = Math.max(MIN_H, rect.h - dy);
        y = rect.y + rect.h - h;
      }
      api.current.resizeWindow(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
    };

    const onMove = (ev: MouseEvent) => {
      if (!dragging.current) return;
      cancelAnimationFrame(raf.current);
      raf.current = requestAnimationFrame(() => apply(ev.screenX, ev.screenY));
    };
    const onUp = () => {
      dragging.current = false;
      cancelAnimationFrame(raf.current);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [maximized]);

  if (maximized) return null;

  const dirs: Dir[] = ['n', 's', 'e', 'w', 'nw', 'ne', 'sw', 'se'];
  return (
    <>
      {dirs.map((dir) => (
        <div
          key={dir}
          style={zoneStyle(dir)}
          onMouseDown={(e) => onZoneMouseDown(dir, e)}
        />
      ))}
    </>
  );
};

export default EdgeResize;
