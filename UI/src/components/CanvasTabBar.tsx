/**
 * CanvasTabBar — 横向滚动标签栏
 *
 * 设计目标:
 * - 每个标签 = 一个 canvas session (1:1 绑定对话)
 * - 标题用对话**序号** (1, 2, 3...) 而非真实对话标题
 * - 横向滚动 (tabs 多了可左右滑)
 * - 状态指示: idle=灰点 / running=绿点 / paused=橙点 / error=红点
 * - 单击切换 active tab; 中键 / × 关闭
 */

import React, { useRef, useEffect, useCallback } from 'react';
import { Plus, X, ChevronLeft, ChevronRight } from '../utils/icons';

export type CanvasTabStatus = 'idle' | 'starting' | 'running' | 'paused' | 'error';

export interface CanvasTab {
  id: string;             // sessionId
  index: number;          // 序号 (从 1 起)
  status: CanvasTabStatus;
  /** 鼠标悬停时显示的原始对话标题(只用于 tooltip) */
  hint?: string;
}

interface CanvasTabBarProps {
  tabs: CanvasTab[];
  activeTabId: string | null;
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
  onNewTab: () => void;
}

const STATUS_COLOR: Record<CanvasTabStatus, string> = {
  idle: 'bg-on-surface/30',
  starting: 'bg-amber-500 animate-pulse',
  running: 'bg-emerald-500 animate-pulse',
  paused: 'bg-orange-500',
  error: 'bg-red-500',
};

const STATUS_LABEL: Record<CanvasTabStatus, string> = {
  idle: '未启动',
  starting: '启动中',
  running: '运行中',
  paused: '已暂停',
  error: '错误',
};

const CanvasTabBar: React.FC<CanvasTabBarProps> = ({
  tabs, activeTabId, onSelectTab, onCloseTab, onNewTab,
}) => {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const activeBtnRef = useRef<HTMLButtonElement | null>(null);

  // active 切换 → 自动滚动到可视区
  useEffect(() => {
    if (activeBtnRef.current && scrollRef.current) {
      activeBtnRef.current.scrollIntoView({
        behavior: 'smooth',
        block: 'nearest',
        inline: 'nearest',
      });
    }
  }, [activeTabId]);

  const scrollBy = useCallback((dx: number) => {
    scrollRef.current?.scrollBy({ left: dx, behavior: 'smooth' });
  }, []);

  // 中键关闭
  const handleAuxClick = (e: React.MouseEvent, id: string) => {
    if (e.button === 1) {
      e.preventDefault();
      onCloseTab(id);
    }
  };

  return (
    <div
      className="flex items-stretch border-b border-outline/40 bg-surface-bright/30 shrink-0 select-none"
      role="tablist"
      aria-label="画布会话标签"
    >
      {/* 左滚按钮 — tab 多了才显示 */}
      <button
        type="button"
        onClick={() => scrollBy(-160)}
        title="向左滚动"
        className="px-1.5 text-on-surface/50 hover:text-on-surface hover:bg-surface-bright/60 transition-colors shrink-0"
      >
        <ChevronLeft className="w-3.5 h-3.5" />
      </button>

      {/* 标签滚动区 */}
      <div
        ref={scrollRef}
        className="flex-1 flex items-stretch overflow-x-auto overflow-y-hidden min-w-0"
        style={{ scrollbarWidth: 'thin' }}
      >
        {tabs.length === 0 ? (
          <div className="flex items-center px-3 text-[10px] font-mono text-on-surface/40">
            暂无画布 — 点击 + 创建
          </div>
        ) : (
          tabs.map((tab) => {
            const isActive = tab.id === activeTabId;
            return (
              <button
                key={tab.id}
                ref={isActive ? activeBtnRef : undefined}
                type="button"
                role="tab"
                aria-selected={isActive}
                onClick={() => onSelectTab(tab.id)}
                onAuxClick={(e) => handleAuxClick(e, tab.id)}
                title={tab.hint ? `${tab.hint} · ${STATUS_LABEL[tab.status]}` : STATUS_LABEL[tab.status]}
                className={[
                  'group relative flex items-center gap-1.5 px-3 py-1.5 shrink-0',
                  'border-r border-outline/30 transition-colors',
                  isActive
                    ? 'bg-surface text-on-surface'
                    : 'bg-surface-bright/40 text-on-surface/65 hover:text-on-surface hover:bg-surface-bright/70',
                ].join(' ')}
                style={isActive ? {
                  boxShadow: 'inset 0 -2px 0 0 var(--color-main-primary, #6366f1)',
                } : undefined}
              >
                <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${STATUS_COLOR[tab.status]}`} />
                <span className="font-mono text-[11px] font-semibold tabular-nums">
                  {tab.index}
                </span>
                <span
                  role="button"
                  aria-label="关闭标签"
                  onClick={(e) => {
                    e.stopPropagation();
                    onCloseTab(tab.id);
                  }}
                  className="ml-1 w-4 h-4 flex items-center justify-center rounded hover:bg-on-surface/15 opacity-0 group-hover:opacity-100 transition-opacity"
                >
                  <X className="w-2.5 h-2.5" />
                </span>
              </button>
            );
          })
        )}
      </div>

      {/* 新建标签 */}
      <button
        type="button"
        onClick={onNewTab}
        title="新建画布标签"
        className="px-2 text-on-surface/60 hover:text-on-surface hover:bg-surface-bright/60 transition-colors shrink-0"
      >
        <Plus className="w-3.5 h-3.5" />
      </button>

      {/* 右滚按钮 */}
      <button
        type="button"
        onClick={() => scrollBy(160)}
        title="向右滚动"
        className="px-1.5 text-on-surface/50 hover:text-on-surface hover:bg-surface-bright/60 transition-colors shrink-0"
      >
        <ChevronRight className="w-3.5 h-3.5" />
      </button>
    </div>
  );
};

export default CanvasTabBar;
