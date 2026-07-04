import React, { useState } from 'react';
import { Search, X, Plus, Trash2 } from 'lucide-react';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { restrictToVerticalAxis } from '@dnd-kit/modifiers';
import { MountTransition } from './MountTransition';
import HistoryItem, { type DraggableChatHistoryItem } from './HistoryItem';
import { DefaultChatIcon } from './brandIcons';
import { DEFAULT_CHATS, parseSavedChats } from '../data/defaultChats';

// 兼容性 re-export
export { AndroidIcon, WindowsIcon, HarmonyOSIcon, DefaultChatIcon } from './brandIcons';

interface HistoryAndEditorPanelProps {
  selectedFile: string;
  selectedChatId: string;
  setSelectedChatId: (id: string) => void;
  editorContent: string;
  setEditorContent: (content: string) => void;
  onClose?: () => void;
  width?: number;
  isResizing?: boolean;
  parentPermissionMode?: 'normal' | 'performance' | 'ultimate' | 'expert';
  onPermissionChange?: (mode: 'normal' | 'performance' | 'ultimate' | 'expert') => void;
  isFloatingEditorOpen?: boolean;
}

export default function HistoryAndEditorPanel({
  selectedFile,
  selectedChatId,
  setSelectedChatId,
  editorContent,
  setEditorContent,
  onClose,
  width = 245,
  isResizing = false,
  parentPermissionMode,
  onPermissionChange,
  isFloatingEditorOpen,
}: HistoryAndEditorPanelProps) {
  const [searchQuery, setSearchQuery] = useState('');

  const [chats, setChats] = useState<DraggableChatHistoryItem[]>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('soloforge_chats_list');
      if (saved) {
        try {
          return parseSavedChats(saved);
        } catch (e) {
          console.error(e);
        }
      }
    }
    return DEFAULT_CHATS;
  });

  const currentChat = chats.find(c => c.id === selectedChatId) || chats[0];
  const permissionMode = currentChat?.permission || 'normal';

  React.useEffect(() => {
    if (typeof window !== 'undefined') {
      localStorage.setItem('soloforge_chats_list', JSON.stringify(chats));
    }
    window.dispatchEvent(new CustomEvent('soloforge-chats-updated'));
  }, [chats]);

  React.useEffect(() => {
    if (onPermissionChange) {
      onPermissionChange(permissionMode);
    }
  }, [selectedChatId, permissionMode, onPermissionChange]);

  const prevSelectedChatIdRef = React.useRef(selectedChatId);
  const prevParentPermissionRef = React.useRef(parentPermissionMode);

  React.useEffect(() => {
    if (selectedChatId !== prevSelectedChatIdRef.current) {
      prevSelectedChatIdRef.current = selectedChatId;
      prevParentPermissionRef.current = parentPermissionMode;
      return;
    }
    if (parentPermissionMode && parentPermissionMode !== prevParentPermissionRef.current) {
      setChats(prevChats =>
        prevChats.map(c =>
          c.id === selectedChatId ? { ...c, permission: parentPermissionMode } : c
        )
      );
    }
    prevParentPermissionRef.current = parentPermissionMode;
  }, [parentPermissionMode, selectedChatId]);

  const handleRenameChat = (id: string, newTitle: string) => {
    setChats(prevChats =>
      prevChats.map(c =>
        c.id === id ? { ...c, title: newTitle } : c
      )
    );
  };

  const [deleteTarget, setDeleteTarget] = useState<{ id: string; title: string } | null>(null);

  // ===== 简化版 dnd-kit =====
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (over && active.id !== over.id) {
      const oldIndex = chats.findIndex((c) => c.id === active.id);
      const newIndex = chats.findIndex((c) => c.id === over.id);
      if (oldIndex !== -1 && newIndex !== -1) {
        setChats(arrayMove(chats, oldIndex, newIndex));
      }
    }
  };

  const handleDeleteChat = (id: string, title: string) => {
    setDeleteTarget({ id, title });
  };

  const executeDelete = (id: string) => {
    const updated = chats.filter(c => c.id !== id);
    if (selectedChatId === id) {
      if (updated.length > 0) {
        setSelectedChatId(updated[0].id);
      } else {
        const nextId = String(Date.now());
        const newChat: DraggableChatHistoryItem = {
          id: nextId,
          title: `新智能对话 #1`,
          time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          tag: 'NEW',
          tagBg: 'bg-amber-500/10 border-amber-500/20',
          tagText: 'text-amber-400',
          icon: DefaultChatIcon,
          permission: 'normal'
        };
        updated.push(newChat);
        setSelectedChatId(nextId);
      }
    }
    setChats(updated);
  };

  const handleCreateNewChat = () => {
    const nextId = String(Date.now());
    const newChat: DraggableChatHistoryItem = {
      id: nextId,
      title: `新对话`,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      tag: 'NEW',
      tagBg: 'bg-amber-500/10 border-amber-500/20',
      tagText: 'text-amber-400',
      icon: DefaultChatIcon,
      permission: 'normal'
    };
    setChats(prev => [newChat, ...prev]);
    setSelectedChatId(nextId);
  };

  const filteredChats = chats.filter((c) =>
    c.title.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <div className="w-full h-full bg-surface flex flex-col overflow-hidden font-sans select-none">
      <div className="p-3 flex flex-col h-full overflow-hidden">
        <div className="flex items-center justify-between text-[11px] font-bold text-on-surface/40 uppercase tracking-widest pb-2 border-b border-outline/50">
          <span className="font-mono text-[10px] text-on-surface/50 tracking-wider">对话历史 ({filteredChats.length})</span>
          <div className="flex items-center gap-1.5 shrink-0">
            <button
              onClick={handleCreateNewChat}
              className="p-1 hover:bg-surface-bright rounded text-primary hover:text-primary-bright transition-colors cursor-pointer flex items-center justify-center"
              title="新建对话"
            >
              <Plus className="w-3.5 h-3.5 text-primary" />
            </button>
            {onClose && (
              <button
                onClick={onClose}
                className="p-0.5 hover:bg-surface-bright rounded text-on-surface/40 hover:text-on-surface transition-colors cursor-pointer"
                title="关闭"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>

        <div className="flex-1 flex flex-col mt-3.5 overflow-hidden gap-2.5">
          {/* Search */}
          <div className="bg-bg border border-outline rounded px-2.5 py-1.5 flex items-center gap-1.5 shrink-0">
            <Search className="w-3.5 h-3.5 text-on-surface/40" />
            <input
              type="text"
              placeholder="搜索对话..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="bg-transparent text-[11.5px] text-on-surface outline-none w-full placeholder-on-surface/30"
            />
          </div>

          {/* Draggable list */}
          <div className="flex-1 overflow-y-auto pr-1.5 scrollbar-thin select-none">
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              modifiers={[restrictToVerticalAxis]}
              onDragEnd={handleDragEnd}
            >
              <SortableContext items={filteredChats.map((c) => c.id)} strategy={verticalListSortingStrategy}>
                <div className="flex flex-col gap-2 w-full">
                  {filteredChats.map((c) => (
                    <HistoryItem
                      key={c.id}
                      chat={c}
                      isActive={selectedChatId === c.id}
                      onSelect={setSelectedChatId}
                      onDelete={handleDeleteChat}
                      onRename={handleRenameChat}
                      onOpenSettings={(id, title) => window.dispatchEvent(new CustomEvent('soloforge-open-agent-settings', { detail: { id, title } }))}
                      isFloatingEditorOpen={isFloatingEditorOpen}
                    />
                  ))}
                </div>
              </SortableContext>
            </DndContext>
          </div>
        </div>
      </div>

      {/* Delete confirmation */}
      <MountTransition show={!!deleteTarget} variant="fade">
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 z-[9999]">
          <div className="bg-surface border border-outline/35 rounded-2xl p-5 max-w-xs w-full shadow-2xl flex flex-col gap-4 font-sans text-on-surface">
            <div className="flex flex-col gap-2">
              <h3 className="text-[13px] font-bold text-red-400 flex items-center gap-2">
                <Trash2 className="w-4 h-4" />
                确认删除对话吗？
              </h3>
              <p className="text-[11px] text-on-surface/65 leading-relaxed">
                您确定要彻底删除 <span className="font-bold text-on-surface text-primary">"{deleteTarget?.title}"</span> 会话吗？删除后此会话的数据将不可恢复。
              </p>
            </div>
            <div className="flex items-center justify-end gap-2 text-[11px]">
              <button
                onClick={() => setDeleteTarget(null)}
                className="px-3 py-1.5 rounded-lg border border-outline/20 hover:bg-surface-bright text-on-surface/75 hover:text-on-surface transition-colors cursor-pointer"
              >
                取消
              </button>
              <button
                onClick={() => {
                  if (deleteTarget) executeDelete(deleteTarget.id);
                  setDeleteTarget(null);
                }}
                className="px-3 py-1.5 rounded-lg bg-red-500/20 border border-red-500/35 text-red-400 hover:bg-red-500/40 hover:text-white transition-colors cursor-pointer font-bold"
              >
                彻底删除
              </button>
            </div>
          </div>
        </div>
      </MountTransition>
    </div>
  );
}
