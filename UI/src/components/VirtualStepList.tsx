/**
 * VirtualStepList — 流送区步骤虚拟列表
 *
 * 包裹 useVirtualList, 用于 SubTaskNode 内的 stepHistory 渲染
 * 行高固定 26px, 容器 maxHeight 220px (超出滚动)
 * - < 50 条: 全量渲染 (DOM 简短, 没必要虚拟化)
 * - >= 50 条: 启用虚拟化
 */
import React from 'react';
import { StepRecordItem } from './StepRecordItem';
import type { StepRecord } from '../types/streaming';
import { useVirtualList } from '../hooks/useVirtualList';

interface VirtualStepListProps {
  steps: StepRecord[];
  /** 每行高度 (px) — StepRecordItem 视觉上单行 ≈ 26px */
  rowHeight?: number;
  /** 容器最大高度 (px) */
  maxHeight?: number;
}

export function VirtualStepList({ steps, rowHeight = 26, maxHeight = 220 }: VirtualStepListProps) {
  const { containerRef, spacerRef, visibleItems, totalHeight } = useVirtualList(steps, {
    rowHeight,
    maxHeight,
  });

  return (
    <div
      ref={containerRef}
      className="relative overflow-y-auto"
      style={{ maxHeight }}
    >
      <div ref={spacerRef} style={{ height: totalHeight, position: 'relative' }}>
        {visibleItems.map(({ index, top }) => (
          <div
            key={`${steps[index].step}-${index}`}
            style={{
              position: 'absolute',
              top,
              left: 0,
              right: 0,
              height: rowHeight,
            }}
          >
            <StepRecordItem
              step={steps[index]}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
