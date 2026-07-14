/**
 * LayoutContext — 隔离侧栏/预览面板的拖拽状态
 *
 * ─────────────────────────────────────────────────────────────
 * 2026-07-02 重构: 拆分 4 个 Context (照搬 ThemeContext 的 hot/static 模式)
 * ─────────────────────────────────────────────────────────────
 * 之前的问题 (底层):
 *   - 单一 LayoutContext, useMemo deps 包含 state
 *   - 每次 dispatch 都返回新 state 对象 → useMemo 重算 → value 引用变化
 *   - <Context.Provider value={value}> 引用变化 → 所有 useContext 消费者强制 re-render
 *   - 即使消费者只关心 action (永不变化), 也会被强制 re-render
 *
 * 修复: 4 个独立 Context
 *   1. LayoutStateContext    — 高频变 state (sidebarWidth, previewWidth)
 *                             每次拖动都更新; 只让真正需要 width 数值的组件订阅
 *   2. LayoutStatusContext   — 低频变 state (isResizing*, dragStart*)
 *                             只在 mousedown/mouseup 切换; 列容器外的 handle / wrapper 用
 *   3. LayoutActionsContext  — 永不变化的 action 集合 (useRef 镜像, 引用永稳定)
 *                             mousedown 调 beginResizeSidebar 等
 *   4. LayoutMetaContext     — 几乎不变 (previewMinWidth, previewWidthLoaded)
 *                             整个 App 生命周期可能变 0-1 次
 *
 * 拆分 consumer hook:
 *   - useLayout()         全部 (向后兼容, 包含 state + status + actions + meta)
 *   - useLayoutState()    仅高频变 (MainLayout 根容器 / 列容器用)
 *   - useLayoutStatus()   仅低频变 (handle / isResizing 监听用)
 *   - useLayoutActions()  仅 actions (Header / ResizeHandles 用)
 *   - useLayoutMeta()     仅 meta (PreviewPanel minWidth 用)
 *
 * ─────────────────────────────────────────────────────────────
 * 2026-07-02 移除"幽灵拖动" (Ghost Drag) — 存在根本性设计缺陷
 * ─────────────────────────────────────────────────────────────
 * 之前方案: 拖动期间不调 IPC, 用 transform: translate3d 让 IDE 内容视觉跟随鼠标
 * 问题: OS 窗口不动, 但 IDE 内容 transform 偏移到 OS 窗口外
 *   - 用户看到的是 OS 窗口的空白背景 (深色主题 = 黑布)
 *   - "画面只能在这个黑布里拖动" — 实际是 IDE 在 OS 窗口外
 *   - mouseup 时 SetWindowPos 把 OS 窗口瞬移到目标位置
 *   - 体验: 完全不可用, 用户看到的是"空框 + 框外的内容"
 *
 * 正确方案: 拖动期间 IPC moveWindow 让 OS 窗口跟随鼠标
 *   - OS 窗口 = 用户视觉
 *   - 1 帧最多 1 次 IPC (rAF 节流)
 *   - main 进程 8ms 节流防御
 *   - 这种方案没有"黑布"问题, OS 窗口本身在动
 */

import React, { createContext, useContext, useReducer, useEffect, useRef, useMemo, useCallback } from 'react';

// ── 1. State 类型定义 ─────────────────────────────────────────

// ★ 2026-07-15: 预览面板宽度上限从 750 降到 600
//   750 太宽, 导致画布区域过大, 挤压聊天区
//   600 足以容纳大多数设备预设 (最宽 iMac 2560 会缩放) + 自由画布
export const PREVIEW_MAX_WIDTH = 600;
export const PREVIEW_MIN_WIDTH = 320;

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
  | { type: 'endResizeSidebar'; width: number }
  | { type: 'endResizePreview'; width: number }
  | { type: 'endResize' }
  | { type: 'loadPreviewWidth'; width: number }
  | { type: 'previewWidthLoaded' };

const INITIAL_STATE: LayoutState = {
  sidebarWidth: 250,
  previewWidth: 385,
  previewMinWidth: PREVIEW_MIN_WIDTH,
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
    case 'endResizeSidebar':
      return {
        ...state,
        isResizingSidebar: false,
        sidebarWidth: action.width,
        dragStartSidebarWidth: action.width,
      };
    case 'endResizePreview':
      return {
        ...state,
        isResizingPreview: false,
        previewWidth: action.width,
        dragStartPreviewWidth: action.width,
        previewWidthLoaded: true,
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

// ── 2. 拆分 4 个 Context ──────────────────────────────────────

// 高频变: sidebarWidth / previewWidth
const LayoutStateContext = createContext<{
  sidebarWidth: number;
  previewWidth: number;
} | null>(null);

// 低频变: isResizing* / dragStart*
const LayoutStatusContext = createContext<{
  isResizingSidebar: boolean;
  isResizingPreview: boolean;
  dragStartSidebarWidth: number;
  dragStartPreviewWidth: number;
} | null>(null);

// 永不变化: 全部 action (useRef 镜像, 引用稳定)
export interface LayoutActions {
  beginResizeSidebar: () => void;
  beginResizePreview: () => void;
  endResize: () => void;
  onPreviewMinWidthChange: (width: number) => void;
}
const LayoutActionsContext = createContext<LayoutActions | null>(null);

// 几乎不变: previewMinWidth, previewWidthLoaded
const LayoutMetaContext = createContext<{
  previewMinWidth: number;
  previewWidthLoaded: boolean;
} | null>(null);

// ── 3. 拆分 consumer hook ────────────────────────────────────

export const useLayoutState = () => {
  const ctx = useContext(LayoutStateContext);
  if (!ctx) throw new Error('useLayoutState must be used within LayoutProvider');
  return ctx;
};

export const useLayoutStatus = () => {
  const ctx = useContext(LayoutStatusContext);
  if (!ctx) throw new Error('useLayoutStatus must be used within LayoutProvider');
  return ctx;
};

export const useLayoutActions = (): LayoutActions => {
  const ctx = useContext(LayoutActionsContext);
  if (!ctx) throw new Error('useLayoutActions must be used within LayoutProvider');
  return ctx;
};

export const useLayoutMeta = () => {
  const ctx = useContext(LayoutMetaContext);
  if (!ctx) throw new Error('useLayoutMeta must be used within LayoutProvider');
  return ctx;
};

// 向后兼容: useLayout() 合并 4 个 Context (用 useMemo 合批避免每次返回新对象)
export const useLayout = () => {
  const state = useLayoutState();
  const status = useLayoutStatus();
  const actions = useLayoutActions();
  const meta = useLayoutMeta();
  return useMemo(
    () => ({ ...state, ...status, ...actions, ...meta }),
    [state, status, actions, meta],
  );
};

// ── 4. LayoutProvider ────────────────────────────────────────

export const LayoutProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [state, dispatch] = useReducer(reducer, INITIAL_STATE);
  // 用 ref 镜像 state, 避免 mousemove 闭包陈旧
  const stateRef = useRef(state);
  stateRef.current = state;

  // ── 4.1 Action callbacks (useCallback 引用稳定) ──

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

  // ── 4.2 用 ref 镜像 actions, 让 LayoutActionsContext 的 value 引用永稳定 ──
  // 这是关键: 即使 dispatch 触发了 useReducer state 变化, actions 对象引用也不变
  // 订阅 actions 的组件 (Header / ResizeHandles) 0 re-render
  const actionsRef = useRef<LayoutActions>({
    beginResizeSidebar,
    beginResizePreview,
    endResize,
    onPreviewMinWidthChange,
  });
  actionsRef.current = {
    beginResizeSidebar,
    beginResizePreview,
    endResize,
    onPreviewMinWidthChange,
  };

  // ── 4.3 server 回填 previewWidth (低优先级, 不影响拖动) ──
  // ★ 2026-07-15: 加载时钳制到 [PREVIEW_MIN_WIDTH, PREVIEW_MAX_WIDTH]
  //   之前保存的值可能超过新上限 (如 750), 需要钳制并回写服务器
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/settings/previewWidth');
        if (!res.ok) return;
        const data = await res.json();
        const w = data?.value;
        if (cancelled) return;
        if (typeof w === 'number' && w >= PREVIEW_MIN_WIDTH && w <= PREVIEW_MAX_WIDTH) {
          dispatch({ type: 'loadPreviewWidth', width: w });
          return;
        }
        // 值超出范围 → 用默认值, 并回写服务器纠正
        if (typeof w === 'number' && w > PREVIEW_MAX_WIDTH) {
          const clamped = PREVIEW_MAX_WIDTH;
          dispatch({ type: 'loadPreviewWidth', width: clamped });
          // 异步回写, 不阻塞
          fetch('/api/settings/previewWidth', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ value: clamped }),
          }).catch(() => {});
          return;
        }
        dispatch({ type: 'previewWidthLoaded' });
      } catch {
        dispatch({ type: 'previewWidthLoaded' });
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // 拖动期间保存到 server 的回调 (mouseup 时调)
  const savePreviewWidth = useCallback((w: number) => {
    if (!stateRef.current.previewWidthLoaded) return;
    fetch('/api/settings/previewWidth', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: w }),
    }).catch(() => {});
  }, []);

  // ── 4.4 侧栏 / 预览面板拖动 mousemove 监听器 ──
  const dragRafRef = useRef<number | null>(null);
  const latestPointerRef = useRef<{ x: number; y: number } | null>(null);
  useEffect(() => {
    const flushPending = () => {
      const p = latestPointerRef.current;
      if (!p) return;
      latestPointerRef.current = null;
      const s = stateRef.current;
      if (s.isResizingSidebar) {
        const newWidth = p.x - 48;
        if (newWidth >= 160 && newWidth <= 600) {
          dispatch({ type: 'setSidebarWidth', width: newWidth });
        }
      } else if (s.isResizingPreview) {
        const newWidth = window.innerWidth - p.x;
        if (newWidth >= s.previewMinWidth && newWidth <= PREVIEW_MAX_WIDTH) {
          dispatch({ type: 'setPreviewWidth', width: newWidth });
        }
      }
    };
    const handleMouseMove = (e: MouseEvent) => {
      latestPointerRef.current = { x: e.clientX, y: e.clientY };
      if (dragRafRef.current != null) return;
      dragRafRef.current = requestAnimationFrame(() => {
        dragRafRef.current = null;
        flushPending();
      });
    };
    const handleMouseUp = () => {
      const s = stateRef.current;
      const p = latestPointerRef.current;
      latestPointerRef.current = null;
      if (dragRafRef.current != null) {
        cancelAnimationFrame(dragRafRef.current);
        dragRafRef.current = null;
      }
      if (s.isResizingSidebar) {
        if (p) {
          const finalWidth = p.x - 48;
          if (finalWidth >= 160 && finalWidth <= 600) {
            dispatch({ type: 'endResizeSidebar', width: finalWidth });
          } else {
            dispatch({ type: 'endResize' });
          }
        } else {
          dispatch({ type: 'endResize' });
        }
      } else if (s.isResizingPreview) {
        const finalWidth = p ? (window.innerWidth - p.x) : s.previewWidth;
        const clamped = Math.max(s.previewMinWidth, Math.min(PREVIEW_MAX_WIDTH, finalWidth));
        if (p && clamped !== s.previewWidth) {
          dispatch({ type: 'endResizePreview', width: clamped });
          savePreviewWidth(clamped);
        } else {
          dispatch({ type: 'endResize' });
        }
      } else {
        dispatch({ type: 'endResize' });
      }
    };

    if (state.isResizingSidebar || state.isResizingPreview) {
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      const iframes = document.querySelectorAll('iframe');
      iframes.forEach((f) => (f.style.pointerEvents = 'none'));
    } else {
      if (document.body.style.cursor === 'col-resize') document.body.style.cursor = '';
      if (document.body.style.userSelect === 'none') document.body.style.userSelect = '';
      // FIX: 复原所有 iframe 的 pointer-events（之前 resize 中被设为 none 但从来没还原）
      document.querySelectorAll('iframe').forEach((f) => {
        if (f.style.pointerEvents === 'none') f.style.pointerEvents = '';
      });
    }

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      if (dragRafRef.current != null) {
        cancelAnimationFrame(dragRafRef.current);
        dragRafRef.current = null;
      }
    };
  }, [state.isResizingSidebar, state.isResizingPreview, savePreviewWidth]);

  // 组件卸载时清理
  useEffect(() => {
    return () => {
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      const iframes = document.querySelectorAll('iframe');
      iframes.forEach((f) => (f.style.pointerEvents = 'auto'));
    };
  }, []);

  // ── 4.5 4 个 Context 的 value (每个独立 useMemo) ──

  // 高频变: sidebarWidth, previewWidth
  // 每次 dispatch 都重新计算, 但只让 useLayoutState 消费者 re-render
  const stateValue = useMemo(
    () => ({
      sidebarWidth: state.sidebarWidth,
      previewWidth: state.previewWidth,
    }),
    [state.sidebarWidth, state.previewWidth],
  );

  // 低频变: isResizing*, dragStart*
  const statusValue = useMemo(
    () => ({
      isResizingSidebar: state.isResizingSidebar,
      isResizingPreview: state.isResizingPreview,
      dragStartSidebarWidth: state.dragStartSidebarWidth,
      dragStartPreviewWidth: state.dragStartPreviewWidth,
    }),
    [
      state.isResizingSidebar,
      state.isResizingPreview,
      state.dragStartSidebarWidth,
      state.dragStartPreviewWidth,
    ],
  );

  // 永不变化: actions (用 ref 镜像, 引用永稳定)
  const actionsValue = actionsRef.current;

  // 几乎不变: previewMinWidth, previewWidthLoaded
  const metaValue = useMemo(
    () => ({
      previewMinWidth: state.previewMinWidth,
      previewWidthLoaded: state.previewWidthLoaded,
    }),
    [state.previewMinWidth, state.previewWidthLoaded],
  );

  return (
    <LayoutActionsContext.Provider value={actionsValue}>
      <LayoutMetaContext.Provider value={metaValue}>
        <LayoutStateContext.Provider value={stateValue}>
          <LayoutStatusContext.Provider value={statusValue}>
            {children}
          </LayoutStatusContext.Provider>
        </LayoutStateContext.Provider>
      </LayoutMetaContext.Provider>
    </LayoutActionsContext.Provider>
  );
};
