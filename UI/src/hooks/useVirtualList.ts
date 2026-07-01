/**
 * useVirtualList — 轻量级虚拟列表 hook (零外部依赖)
 *
 * 适用场景: 一个已知 itemCount、固定 rowHeight 的纵向滚动列表
 * 设计取舍:
 *   - 不引入 @tanstack/react-virtual (减体积)
 *   - 用 ResizeObserver + scrollTop 计算可见窗口
 *   - 上下各预留 overscan 行作为 buffer
 *   - 父容器高度 clientHeight, 不假设父容器尺寸
 *   - 核心算法抽出为 computeVisibleItems 纯函数, 便于单元测试
 *
 * 返回:
 *   containerRef  - 滚动的容器 div
 *   visibleItems  - { index, top }[]  (按当前窗口裁剪后的子集)
 *   totalHeight   - 完整列表像素高度
 *   enabled       - 是否真正启用了虚拟化 (item 数量超过阈值才启用)
 */
import { useEffect, useRef, useState } from 'react';

export interface VirtualListItem {
  index: number;
  top: number;
}

export interface UseVirtualListOptions {
  /** 每行固定高度 (px) */
  rowHeight?: number;
  /** 上下各多渲染多少行 buffer (滚动不抖动) */
  overscan?: number;
  /** 容器最大可见高度 (px), 超过这个高度时启用内部滚动 */
  maxHeight?: number;
}

export interface UseVirtualListResult<T> {
  containerRef: React.RefObject<HTMLDivElement>;
  spacerRef: React.RefObject<HTMLDivElement>;
  visibleItems: VirtualListItem[];
  totalHeight: number;
  /** 是否真正启用了虚拟化 (item 数量超过阈值才启用) */
  enabled: boolean;
}

/** item 数量达到这个阈值才启用虚拟化 */
export const DEFAULT_VIRTUALIZE_THRESHOLD = 50;

/**
 * 纯函数: 给定 items.length, scrollTop, clientHeight → 哪些 index 可见
 *   - 边界: scrollTop < 0 → 0; clientHeight <= 0 → 仅看 0..overscan
 *   - 边界: scrollTop + clientHeight >= totalHeight → 窗口贴底
 */
export function computeVisibleItems(
  itemCount: number,
  rowHeight: number,
  scrollTop: number,
  clientHeight: number,
  overscan: number,
): VirtualListItem[] {
  if (itemCount === 0) return [];
  const safeScrollTop = Math.max(0, scrollTop);
  const safeClientHeight = Math.max(0, clientHeight);

  // startIdx 防御: scrollTop 超出 totalHeight 时, naive floor 会爆到 itemCount 以上
  // → clamp 到 [0, itemCount - 1]
  const rawStart = Math.floor(safeScrollTop / rowHeight) - overscan;
  const startIdx = Math.max(0, Math.min(itemCount - 1, rawStart));
  // 如果滚到或超出底部, endIdx 取最后一个
  const endIdxRaw = Math.ceil((safeScrollTop + safeClientHeight) / rowHeight) + overscan;
  const endIdx = Math.min(itemCount - 1, endIdxRaw);

  const visible: VirtualListItem[] = [];
  for (let i = startIdx; i <= endIdx; i++) {
    visible.push({ index: i, top: i * rowHeight });
  }
  // 防御: 极端情况下 startIdx > endIdx (容器不可见), 至少露出第一个
  if (visible.length === 0 && itemCount > 0) {
    visible.push({ index: 0, top: 0 });
  }
  return visible;
}

/**
 * 虚拟列表 hooks 主体 (封装 useEffect + scrollTop 状态机)
 */
export function useVirtualList<T>(
  items: T[],
  options: UseVirtualListOptions = {}
): UseVirtualListResult<T> {
  const { rowHeight = 32, overscan = 4, maxHeight = 360 } = options;
  const containerRef = useRef<HTMLDivElement>(null);
  const spacerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [clientHeight, setClientHeight] = useState(maxHeight);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const onScroll = () => setScrollTop(el.scrollTop);
    el.addEventListener('scroll', onScroll, { passive: true });

    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(() => {
        const h = el.clientHeight;
        if (h > 0 && Math.abs(h - clientHeight) > 1) setClientHeight(h);
      });
      ro.observe(el);
    }

    return () => {
      el.removeEventListener('scroll', onScroll);
      ro?.disconnect();
    };
  }, [clientHeight]);

  const totalHeight = items.length * rowHeight;
  const enabled = items.length >= DEFAULT_VIRTUALIZE_THRESHOLD;

  // 未启用: 返回全部 items (DOM 简短不必要虚拟化)
  if (!enabled) {
    return {
      containerRef,
      spacerRef,
      visibleItems: items.map((_, index) => ({ index, top: index * rowHeight })),
      totalHeight,
      enabled: false,
    };
  }

  // 启用: 调纯函数
  const visibleItems = computeVisibleItems(
    items.length,
    rowHeight,
    scrollTop,
    clientHeight,
    overscan,
  );

  return {
    containerRef,
    spacerRef,
    visibleItems,
    totalHeight,
    enabled: true,
  };
}
