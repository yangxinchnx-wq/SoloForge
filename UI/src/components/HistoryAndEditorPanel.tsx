import React, { useState, useMemo, useCallback, useRef, useLayoutEffect } from 'react';
import { Search, X, Plus, FolderPlus, Eraser } from '../utils/icons';
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
import { useWorkspaceStore } from '../state/useWorkspaceStore';
import { useAppStore } from '../state/appStore';
import type { FileNode } from '../shared/types/file';

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
  setEditorContent: (content: string) => void;
  onClose?: () => void;
  width?: number;
  isResizing?: boolean;
}

export default function HistoryAndEditorPanel({
  setEditorContent,
  onClose,
  width = 245,
  isResizing = false,
}: HistoryAndEditorPanelProps) {
  // ★ 从 appStore 直接订阅, 切断 App→MainLayout props 透传链, 避免打字/切文件/切对话全局刷新
  const selectedFile = useAppStore(s => s.selectedFile);
  const selectedChatId = useAppStore(s => s.selectedChatId);
  const setSelectedChatId = useAppStore(s => s.setSelectedChatId);
  const editorContent = useAppStore(s => s.editorContent);
  const parentPermissionMode = useAppStore(s => s.currentPermissionMode);
  const onPermissionChange = useAppStore(s => s.setCurrentPermissionMode);
  const isFloatingEditorOpen = useAppStore(s => s.showFloatingEditor);
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
  // ★ 性能优化: 基于 id 缓存映射结果, 只对新增/修改的对话创建新对象
  //   原实现 rawChats.map(chatItemToDraggable) 每次都为所有对话创建全新对象,
  //   导致 SortableHistoryItem 的 React.memo 因 chat prop 引用变化而全部失效。
  //   新建对话时 temp 插入 + real 替换触发 2 轮全量 re-render, 对话越多越卡。
  //   修复: 浅比较关键字段, 未变的对话复用缓存的映射对象, 保持引用稳定。
  const chatMapCacheRef = useRef<Map<string, { raw: ChatItem; mapped: DraggableChatHistoryItem }>>(new Map());
  const chats: DraggableChatHistoryItem[] = useMemo(
    () => {
      const cache = chatMapCacheRef.current;
      const nextCache = new Map<string, { raw: ChatItem; mapped: DraggableChatHistoryItem }>();
      const result: DraggableChatHistoryItem[] = [];
      for (const raw of rawChats) {
        const cached = cache.get(raw.id);
        // 浅比较关键字段: 如果原始对话没变, 复用缓存的映射对象 (保持引用稳定)
        if (cached &&
            cached.raw.title === raw.title &&
            cached.raw.tag === raw.tag &&
            cached.raw.tagBg === raw.tagBg &&
            cached.raw.tagText === raw.tagText &&
            cached.raw.permission === raw.permission &&
            cached.raw.workspaceFolder === raw.workspaceFolder &&
            cached.raw.time === raw.time &&
            cached.raw.updatedAt === raw.updatedAt) {
          nextCache.set(raw.id, cached);
          result.push(cached.mapped);
        } else {
          const mapped = chatItemToDraggable(raw);
          nextCache.set(raw.id, { raw, mapped });
          result.push(mapped);
        }
      }
      chatMapCacheRef.current = nextCache;
      return result;
    },
    [rawChats]
  );

  // ── 新建对话入场动画: useLayoutEffect 在浏览器绘制前检测新项 ──────
  // 核心原理: useLayoutEffect 在 DOM 提交后、浏览器绘制前同步执行。
  // 在此处检测新 ID 并 setState, React 会同步重渲染, 动画类在首次
  // 绘制时就存在, 不会出现全不透明→透明→不透明的闪烁。
  // 必须放在 chats 定义之后, 否则 TDZ (暂时性死区) 会报 ReferenceError。
  //
  // ★ 性能优化: 跳过 temp-Id 的动画
  //   chatsStore.createChat 先用 temp-xxx 乐观更新, 后端返回 real-Id 后替换。
  //   temp-Id 存在时间很短 (一个网络往返), 给它播放动画是浪费 —
  //   会触发一次额外的 setAnimatingIds 同步 re-render, 然后马上被 real-Id 替换。
  //   修复: temp-Id 不加入 seenChatIdsRef, 不播放动画;
  //   real-Id 到来时会被检测为"新项"并正常播放动画。
  useLayoutEffect(() => {
    const currentIds = new Set(chats.map((c) => c.id));

    // 首次渲染: 记录所有非 temp ID, 不播放动画
    if (seenChatIdsRef.current === null) {
      const initial = new Set<string>();
      for (const id of currentIds) {
        if (!id.startsWith('temp-')) initial.add(id);
      }
      seenChatIdsRef.current = initial;
      return;
    }

    // 检测新出现的 ID (排除 temp-Id — 它很快会被 real-Id 替换, 播动画是浪费)
    const newOnes: string[] = [];
    for (const id of currentIds) {
      if (id.startsWith('temp-')) continue;
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

    // 更新 seenChatIdsRef: 只保留非 temp ID
    // (temp-Id 不记录, 这样 real-Id 到来时会被检测为"新项")
    const nextSeen = new Set<string>();
    for (const id of currentIds) {
      if (!id.startsWith('temp-')) nextSeen.add(id);
    }
    seenChatIdsRef.current = nextSeen;

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

  // ★ inline 确认: HistoryItemCard 内部确认后直接调 handleDelete 执行删除, 不再弹全屏 Modal
  const handleDelete = useCallback(async (id: string, _title: string) => {
    await useChatsStore.getState().deleteChat(id);
    // 同步选中态到 appStore (修复: 原来只在 nextSelected 非空时同步,
    //   删除最后一个对话后 appStore.selectedChatId 仍指向已删除的对话)
    const nextSelected = useChatsStore.getState().selectedChatId;
    setSelectedChatId(nextSelected || '');
  }, [setSelectedChatId]);

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
    console.log('[handleCreateFolderChat] sf keys:', sf ? Object.keys(sf) : 'undefined');

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
    let browserDirHandle: any = null;
    if (!folderName && !userCanceled && typeof window !== 'undefined' && (window as any).showDirectoryPicker) {
      try {
        browserDirHandle = await (window as any).showDirectoryPicker();
        folderPath = browserDirHandle.name;
        folderName = browserDirHandle.name;
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

    // ── 读取目录树并存入 workspace store ──
    // 问题根因: createChat 只保存了 workspaceFolder 元数据,
    // 但文件树数据从未加载, 导致 FileExplorer 显示 "未绑定工作区"。
    // 修复: 在创建对话前先读取目录树, 创建后立即存入 workspaces[chatId]。
    let treeData: FileNode | null = null;

    if (sf?.readDirTree && folderPath) {
      // Electron: 通过 IPC 读取任意路径
      try {
        const result = await sf.readDirTree(folderPath);
        if (result?.success && result.tree) {
          treeData = result.tree as FileNode;
        }
      } catch (e) {
        console.warn('[HistoryAndEditorPanel] readDirTree IPC 失败:', e);
      }
    } else if (browserDirHandle) {
      // Browser: 用 FileSystemDirectoryHandle 递归读取
      try {
        const readDirRecursive = async (
          dirHandle: any,
          dirName: string,
          parentPath: string,
          depth: number = 0,
        ): Promise<FileNode> => {
          const children: FileNode[] = [];
          if (depth < 12) {
            try {
              for await (const entry of dirHandle.values()) {
                if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === '__pycache__') continue;
                const entryPath = `${parentPath}/${entry.name}`;
                if (entry.kind === 'file') {
                  children.push({ name: entry.name, type: 'file', path: entryPath });
                } else if (entry.kind === 'directory') {
                  children.push(await readDirRecursive(entry, entry.name, entryPath, depth + 1));
                }
              }
            } catch {}
          }
          children.sort((a, b) => {
            if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
            return a.name.localeCompare(b.name);
          });
          return { name: dirName, type: 'folder', path: parentPath, children };
        };
        treeData = await readDirRecursive(browserDirHandle, folderName, folderName);
      } catch (e) {
        console.warn('[HistoryAndEditorPanel] browser dir read failed:', e);
      }
    }

    const newChat = await useChatsStore.getState().createChat(folderName, 'normal', folderPath ?? undefined);
    if (newChat) {
      // 将文件树存入 workspace store (用 realId, createChat 返回后 ID 已确定)
      if (treeData) {
        useWorkspaceStore.getState().setWorkspaces((prev) => ({
          ...prev,
          [newChat.id]: {
            name: folderName,
            tree: treeData,
            openFolders: { [folderName]: true },
          },
        }));
      }
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

    // 尝试通过 Electron IPC 读取目录树
    let treeData: FileNode | null = null;
    const sf = (window as any).soloforge;
    if (sf?.readDirTree) {
      try {
        const result = await sf.readDirTree(trimmed);
        if (result?.success && result.tree) {
          treeData = result.tree as FileNode;
        }
      } catch (e) {
        console.warn('[HistoryAndEditorPanel] manual path readDirTree failed:', e);
      }
    }

    const newChat = await useChatsStore.getState().createChat(folderName, 'normal', trimmed);
    if (newChat) {
      if (treeData) {
        useWorkspaceStore.getState().setWorkspaces((prev) => ({
          ...prev,
          [newChat.id]: {
            name: folderName,
            tree: treeData,
            openFolders: { [folderName]: true },
          },
        }));
      }
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

    // P3 集成: 清除流送区 + Actor + uiMessageStore + 持久化 (统一清理)
    const { clearChatAll } = await import('../services/actorIntegration');
    clearChatAll(id);

    // 清除终端日志
    const { useTerminalLogStore } = await import('../components/terminal/store/terminalLogStore');
    useTerminalLogStore.getState().removeChat(id);

    // 清除画布预览流
    const { usePreviewStreamStore } = await import('../state/previewStreamStore');
    usePreviewStreamStore.getState().clearEntry(id);

    // 清除 liveState
    useChatsStore.getState().clearLiveState(id);

    // ★ FIX v2: 彻底清除画布数据 — 从后端查全部画布再逐个删
    //   之前只依赖 peekCanvasSessionId, 但该映射可能在清除时尚未建立
    //   (PreviewPanel useEffect 还没跑), 导致画布没被删, 刷新后又冒出来。
    //   现在直接查后端 GET /api/canvas/resources 拿到该 chat 拥有的所有画布,
    //   逐个 DELETE (后端会同时删 Garnet state + DSL + SurrealDB),
    //   并停 Electron 子进程 + 清前端缓存。
    //   同时删后端对话消息 (DELETE /api/conversations/:chatId), 刷新后不再恢复。
    try {
      const { clearCanvasSessionId, clearByCanvasSessionId } =
        await import('../services/incrementalCanvasPusher');
      const { useCanvasDeviceStore } = await import('../state/canvasDeviceStore');

      // 1. 查后端拿该 chat 拥有的所有画布
      let ownedCanvasIds: string[] = [];
      try {
        const resp = await fetch(
          `/api/canvas/resources?requesterChatSessionId=${encodeURIComponent(id)}`,
        );
        const data = await resp.json();
        if (data.success && data.payload?.canvases) {
          ownedCanvasIds = data.payload.canvases
            .filter((c: { isOwner: boolean; sessionId: string }) => c.isOwner)
            .map((c: { sessionId: string }) => c.sessionId);
        }
      } catch (e) {
        console.warn('[handleClearSession] list canvases failed:', (e as Error).message);
      }

      // 2. 逐个删除画布 — 停子进程 + DELETE 后端(含 Garnet state+DSL + SurrealDB) + 清前端缓存
      for (const canvasId of ownedCanvasIds) {
        // DELETE 后端 — 清内存 + Garnet(state+dsl) + SurrealDB
        try {
          await fetch(`/api/canvas/sessions/${encodeURIComponent(canvasId)}`, {
            method: 'DELETE',
            headers: { 'X-Requester-Chat-Session-Id': id },
          });
        } catch (e) {
          console.warn('[handleClearSession] canvas delete failed:', (e as Error).message);
        }
        // 清前端缓存
        clearByCanvasSessionId(canvasId);
        useCanvasDeviceStore.getState().removeDevice(canvasId);
      }

      // 3. 清 chatId→canvasId 映射 (即使上面没查到画布也要清, 防止残留 fallback 映射)
      clearCanvasSessionId(id);

      // 4. 删后端对话消息 — 防止刷新后聊天历史降级恢复画布内容
      try {
        await fetch(`/api/conversations/${encodeURIComponent(id)}`, { method: 'DELETE' });
      } catch (e) {
        console.warn('[handleClearSession] delete conversations failed:', (e as Error).message);
      }

      // 5. 刷新画布列表 — 通知 bridge 重新 resolve (会创建新画布)
      window.dispatchEvent(new CustomEvent('soloforge-canvas-deleted'));
    } catch (e) {
      console.warn('[handleClearSession] canvas cleanup failed:', (e as Error).message);
    }

    console.log('[HistoryAndEditorPanel] 已清除会话', id, '的上下文/流送/画布/终端/对话消息');
  }, []);

  // ── 删除对话的逻辑已合并到 handleDelete (inline 确认模式) ───

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
