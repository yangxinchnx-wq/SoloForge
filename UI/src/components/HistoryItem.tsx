import React from 'react';
import { SlidersHorizontal, Trash2, Eraser, Folder } from '../utils/icons';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { ChatHistoryItem } from '../types';

interface DraggableChatHistoryItem extends ChatHistoryItem {
  tag: string;
  tagBg: string;
  tagText: string;
  icon: any;
  permission?: 'normal' | 'performance' | 'ultimate' | 'expert';
  workspaceFolder?: string;
}

// ============================================================
// HistoryItemCard — 纯展示组件，不包含任何 dnd-kit hook。
// 用于 SortableHistoryItem（列表项）和 DragOverlay（拖拽克隆体）。
// 分离的目的：DragOverlay 内不能再调用 useSortable，否则同一个 id
// 注册两个 draggable，dnd-kit 内部冲突导致 overlay 不跟鼠标。
// ============================================================

interface HistoryItemCardProps {
  chat: DraggableChatHistoryItem;
  isActive: boolean;
  onSelect: (id: string) => void;
  onOpenSettings: (id: string, title: string) => void;
  onDelete: (id: string, title: string) => void;
  onRename: (id: string, title: string) => void;
  onClearSession?: (id: string) => void;
  isFloatingEditorOpen?: boolean;
  /** When true, this card is rendered inside <DragOverlay>。
   *  使用 .sf-overlay-card 类（不透明背景 + lifted 阴影），
   *  而非 .is-lifted（后者背景 !important 6% 透明）。 */
  isOverlayClone?: boolean;
  /** When true, this card is the current dnd-kit `over` target. */
  isOverTarget?: boolean;
  /** When true, play the post-drop pulse highlight. */
  isPulsing?: boolean;
  /** When true, play the post-drop radial ripple. */
  isRippling?: boolean;
  /** When true, play the soft enter animation (fade + slide + scale). */
  isNew?: boolean;
}

// React.memo — 拖动时父组件 onDragOver 会 setState,如果不 memo,
// 所有 HistoryItemCard 都会重渲染。memo 做浅比较,props 不变就跳过。
const HistoryItemCard = React.memo(function HistoryItemCard({
  chat,
  isActive,
  onSelect,
  onOpenSettings,
  onDelete,
  onRename,
  onClearSession,
  isFloatingEditorOpen,
  isOverlayClone,
  isOverTarget,
  isPulsing,
  isRippling,
  isNew,
}: HistoryItemCardProps) {
  const [isEditingTitle, setIsEditingTitle] = React.useState(false);
  const [editTitle, setEditTitle] = React.useState(chat.title);
  const inputRef = React.useRef<HTMLInputElement | null>(null);

  React.useEffect(() => {
    setEditTitle(chat.title);
  }, [chat.title]);

  const saveRename = () => {
    const trimmed = editTitle.trim();
    if (trimmed && trimmed !== chat.title) {
      onRename(chat.id, trimmed);
    } else {
      setEditTitle(chat.title);
    }
    setIsEditingTitle(false);
  };

  // overlay clone 用 .sf-overlay-card（不透明），列表项用 .sf-history-card
  const cardClassName = isOverlayClone
    ? `sf-overlay-card group relative p-3 rounded-xl border flex flex-col gap-1.5 w-full max-w-full box-border overflow-hidden select-none outline-none focus:outline-none ${
        isActive
          ? 'bg-surface-bright border-primary text-primary font-bold'
          : 'bg-surface border-outline text-on-surface/85'
      } cursor-grabbing`
    : `sf-history-card group relative p-3 rounded-xl border flex flex-col gap-1.5 w-full max-w-full box-border overflow-hidden select-none outline-none focus:outline-none ${
        isActive
          ? 'bg-primary/10 border-primary shadow-[inset_0_1px_3px_rgba(0,0,0,0.12)] font-bold'
          : 'bg-bg/40 border-outline hover:border-primary/40 hover:bg-surface-bright text-on-surface/85 hover:text-on-surface'
      } cursor-default`;

  const wrapperClassName = `w-full relative select-none ${isOverlayClone ? 'cursor-grabbing' : 'cursor-grab'} touch-none box-border block focus:outline-none outline-none rounded-xl ${isOverTarget ? 'sf-drop-target' : ''} ${isPulsing ? 'sf-drop-pulse' : ''} ${isRippling ? 'sf-drop-ripple is-rippling' : ''} ${isNew && !isOverlayClone ? 'sf-item-enter' : ''}`;

  const handleClick = isOverlayClone ? undefined : (e: React.MouseEvent) => {
    if (isEditingTitle) return;
    onSelect(chat.id);
  };

  return (
    <div
      onClick={handleClick}
      className={wrapperClassName}
    >
      <div className={cardClassName}>
        {/* Title Row */}
        <div className="flex items-center justify-between gap-1.5">
          <div className="flex items-center gap-2 min-w-0 flex-1">
            {chat.workspaceFolder && (
              <div className="text-amber-500/80 shrink-0" title={`工作区: ${chat.workspaceFolder}`}>
                <Folder className="w-3 h-3" />
              </div>
            )}
            {chat.icon && (
              <div className="text-primary shrink-0 opacity-80 group-hover:opacity-100 transition-opacity">
                {React.createElement(chat.icon, { className: "w-3.5 h-3.5" })}
              </div>
            )}
            {isEditingTitle ? (
              <input
                ref={inputRef}
                type="text"
                value={editTitle}
                onChange={(e) => setEditTitle(e.target.value)}
                onBlur={saveRename}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') saveRename();
                  if (e.key === 'Escape') {
                    setEditTitle(chat.title);
                    setIsEditingTitle(false);
                  }
                }}
                onClick={(e) => {
                  e.stopPropagation();
                  e.preventDefault();
                }}
                onMouseDown={(e) => {
                  e.stopPropagation();
                }}
                className="text-[12px] font-bold bg-black/40 border border-primary/40 rounded px-1.5 py-0.5 outline-none w-full text-on-surface"
                autoFocus
              />
            ) : (
              <div
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  e.preventDefault();
                  setIsEditingTitle(true);
                }}
                className="text-[12px] font-bold truncate leading-tight select-none cursor-text flex-1"
                title="双击重命名项目名称"
              >
                {chat.title}
              </div>
            )}
          </div>
          <div className="flex flex-col items-end gap-0.5 shrink-0">
            <div className="flex items-center gap-1">
              {isFloatingEditorOpen && (
                <button
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    onOpenSettings(chat.id, chat.title);
                  }}
                  className="p-1 rounded hover:bg-primary/20 text-on-surface/75 hover:text-primary transition-all duration-150 cursor-pointer"
                  title="定制智能体角色"
                >
                  <SlidersHorizontal className="w-3.5 h-3.5" />
                </button>
              )}
              <button
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  onDelete(chat.id, chat.title);
                }}
                className="p-1 rounded hover:bg-red-500/25 text-on-surface/40 hover:text-red-400 transition-all duration-150 cursor-pointer"
                title="删除会话"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
            {onClearSession && (
              <button
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  onClearSession(chat.id);
                }}
                className="p-1 rounded hover:bg-amber-500/20 text-on-surface/30 hover:text-amber-400 transition-all duration-150 cursor-pointer"
                title="清除当前会话 (保留对话, 清除上下文/流送/画布/终端)"
              >
                <Eraser className="w-3 h-3" />
              </button>
            )}
          </div>
        </div>

        {/* Tile Bottom details / Meta indicators */}
        <div className="flex items-center justify-between text-[10px] mt-0.5">
          <span className="text-on-surface/40 font-mono tracking-wide">{chat.time}</span>
          {isFloatingEditorOpen && (
            <div className="flex items-center gap-1.5">
              <span
                className="inline-flex items-center px-1.5 py-0.5 rounded border text-[8px] font-bold font-mono shadow-sm"
                style={{
                  color:
                    (chat.permission || 'normal') === 'normal' ? '#34d399' :
                    (chat.permission || 'normal') === 'performance' ? '#60a5fa' :
                    (chat.permission || 'normal') === 'expert' ? '#c084fc' : '#f59e0b',
                  borderColor:
                    (chat.permission || 'normal') === 'normal' ? 'rgba(52, 211, 153, 0.2)' :
                    (chat.permission || 'normal') === 'performance' ? 'rgba(96, 165, 250, 0.2)' :
                    (chat.permission || 'normal') === 'expert' ? 'rgba(192, 132, 252, 0.2)' : 'rgba(245, 158, 11, 0.2)',
                  backgroundColor:
                    (chat.permission || 'normal') === 'normal' ? 'rgba(52, 211, 153, 0.08)' :
                    (chat.permission || 'normal') === 'performance' ? 'rgba(96, 165, 250, 0.08)' :
                    (chat.permission || 'normal') === 'expert' ? 'rgba(192, 132, 252, 0.08)' : 'rgba(245, 158, 11, 0.08)',
                }}
              >
                <span>{
                  (chat.permission || 'normal') === 'normal' ? '安全' :
                  (chat.permission || 'normal') === 'performance' ? '半自动' : '全自动'
                }</span>
              </span>

              <span className={`px-1.5 py-0.5 rounded border text-[8.5px] font-bold font-mono ${chat.tagBg} ${chat.tagText}`}>
                {chat.tag}
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
});

// ============================================================
// SortableHistoryItem — 列表项，包裹 useSortable hook。
// 拖拽时 source card 设置 visibility:hidden（让 DragOverlay 接管视觉）。
// ============================================================

interface SortableHistoryItemProps extends Omit<HistoryItemCardProps, 'isOverlayClone'> {}

const SortableHistoryItem = React.memo(React.forwardRef<any, SortableHistoryItemProps>((props, _ref) => {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: props.chat.id });

  // 拖动中的项: transition none (瞬间跟随鼠标)
  // 其他项: 使用 dnd-kit 提供的 transition — 被推开时有弹性碰撞动画
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition: isDragging ? 'none' : (transition ?? 'transform 200ms cubic-bezier(0.22, 1, 0.36, 1)'),
    visibility: isDragging ? 'hidden' : 'visible',
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
    >
      <HistoryItemCard {...props} />
    </div>
  );
}));

export default SortableHistoryItem;
export { HistoryItemCard, SortableHistoryItem };
export type { DraggableChatHistoryItem, HistoryItemCardProps };
