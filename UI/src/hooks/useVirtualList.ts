import React from 'react';

/**
 * Default item count threshold above which virtualization kicks in.
 * Lists with fewer items render all at once (no measurement overhead).
 */
export const DEFAULT_VIRTUALIZE_THRESHOLD = 50;

/**
 * Pure function: compute which items are visible given scroll state.
 *
 * @param totalItems  Total item count
 * @param rowHeight   Height of each row in px
 * @param scrollTop   Current scroll offset in px
 * @param clientHeight Viewport height in px (0 = container not yet rendered)
 * @param overscan    Extra items to render above/below viewport
 * @returns Array of { index, top } for visible items
 */
export function computeVisibleItems(
  totalItems: number,
  rowHeight: number,
  scrollTop: number,
  clientHeight: number,
  overscan: number,
): { index: number; top: number }[] {
  if (totalItems <= 0 || rowHeight <= 0) return [];

  // Clamp negative scrollTop
  const st = Math.max(0, scrollTop);

  // Defensive: if clientHeight is 0 (container not rendered), show at least first item
  if (clientHeight <= 0) {
    return [{ index: 0, top: 0 }];
  }

  const firstIdx = Math.max(0, Math.floor(st / rowHeight) - overscan);
  const endIdx = Math.min(
    totalItems - 1,
    Math.ceil((st + clientHeight) / rowHeight) + overscan,
  );

  if (firstIdx > endIdx) {
    // Scroll past end: show last item only
    return [{ index: endIdx, top: endIdx * rowHeight }];
  }

  const result: { index: number; top: number }[] = [];
  for (let i = firstIdx; i <= endIdx; i++) {
    result.push({ index: i, top: i * rowHeight });
  }
  return result;
}

/**
 * Lightweight windowing hook for dnd-kit sortable lists.
 *
 * Why not react-virtuoso? It doesn't play well with dnd-kit's
 * useSortable ref measurement during a drag. So we use a simple
 * "estimateSize + scrollTop" windowing: only items whose estimated
 * vertical range intersects [scrollTop - overscan, scrollTop + viewport
 * + overscan] are mounted.
 *
 * Critical dnd-kit constraint: during a drag we mount ALL items so the
 * collision algorithm can measure every node. We expose `forceAll` to
 * flip on/off windowing; the parent component drives it from
 * activeDragId state.
 */
export interface UseVirtualListOptions {
  /** Total item count */
  count: number;
  /** Estimated item height in px (use the modal value — collisions need this stable) */
  estimateSize: number;
  /** Vertical gap between items in px (matches `space-y-2` etc.) */
  gap: number;
  /** Ref to the scroll container */
  scrollRef: React.RefObject<HTMLElement>;
  /** Items to render before/after viewport in px (default 600) */
  overscan?: number;
  /** When true, mount all items (used during drag) */
  forceAll?: boolean;
}

export interface VirtualItem {
  index: number;
  /** Absolute top of this item within the virtualized list, in px */
  top: number;
  style: React.CSSProperties;
}

export function useVirtualList(opts: UseVirtualListOptions): {
  totalHeight: number;
  items: VirtualItem[];
  offsetTop: number;
} {
  const { count, estimateSize, gap, scrollRef, overscan = 600, forceAll = false } = opts;
  const [scrollTop, setScrollTop] = React.useState(0);
  const [viewportH, setViewportH] = React.useState(0);

  React.useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => setScrollTop(el.scrollTop);
    onScroll();
    // Use ResizeObserver to track viewport height changes
    const ro = new ResizeObserver(() => {
      setViewportH(el.clientHeight);
      setScrollTop(el.scrollTop);
    });
    ro.observe(el);
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      ro.disconnect();
      el.removeEventListener('scroll', onScroll);
    };
  }, [scrollRef]);

  const rowStride = estimateSize + gap;
  const totalHeight = count > 0 ? count * rowStride - gap : 0;

  if (count === 0) {
    return { totalHeight: 0, items: [], offsetTop: 0 };
  }

  if (forceAll) {
    const items: VirtualItem[] = [];
    for (let i = 0; i < count; i++) {
      items.push({
        index: i,
        top: i * rowStride,
        style: {
          position: 'absolute',
          left: 0,
          right: 0,
          top: i * rowStride,
          // height left to its content (caller sets it via inner div)
        },
      });
    }
    return { totalHeight, items, offsetTop: 0 };
  }

  const startVisible = Math.max(0, Math.floor((scrollTop - overscan) / rowStride));
  const endVisible = Math.min(
    count - 1,
    Math.ceil((scrollTop + viewportH + overscan) / rowStride)
  );

  const items: VirtualItem[] = [];
  for (let i = startVisible; i <= endVisible; i++) {
    items.push({
      index: i,
      top: i * rowStride,
      style: {
        position: 'absolute',
        left: 0,
        right: 0,
        top: i * rowStride,
      },
    });
  }
  return { totalHeight, items, offsetTop: 0 };
}
