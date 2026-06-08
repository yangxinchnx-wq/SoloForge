// ─────────────────────────────────────────────────────────────────
// 通用 UI 组件库
// Button / IconButton / Badge / Tooltip / Card / Tabs / Toggle / Select
// ─────────────────────────────────────────────────────────────────

import React, { useState, useRef, useEffect, useCallback } from 'react';

// ─── Button ───
type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'outline';
type ButtonSize = 'xs' | 'sm' | 'md' | 'lg';

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: string;
  iconRight?: string;
  loading?: boolean;
  block?: boolean;
  tooltip?: string;
}

export function Button({
  variant = 'secondary', size = 'sm', icon, iconRight, tooltip,
  loading, block, className = '', children, ...rest
}: ButtonProps) {
  const variantCls: Record<ButtonVariant, string> = {
    primary:   'bg-primary text-on-primary hover:opacity-90 active:opacity-80',
    secondary: 'bg-surface-high text-text hover:bg-border-light border border-border-light',
    ghost:     'text-text-secondary hover:text-text hover:bg-surface-high',
    danger:    'bg-danger text-white hover:opacity-90',
    outline:   'border border-border text-text hover:bg-surface-high hover:border-primary',
  };
  const sizeCls: Record<ButtonSize, string> = {
    xs: 'h-6 px-2 text-[10px] gap-1',
    sm: 'h-7 px-2.5 text-xs gap-1.5',
    md: 'h-9 px-3 text-sm gap-2',
    lg: 'h-10 px-4 text-sm gap-2',
  };
  return (
    <Tooltip content={tooltip}>
      <button
        {...rest}
        disabled={rest.disabled || loading}
        className={`inline-flex items-center justify-center rounded-md font-medium transition-all
          disabled:opacity-40 disabled:cursor-not-allowed select-none
          ${variantCls[variant]} ${sizeCls[size]} ${block ? 'w-full' : ''} ${className}`}
      >
        {loading ? (
          <span className="material-symbols-outlined animate-spin text-current" style={{ fontSize: '1em' }}>progress_activity</span>
        ) : icon ? (
          <span className="material-symbols-outlined" style={{ fontSize: '1.1em' }}>{icon}</span>
        ) : null}
        {children}
        {iconRight && <span className="material-symbols-outlined" style={{ fontSize: '1.1em' }}>{iconRight}</span>}
      </button>
    </Tooltip>
  );
}

// ─── IconButton ───
interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  icon: string;
  filled?: boolean;
  active?: boolean;
  size?: 'xs' | 'sm' | 'md';
  tooltip?: string;
}
export function IconButton({ icon, filled, active, size = 'sm', tooltip, className = '', ...rest }: IconButtonProps) {
  const sz = { xs: 'w-6 h-6', sm: 'w-7 h-7', md: 'w-9 h-9' }[size];
  const ic = { xs: 'text-sm', sm: 'text-base', md: 'text-lg' }[size];
  return (
    <Tooltip content={tooltip}>
      <button
        {...rest}
        className={`${sz} inline-flex items-center justify-center rounded-md transition-colors
          ${active
            ? 'bg-primary-container text-on-primary-container'
            : 'text-text-secondary hover:text-text hover:bg-surface-high'
          } ${className}`}
      >
        <span className={`material-symbols-outlined ${ic} ${filled || active ? 'filled' : ''}`}>{icon}</span>
      </button>
    </Tooltip>
  );
}

// ─── Tooltip ───
// Tooltip 升级:支持快捷键 keys (渲染为 chip) + 参数 arg (独立显示)
export function Tooltip({ content, keys, arg, hint, children, side = 'top' }: {
  content?: string;
  keys?: string[];
  arg?: string;
  hint?: string;
  children: React.ReactNode;
  side?: 'top' | 'bottom' | 'left' | 'right';
}) {
  const [show, setShow] = useState(false);
  if (!content && !keys?.length && !arg && !hint) return <>{children}</>;
  const pos = {
    top:    'bottom-full left-1/2 -translate-x-1/2 mb-1.5',
    bottom: 'top-full left-1/2 -translate-x-1/2 mt-1.5',
    left:   'right-full top-1/2 -translate-y-1/2 mr-1.5',
    right:  'left-full top-1/2 -translate-y-1/2 ml-1.5',
  }[side];
  const isDanger = arg?.toUpperCase() === 'DESTRUCTIVE';
  return (
    <span className="relative inline-flex" onMouseEnter={() => setShow(true)} onMouseLeave={() => setShow(false)}>
      {children}
      {show && (
        <span className={`absolute z-50 ${pos} px-2 py-1 rounded text-[10px] font-medium whitespace-nowrap pointer-events-none animate-fade-in shadow-lg flex flex-col items-start gap-0.5 min-w-max
          ${isDanger ? 'bg-danger text-white' : 'bg-text text-bg'}`}>
          <span className="flex items-center gap-1.5">
            {content && <span className="font-semibold">{content}</span>}
            {keys && keys.length > 0 && (
              <span className="flex items-center gap-0.5">
                {keys.map((k, i) => (
                  <span key={i} className="px-1 h-3.5 min-w-[14px] inline-flex items-center justify-center rounded border border-bg/30 bg-bg/20 text-[9px] font-mono">
                    {k}
                  </span>
                ))}
              </span>
            )}
          </span>
          {(arg || hint) && (
            <span className="flex items-center gap-1.5 text-[9px] opacity-90 font-mono">
              {arg && (
                <span className={`px-1 py-0.5 rounded ${isDanger ? 'bg-white/20 text-white' : 'bg-bg/20 text-bg'}`}>
                  {arg}
                </span>
              )}
              {hint && <span className="opacity-75">{hint}</span>}
            </span>
          )}
        </span>
      )}
    </span>
  );
}

// 单个 kbd 键位 chip
export function Kbd({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <kbd className={`px-1 h-4 min-w-[16px] inline-flex items-center justify-center rounded border border-border bg-bg-dim text-text-secondary font-mono text-[9px] ${className}`}>
      {children}
    </kbd>
  );
}

// 键位组(显示 Ctrl+Shift+F 之类)
export function KbdGroup({ keys, className = '' }: { keys: string[]; className?: string }) {
  return (
    <span className={`inline-flex items-center gap-0.5 ${className}`}>
      {keys.map((k, i) => (
        <Kbd key={i}>{k}</Kbd>
      ))}
    </span>
  );
}

// ─── Badge ───
type BadgeVariant = 'default' | 'primary' | 'success' | 'warning' | 'danger' | 'info';
export function Badge({ children, variant = 'default', dot, pulse, className = '' }: { children: React.ReactNode; variant?: BadgeVariant; dot?: boolean; pulse?: boolean; className?: string }) {
  const colors: Record<BadgeVariant, string> = {
    default: 'bg-surface-high text-text-secondary border-border-light',
    primary: 'bg-primary-container text-on-primary-container border-primary/30',
    success: 'bg-success/15 text-success border-success/30',
    warning: 'bg-warning/15 text-warning border-warning/30',
    danger:  'bg-danger/15 text-danger border-danger/30',
    info:    'bg-accent/15 text-accent border-accent/30',
  };
  const dotColor: Record<BadgeVariant, string> = {
    default: 'bg-text-secondary', primary: 'bg-primary', success: 'bg-success',
    warning: 'bg-warning', danger: 'bg-danger', info: 'bg-accent',
  };
  return (
    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium border ${colors[variant]} ${className}`}>
      {dot && <span className="relative inline-flex">
        <span className={`w-1.5 h-1.5 rounded-full ${dotColor[variant]}`} />
        {pulse && <span className={`absolute inset-0 w-1.5 h-1.5 rounded-full ${dotColor[variant]} animate-ping opacity-60`} />}
      </span>}
      {children}
    </span>
  );
}

// ─── Card ───
export function Card({ title, icon, action, children, className = '', bodyClass = '' }: {
  title?: React.ReactNode;
  icon?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  bodyClass?: string;
}) {
  return (
    <div className={`bg-surface rounded-xl border border-border overflow-hidden ${className}`}>
      {(title || action) && (
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-border bg-surface-high">
          <h3 className="text-xs font-semibold text-text flex items-center gap-1.5">
            {icon && <span className="material-symbols-outlined filled text-primary text-sm">{icon}</span>}
            {title}
          </h3>
          {action}
        </div>
      )}
      <div className={bodyClass || 'p-4'}>{children}</div>
    </div>
  );
}

// ─── Toggle / Switch ───
export function Switch({ checked, onChange, size = 'sm', label, disabled }: {
  checked: boolean;
  onChange: (v: boolean) => void;
  size?: 'sm' | 'md';
  label?: string;
  disabled?: boolean;
}) {
  const sz = size === 'sm' ? 'w-8 h-4' : 'w-10 h-5';
  const dot = size === 'sm' ? 'w-3 h-3 top-0.5 left-0.5' : 'w-4 h-4 top-0.5 left-0.5';
  const offset = size === 'sm' ? 'translate-x-4' : 'translate-x-5';
  return (
    <label className={`inline-flex items-center gap-2 ${disabled ? 'opacity-40' : 'cursor-pointer'}`}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={`relative ${sz} rounded-full transition-colors ${checked ? 'bg-primary' : 'bg-surface-high border border-border'}`}
      >
        <span className={`absolute ${dot} rounded-full bg-bg transition-transform ${checked ? offset : ''}`} />
      </button>
      {label && <span className="text-xs text-text">{label}</span>}
    </label>
  );
}

// ─── Tabs ───
interface TabsProps {
  tabs: Array<{ id: string; label: string; icon?: string; badge?: React.ReactNode }>;
  active: string;
  onChange: (id: string) => void;
  variant?: 'underline' | 'pill';
  size?: 'sm' | 'md';
}
export function Tabs({ tabs, active, onChange, variant = 'underline', size = 'sm' }: TabsProps) {
  if (variant === 'pill') {
    return (
      <div className="inline-flex items-center gap-1 p-0.5 bg-surface-high rounded-lg border border-border-light">
        {tabs.map(t => (
          <button
            key={t.id}
            onClick={() => onChange(t.id)}
            className={`flex items-center gap-1 px-2.5 h-7 rounded-md text-[11px] font-medium transition-all
              ${active === t.id
                ? 'bg-surface text-text shadow-sm'
                : 'text-text-secondary hover:text-text'
              }`}
          >
            {t.icon && <span className="material-symbols-outlined text-sm">{t.icon}</span>}
            <span>{t.label}</span>
            {t.badge}
          </button>
        ))}
      </div>
    );
  }
  return (
    <div className="flex items-center gap-0 border-b border-border">
      {tabs.map(t => (
        <button
          key={t.id}
          onClick={() => onChange(t.id)}
          className={`relative flex items-center gap-1.5 px-3 h-${size === 'sm' ? '9' : '10'} text-xs font-medium transition-colors
            ${active === t.id
              ? 'text-primary'
              : 'text-text-secondary hover:text-text'
            }`}
        >
          {t.icon && <span className={`material-symbols-outlined text-sm ${active === t.id ? 'filled' : ''}`}>{t.icon}</span>}
          <span>{t.label}</span>
          {t.badge}
          {active === t.id && <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary rounded-t" />}
        </button>
      ))}
    </div>
  );
}

// ─── Select ───
interface SelectProps<T extends string> {
  value: T;
  options: Array<{ value: T; label: string; icon?: string }>;
  onChange: (v: T) => void;
  size?: 'xs' | 'sm' | 'md';
  className?: string;
  disabled?: boolean;
}
export function Select<T extends string>({ value, options, onChange, size = 'sm', className = '', disabled }: SelectProps<T>) {
  const sz = { xs: 'h-6 text-[10px] px-1.5', sm: 'h-7 text-xs px-2', md: 'h-9 text-sm px-2.5' }[size];
  return (
    <select
      value={value}
      onChange={e => onChange(e.target.value as T)}
      disabled={disabled}
      className={`bg-surface-high border border-border-light text-text rounded-md
        focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary
        ${sz} ${disabled ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'} ${className}`}
    >
      {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

// ─── Kbd (旧版兼容,新版请用顶部新版) ───
// 注:新 Kbd / KbdGroup 已在 Tooltip 之后定义,这里保留旧版以防外部使用

// ─── Spinner ───
export function Spinner({ size = 14, className = '' }: { size?: number; className?: string }) {
  return (
    <span
      className={`material-symbols-outlined animate-spin inline-block ${className}`}
      style={{ fontSize: size }}
    >progress_activity</span>
  );
}

// ─── ProgressBar ───
export function ProgressBar({ value, max = 100, color = 'primary', size = 'sm', showLabel }: {
  value: number; max?: number; color?: 'primary' | 'success' | 'warning' | 'danger' | 'accent';
  size?: 'xs' | 'sm' | 'md'; showLabel?: boolean;
}) {
  const pct = Math.min(100, Math.max(0, (value / max) * 100));
  const h = { xs: 'h-1', sm: 'h-1.5', md: 'h-2' }[size];
  const c = { primary: 'bg-primary', success: 'bg-success', warning: 'bg-warning', danger: 'bg-danger', accent: 'bg-accent' }[color];
  return (
    <div className="flex items-center gap-2 w-full">
      <div className={`flex-1 ${h} bg-surface-high rounded-full overflow-hidden`}>
        <div
          className={`h-full ${c} rounded-full transition-all duration-500 ease-out`}
          style={{ width: `${pct}%` }}
        />
      </div>
      {showLabel && <span className="text-[10px] font-mono text-text-secondary tabular-nums w-8 text-right">{pct.toFixed(0)}%</span>}
    </div>
  );
}

// ─── PanelHeader (统一风格的标题栏) ───
export function PanelHeader({
  icon, title, count, action, className = '',
}: {
  icon?: string; title: React.ReactNode; count?: React.ReactNode; action?: React.ReactNode; className?: string;
}) {
  return (
    <div className={`flex items-center justify-between px-3 h-9 bg-surface border-b border-border shrink-0 ${className}`}>
      <div className="flex items-center gap-2 text-xs min-w-0">
        {icon && <span className="material-symbols-outlined filled text-primary text-sm shrink-0">{icon}</span>}
        <span className="font-semibold text-text truncate">{title}</span>
        {count != null && <span className="text-text-secondary shrink-0">· {count}</span>}
      </div>
      {action && <div className="flex items-center gap-1 shrink-0">{action}</div>}
    </div>
  );
}

// ─── Status Dot ───
export function StatusDot({ status, pulse }: { status: 'running' | 'idle' | 'error' | 'warning' | 'success' | 'pending'; pulse?: boolean }) {
  const color = {
    running: 'bg-success', idle: 'bg-text-secondary', error: 'bg-danger',
    warning: 'bg-warning', success: 'bg-success', pending: 'bg-warning',
  }[status];
  return (
    <span className="relative inline-flex items-center">
      <span className={`w-2 h-2 rounded-full ${color}`} />
      {pulse && <span className={`absolute inset-0 w-2 h-2 rounded-full ${color} animate-ping opacity-60`} />}
    </span>
  );
}

// ─── Empty State ───
export function EmptyState({ icon, title, hint, action }: { icon: string; title: string; hint?: string; action?: React.ReactNode }) {
  return (
    <div className="h-full flex flex-col items-center justify-center text-text-secondary p-6 animate-fade-in">
      <div className="relative mb-4">
        <span className="material-symbols-outlined text-5xl opacity-30">{icon}</span>
        <span className="absolute inset-0 blur-2xl bg-primary/10 rounded-full" />
      </div>
      <p className="text-sm font-medium text-text-secondary">{title}</p>
      {hint && <p className="text-xs text-text-secondary/70 mt-1 max-w-xs text-center">{hint}</p>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

// ─── Divider ───
export function Divider({ vertical, className = '' }: { vertical?: boolean; className?: string }) {
  return vertical
    ? <div className={`w-px h-full bg-border ${className}`} />
    : <div className={`h-px w-full bg-border ${className}`} />;
}

// ─── Avatar ───
export function Avatar({ name, size = 24, color }: { name: string; size?: number; color?: string }) {
  const initial = name.slice(0, 1).toUpperCase();
  const hue = name.split('').reduce((a, c) => a + c.charCodeAt(0), 0) % 360;
  const bg = color || `hsl(${hue}, 60%, 35%)`;
  return (
    <div
      className="rounded-full flex items-center justify-center text-white font-semibold shrink-0"
      style={{ width: size, height: size, fontSize: size * 0.5, backgroundColor: bg }}
    >
      {initial}
    </div>
  );
}

// ─── DragHandle (统一拖拽条) ───
export function DragHandle({ direction = 'h', onMouseDown, className = '' }: {
  direction?: 'h' | 'v'; onMouseDown?: () => void; className?: string;
}) {
  return (
    <div
      onMouseDown={onMouseDown}
      className={`drag-handle shrink-0 ${direction === 'h' ? 'drag-handle-h' : 'drag-handle-v'} ${className}`}
    />
  );
}

// ─── Ripple Button (带点击波纹) ───
export function RippleButton({
  children, onClick, className = '',
}: {
  children: React.ReactNode; onClick?: (e: React.MouseEvent) => void; className?: string;
}) {
  const [ripples, setRipples] = useState<Array<{ id: number; x: number; y: number; size: number }>>([]);

  const handle = (e: React.MouseEvent<HTMLButtonElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const size = Math.max(rect.width, rect.height);
    const id = Date.now() + Math.random();
    setRipples(prev => [...prev, { id, x, y, size }]);
    setTimeout(() => setRipples(prev => prev.filter(r => r.id !== id)), 600);
    onClick?.(e);
  };

  return (
    <button
      onClick={handle}
      className={`relative overflow-hidden ${className}`}
    >
      {children}
      {ripples.map(r => (
        <span
          key={r.id}
          className="ripple-effect"
          style={{
            left: r.x - r.size / 2,
            top: r.y - r.size / 2,
            width: r.size,
            height: r.size,
          }}
        />
      ))}
    </button>
  );
}

// ─── AnimatedNumber (数字滚动入场) ───
export function AnimatedNumber({ value, duration = 600, format, className = '' }: {
  value: number; duration?: number; format?: (n: number) => string; className?: string;
}) {
  const [display, setDisplay] = useState(value);
  const [animKey, setAnimKey] = useState(0);
  const startRef = useRef<number | null>(null);
  const fromRef = useRef(value);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    fromRef.current = display;
    startRef.current = null;
    setAnimKey(k => k + 1);
    const start = performance.now();
    const tick = (t: number) => {
      if (!startRef.current) startRef.current = t;
      const elapsed = t - startRef.current;
      const p = Math.min(1, elapsed / duration);
      const eased = 1 - Math.pow(1 - p, 3);
      const next = fromRef.current + (value - fromRef.current) * eased;
      setDisplay(next);
      if (p < 1) rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const text = format ? format(display) : display.toFixed(0);
  return <span key={animKey} className={`animate-counter tabular-nums ${className}`}>{text}</span>;
}

// ─── Heatmap (热力图) ───
export function Heatmap({ data, cols = 12, rows = 5, className = '' }: {
  data: number[]; cols?: number; rows?: number; className?: string;
}) {
  return (
    <div className={`grid gap-1 ${className}`} style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}>
      {data.map((v, i) => {
        const intensity = Math.min(1, v);
        return (
          <div
            key={i}
            className="aspect-square rounded-sm transition-all hover:scale-110"
            style={{
              background: `color-mix(in srgb, var(--color-primary) ${intensity * 100}%, var(--color-surface-high))`,
            }}
            title={`值: ${v.toFixed(2)}`}
          />
        );
      })}
    </div>
  );
}

// ─── RingProgress (环形进度) ───
export function RingProgress({ value, size = 48, strokeWidth = 4, color = 'primary', showLabel }: {
  value: number; size?: number; strokeWidth?: number; color?: 'primary' | 'success' | 'warning' | 'danger' | 'accent'; showLabel?: boolean;
}) {
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - value / 100);
  const c = { primary: 'text-primary', success: 'text-success', warning: 'text-warning', danger: 'text-danger', accent: 'text-accent' }[color];
  return (
    <div className="relative inline-flex items-center justify-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeWidth={strokeWidth}
          className="text-surface-high"
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeWidth={strokeWidth}
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          strokeLinecap="round"
          className={`${c} transition-all duration-700`}
        />
      </svg>
      {showLabel && <span className="absolute text-[10px] font-semibold text-text tabular-nums">{value.toFixed(0)}%</span>}
    </div>
  );
}
