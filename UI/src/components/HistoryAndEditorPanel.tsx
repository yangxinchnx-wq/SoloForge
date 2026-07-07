import React, { useState, useMemo, useCallback, useRef, useLayoutEffect } from 'react';
import { Search, X, Plus, Trash2, FolderPlus, Eraser } from '../utils/icons';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent,
  DragStartEvent,
  DragOverlay,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { restrictToVerticalAxis, restrictToFirstScrollableAncestor } from '@dnd-kit/modifiers';
import { MountTransition } from './MountTransition';
import { SortableHistoryItem, HistoryItemCard, type DraggableChatHistoryItem } from './HistoryItem';
import { DefaultChatIcon } from './brandIcons';
import { Code, Key, Brain, Database, CreditCard, HelpCircle } from '../utils/icons';
import { AndroidIcon, WindowsIcon, HarmonyOSIcon } from './brandIcons';
import { useChatsStore, type ChatItem, type ChatTag } from '../state/chatsStore';
import { useChatStore, emptyStreamState } from '../state/useChatStore';

// 兼容性 re-export
export { AndroidIcon, WindowsIcon, HarmonyOSIcon, DefaultChatIcon } from './brandIcons';

// ── ChatItem → DraggableChatHistoryItem 映射 ──────────────────
// chatsStore 的 ChatItem 不含 icon (icon 是纯前端渲染关注点),
// 这里根据 tag 映射到对应的 React 图标组件

const TAG_ICON_MAP: Record<ChatTag, any> = {
  VUE: Code,
  AUTH: Key,
  AI: Brain,
  DB: Database,
  PAY: CreditCard,
  HELP: HelpCircle,
  NEW: DefaultChatIcon,
  WINDOWS: WindowsIcon,
  HARMONY: HarmonyOSIcon,
};

function chatItemToDraggable(chat: ChatItem): DraggableChatHistoryItem {
  return {
    id: chat.id,
    title: chat.title,
    time: chat.time || new Date(chat.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    tag: chat.tag,
    tagBg: chat.tagBg,
    tagText: chat.tagText,
    icon: TAG_ICON_MAP[chat.tag] || DefaultChatIcon,
    permission: chat.permission,
    workspaceFolder: chat.workspaceFolder,
  };
}

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

  // ── 手动输入文件夹路径 (fallback) ─────────────────────────
  const [showManualFolderInput, setShowManualFolderInput] = useState(false);
  const [manualPathValue, setManualPathValue] = useState('');

  const seenChatIdsRef = useRef<Set<string> | null>(null);
  const [animatingIds, setAnimatingIds] = useState<ReadonlySet<string>>(
    () => new Set<string>()
  );
  const animatingTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // ── 从 useChatsStore 读取对话列表 ──────────────────────────
  const rawChats = useChatsStore((s) => s.chats);
  const chats: DraggableChatHistoryItem[] = useMemo(
    () => rawChats.map(chatItemToDraggable),
    [rawChats]
  );

  // ── 新建对话入场动画: useLayoutEffect 在浏览器绘制前检测新项 ──────
  // 核心原理: useLayoutEffect 在 DOM 提交后、浏览器绘制前同步执行。
  // 在此处检测新 ID 并 setState, React 会同步重渲染, 动画类在首次
  // 绘制时就存在, 不会出现全不透明→透明→不透明的闪烁。
  // 必须放在 chats 定义之后, 否则 TDZ (暂时性死区) 会报 ReferenceError。
  useLayoutEffect(() => {
    const currentIds = new Set(chats.map((c) => c.id));

    // 首次渲染: 记录所有现有 ID, 不播放动画
    if (seenChatIdsRef.current === null) {
      seenChatIdsRef.current = currentIds;
      return;
    }

    // 检测新出现的 ID
    const newOnes: string[] = [];
    for (const id of currentIds) {
      if (!seenChatIdsRef.current.has(id)) {
        newOnes.push(id);
      }
    }

    // 检测已删除的 ID (清理对应的 timer)
    for (const id of seenChatIdsRef.current) {
      if (!currentIds.has(id)) {
        const t = animatingTimersRef.current.get(id);
        if (t) {
          clearTimeout(t);
          animatingTimersRef.current.delete(id);
        }
      }
    }

    seenChatIdsRef.current = currentIds;

    if (newOnes.length === 0) return;

    // 标记新项为动画中
    setAnimatingIds((prev) => {
      const next = new Set(prev);
      newOnes.forEach((id) => next.add(id));
      return next;
    });

    // 动画完成后移除标记 (400ms 动画 + 100ms buffer)
    for (const id of newOnes) {
      const existing = animatingTimersRef.current.get(id);
      if (existing) clearTimeout(existing);
      const timer = setTimeout(() => {
        setAnimatingIds((prev) => {
          if (!prev.has(id)) return prev;
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
        animatingTimersRef.current.delete(id);
      }, 500);
      animatingTimersRef.current.set(id, timer);
    }
  }, [chats]);

  const currentChat = chats.find(c => c.id === selectedChatId) || chats[0];
  const permissionMode = currentChat?.permission || 'normal';

  // ── 权限同步 effect ────────────────────────────────────────
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
    // 父组件权限模式变化 → 同步到后端
    if (parentPermissionMode && parentPermissionMode !== prevParentPermissionRef.current) {
      useChatsStore.getState().updateChat(selectedChatId, { permission: parentPermissionMode });
    }
    prevParentPermissionRef.current = parentPermissionMode;
  }, [parentPermissionMode, selectedChatId]);

  // ── dnd-kit drag infrastructure ────────────────────────────
  const scrollContainerRef = React.useRef<HTMLDivElement>(null);
  const [activeDragId, setActiveDragId] = React.useState<string | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  // useCallback — 这些回调传给 SortableHistoryItem,如果不稳定,
  // React.memo 就失效了 (每次渲染都生成新函数引用)。
  const handleSelect = useCallback((id: string) => {
    setSelectedChatId(id);
    // 同步到后端 (非阻塞, 失败不回滚本地选中态)
    useChatsStore.getState().selectChat(id);
  }, [setSelectedChatId]);

  const [deleteTarget, setDeleteTarget] = useState<{ id: string; title: string } | null>(null);
  const handleDelete = useCallback((id: string, title: string) => setDeleteTarget({ id, title }), []);

  const handleRename = useCallback((id: string, newTitle: string) => {
    useChatsStore.getState().updateChat(id, { title: newTitle });
  }, []);

  const handleOpenSettings = useCallback((id: string, title: string) => {
    window.dispatchEvent(new CustomEvent('soloforge-open-agent-settings', { detail: { id, title } }));
  }, []);

  const handleDragStart = useCallback((event: DragStartEvent) => {
    setActiveDragId(String(event.active.id));
  }, []);

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    setActiveDragId(null);
    if (!over || active.id === over.id) return;

    const oldIndex = chats.findIndex((c) => c.id === active.id);
    const newIndex = chats.findIndex((c) => c.id === over.id);
    if (oldIndex !== -1 && newIndex !== -1) {
      // 乐观更新: 先本地 arrayMove, 再上报后端
      const reordered = arrayMove(chats, oldIndex, newIndex);
      useChatsStore.getState().reorderChats(reordered.map(c => c.id));
    }
  }, [chats]);

  const handleDragCancel = useCallback(() => {
    setActiveDragId(null);
  }, []);

  // ── 创建新对话 ─────────────────────────────────────────────
  const handleCreateNewChat = useCallback(async () => {
    const newChat = await useChatsStore.getState().createChat();
    if (newChat) {
      setSelectedChatId(newChat.id);
    }
  }, [setSelectedChatId]);

  // ── 从文件夹创建对话 ──────────────────────────────────────────
  const handleCreateFolderChat = useCallback(async () => {
    let folderPath: string | null = null;
    let folderName: string | null = null;
    let userCanceled = false;

    const sf = (window as any).soloforge;

    // 1. 尝试 Electron IPC (需要重启 Electron 生效)
    if (sf?.selectFolder) {
      try {
        const result = await sf.selectFolder();
        if (result) {
          folderPath = result.path;
          folderName = result.name;
        } else {
          userCanceled = true; // IPC 返回 null = 用户取消
        }
      } catch (e) {
        console.warn('[HistoryAndEditorPanel] Electron IPC selectFolder 失败:', e);
        // IPC 出错 — 继续尝试 fallback
      }
    }

    // 2. 如果 IPC 不可用或出错, 尝试浏览器 showDirectoryPicker
    if (!folderName && !userCanceled && typeof window !== 'undefined' && (window as any).showDirectoryPicker) {
      try {
        const handle = await (window as any).showDirectoryPicker();
        folderPath = handle.name;
        folderName = handle.name;
      } catch {
        userCanceled = true; // showDirectoryPicker 取消时会 throw
      }
    }

    // 3. 如果以上方式都不可用, 弹出手动输入对话框
    if (!folderName && !userCanceled) {
      setShowManualFolderInput(true);
      return;
    }

    if (!folderName) return; // 用户取消了选择

    const newChat = await useChatsStore.getState().createChat(folderName, 'normal', folderPath ?? undefined);
    if (newChat) {
      setSelectedChatId(newChat.id);
    }
  }, [setSelectedChatId]);

  // ── 手动输入路径确认 ───────────────────────────────────────
  const handleManualPathSubmit = useCallback(async () => {
    const trimmed = manualPathValue.trim();
    if (!trimmed) return;

    // 从路径提取文件夹名
    const parts = trimmed.replace(/\\/g, '/').split('/').filter(Boolean);
    const folderName = parts[parts.length - 1] || trimmed;

    setShowManualFolderInput(false);
    setManualPathValue('');

    const newChat = await useChatsStore.getState().createChat(folderName, 'normal', trimmed);
    if (newChat) {
      setSelectedChatId(newChat.id);
    }
  }, [manualPathValue, setSelectedChatId]);

  // ── 清除当前会话 ──────────────────────────────────────────────
  const handleClearSession = useCallback(async (id: string) => {
    // 清除对话消息
    useChatStore.setState((s) => {
      const convos = { ...s.conversations };
      convos[id] = [];
      const configs = { ...s.configs };
      // 保留 configs 中的设置, 不清除
      return { conversations: convos, configs, streamState: { ...emptyStreamState }, isGenerating: false };
    });

    // 清除终端日志
    const { useTerminalLogStore } = await import('../components/terminal/store/terminalLogStore');
    useTerminalLogStore.getState().removeChat(id);

    // 清除画布预览流
    const { usePreviewStreamStore } = await import('../state/previewStreamStore');
    usePreviewStreamStore.getState().clearEntry(id);

    // 清除 liveState
    useChatsStore.getState().clearLiveState(id);

    console.log('[HistoryAndEditorPanel] 已清除会话', id, '的上下文/流送/画布/终端');
  }, []);

  // ── 删除对话 ────────────────────────────────────────────────
  const executeDelete = useCallback(async (id: string) => {
    await useChatsStore.getState().deleteChat(id);
    // 同步选中态到 appStore
    const nextSelected = useChatsStore.getState().selectedChatId;
    if (nextSelected) {
      setSelectedChatId(nextSelected);
    }
  }, [setSelectedChatId]);

  const filteredChats = useMemo(() =>
    chats.filter((c) =>
      c.title.toLowerCase().includes(searchQuery.toLowerCase())
    ), [chats, searchQuery]);

  return (
    <div className="w-full h-full bg-surface flex flex-col overflow-hidden font-sans select-none">
      {/* History Conversations Section */}
      <div className="p-3 flex flex-col h-full overflow-hidden">
        <div className="flex items-center justify-between text-[11px] font-bold text-on-surface/40 uppercase tracking-widest pb-2 border-b border-outline/50">
          <div className="flex items-center gap-1.5" id="history-header-title">
            <span className="font-mono text-[10px] text-on-surface/50 tracking-wider">对话历史 ({filteredChats.length})</span>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
              <button
                onClick={handleCreateFolderChat}
                className="p-1 hover:bg-surface-bright rounded text-primary hover:text-primary-bright transition-colors cursor-pointer flex items-center justify-center"
                title="从文件夹创建对话"
              >
                <FolderPlus className="w-3.5 h-3.5 text-primary" />
              </button>
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
          {/* Search Input */}
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

          {/* Draggable Tiles List (dnd-kit Sortable) */}
          <div
            ref={scrollContainerRef}
            className="sf-scroll-contain flex-1 overflow-y-auto pr-1.5 scrollbar-thin scrollbar-thumb-[#2c2f33] select-none relative"
          >
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              modifiers={[restrictToVerticalAxis, restrictToFirstScrollableAncestor]}
              onDragStart={handleDragStart}
              onDragEnd={handleDragEnd}
              onDragCancel={handleDragCancel}
            >
              <SortableContext items={filteredChats.map((c) => c.id)} strategy={verticalListSortingStrategy}>
                {/*
                  is-dimming 必须放在这里(SortableContext 内部的列表容器),
                  而不是外层滚动容器上。
                  原因: .is-dimming 有 filter:blur+saturate,CSS 规范规定
                  有 filter 的元素会成为 position:fixed 后代的 containing block。
                  DragOverlay 内部用 position:fixed 跟随鼠标,如果 filter
                  在滚动容器(DragOverlay 的祖先)上,fixed 会退化成 absolute,
                  导致 overlay 不跟鼠标。
                  放在这里后,DragOverlay 是 SortableContext 的兄弟元素,
                  不是这个 div 的后代,不受 filter 影响。
                */}
                <div className={`sf-drag-context flex flex-col gap-2 w-full ${activeDragId ? 'is-dimming' : ''}`}>
                  {filteredChats.map((c) => (
                    <SortableHistoryItem
                      key={c.id}
                      chat={c}
                      isActive={selectedChatId === c.id}
                      onSelect={handleSelect}
                      onDelete={handleDelete}
                      onRename={handleRename}
                      onOpenSettings={handleOpenSettings}
                      onClearSession={handleClearSession}
                      isFloatingEditorOpen={isFloatingEditorOpen}
                      isNew={animatingIds.has(c.id)}
                    />
                  ))}
                </div>
              </SortableContext>
              {/*
                DragOverlay 内必须使用 HistoryItemCard（纯展示，无 useSortable）。
                如果在这里使用 SortableHistoryItem，useSortable 会注册第二个同 ID
                draggable，导致 dnd-kit 内部冲突，overlay 不跟鼠标。
              */}
              <DragOverlay
                dropAnimation={null}
                zIndex={9999}
              >
                {activeDragId ? (
                  (() => {
                    const active = chats.find((c) => c.id === activeDragId);
                    if (!active) return null;
                    return (
                      <HistoryItemCard
                        chat={active}
                        isActive={selectedChatId === active.id}
                        onSelect={() => {}}
                        onDelete={() => {}}
                        onRename={() => {}}
                        onOpenSettings={() => {}}
                        isFloatingEditorOpen={isFloatingEditorOpen}
                        isOverlayClone
                      />
                    );
                  })()
                ) : null}
              </DragOverlay>
            </DndContext>
          </div>
        </div>
      </div>

      {/* Delete Confirmation Dialog */}
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

      {/* 手动输入文件夹路径 (fallback) */}
      <MountTransition show={showManualFolderInput} variant="fade-scale">
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 z-[9999]">
          <div className="bg-surface border border-outline/35 rounded-2xl p-5 max-w-sm w-full shadow-2xl flex flex-col gap-4 font-sans text-on-surface">
            <div className="flex flex-col gap-2">
              <h3 className="text-[13px] font-bold text-primary flex items-center gap-2">
                <FolderPlus className="w-4 h-4" />
                输入工作区文件夹路径
              </h3>
              <p className="text-[11px] text-on-surface/65 leading-relaxed">
                系统文件夹选择器不可用，请手动输入文件夹的完整路径：
              </p>
            </div>
            <input
              type="text"
              placeholder="例如: C:\Users\...\my-project"
              value={manualPathValue}
              onChange={(e) => setManualPathValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleManualPathSubmit();
                if (e.key === 'Escape') {
                  setShowManualFolderInput(false);
                  setManualPathValue('');
                }
              }}
              autoFocus
              className="bg-bg border border-outline rounded-lg px-3 py-2 text-[12px] text-on-surface outline-none focus:border-primary/50 w-full font-mono"
            />
            <div className="flex items-center justify-end gap-2 text-[11px]">
              <button
                onClick={() => {
                  setShowManualFolderInput(false);
                  setManualPathValue('');
                }}
                className="px-3 py-1.5 rounded-lg border border-outline/20 hover:bg-surface-bright text-on-surface/75 hover:text-on-surface transition-colors cursor-pointer"
              >
                取消
              </button>
              <button
                onClick={handleManualPathSubmit}
                className="px-3 py-1.5 rounded-lg bg-primary/20 border border-primary/35 text-primary hover:bg-primary/40 hover:text-white transition-colors cursor-pointer font-bold"
              >
                确认
              </button>
            </div>
          </div>
        </div>
      </MountTransition>
    </div>
  );
}
