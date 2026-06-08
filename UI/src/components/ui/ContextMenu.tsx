// ─────────────────────────────────────────────────────────────────
// 全局右键菜单组件
// 用法:
//   <ContextMenu items={[{label, icon, onClick, danger?, divider?}, ...]} />
//  - 通过 children 包裹触发区域
//  - 菜单位置自适应视口边缘
// ─────────────────────────────────────────────────────────────────

import { useState, useRef, useEffect, ReactNode } from 'react';

export interface ContextMenuItem {
  id?: string;
  label: string;
  icon?: string;
  shortcut?: string;
  danger?: boolean;
  disabled?: boolean;
  divider?: boolean;
  onClick?: () => void;
  // 子菜单: items 数组合并为一个 submenu
  submenu?: ContextMenuItem[];
  // 颜色 (默认 text-text)
  color?: string;
  // 选中态 (e.g. 收藏项目显示 ★)
  checked?: boolean;
}

interface Props {
  items: ContextMenuItem[];
  children: ReactNode;
  // 触发方式: 默认 right-click
  trigger?: 'contextmenu' | 'click';
}

export function ContextMenu({ items, children, trigger = 'contextmenu' }: Props) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  const show = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setOpen(true);
    setPos({ x: e.clientX, y: e.clientY });
  };
  const hide = () => {
    setOpen(false);
    setPos(null);
  };

  // 点击外部关闭
  useEffect(() => {
    if (!open) return;
    const onClick = () => hide();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') hide();
    };
    setTimeout(() => {
      window.addEventListener('click', onClick);
      window.addEventListener('contextmenu', onClick);
      window.addEventListener('keydown', onKey);
    }, 0);
    return () => {
      window.removeEventListener('click', onClick);
      window.removeEventListener('contextmenu', onClick);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // 视口边缘调整
  const adjustedPos = pos ? adjustToViewport(pos, 220, items.length * 28 + 8) : null;

  return (
    <div
      ref={ref}
      onContextMenu={trigger === 'contextmenu' ? show : undefined}
      onClick={trigger === 'click' ? show : undefined}
      className="contents"
    >
      {children}
      {open && adjustedPos && (
        <div
          className="fixed z-[300] min-w-[180px] max-w-[280px] bg-surface border border-border rounded-lg shadow-2xl py-1 animate-fade-in"
          style={{ left: adjustedPos.x, top: adjustedPos.y }}
          onClick={e => e.stopPropagation()}
        >
          {items.map((it, i) => {
            if (it.divider) {
              return <div key={i} className="my-1 h-px bg-border-light" />;
            }
            return (
              <button
                key={i}
                disabled={it.disabled}
                onClick={() => {
                  if (it.disabled) return;
                  it.onClick?.();
                  hide();
                }}
                className={`w-full flex items-center gap-2 px-2.5 h-7 text-[11px] text-left transition-colors ${
                  it.disabled
                    ? 'text-text-secondary/40 cursor-not-allowed'
                    : it.danger
                      ? 'text-danger hover:bg-danger/10'
                      : 'text-text hover:bg-surface-high'
                }`}
              >
                {it.icon && (
                  <span className={`material-symbols-outlined text-sm ${it.danger ? 'text-danger' : it.color || 'text-text-secondary'}`}>
                    {it.icon}
                  </span>
                )}
                <span className="flex-1 truncate">{it.label}</span>
                {it.checked && <span className="material-symbols-outlined text-xs text-primary">check</span>}
                {it.shortcut && (
                  <span className="text-[9px] text-text-secondary/70 font-mono shrink-0">{it.shortcut}</span>
                )}
                {it.submenu && (
                  <span className="material-symbols-outlined text-xs text-text-secondary/70">chevron_right</span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function adjustToViewport(p: { x: number; y: number }, w: number, h: number) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  return {
    x: Math.min(p.x, vw - w - 4),
    y: Math.min(p.y, vh - h - 4),
  };
}
