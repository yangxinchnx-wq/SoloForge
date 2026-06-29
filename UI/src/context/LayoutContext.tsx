/**
 * LayoutContext — 隔离侧栏/预览面板的拖拽状态
 *
 * 2026-06-24 性能优化:
 *   - 之前 sidebarWidth / previewWidth / isResizing* 全部在 App.tsx 顶层 useState
 *   - 拖动 1 秒 = 60 次 setState → App 整树重渲染 60 次
 *   - 现在隔离到独立 provider,只有消费这些状态的组件重渲染
 *
 * 设计:
 *   - 单一 state + dispatch(用 useReducer 替代多个 useState)
 *   - mousemove / mouseup 监听器放 provider 内,只 set 自己的 state
 *   - 通过 Context 暴露给 Header / ChatPanel / PreviewPanel / 等
 */

import React, { createContext, useContext, useReducer, useEffect, useRef, useMemo, useCallback } from 'react';

export interface LayoutState {
  sidebarWidth: number;
  previewWidth: number;
  previewMinWidth: number;
  isResizingSidebar: boolean;
  isResizingPreview: boolean;
  dragStartSidebarWidth: number;
  dragStartPreviewWidth: number;
  // 标记 server 端回填是否完成
  previewWidthLoaded: boolean;
}

type Action =
  | { type: 'setSidebarWidth'; width: number }
  | { type: 'setPreviewWidth'; width: number }
  | { type: 'setPreviewMinWidth'; width: number }
  | { type: 'beginResizeSidebar'; startWidth: number }
  | { type: 'beginResizePreview'; startWidth: number }
  | { type: 'endResize' }
  | { type: 'loadPreviewWidth'; width: number }
  | { type: 'previewWidthLoaded' };

const INITIAL_STATE: LayoutState = {
  sidebarWidth: 250,
  previewWidth: 385,
  previewMinWidth: 320,
  isResizingSidebar: false,
  isResizingPreview: false,
  dragStartSidebarWidth: 250,
  dragStartPreviewWidth: 385,
  previewWidthLoaded: false,
};

function reducer(state: LayoutState, action: Action): LayoutState {
  switch (action.type) {
    case 'setSidebarWidth':
      return { ...state, sidebarWidth: action.width };
    case 'setPreviewWidth':
      return { ...state, previewWidth: action.width };
    case 'setPreviewMinWidth':
      return { ...state, previewMinWidth: action.width };
    case 'beginResizeSidebar':
      return {
        ...state,
        isResizingSidebar: true,
        dragStartSidebarWidth: action.startWidth,
      };
    case 'beginResizePreview':
      return {
        ...state,
        isResizingPreview: true,
        dragStartPreviewWidth: action.startWidth,
      };
    case 'endResize':
      return {
        ...state,
        isResizingSidebar: false,
        isResizingPreview: false,
      };
    case 'loadPreviewWidth':
      return {
        ...state,
        previewWidth: action.width,
        dragStartPreviewWidth: action.width,
        previewWidthLoaded: true,
      };
    case 'previewWidthLoaded':
      return { ...state, previewWidthLoaded: true };
    default:
      return state;
  }
}

export interface LayoutContextValue {
  state: LayoutState;
  beginResizeSidebar: () => void;
  beginResizePreview: () => void;
  endResize: () => void;
  onPreviewMinWidthChange: (width: number) => void;
}

const LayoutContext = createContext<LayoutContextValue | undefined>(undefined);

export const useLayout = (): LayoutContextValue => {
  const ctx = useContext(LayoutContext);
  if (!ctx) throw new Error('useLayout must be used within LayoutProvider');
  return ctx;
};

export const LayoutProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [state, dispatch] = useReducer(reducer, INITIAL_STATE);
  // 用 ref 镜像 state,避免 mousemove 闭包陈旧
  const stateRef = useRef(state);
  stateRef.current = state;

  // 4 个 callback 抽离为 useCallback,引用稳定,避免消费方 useEffect 因引用变化反复触发
  // (例如 PreviewPanel 的 onMinWidthChange 依赖项陷阱会导致 Maximum update depth)
  const beginResizeSidebar = useCallback(() => {
    dispatch({ type: 'beginResizeSidebar', startWidth: stateRef.current.sidebarWidth });
  }, []);

  const beginResizePreview = useCallback(() => {
    dispatch({ type: 'beginResizePreview', startWidth: stateRef.current.previewWidth });
  }, []);

  const endResize = useCallback(() => {
    dispatch({ type: 'endResize' });
  }, []);

  const onPreviewMinWidthChange = useCallback((width: number) => {
    dispatch({ type: 'setPreviewMinWidth', width });
  }, []);

  // server 端回填 previewWidth
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/settings/previewWidth');
        if (!res.ok) return;
        const data = await res.json();
        const w = data?.value;
        if (cancelled) return;
        if (typeof w === 'number' && w >= 160 && w <= 1200) {
          dispatch({ type: 'loadPreviewWidth', width: w });
          return;
        }
        // 没拿到有效值,只标记 loaded
        dispatch({ type: 'previewWidthLoaded' });
      } catch {
        dispatch({ type: 'previewWidthLoaded' });
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // 拖动期间保存到 server 的回调 (mouseup 时调)
  // 用 ref 避免组件重渲染
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savePreviewWidth = useCallback((w: number) => {
    if (!stateRef.current.previewWidthLoaded) return;
    fetch('/api/settings/previewWidth', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: w }),
    }).catch(() => {});
  }, []);

  // mousemove / mouseup 全局监听 — 只 dispatch 自己的 state
  //   不影响 App 树其他部分重渲染
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      const s = stateRef.current;
      if (s.isResizingSidebar) {
        // 左侧栏紧贴 48px ActivityBar
        const newWidth = e.clientX - 48;
        if (newWidth >= 160 && newWidth <= 600) {
          dispatch({ type: 'setSidebarWidth', width: newWidth });
        }
      } else if (s.isResizingPreview) {
        const newWidth = window.innerWidth - e.clientX;
        if (newWidth >= s.previewMinWidth && newWidth <= 750) {
          dispatch({ type: 'setPreviewWidth', width: newWidth });
        }
      }
    };
    const handleMouseUp = () => {
      const s = stateRef.current;
      if (s.isResizingPreview) {
        // mouseup 时持久化到 server,避免每帧 PUT
        savePreviewWidth(s.previewWidth);
      }
      dispatch({ type: 'endResize' });
    };

    if (state.isResizingSidebar || state.isResizingPreview) {
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      const iframes = document.querySelectorAll('iframe');
      iframes.forEach((f) => (f.style.pointerEvents = 'none'));
    } else {
      // 还原 cursor / userSelect / iframe 状态
      if (document.body.style.cursor === 'col-resize') document.body.style.cursor = '';
      if (document.body.style.userSelect === 'none') document.body.style.userSelect = '';
    }

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [state.isResizingSidebar, state.isResizingPreview, savePreviewWidth]);

  // 组件卸载时清理
  useEffect(() => {
    return () => {
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      const iframes = document.querySelectorAll('iframe');
      iframes.forEach((f) => (f.style.pointerEvents = 'auto'));
    };
  }, []);

  const value = useMemo<LayoutContextValue>(() => ({
    state,
    beginResizeSidebar,
    beginResizePreview,
    endResize,
    onPreviewMinWidthChange,
  }), [state, beginResizeSidebar, beginResizePreview, endResize, onPreviewMinWidthChange]);

  return <LayoutContext.Provider value={value}>{children}</LayoutContext.Provider>;
};
