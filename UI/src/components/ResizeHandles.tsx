/**
 * ResizeHandle — 隔离在 LayoutContext 下的拖拽手柄
 *
 * 2026-07-02 重构:
 *   - 改用 useLayoutStatus (低频变: isResizing*) + useLayoutActions (永不变化)
 *   - 之前用 useLayout() 一次性拿到整个 state, 高频变字段 (sidebarWidth) 会强制 re-render
 *   - HistoryResizeHandle 仍需要 sidebarWidth 计算 left, 用 useLayoutState 仅取这一个字段
 *     但 React 18+ useContext selector 模式: 取到的 sidebarWidth 变化时本组件 re-render,
 *     频率从 60fps 降到 60fps (因为左侧栏拖动期间 sidebarWidth 必变, 这是无法避免的)
 *   - 真正能 0 re-render 的方案: 让 handle 跟着 sidebar 列容器走 (DOM 结构改成父子)
 *     但这是更大的重构, 本次先按"按需订阅"修
 */

import React from 'react';
import { useLayoutState, useLayoutStatus, useLayoutActions } from '../context/LayoutContext';

// 通用内层线条: 永远 1px, 颜色 + box-shadow 走合成层
const HandleBar: React.FC<{ active?: boolean }> = ({ active }) => (
  <div
    data-resizing={active ? 'true' : 'false'}
    className="
      absolute top-0 bottom-0 w-[1px] pointer-events-none
      bg-[var(--color-primary)]/20
      transition-[background-color,box-shadow] duration-150 ease-out
      group-hover:bg-[var(--color-primary)]
      group-hover:shadow-[-1px_0_4px_var(--color-primary),1px_0_4px_var(--color-primary)]
      group-data-[resizing='true']:bg-[var(--color-primary)]
      group-data-[resizing='true']:shadow-[-1px_0_4px_var(--color-primary),1px_0_4px_var(--color-primary)]
    "
  />
);

// 左侧栏拖拽手柄 (普通布局)
export const SidebarResizeHandle: React.FC<{ className?: string }> = ({ className = '' }) => {
  const { isResizingSidebar } = useLayoutStatus();
  const { beginResizeSidebar } = useLayoutActions();
  return (
    <div
      onMouseDown={beginResizeSidebar}
      data-resizing={isResizingSidebar ? 'true' : 'false'}
      className={`group relative w-3 h-full cursor-col-resize shrink-0 z-35 select-none -mx-1.5 flex items-center justify-center ${className}`}
      title="拖拽调整左侧栏宽度"
    >
      <HandleBar active={isResizingSidebar} />
    </div>
  );
};

// 历史面板拖拽手柄 (absolute 定位的版本)
// 注意: 这里仍订阅 useLayoutState.sidebarWidth 来计算 left
//   因为历史面板列宽是 sidebarWidth, handle 必须跟着列右边
//   在侧栏拖动期间本组件会 re-render 60fps, 但因为它只渲染一个 div + 1 个 HandleBar,
//   渲染开销极低 (远小于 App 整树 re-render)
export const HistoryResizeHandle: React.FC = () => {
  const { sidebarWidth } = useLayoutState();
  const { isResizingSidebar } = useLayoutStatus();
  const { beginResizeSidebar } = useLayoutActions();
  return (
    <div
      onMouseDown={beginResizeSidebar}
      data-resizing={isResizingSidebar ? 'true' : 'false'}
      className="group absolute top-0 bottom-0 h-full w-3 cursor-col-resize select-none z-50 flex items-center justify-center"
      style={{
        left: 48 + sidebarWidth - 6,
        transition: isResizingSidebar ? 'none' : 'left 250ms cubic-bezier(0.16, 1, 0.3, 1)',
      }}
      title="拖拽调整历史面板宽度"
    >
      <HandleBar active={isResizingSidebar} />
    </div>
  );
};

// 右侧预览面板拖拽手柄
export const PreviewResizeHandle: React.FC = () => {
  const { isResizingPreview } = useLayoutStatus();
  const { beginResizePreview } = useLayoutActions();
  return (
    <div
      onMouseDown={beginResizePreview}
      data-resizing={isResizingPreview ? 'true' : 'false'}
      className="group relative w-3 h-full cursor-col-resize shrink-0 z-35 select-none -mx-1.5 flex items-center justify-center"
      title="拖拽调整右侧预览宽度"
    >
      <HandleBar active={isResizingPreview} />
    </div>
  );
};
