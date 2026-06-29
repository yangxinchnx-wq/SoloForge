/**
 * ResizeHandle — 隔离在 LayoutContext 下的拖拽手柄
 *
 * 2026-06-24 性能优化:
 *   - 这些组件消费 useLayout() 但 App.tsx 不消费
 *   - 拖动时只 set 自己的 state + 重渲染这几个 handle + 实际宽度消费者
 *   - App 树其余部分不参与重渲染
 *
 * 2026-06-26 v2 性能优化:
 *   - 内层线条从 `w-[1px]/group-hover:w-[2px]` 改为永远 1px, "变粗" 用 box-shadow 外扩
 *   - 颜色/宽度变化全程走 GPU 合成层, 不触发 layout / paint
 *   - 状态切到 [data-resizing] 属性, React 仅写属性
 */

import React from 'react';
import { useLayout } from '../context/LayoutContext';

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
  const { state, beginResizeSidebar } = useLayout();
  return (
    <div
      onMouseDown={beginResizeSidebar}
      data-resizing={state.isResizingSidebar ? 'true' : 'false'}
      className={`group relative w-3 h-full cursor-col-resize shrink-0 z-35 select-none -mx-1.5 flex items-center justify-center ${className}`}
      title="拖拽调整左侧栏宽度"
    >
      <HandleBar active={state.isResizingSidebar} />
    </div>
  );
};

// 历史面板拖拽手柄 (absolute 定位的版本)
export const HistoryResizeHandle: React.FC = () => {
  const { state, beginResizeSidebar } = useLayout();
  return (
    <div
      onMouseDown={beginResizeSidebar}
      data-resizing={state.isResizingSidebar ? 'true' : 'false'}
      className="group absolute top-0 bottom-0 h-full w-3 cursor-col-resize select-none z-50 flex items-center justify-center"
      style={{
        left: 48 + state.sidebarWidth - 6,
        transition: state.isResizingSidebar ? 'none' : 'left 250ms cubic-bezier(0.16, 1, 0.3, 1)',
      }}
      title="拖拽调整历史面板宽度"
    >
      <HandleBar active={state.isResizingSidebar} />
    </div>
  );
};

// 右侧预览面板拖拽手柄
export const PreviewResizeHandle: React.FC = () => {
  const { state, beginResizePreview } = useLayout();
  return (
    <div
      onMouseDown={beginResizePreview}
      data-resizing={state.isResizingPreview ? 'true' : 'false'}
      className="group relative w-3 h-full cursor-col-resize shrink-0 z-35 select-none -mx-1.5 flex items-center justify-center"
      title="拖拽调整右侧预览宽度"
    >
      <HandleBar active={state.isResizingPreview} />
    </div>
  );
};
