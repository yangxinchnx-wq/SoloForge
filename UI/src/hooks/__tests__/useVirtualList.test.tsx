/**
 * useVirtualList + VirtualStepList 测试
 *
 * 验证:
 *   1. items < 阈值 (50): 全部可见 (不启用虚拟化)
 *   2. items >= 阈值: 启用虚拟化, 只渲染可见窗口 + overscan
 *   3. scrollTop = 0: 第一项 index=0 起可见
 *   4. 滚动到底: 最后一项 index 可见
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import React, { useEffect, useState } from 'react';
import { useVirtualList } from '../useVirtualList';

// 测试 harness: 把 hook 暴露的值输出到 DOM
function Harness({ count, rowHeight = 26, maxHeight = 220, itemLabel = 'item' }: {
  count: number; rowHeight?: number; maxHeight?: number; itemLabel?: string;
}) {
  const items = Array.from({ length: count }, (_, i) => i);
  const { containerRef, visibleItems, totalHeight, enabled } = useVirtualList(items, {
    rowHeight,
    maxHeight,
  });
  return (
    <div>
      <div data-testid="enabled">{String(enabled)}</div>
      <div data-testid="totalHeight">{totalHeight}</div>
      <div data-testid="visibleCount">{visibleItems.length}</div>
      <div data-testid="firstIdx">{visibleItems[0]?.index ?? -1}</div>
      <div data-testid="lastIdx">{visibleItems.at(-1)?.index ?? -1}</div>
      <div ref={containerRef} data-testid="container" style={{ height: maxHeight, overflowY: 'auto' }}>
        {visibleItems.map((it) => (
          <div key={it.index} data-testid={`${itemLabel}-${it.index}`}>{it.index}</div>
        ))}
      </div>
    </div>
  );
}

describe('useVirtualList — item 数 < 阈值 (50)', () => {
  it('不启用虚拟化, 全部可见', () => {
    render(<Harness count={10} />);
    expect(screen.getByTestId('enabled').textContent).toBe('false');
    expect(screen.getByTestId('visibleCount').textContent).toBe('10');
    expect(screen.getByTestId('firstIdx').textContent).toBe('0');
    expect(screen.getByTestId('lastIdx').textContent).toBe('9');
    expect(screen.getByTestId('totalHeight').textContent).toBe(String(10 * 26));
  });

  it('49 个 items 时仍不启用虚拟化', () => {
    render(<Harness count={49} />);
    expect(screen.getByTestId('enabled').textContent).toBe('false');
    expect(screen.getByTestId('visibleCount').textContent).toBe('49');
  });
});

describe('useVirtualList — item 数 >= 阈值 (50): 启用虚拟化', () => {
  it('默认 overscan=4, 默认 maxHeight=360: 启用了虚拟化', () => {
    render(<Harness count={100} maxHeight={220} />);
    expect(screen.getByTestId('enabled').textContent).toBe('true');
    // 220 / 26 ≈ 8.5 行可见 + 2*4 overscan = 17 行 max
    const vis = Number(screen.getByTestId('visibleCount').textContent);
    expect(vis).toBeGreaterThan(0);
    expect(vis).toBeLessThan(20);
    expect(screen.getByTestId('firstIdx').textContent).toBe('0');
  });

  it('实际渲染的 DOM 节点数 == visibleItems.length (虚拟化生效)', () => {
    render(<Harness count={100} maxHeight={220} />);
    const vis = Number(screen.getByTestId('visibleCount').textContent);
    const rendered = screen.getAllByTestId(/^item-\d/).length;
    expect(rendered).toBe(vis);
  });

  it('totalHeight = items.length * rowHeight (1100px for 100×11px rowHeight)', () => {
    render(<Harness count={100} rowHeight={11} />);
    expect(screen.getByTestId('totalHeight').textContent).toBe('1100');
  });
});

describe('useVirtualList — 滚动到底部', () => {
  function ScrollHarness({ count, scrollTop }: { count: number; scrollTop: number }) {
    const items = Array.from({ length: count }, (_, i) => i);
    const { containerRef, visibleItems, totalHeight, enabled } = useVirtualList(items, {
      rowHeight: 26,
      maxHeight: 220,
    });
    useEffect(() => {
      const el = containerRef.current;
      if (el) el.scrollTop = scrollTop;
    }, [scrollTop]);
    return (
      <div>
        <div data-testid="enabled">{String(enabled)}</div>
        <div data-testid="totalHeight">{totalHeight}</div>
        <div data-testid="firstIdx">{visibleItems[0]?.index ?? -1}</div>
        <div data-testid="lastIdx">{visibleItems.at(-1)?.index ?? -1}</div>
        <div ref={containerRef} data-testid="container" style={{ height: 220, overflowY: 'auto' }}>
          {visibleItems.map((it) => <div key={it.index} data-testid={`item-${it.index}`}>{it.index}</div>)}
        </div>
      </div>
    );
  }

  it('滚动到 scrollTop=1000 (1000/26 ≈ 38): firstIdx 含 overscan, lastIdx 受 overscan 影响', () => {
    render(<ScrollHarness count={100} scrollTop={1000} />);
    expect(screen.getByTestId('enabled').textContent).toBe('true');
    // floor(1000/26) = 38, overscan=4 → firstIdx = 34
    expect(screen.getByTestId('firstIdx').textContent).toBe('34');
    // (1000+220)/26 = 46.9, ceil = 47, + overscan = 51, 限到 items.length-1=99
    expect(screen.getByTestId('lastIdx').textContent).toBe('51');
  });

  it('滚动到底 (scrollTop >= totalHeight): lastIdx 应为 items.length-1', () => {
    render(<ScrollHarness count={100} scrollTop={100000} />);
    expect(screen.getByTestId('lastIdx').textContent).toBe('99');
    // firstIdx 不超过 items.length-1 - visibleWindow
    const first = Number(screen.getByTestId('firstIdx').textContent);
    expect(first).toBeGreaterThanOrEqual(80);
  });
});

describe('useVirtualList — 边界', () => {
  it('空列表: enabled=false (因 length=0 < 阈值)', () => {
    render(<Harness count={0} />);
    expect(screen.getByTestId('enabled').textContent).toBe('false');
    expect(screen.getByTestId('visibleCount').textContent).toBe('0');
    expect(screen.getByTestId('totalHeight').textContent).toBe('0');
  });
});
