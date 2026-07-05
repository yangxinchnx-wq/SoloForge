import React from 'react';
import { Plus, Trash2 } from '../utils/icons';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { ModelIcon } from './ModelIcon';
import type { ModelProvider } from '../data/providersRegistry';

// =====================================================
// 【左面板可拖拽服务商卡片】
// 与 HistoryAndEditorPanel 中 history 项使用同一套 dnd-kit 设计：
//   1. visibility:hidden 隐藏源卡 → 仅 DragOverlay 克隆可见（绝不透明）
//   2. outer / overlay / scroll container 三处 GPU 加速
//   3. modifiers = [restrictToVerticalAxis, restrictToParentElement]
//   4. window 'mousemove' 自定义 auto-scroll（ref 同步绑定，不依赖 React 调度）
//   5. transform 180ms cubic-bezier(0.22,1,0.36,1)，drop animation 140ms
// 不下阴影（用户要求）：
//   - 完全移除 shadow-* / boxShadow / drop-shadow，仅保留主题色 border + bg-surface/bright 区分状态
// =====================================================
export interface ProviderCardProps {
  provider: ModelProvider;
  isSelected: boolean;
  onSelect: (id: string) => void;
  onDelete?: (id: string) => void;
  /** Apple HIG spring transition, sourced from parent (providerItemTransition). */
  itemTransition?: string;
  /** When true, this card is rendered inside <DragOverlay>: opaque clone,
   *  no dnd listeners, no click handler, fixed transform=identity. */
  isOverlayClone?: boolean;
  /** When true, this card is the current dnd-kit `over` target. */
  isOverTarget?: boolean;
  /** When true, play the post-drop pulse highlight. */
  isPulsing?: boolean;
}

export const ProviderCard = React.forwardRef<HTMLDivElement, ProviderCardProps>(
  ({ provider, isSelected, onSelect, onDelete, itemTransition, isOverlayClone, isOverTarget, isPulsing }, ref) => {
    const { setNodeRef, attributes, listeners, transform, transition, isDragging } = useSortable({ id: provider.id });
    const [showDelHint, setShowDelHint] = React.useState(false);
    const isCustom = provider.id.startsWith('custom_');

    // GPU-accelerated style: transform only, no opacity (spec: visibility hidden).
    // Apple HIG spring curve for collision displacement — overshoot gives the
    // "jelly" feel when items get pushed aside by the dragged card.
    // Overlay clone: render at identity transform (dnd-kit positions it via
    // top-level DragOverlay transform), and use the spring curve for drop-in.
    const dndStyle: React.CSSProperties = isOverlayClone
      ? {
          transform: 'translate3d(0,0,0) scale(1)',
          transition: 'transform 220ms cubic-bezier(0.22, 1, 0.36, 1)',
          willChange: 'transform',
          backfaceVisibility: 'hidden',
          WebkitBackfaceVisibility: 'hidden',
          contain: 'layout paint style',
        }
      : {
          transform: CSS.Transform.toString(transform),
          transition: transition || itemTransition || 'transform 380ms cubic-bezier(0.34, 1.56, 0.64, 1)',
          visibility: isDragging ? 'hidden' : 'visible',
          willChange: isDragging ? 'transform' : 'auto',
          backfaceVisibility: 'hidden',
          WebkitBackfaceVisibility: 'hidden',
          contain: 'layout paint style',
        };

    return (
      <div
        ref={isOverlayClone ? undefined : (node: HTMLDivElement | null) => {
          setNodeRef(node);
          if (typeof ref === 'function') ref(node);
          else if (ref) (ref as React.MutableRefObject<HTMLDivElement | null>).current = node;
        }}
        style={dndStyle}
        data-provider-id={provider.id}
        {...(isOverlayClone ? {} : attributes)}
        {...(isOverlayClone ? {} : listeners)}
        onClick={isOverlayClone ? undefined : (e) => {
          if (isDragging) { e.preventDefault(); e.stopPropagation(); return; }
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
          <div className="flex items-center gap-2.5 truncate pointer-events-none">
            {provider.id === 'custom' && !isCustom ? (
              <Plus className="shrink-0 opacity-65" style={{ width: 22, height: 22 }} />
            ) : (
              <ModelIcon modelName={provider.id} size={22} className="shrink-0" />
            )}
            <span className="truncate">{provider.name}</span>
          </div>
          <div className="flex items-center gap-1.5 shrink-0 pointer-events-none">
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
  }
);
ProviderCard.displayName = 'ProviderCard';

export default ProviderCard;
