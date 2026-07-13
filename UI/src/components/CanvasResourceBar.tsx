/**
 * CanvasResourceBar — 画布资源池 chip 栏
 * ---------------------------------------------------------------------------
 * P0: 显示当前 chat 可访问的所有画布 (1..10), 以 chip 形式横向排列:
 *   - 序号 (displayName, 无前导零)
 *   - owner 标识: ★ 表示当前 chat 是 owner, ○ 表示别人是
 *   - 当前选中: bg-surface-elevated + ring
 *   - 鼠标悬浮: 显示 description tooltip
 *   - 点击 chip: 切换画布
 *   - 双击 chip (仅 owner): 进入 inline 编辑 description
 *   - 满 10 时: + 按钮 disabled, 鼠标悬浮提示
 *
 * 切换通过父组件传入的 onSelect(canvasId) 实现。
 * 新建通过 + 按钮 → onCreate() 回调, 父组件调 createCanvas API。
 * 改描述 → onRename(canvasId, description) 回调, 父组件调 updateCanvasDescription API。
 */

import React, { useState, useRef, useEffect } from 'react';
import { Plus, Crown, Users, X } from '../utils/icons';
import type { CanvasResource } from '../services/canvas/sessionApi';

interface Props {
  canvases: CanvasResource[];
  activeCanvasId: string | null;
  maxCanvases: number;
  onSelect: (canvasId: string) => void;
  onCreate: () => Promise<string | null>;
  onRename: (canvasId: string, description: string) => Promise<boolean>;
  onDelete?: (canvasId: string) => Promise<boolean>;
  loading?: boolean;
}

export function CanvasResourceBar({
  canvases,
  activeCanvasId,
  maxCanvases,
  onSelect,
  onCreate,
  onRename,
  onDelete,
  loading,
}: Props) {
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState('');
  const [savingRename, setSavingRename] = useState(false);
  const editInputRef = useRef<HTMLInputElement | null>(null);

  const full = canvases.length >= maxCanvases;

  // 按 displayName 数字升序排 (1, 2, 3 ...)
  const sorted = [...canvases].sort((a, b) => {
    const an = parseInt(a.displayName, 10);
    const bn = parseInt(b.displayName, 10);
    return an - bn;
  });

  // 进入编辑态时 focus + select all
  useEffect(() => {
    if (editingId && editInputRef.current) {
      editInputRef.current.focus();
      editInputRef.current.select();
    }
  }, [editingId]);

  const beginEdit = (c: CanvasResource) => {
    if (!c.isOwner) return; // 仅 owner 可改名
    setEditingId(c.sessionId);
    setEditingText(c.description || '');
  };

  const commitEdit = async () => {
    if (!editingId || savingRename) return;
    setSavingRename(true);
    try {
      await onRename(editingId, editingText.trim());
    } finally {
      setSavingRename(false);
      setEditingId(null);
      setEditingText('');
    }
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditingText('');
  };

  return (
    <div className="flex items-center gap-1 px-3 h-14 bg-surface/60 border-b border-outline/30 select-none">
      <div className="flex items-center gap-1 overflow-x-auto scrollbar-none">
        {sorted.map((c) => {
          const active = c.sessionId === activeCanvasId;
          const isEditing = editingId === c.sessionId;

          if (isEditing) {
            return (
              <span
                key={c.sessionId}
                className="h-6 px-1 rounded-md text-[11px] font-medium shrink-0 flex items-center gap-1 border border-primary bg-primary/5"
              >
                <span className="tabular-nums text-primary">{c.displayName}</span>
                <input
                  ref={editInputRef}
                  type="text"
                  value={editingText}
                  onChange={(e) => setEditingText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      void commitEdit();
                    } else if (e.key === 'Escape') {
                      e.preventDefault();
                      cancelEdit();
                    }
                    e.stopPropagation();
                  }}
                  onBlur={() => void commitEdit()}
                  placeholder="给画布起个名字…"
                  maxLength={80}
                  className="w-32 h-5 px-1 rounded bg-surface border border-outline/40 text-[11px] outline-none focus:border-primary"
                />
                {savingRename && <span className="text-[9px] text-primary/70">…</span>}
              </span>
            );
          }

          return (
            <button
              key={c.sessionId}
              onClick={() => onSelect(c.sessionId)}
              onDoubleClick={(e) => {
                e.preventDefault();
                beginEdit(c);
              }}
              title={
                (c.description ? `备注: ${c.description}\n` : '') +
                'owner: ' + c.ownerChatSessionId +
                (c.isOwner
                  ? '\n★ 你可以编辑\n双击改名 · 点击切换'
                  : '\n○ 只读 (你非 owner)')
              }
              className={[
                'group h-6 px-2 rounded-md text-[11px] font-medium shrink-0 transition-all',
                'flex items-center gap-1 border',
                active
                  ? 'bg-primary text-on-primary border-primary shadow-sm'
                  : c.isOwner
                    ? 'bg-surface hover:bg-primary/10 border-outline/40 text-on-surface'
                    : 'bg-surface/60 hover:bg-surface border-outline/30 text-on-surface/70',
              ].join(' ')}
            >
              <span className="tabular-nums">{c.displayName}</span>
              {c.isOwner
                ? <Crown className={`w-2.5 h-2.5 ${active ? '' : 'text-amber-500'}`} />
                : <Users className="w-2.5 h-2.5 opacity-60" />}
              {c.deviceCount > 0 && (
                <span className={active ? 'opacity-80' : 'opacity-50'}>{c.deviceCount}</span>
              )}
              {c.description && (
                <span
                  className={active ? 'opacity-80 max-w-[60px] truncate' : 'opacity-60 max-w-[60px] truncate text-[10px]'}
                  title={c.description}
                >
                  · {c.description}
                </span>
              )}
              {/* 删除按钮: 只在 owner 且 canvases > 1 时显示 */}
              {c.isOwner && onDelete && canvases.length > 1 && (
                <span
                  role="button"
                  aria-label="删除画布"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (confirm(`确认删除画布 ${c.displayName}？`)) {
                      void onDelete(c.sessionId);
                    }
                  }}
                  className={`ml-0.5 w-3.5 h-3.5 flex items-center justify-center rounded transition-all ${
                    active
                      ? 'opacity-60 hover:opacity-100 hover:bg-on-primary/15'
                      : 'opacity-0 group-hover:opacity-60 hover:!opacity-100 hover:bg-on-surface/15'
                  }`}
                  title="删除画布"
                >
                  <X className="w-2.5 h-2.5" />
                </span>
              )}
            </button>
          );
        })}

        <button
          onClick={async () => {
            if (full || creating || editingId) return;
            setCreating(true);
            try {
              await onCreate();
            } finally {
              setCreating(false);
            }
          }}
          disabled={full || creating || loading}
          title={full ? `已达上限 ${maxCanvases} 个, 请先删除` : '新建画布 (占用最小可用序号)'}
          className={[
            'h-6 w-6 rounded-md text-[11px] flex items-center justify-center shrink-0 border border-dashed',
            full
              ? 'border-outline/30 text-on-surface/30 cursor-not-allowed'
              : 'border-outline/50 text-on-surface/70 hover:bg-primary/10 hover:text-primary hover:border-primary',
          ].join(' ')}
        >
          <Plus className="w-3 h-3" />
        </button>
      </div>

      <span className="ml-auto text-[10px] text-on-surface/40 tabular-nums shrink-0">
        {canvases.length} / {maxCanvases}
      </span>
    </div>
  );
}