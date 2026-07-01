import React, { useState } from 'react';
import { Search, ChevronDown, Check, GripVertical, Code, Database, Key, CreditCard, HelpCircle, X, Shield, Cpu, Zap, ShieldCheck, Flame, Brain, BadgeCheck, Gauge, Workflow, Rocket, Plus, MessageSquarePlus, SlidersHorizontal, Trash2, Smartphone, Monitor, Layers } from 'lucide-react';
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
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { restrictToVerticalAxis, restrictToParentElement } from '@dnd-kit/modifiers';
import { MountTransition } from './MountTransition';
import { ChatHistoryItem } from '../types';

// Custom dynamic SVG icon components for high-fidelity branding
export const AndroidIcon = (props: React.SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" fill="currentColor" {...props}>
    <path d="M17.523 14.625c-.621 0-1.125-.504-1.125-1.125s.504-1.125 1.125-1.125 1.125.504 1.125 1.125-.504 1.125-1.125 1.125zm-11.046 0c-.621 0-1.125-.504-1.125-1.125s.504-1.125 1.125-1.125 1.125.504 1.125 1.125-.504 1.125-1.125 1.125zM6.573 9.818l1.984-3.438.003-.005.748-1.295a.47.47 0 0 0-.172-.642.47.47 0 0 0-.642.172L6.519 6.046a.21.21 0 0 1-.314.074.21.21 0 0 1-.036-.294l2.19-3.168a.47.47 0 0 0-.133-.654.47.47 0 0 0-.654.133L5.023 6.066c-.007.013-.012.027-.02.04L1.665 12.25v7.965h20.67v-7.965l-3.584-6.211zm0 0"/>
  </svg>
);

export const WindowsIcon = (props: React.SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" fill="currentColor" {...props}>
    <path d="M0 3.449L9.75 2.1v9.45H0V3.449zM0 12.45h9.75v9.45L0 20.551v-8.1zM11.25 1.884L24 0v11.55H11.25V1.884zM11.25 12.45H24v11.55l-12.75-1.884V12.45z"/>
  </svg>
);

export const HarmonyOSIcon = (props: React.SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" {...props}>
    {/* Beautifully balanced 8-petal blooming flower style, scaled larger and distinct from a lotus */}
    {/* Petal 1: Leftmost horizontal-ish */}
    <path 
      d="M12 20C9.5 18.0 2.2 16.5 2.2 13.0C2.2 11.5 9.5 14.0 12 20Z" 
      fill="#ef4444" 
    />
    {/* Petal 2: Left outer */}
    <path 
      d="M12 20C10.5 16.0 4.5 11.5 4.5 7.5C5.2 6.5 10.5 12.0 12 20Z" 
      fill="#ef4444" 
    />
    {/* Petal 3: Left middle */}
    <path 
      d="M12 20C11.2 16.0 7.8 8.5 7.8 4.2C8.8 3.5 11.2 11.0 12 20Z" 
      fill="#ef4444" 
    />
    {/* Petal 4: Left inner */}
    <path 
      d="M12 20C11.5 15.5 10.2 8.5 10.5 2.5C11.3 2.5 11.8 12.5 12 20Z" 
      fill="#ef4444" 
    />
    {/* Petal 5: Right inner */}
    <path 
      d="M12 20C12.5 15.5 13.8 8.5 13.5 2.5C12.7 2.5 12.2 12.5 12 20Z" 
      fill="#ef4444" 
    />
    {/* Petal 6: Right middle */}
    <path 
      d="M12 20C12.8 16.0 16.2 8.5 16.2 4.2C15.2 3.5 12.8 11.0 12 20Z" 
      fill="#ef4444" 
    />
    {/* Petal 7: Right outer */}
    <path 
      d="M12 20C13.5 16.0 19.5 11.5 19.5 7.5C18.8 6.5 13.5 12.0 12 20Z" 
      fill="#ef4444" 
    />
    {/* Petal 8: Rightmost horizontal-ish */}
    <path 
      d="M12 20C14.5 18.0 21.8 16.5 21.8 13.0C21.8 11.5 14.5 14.0 12 20Z" 
      fill="#ef4444" 
    />
  </svg>
);

export const DefaultChatIcon = (props: React.SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    <line x1="12" y1="7" x2="12" y2="13" />
    <line x1="9" y1="10" x2="15" y2="10" />
  </svg>
);

interface DraggableChatHistoryItem extends ChatHistoryItem {
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
  containerRef?: React.RefObject<any>;
  key?: React.Key;
  isFloatingEditorOpen?: boolean;
}

const HistoryItem = React.forwardRef<any, HistoryItemProps>(({ chat, isActive, onSelect, onOpenSettings, onDelete, onRename, containerRef, isFloatingEditorOpen }, ref) => {
  const [isDragging, setIsDragging] = React.useState(false);
  const isDraggingRef = React.useRef(false);

  const [isEditingTitle, setIsEditingTitle] = React.useState(false);
  const [editTitle, setEditTitle] = React.useState(chat.title);
  const inputRef = React.useRef<HTMLInputElement | null>(null);

  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging: isSortableDragging,
  } = useSortable({ id: chat.id });

  // Sync dnd-kit dragging state into local ref/state so click can skip work
  React.useEffect(() => {
    if (isSortableDragging) {
      isDraggingRef.current = true;
      setIsDragging(true);
    } else {
      setIsDragging(false);
      setTimeout(() => {
        isDraggingRef.current = false;
      }, 100);
    }
  }, [isSortableDragging]);

  // Sync title prop changes to local state
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

  // GPU-accelerated style: transform only, no opacity (spec: visibility hidden)
  const dndStyle: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition: transition || 'transform 180ms cubic-bezier(0.22, 1, 0.36, 1)',
    visibility: isSortableDragging ? 'hidden' : 'visible',
    willChange: isSortableDragging ? 'transform' : 'auto',
    backfaceVisibility: 'hidden',
    WebkitBackfaceVisibility: 'hidden',
  };

  return (
    <div
      ref={setNodeRef}
      style={dndStyle}
      {...attributes}
      {...listeners}
      onClick={(e) => {
        if (isDraggingRef.current) {
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        if (isEditingTitle) return;
        onSelect(chat.id);
      }}
      className="w-full relative select-none cursor-default touch-none box-border block focus:outline-none outline-none rounded-xl"
    >
      {/* 
        This nested wrapper isolates Tailwind background colors, border styles and 
          transitions from Framer Motion's absolute inline translate positioning tags.
      */}
      <div
        className={`group relative p-3 rounded-xl border flex flex-col gap-1.5 w-full max-w-full box-border overflow-hidden select-none outline-none focus:outline-none cursor-default transition-all duration-150 ${
          isDragging
            ? 'bg-surface border-primary text-primary shadow-2xl shadow-black/25 ring-2 ring-primary/40 opacity-100'
            : isActive
            ? 'bg-primary/10 border-primary text-primary shadow-[inset_0_1px_3px_rgba(0,0,0,0.12)] font-bold'
            : 'bg-bg/40 border-outline hover:border-primary/40 hover:bg-surface-bright text-on-surface/85 hover:text-on-surface'
        }`}
      >
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
          <div className="flex items-center gap-1 shrink-0">
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
        </div>

        {/* Tile Bottom details / Meta indicators */}
        <div className="flex items-center justify-between text-[10px] mt-0.5">
          <span className="text-on-surface/40 font-mono tracking-wide">{chat.time}</span>
          {isFloatingEditorOpen && (
            <div className="flex items-center gap-1.5">
              {/* Permission mode indicator badge */}
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

  // ==========================================
  // 【后端对接提示 - 历史会话列表加载与持久化】
  // 此处原通过 localStorage 读取历史会话。后期若支持云端数据库同步：
  // 1. 发起 API 请求 (例如 GET /api/chats) 获取当前用户所有的对话历史
  // 2. 将数据存入对应数据库表 (比如 chats: id, user_id, title, tag, permission, created_at)
  // 3. 在此处 useEffect 内调用 fetchChats 填充数据，若无数据则初始化默认对话数据
  // ==========================================
  // Manage history chats state so user can reorder them via drag-and-drop
  const [chats, setChats] = useState<DraggableChatHistoryItem[]>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('soloforge_chats_list');
      if (saved) {
        try {
          const parsed = JSON.parse(saved);
          return parsed.map((c: any) => {
            let iconComponent: any = DefaultChatIcon;
            if (c.tag === 'VUE') iconComponent = Code;
            else if (c.tag === 'AUTH') iconComponent = Key;
            else if (c.tag === 'AI') iconComponent = Brain;
            else if (c.tag === 'DB') iconComponent = Database;
            else if (c.tag === 'PAY') iconComponent = CreditCard;
            else if (c.tag === 'HELP') iconComponent = HelpCircle;
            else if (c.tag === 'WINDOWS') iconComponent = WindowsIcon;
            else if (c.tag === 'HARMONY') iconComponent = HarmonyOSIcon;
            else if (c.tag === 'NEW') iconComponent = DefaultChatIcon;
            return { ...c, icon: iconComponent };
          });
        } catch (e) {
          console.error(e);
        }
      }
    }
    return [
      { id: '1', title: '电商平台原型开发', time: '14:30', tag: 'VUE', tagBg: 'bg-blue-500/10 border-blue-500/20', tagText: 'text-blue-400', icon: Code, permission: 'normal' },
      { id: '2', title: '用户认证 system 设计', time: '昨天', tag: 'AUTH', tagBg: 'bg-emerald-500/10 border-emerald-500/20', tagText: 'text-emerald-400', icon: Key, permission: 'performance' },
      { id: '3', title: 'API 接口文档生成', time: '昨天', tag: 'AI', tagBg: 'bg-purple-500/10 border-purple-500/20', tagText: 'text-purple-400', icon: Brain, permission: 'ultimate' },
      { id: '4', title: '数据库表结构设计', time: '05-18', tag: 'DB', tagBg: 'bg-yellow-500/10 border-yellow-500/20', tagText: 'text-yellow-400', icon: Database, permission: 'normal' },
      { id: '5', title: '支付模块集成方案', time: '05-17', tag: 'PAY', tagBg: 'bg-indigo-500/10 border-indigo-500/20', tagText: 'text-indigo-400', icon: CreditCard, permission: 'performance' },
      { id: '6', title: '优化建议', time: '05-16', tag: 'HELP', tagBg: 'bg-pink-500/10 border-pink-500/20', tagText: 'text-pink-400', icon: HelpCircle, permission: 'expert' },
    ] as any;
  });

  const currentChat = chats.find(c => c.id === selectedChatId) || chats[0];
  const permissionMode = currentChat?.permission || 'normal';

  // Synchronize state back to parent container & localStorage
  // ==========================================
  // 【后端对接提示 - 会话自定义顺序 Reorder 调整驱动】
  // 服务端对应的保存接口可以是 (PUT /api/chats/reorder)，用以持久化拖拽后的排序位置：
  // chats.map((c, index) => ({ id: c.id, order_index: index }))
  // ==========================================
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

  // Synchronize parent state changes down into current chat permission
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

  // ==========================================
  // 【后端对接提示 - 修改会话许可权限等级】
  // 后期接入真实后端时，将修改操作通过 HTTP PUT 请求同步至后端数据库：
  // 接口设计: PUT /api/chats/:id/permission, 载荷: { permission: mode }
  // ==========================================
  const handleSetPermission = (id: string, mode: 'normal' | 'performance' | 'ultimate' | 'expert') => {
    setChats(prevChats => 
      prevChats.map(c => 
        c.id === id ? { ...c, permission: mode } : c
      )
    );
  };

  const handleRenameChat = (id: string, newTitle: string) => {
    setChats(prevChats =>
      prevChats.map(c =>
        c.id === id ? { ...c, title: newTitle } : c
      )
    );
  };

  const [deleteTarget, setDeleteTarget] = useState<{ id: string; title: string } | null>(null);

  // ===== dnd-kit drag infra (replaces Reorder.Group) =====
  const scrollContainerRef = React.useRef<HTMLDivElement>(null);
  const dragMoveHandlerRef = React.useRef<((ev: MouseEvent) => void) | null>(null);
  const [activeDragId, setActiveDragId] = React.useState<string | null>(null);

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
    setActiveDragId(null);
    if (dragMoveHandlerRef.current) {
      window.removeEventListener('mousemove', dragMoveHandlerRef.current);
      dragMoveHandlerRef.current = null;
    }
  };

  const handleDragStart = (event: { active: { id: string | number } }) => {
    setActiveDragId(String(event.active.id));
    // Per spec: synchronous addEventListener in handleDragStart (no React effect delay)
    const onMove = (ev: MouseEvent) => {
      const sc = scrollContainerRef.current;
      if (!sc) return;
      const r = sc.getBoundingClientRect();
      const EDGE = 48;
      const MAX_SPEED = 12;
      const py = ev.clientY;
      if (py < r.top + EDGE) {
        const k = 1 - Math.min(1, Math.max(0, (r.top + EDGE - py) / EDGE));
        sc.scrollTop -= Math.max(1, Math.round(MAX_SPEED * k));
      } else if (py > r.bottom - EDGE) {
        const k = 1 - Math.min(1, Math.max(0, (py - (r.bottom - EDGE)) / EDGE));
        sc.scrollTop += Math.max(1, Math.round(MAX_SPEED * k));
      }
    };
    dragMoveHandlerRef.current = onMove;
    window.addEventListener('mousemove', onMove);
  };

  const handleDragCancel = () => {
    setActiveDragId(null);
    if (dragMoveHandlerRef.current) {
      window.removeEventListener('mousemove', dragMoveHandlerRef.current);
      dragMoveHandlerRef.current = null;
    }
  };

  React.useEffect(() => {
    return () => {
      if (dragMoveHandlerRef.current) {
        window.removeEventListener('mousemove', dragMoveHandlerRef.current);
        dragMoveHandlerRef.current = null;
      }
    };
  }, []);

  const handleDeleteChat = (id: string, title: string) => {
    setDeleteTarget({ id, title });
  };

  // ==========================================
  // 【后端对接提示 - 删除会话历史】
  // 后期接入真实后端时，在确认删除后，应向后端发送 HTTP DELETE 请求：
  // 接口设计: DELETE /api/chats/:id
  // 数据库对应操作: DELETE FROM chats WHERE id = :id (同时级联删除对应的消息/文件等关联表数据)
  // ==========================================
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

  // ==========================================
  // 【后端对接提示 - 创建新会话对话】
  // 后期接入真实后端时，创建会话点击将触发一次 POST 请求：
  // 接口设计: POST /api/chats, 载荷: { title: "新智能对话", tag: "NEW", permission: "normal" }
  // 后端数据库创建成功后返回带有自增 ID 或 UUID 的会话记录，再将返回的数据 set 到 chats 状态中
  // ==========================================
  const getNextChatNumber = (): number => {
    const key = 'soloforge_chat_counter';
    const saved = typeof window !== 'undefined' ? localStorage.getItem(key) : null;
    const next = saved ? parseInt(saved, 10) + 1 : 1;
    if (typeof window !== 'undefined') {
      localStorage.setItem(key, String(next));
    }
    return next;
  };

  const handleCreateNewChat = () => {
    const nextId = String(Date.now());
    const nextNum = getNextChatNumber();
    const newChat: DraggableChatHistoryItem = {
      id: nextId,
      title: `新对话${nextNum}`,
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
    <div 
      className="w-full h-full bg-surface flex flex-col overflow-hidden font-sans select-none"
    >
      {/* History Conversations Section */}
      <div className="p-3 flex flex-col h-full overflow-hidden">
        <div className="flex items-center justify-between text-[11px] font-bold text-on-surface/40 uppercase tracking-widest pb-2 border-b border-outline/50">
          <div className="flex items-center gap-1.5" id="history-header-title">
            <span className="font-mono text-[10px] text-on-surface/50 tracking-wider">对话历史 ({filteredChats.length})</span>
          </div>
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

        <div ref={listContainerRef} className="flex-1 flex flex-col mt-3.5 overflow-hidden gap-2.5">
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
            className="flex-1 overflow-y-auto space-y-2 pr-1.5 scrollbar-thin scrollbar-thumb-[#2c2f33] select-none relative"
            style={{ contain: 'layout paint', willChange: activeDragId ? 'scroll-position' : 'auto' }}
          >
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              modifiers={[restrictToVerticalAxis, restrictToParentElement]}
              onDragStart={handleDragStart}
              onDragEnd={handleDragEnd}
              onDragCancel={handleDragCancel}
            >
              <SortableContext items={chats.map((c) => c.id)} strategy={verticalListSortingStrategy}>
                {filteredChats.map((c) => (
                  <HistoryItem
                    key={c.id}
                    chat={c}
                    isActive={selectedChatId === c.id}
                    onSelect={setSelectedChatId}
                    onDelete={handleDeleteChat}
                    onRename={handleRenameChat}
                    containerRef={scrollContainerRef}
                    onOpenSettings={(id, title) => window.dispatchEvent(new CustomEvent('soloforge-open-agent-settings', { detail: { id, title } }))}
                    isFloatingEditorOpen={isFloatingEditorOpen}
                  />
                ))}
              </SortableContext>
            </DndContext>
          </div>
        </div>
      </div>

      {/* Elegant Second Confirmation Delete Dialog */}
      <MountTransition show={!!deleteTarget} variant="fade">
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 z-[9999]">
          <div className="bg-surface border border-outline/35 rounded-2xl p-5 max-w-xs w-full shadow-2xl flex flex-col gap-4 font-sans text-on-surface">
            <div className="flex flex-col gap-2">
              <h3 className="text-[13px] font-bold text-red-400 flex items-center gap-2">
                <Trash2 className="w-4 h-4" />
                确认删除对话吗？
              </h3>
              <p className="text-[11px] text-on-surface/65 leading-relaxed">
                您确定要彻底删除 <span className="font-bold text-on-surface text-primary">“{deleteTarget?.title}”</span> 会话吗？删除后此会话的数据将不可恢复。
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
