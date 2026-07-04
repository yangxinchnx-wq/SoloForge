import React from 'react';
import { Trash2 } from 'lucide-react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { ChatHistoryItem } from '../types';

interface DraggableChatHistoryItem extends ChatHistoryItem {
  chatNumber?: number;
  tag: string;
  tagBg: string;
  tagText: string;
  icon: any;
  permission?: 'normal' | 'performance' | 'ultimate' | 'expert';
}

interface HistoryItemProps {
  chat: DraggableChatHistoryItem;
  isActive: boolean;
  onSelect: (id: string) => void;
  onOpenSettings: (id: string, title: string) => void;
  onDelete: (id: string, title: string) => void;
  onRename: (id: string, title: string) => void;
  isFloatingEditorOpen?: boolean;
}

const HistoryItem = React.memo<HistoryItemProps>(({ chat, isActive, onSelect, onDelete, onRename, isFloatingEditorOpen }) => {
  const [isEditingTitle, setIsEditingTitle] = React.useState(false);
  const [editTitle, setEditTitle] = React.useState(chat.title);
  const isDraggingRef = React.useRef(false);

  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: chat.id });

  React.useEffect(() => {
    if (isDragging) {
      isDraggingRef.current = true;
    } else {
      const t = setTimeout(() => { isDraggingRef.current = false; }, 100);
      return () => clearTimeout(t);
    }
  }, [isDragging]);

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

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition: transition || 'transform 200ms cubic-bezier(0.22, 1, 0.36, 1)',
    visibility: isDragging ? 'hidden' : 'visible',
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      onClick={(e) => {
        if (isDraggingRef.current) { e.preventDefault(); e.stopPropagation(); return; }
        if (isEditingTitle) return;
        onSelect(chat.id);
      }}
      className={`w-full select-none touch-none box-border block focus:outline-none outline-none rounded-xl cursor-grab`}
    >
      <div className={`group relative p-3 rounded-xl border flex flex-col gap-1.5 w-full max-w-full box-border overflow-hidden select-none outline-none focus:outline-none ${
        isDragging
          ? 'bg-surface border-primary opacity-0'
          : isActive
          ? 'bg-primary/10 border-primary text-primary shadow-[inset_0_1px_3px_rgba(0,0,0,0.12)] font-bold'
          : 'bg-surface border-outline hover:border-primary/40 hover:bg-surface-bright text-on-surface/85 hover:text-on-surface'
      }`}>
        {/* Title Row */}
        <div className="flex items-center justify-between gap-1.5">
          <div className="flex items-center gap-2 min-w-0 flex-1">
            {chat.icon && (
              <div className="text-primary shrink-0 opacity-80 group-hover:opacity-100 transition-opacity">
                {React.createElement(chat.icon, { className: "w-3.5 h-3.5" })}
              </div>
            )}
            {isEditingTitle ? (
              <input
                type="text"
                value={editTitle}
                onChange={(e) => setEditTitle(e.target.value)}
                onBlur={saveRename}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') saveRename();
                  if (e.key === 'Escape') { setEditTitle(chat.title); setIsEditingTitle(false); }
                }}
                onClick={(e) => { e.stopPropagation(); e.preventDefault(); }}
                onMouseDown={(e) => { e.stopPropagation(); }}
                className="text-[12px] font-bold bg-black/40 border border-primary/40 rounded px-1.5 py-0.5 outline-none w-full text-on-surface"
                autoFocus
              />
            ) : (
              <div
                onDoubleClick={(e) => { e.stopPropagation(); e.preventDefault(); setIsEditingTitle(true); }}
                className="text-[12px] font-bold truncate leading-tight select-none cursor-text flex-1"
                title="双击重命名"
              >
                {chat.title}
              </div>
            )}
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <button
              onClick={(e) => { e.preventDefault(); e.stopPropagation(); onDelete(chat.id, chat.title); }}
              className="p-1 rounded hover:bg-red-500/25 text-on-surface/40 hover:text-red-400 transition-all duration-150 cursor-pointer"
              title="删除会话"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* Bottom row: time + 编号 */}
        <div className="flex items-center justify-between text-[10px] mt-0.5">
          <span className="text-on-surface/40 font-mono tracking-wide">{chat.time}</span>
          {typeof chat.chatNumber === 'number' && (
            <span className="text-[9px] font-mono font-bold text-on-surface/30">
              #{chat.chatNumber}
            </span>
          )}
        </div>
      </div>
    </div>
  );
});

export default HistoryItem;
export type { DraggableChatHistoryItem, HistoryItemProps };
