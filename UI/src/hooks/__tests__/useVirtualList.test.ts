/**
 * useVirtualList 单元测试 — 测核心纯函数 computeVisibleItems
 *
 * 注: hook 自身需要 DOM 才能跑 ResizeObserver/scroll 监听, 单元测试聚焦算法
 */
import { describe, it, expect } from 'vitest';
import { computeVisibleItems, DEFAULT_VIRTUALIZE_THRESHOLD } from '../useVirtualList';

describe('useVirtualList — computeVisibleItems 纯函数', () => {
  it('空列表 → visible=[]', () => {
    expect(computeVisibleItems(0, 26, 0, 220, 4)).toEqual([]);
  });

  it('滚动顶部 (scrollTop=0): firstIdx=0, endIdx = ceil(220/26)+4 = 13', () => {
    // 220/26 = 8.46, ceil = 9, + 4 overscan = 13
    const vis = computeVisibleItems(100, 26, 0, 220, 4);
    expect(vis[0].index).toBe(0);
    expect(vis[0].top).toBe(0);
    expect(vis.at(-1)!.index).toBe(13);
    expect(vis.length).toBe(14); // index 0..13 = 14 项
  });

  it('滚动中部 (scrollTop=520, 20 行): firstIdx=16, endIdx=33', () => {
    // floor(520/26) = 20, - 4 overscan = 16
    // ceil((520+220)/26) = 29, + 4 = 33
    const vis = computeVisibleItems(100, 26, 520, 220, 4);
    expect(vis[0].index).toBe(16);
    expect(vis.at(-1)!.index).toBe(33);
    expect(vis.length).toBe(18); // 16..33 = 18 项
  });

  it('滚动到底部 (scrollTop 超过 totalHeight): lastIdx = items.length - 1', () => {
    const vis = computeVisibleItems(100, 26, 100000, 220, 4);
    expect(vis.at(-1)!.index).toBe(99);
    // firstIdx 也应该在底部附近, 不应出现空数组
    expect(vis.length).toBeGreaterThan(0);
  });

  it('clientHeight=0 (容器未渲染): 仅第一项可见 (防御性)', () => {
    const vis = computeVisibleItems(100, 26, 0, 0, 4);
    // 防御分支: visible.length===0 时强制 push {0,0}
    expect(vis[0].index).toBe(0);
    expect(vis[0].top).toBe(0);
  });

  it('scrollTop 负值: clamp 到 0', () => {
    const vis = computeVisibleItems(100, 26, -50, 220, 4);
    expect(vis[0].index).toBe(0);
  });

  it('overscan=0: 恰好可见 ceil(clientHeight/rowHeight) 行 (idx 0..9 共 10 项)', () => {
    const vis = computeVisibleItems(100, 26, 0, 220, 0);
    // ceil(220/26) = 9, endIdx = 9, index 0..9 = 10 项
    expect(vis.length).toBe(10);
    expect(vis.at(-1)!.index).toBe(9);
  });

  it('rowHeight 太大 (单行超过 clientHeight): 仅第一项可见, top=0', () => {
    const vis = computeVisibleItems(100, 1000, 0, 220, 4);
    // floor(0/1000) - 4 = -4 → clamp 0; ceil(220/1000) + 4 = 5 → endIdx = 5
    expect(vis[0].index).toBe(0);
    expect(vis.at(-1)!.index).toBe(5);
    expect(vis[0].top).toBe(0);
  });

  it('每个 visible 项的 top 严格等于 index * rowHeight', () => {
    const vis = computeVisibleItems(100, 30, 200, 300, 4);
    vis.forEach(v => expect(v.top).toBe(v.index * 30));
  });
});

describe('useVirtualList — 虚拟化阈值常量', () => {
  it('默认阈值 50', () => {
    expect(DEFAULT_VIRTUALIZE_THRESHOLD).toBe(50);
  });
});
