import React from 'react';
import { Trash2, Eraser, Folder } from '../utils/icons';
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
  isOverlayClone?: boolean;
  isOverTarget?: boolean;
  isPulsing?: boolean;
  isRippling?: boolean;
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
        {/* Row 1: icon + title + delete button */}
        <div className="flex items-center gap-2 w-full">
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
              className="text-[12px] font-bold bg-black/40 border border-primary/40 rounded px-1.5 py-0.5 outline-none flex-1 min-w-0 text-on-surface"
              autoFocus
            />
          ) : (
            <div
              onDoubleClick={(e) => {
                e.stopPropagation();
                e.preventDefault();
                setIsEditingTitle(true);
              }}
              className="text-[12px] font-bold truncate leading-tight select-none cursor-text flex-1 min-w-0"
              title="双击重命名项目名称"
            >
              {chat.title}
            </div>
          )}
          <button
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onDelete(chat.id, chat.title);
            }}
            className="p-1 rounded hover:bg-red-500/25 text-on-surface/40 hover:text-red-400 transition-all duration-150 cursor-pointer shrink-0"
            title="删除会话"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Row 2: time + clear session button */}
        <div className="flex items-center justify-between text-[10px]">
          <span className="text-on-surface/40 font-mono tracking-wide">{chat.time}</span>
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
