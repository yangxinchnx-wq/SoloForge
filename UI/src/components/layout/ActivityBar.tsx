// ─────────────────────────────────────────────────────────────────
// ActivityBar (最左侧 1 列导航) - VSCode 风格
// - 文件资源 / 搜索 / Git / 调试 / 扩展 / 设置
// - 当前激活的视图高亮
// - 底部用户头像
// - 拖拽排序 (HTML5 DnD, 持久化到 localStorage)
// ──────────────────────────────────────────────═══════════════════

import { useState, useEffect, useRef } from 'react';
import { Tooltip, Badge } from '../ui/Button';
import { pushToast } from '../overlays/Notifications';

interface ActivityItem {
  id: string;
  icon: string;
  label: string;
  badge?: number | string;
}

interface Props {
  active: string;
  onChange: (id: string) => void;
  onOpenSettings?: () => void;
  onOpenHotkey?: () => void;
}

const DEFAULT_ITEMS: ActivityItem[] = [
  { id: 'explorer', icon: 'files', label: '资源管理' },
  { id: 'search',   icon: 'search', label: '搜索' },
  { id: 'git',      icon: 'account_tree', label: '源码管理', badge: 3 },
  { id: 'debug',    icon: 'bug_report', label: '调试' },
  { id: 'terminal', icon: 'terminal', label: '终端' },
  { id: 'extension',icon: 'extension', label: '扩展' },
  { id: 'court',    icon: 'gavel', label: '法庭' },
  { id: 'agents',   icon: 'memory', label: '智能体' },
];

const ORDER_KEY = 'soloforge.activity.order';

export function ActivityBar({ active, onChange, onOpenSettings, onOpenHotkey }: Props) {
  const [items, setItems] = useState<ActivityItem[]>(() => {
    try {
      const raw = localStorage.getItem(ORDER_KEY);
      if (raw) {
        const order = JSON.parse(raw) as string[];
        // 按保存的顺序重排, 未保存的追加到末尾
        const map = new Map(DEFAULT_ITEMS.map(i => [i.id, i]));
        const ordered = order.map(id => map.get(id)).filter(Boolean) as ActivityItem[];
        const knownIds = new Set(order);
        const tail = DEFAULT_ITEMS.filter(i => !knownIds.has(i.id));
        return [...ordered, ...tail];
      }
    } catch { /* ignore */ }
    return DEFAULT_ITEMS;
  });
  useEffect(() => {
    try {
      localStorage.setItem(ORDER_KEY, JSON.stringify(items.map(i => i.id)));
    } catch { /* ignore */ }
  }, [items]);

  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [dragPos, setDragPos] = useState<'above' | 'below'>('above');
  const dragRef = useRef<{ id: string; y: number } | null>(null);

  const onDragStart = (e: React.DragEvent, id: string) => {
    setDraggingId(id);
    dragRef.current = { id, y: e.clientY };
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', id);
  };
  const onDragOver = (e: React.DragEvent, id: string) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (!dragRef.current) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const mid = rect.top + rect.height / 2;
    setDragOverId(id);
    setDragPos(e.clientY < mid ? 'above' : 'below');
  };
  const onDragEnd = () => {
    setDraggingId(null);
    setDragOverId(null);
    dragRef.current = null;
  };
  const onDrop = (e: React.DragEvent, targetId: string) => {
    e.preventDefault();
    const sourceId = e.dataTransfer.getData('text/plain') || draggingId;
    if (!sourceId || sourceId === targetId) { onDragEnd(); return; }
    setItems(prev => {
      const arr = prev.slice();
      const srcIdx = arr.findIndex(i => i.id === sourceId);
      const tgtIdx = arr.findIndex(i => i.id === targetId);
      if (srcIdx < 0 || tgtIdx < 0) return prev;
      const [moved] = arr.splice(srcIdx, 1);
      // 重新计算目标索引 (移除后索引可能变化)
      const newTgtIdx = arr.findIndex(i => i.id === targetId);
      const insertAt = dragPos === 'above' ? newTgtIdx : newTgtIdx + 1;
      arr.splice(insertAt, 0, moved);
      return arr;
    });
    onDragEnd();
  };

  return (
    <nav className="w-12 flex flex-col items-center py-1.5 bg-bg-dim border-r border-border shrink-0">
      {items.map(item => {
        const isDragging = draggingId === item.id;
        const isOver = dragOverId === item.id && draggingId && draggingId !== item.id;
        return (
          <Tooltip key={item.id} content={`${item.label} (拖拽排序)`} side="right">
            <button
              draggable
              onDragStart={e => onDragStart(e, item.id)}
              onDragOver={e => onDragOver(e, item.id)}
              onDragEnd={onDragEnd}
              onDrop={e => onDrop(e, item.id)}
              onClick={() => onChange(item.id)}
              className={`group relative w-12 h-10 flex items-center justify-center transition-all cursor-grab active:cursor-grabbing ${
                active === item.id
                  ? 'text-text'
                  : 'text-text-secondary hover:text-text'
              } ${isDragging ? 'opacity-40 scale-90' : ''}`}
            >
              {/* 拖拽指示线 */}
              {isOver && dragPos === 'above' && (
                <span className="absolute -top-px left-1 right-1 h-0.5 bg-primary rounded-full" />
              )}
              {isOver && dragPos === 'below' && (
                <span className="absolute -bottom-px left-1 right-1 h-0.5 bg-primary rounded-full" />
              )}
              {/* 激活条 */}
              {active === item.id && (
                <span className="absolute left-0 top-1.5 bottom-1.5 w-0.5 bg-primary rounded-r" />
              )}
              <span className={`material-symbols-outlined text-xl ${active === item.id ? 'filled' : ''}`}>
                {item.icon}
              </span>
              {item.badge != null && (
                <span className="absolute top-1 right-1 min-w-[16px] h-4 px-1 rounded-full bg-primary text-on-primary text-[9px] font-bold flex items-center justify-center">
                  {item.badge}
                </span>
              )}
            </button>
          </Tooltip>
        );
      })}

      {/* 顺序重置按钮 (在调试时方便) */}
      {items.some((item, i) => item.id !== DEFAULT_ITEMS[i]?.id) && (
        <button
          onClick={() => {
            setItems(DEFAULT_ITEMS);
            try { localStorage.removeItem(ORDER_KEY); } catch { /* ignore */ }
            pushToast({ level: 'info', title: '已重置活动栏顺序', duration: 1500 });
          }}
          className="mt-1 material-symbols-outlined text-xs text-text-secondary/50 hover:text-primary"
          title="重置顺序"
        >restart_alt</button>
      )}

      <div className="flex-1" />

      <Tooltip content="设置" side="right">
        <button
          onClick={onOpenSettings}
          className="w-12 h-10 flex items-center justify-center text-text-secondary hover:text-text transition-colors"
        >
          <span className="material-symbols-outlined text-xl">settings</span>
        </button>
      </Tooltip>
      <Tooltip content="账号 / 快捷键" side="right">
        <button
          onClick={onOpenHotkey}
          className="w-8 h-8 rounded-full bg-gradient-to-br from-primary to-accent flex items-center justify-center text-white font-semibold text-xs mb-1 cursor-pointer hover:scale-110 transition-transform"
        >
          Y
        </button>
      </Tooltip>
    </nav>
  );
}
