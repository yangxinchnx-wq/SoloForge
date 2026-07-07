import React from 'react';
import { Trash2 } from '../utils/icons';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { ModelIcon } from './ModelIcon';
import type { ModelProvider } from '../data/providersRegistry';

// =====================================================
// 【左面板可拖拽服务商卡片】
// 与 HistoryItem.tsx 完全对齐的双层结构：
//   1. ProviderCardInner — 纯展示组件 (React.memo)，不含 useSortable
//   2. SortableProviderCard — sortable wrapper，调用 useSortable
//
// 设计要点（与 HistoryItem 一致）：
//   - 列表项 inline style 极简：仅 transform / transition / visibility
//   - 拖拽项 transition: 'none' — 瞬跟鼠标，无延迟
//   - 不用 willChange / contain / backfaceVisibility — 这些在 24 项列表上
//     反而创建过多 GPU 层，拖慢合成器
//   - React.memo 防止 onDragOver setState 时全量重渲染
//   - visibility:hidden 源卡 → DragOverlay 克隆唯一可见
// =====================================================

// ─────────────────────────────────────────────────────
// ProviderCardInner — 纯展示组件
// 同时用于列表项 (SortableProviderCard 内) 和 DragOverlay 克隆
// ─────────────────────────────────────────────────────
export interface ProviderCardInnerProps {
  provider: ModelProvider;
  isSelected: boolean;
  onSelect: (id: string) => void;
  onDelete?: (id: string) => void;
  /** When true, this card is rendered inside <DragOverlay>. */
  isOverlayClone?: boolean;
  /** When true, this card is the current dnd-kit `over` target. */
  isOverTarget?: boolean;
  /** When true, play the post-drop pulse highlight. */
  isPulsing?: boolean;
}

const ProviderCardInner = React.memo(function ProviderCardInner({
  provider,
  isSelected,
  onSelect,
  onDelete,
  isOverlayClone,
  isOverTarget,
  isPulsing,
}: ProviderCardInnerProps) {
  const [showDelHint, setShowDelHint] = React.useState(false);
  const isCustom = provider.id.startsWith('custom_');

  return (
    <div
      onClick={isOverlayClone ? undefined : (e) => {
        onSelect(provider.id);
      }}
      className={`w-full relative select-none cursor-pointer touch-none box-border block focus:outline-none outline-none rounded-xl ${isOverTarget ? 'sf-drop-target' : ''} ${isPulsing ? 'sf-drop-pulse' : ''}`}
    >
      <div
        onMouseEnter={() => setShowDelHint(true)}
        onMouseLeave={() => setShowDelHint(false)}
        className={`w-full flex items-center justify-between text-left px-3 py-3 rounded-xl text-xs font-semibold cursor-pointer active:cursor-grabbing border transition-colors duration-200 ${
          isSelected
            ? provider.enabled
              ? 'bg-[var(--color-surface-bright)] border-[var(--color-primary)] text-[var(--color-primary)] font-black'
              : 'bg-[var(--color-surface)] border-on-surface/30 text-on-surface/55 font-black'
            : provider.enabled
              ? 'bg-[var(--color-surface)] border-transparent text-[var(--color-on-surface)]/75 hover:bg-[var(--color-surface-bright)]/40 hover:text-[var(--color-on-surface)] hover:border-[var(--color-primary)]/30'
              : 'bg-[var(--color-surface)] border-transparent text-[var(--color-on-surface)]/35 hover:text-[var(--color-on-surface)]/50'
        }`}
      >
        <div className="flex items-center gap-2 min-w-0 pointer-events-none">
          <ModelIcon modelName={provider.id} size={22} className="shrink-0" iconType={provider.iconType} />
          <span className="truncate">{provider.name}</span>
        </div>
        <div className="flex items-center gap-1.5 shrink-0 pointer-events-none">
          {provider.enabled && (
            <span
              className="w-2 h-2 rounded-full shrink-0"
              style={{ background: 'var(--color-primary)' }}
            />
          )}
          {provider.enabled && provider.status === 'success' && provider.delay && (
            <span className="text-[10px] bg-emerald-500/10 text-emerald-400 font-mono px-1 rounded-sm scale-90 shrink-0">
              {provider.delay}毫秒
            </span>
          )}
          {isCustom && onDelete && showDelHint && (
            <button
              type="button"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onDelete(provider.id);
              }}
              onPointerDown={(e) => { e.stopPropagation(); }}
              onMouseDown={(e) => { e.stopPropagation(); }}
              className="p-1 rounded-md text-on-surface/40 hover:text-rose-400 transition-colors cursor-pointer pointer-events-auto"
              title="删除此自定义通道"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
});

// ─────────────────────────────────────────────────────
// SortableProviderCard — sortable wrapper
// 调用 useSortable，渲染 ProviderCardInner
// ─────────────────────────────────────────────────────
export interface ProviderCardProps {
  provider: ModelProvider;
  isSelected: boolean;
  onSelect: (id: string) => void;
  onDelete?: (id: string) => void;
  /** Transition for sortable displacement, sourced from parent. */
  itemTransition?: string;
  /** When true, this card is the current dnd-kit `over` target. */
  isOverTarget?: boolean;
  /** When true, play the post-drop pulse highlight. */
  isPulsing?: boolean;
}

const SortableProviderCard = React.memo(React.forwardRef<HTMLDivElement, ProviderCardProps>(
  ({ provider, isSelected, onSelect, onDelete, itemTransition, isOverTarget, isPulsing }, ref) => {
    const { setNodeRef, attributes, listeners, transform, transition, isDragging } = useSortable({ id: provider.id });

    // 与 HistoryItem 完全一致的内联样式策略：
    //   - 拖拽中: transition 'none' → 瞬跟鼠标，无延迟
    //   - 其他项: dnd-kit 提供的 transition 或 fallback
    //   - 仅 transform / transition / visibility 三个属性
    //   - 不加 willChange / contain / backfaceVisibility
    const style: React.CSSProperties = {
      transform: CSS.Transform.toString(transform),
      transition: isDragging ? 'none' : (transition ?? itemTransition ?? 'transform 200ms cubic-bezier(0.22, 1, 0.36, 1)'),
      visibility: isDragging ? 'hidden' : 'visible',
    };

    return (
      <div
        ref={(node: HTMLDivElement | null) => {
          setNodeRef(node);
          if (typeof ref === 'function') ref(node);
          else if (ref) (ref as React.MutableRefObject<HTMLDivElement | null>).current = node;
        }}
        style={style}
        data-provider-id={provider.id}
        {...attributes}
        {...listeners}
        onClick={(e) => {
          if (isDragging) { e.preventDefault(); e.stopPropagation(); return; }
          onSelect(provider.id);
        }}
      >
        <ProviderCardInner
          provider={provider}
          isSelected={isSelected}
          onSelect={onSelect}
          onDelete={onDelete}
          isOverTarget={isOverTarget}
          isPulsing={isPulsing}
        />
      </div>
    );
  }
));
SortableProviderCard.displayName = 'SortableProviderCard';

export { ProviderCardInner, SortableProviderCard };
export default SortableProviderCard;
