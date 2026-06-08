// ─────────────────────────────────────────────────────────────────
// 全局通知中心 (右上角浮层)
// ─────────────────────────────────────────────────────────────────

import { useEffect, useState, useCallback, useRef } from 'react';
import { Badge, Button, IconButton, Tooltip } from '../ui/Button';

export interface NotificationItem {
  id: string;
  level: 'info' | 'success' | 'warning' | 'error';
  title: string;
  message?: string;
  timestamp: number;
  read?: boolean;
  action?: { label: string; onClick: () => void };
}

const LEVEL_STYLE = {
  info:    { icon: 'info',         color: 'text-accent',   bg: 'bg-accent/10',   border: 'border-accent/30' },
  success: { icon: 'check_circle', color: 'text-success',  bg: 'bg-success/10',  border: 'border-success/30' },
  warning: { icon: 'warning',      color: 'text-warning',  bg: 'bg-warning/10',  border: 'border-warning/30' },
  error:   { icon: 'error',        color: 'text-danger',   bg: 'bg-danger/10',   border: 'border-danger/30' },
} as const;

let globalPush: ((n: Omit<NotificationItem, 'id' | 'timestamp' | 'read'>) => void) | null = null;

export function pushNotification(n: Omit<NotificationItem, 'id' | 'timestamp' | 'read'>) {
  globalPush?.(n);
}

// ─── Toast (transient, 自动消失) ───
export interface ToastItem {
  id: string;
  level: 'info' | 'success' | 'warning' | 'error';
  title: string;
  message?: string;
  duration?: number;
  action?: { label: string; onClick: () => void };
}

const TOAST_DEFAULT_MS = 4000;
let globalToast: ((n: Omit<ToastItem, 'id'>) => string) | null = null;

export function pushToast(n: Omit<ToastItem, 'id'>) {
  if (!globalToast) return '';
  return globalToast(n);
}

export function NotificationCenter() {
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [open, setOpen] = useState(false);

  const push = useCallback((n: Omit<NotificationItem, 'id' | 'timestamp' | 'read'>) => {
    const item: NotificationItem = {
      ...n,
      id: 'n_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
      timestamp: Date.now(),
      read: false,
    };
    setItems(prev => [item, ...prev].slice(0, 50));
  }, []);

  useEffect(() => {
    globalPush = push;
    return () => { globalPush = null; };
  }, [push]);

  const unread = items.filter(i => !i.read).length;
  const markAllRead = () => setItems(prev => prev.map(i => ({ ...i, read: true })));
  const clear = () => setItems([]);

  return (
    <div className="fixed top-12 right-3 z-40 pointer-events-none">
      <div className="flex items-start gap-2 justify-end pointer-events-auto">
        {/* 通知列表 */}
        {open && (
          <div className="w-80 max-h-[60vh] bg-surface border border-border rounded-xl shadow-2xl overflow-hidden flex flex-col animate-slide-in-right">
            <div className="flex items-center justify-between px-3 h-10 bg-surface-high border-b border-border">
              <div className="flex items-center gap-2 text-xs">
                <span className="material-symbols-outlined text-primary text-sm">notifications</span>
                <span className="font-semibold text-text">通知</span>
                {unread > 0 && <Badge variant="primary">{unread}</Badge>}
              </div>
              <div className="flex items-center gap-1">
                <button onClick={markAllRead} className="text-[10px] text-text-secondary hover:text-text px-1.5">全部已读</button>
                <button onClick={clear} className="text-[10px] text-danger hover:underline px-1.5">清空</button>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto scrollbar-thin">
              {items.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-40 text-text-secondary">
                  <span className="material-symbols-outlined text-3xl mb-1 opacity-40">notifications_off</span>
                  <p className="text-xs">暂无通知</p>
                </div>
              ) : (
                items.map(item => {
                  const s = LEVEL_STYLE[item.level];
                  return (
                    <div
                      key={item.id}
                      className={`group p-2.5 border-b border-border-light hover:bg-surface-low transition-colors ${
                        !item.read ? 'bg-primary/5' : ''
                      }`}
                    >
                      <div className="flex items-start gap-2">
                        <div className={`w-7 h-7 rounded-full ${s.bg} border ${s.border} flex items-center justify-center shrink-0`}>
                          <span className={`material-symbols-outlined text-sm ${s.color}`}>{s.icon}</span>
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="text-xs font-semibold text-text">{item.title}</div>
                          {item.message && (
                            <div className="text-[10px] text-text-secondary mt-0.5 line-clamp-2">{item.message}</div>
                          )}
                          <div className="text-[9px] text-text-secondary/70 mt-0.5 font-mono">
                            {new Date(item.timestamp).toLocaleTimeString('zh-CN', { hour12: false })}
                          </div>
                          {item.action && (
                            <button
                              onClick={item.action.onClick}
                              className="mt-1 text-[10px] text-primary hover:underline"
                            >
                              {item.action.label} →
                            </button>
                          )}
                        </div>
                        {!item.read && <div className="w-1.5 h-1.5 rounded-full bg-primary mt-1.5 shrink-0" />}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        )}

        {/* 触发按钮 */}
        <Tooltip content="通知" side="left">
          <button
            onClick={() => setOpen(o => !o)}
            className="relative w-8 h-8 rounded-lg bg-surface border border-border hover:border-primary flex items-center justify-center text-text-secondary hover:text-text transition-colors"
          >
            <span className="material-symbols-outlined text-sm">notifications</span>
            {unread > 0 && (
              <span className="absolute -top-1 -right-1 min-w-[16px] h-4 px-1 rounded-full bg-danger text-white text-[9px] font-bold flex items-center justify-center">
                {unread > 9 ? '9+' : unread}
              </span>
            )}
          </button>
        </Tooltip>
      </div>
    </div>
  );
}

// ─── 启动时的欢迎通知 ───
export function WelcomeNotifications() {
  useEffect(() => {
    const t1 = setTimeout(() => {
      pushToast({
        level: 'success',
        title: 'SoloForge 已就绪',
        message: '前端 v1.0.0 启动完成',
      });
    }, 1200);
    const t2 = setTimeout(() => {
      pushToast({
        level: 'info',
        title: '快捷键提示',
        message: 'Ctrl+K 命令面板 · Ctrl+` 终端 · Ctrl+P 跳文件',
        duration: 6000,
      });
    }, 3500);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, []);
  return null;
}

// ─── Toast 浮层 (右下角，4 秒自动消失) ───
export function ToastCenter() {
  const [items, setItems] = useState<ToastItem[]>([]);
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const push = useCallback((n: Omit<ToastItem, 'id'>) => {
    const id = 't_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    const item: ToastItem = { id, duration: TOAST_DEFAULT_MS, ...n };
    setItems(prev => [...prev.slice(-4), item]); // 最多保留 5 条
    if (item.duration && item.duration > 0) {
      const t = setTimeout(() => {
        setItems(prev => prev.filter(p => p.id !== id));
        timersRef.current.delete(id);
      }, item.duration);
      timersRef.current.set(id, t);
    }
    return id;
  }, []);

  useEffect(() => {
    globalToast = push;
    return () => {
      globalToast = null;
      timersRef.current.forEach(t => clearTimeout(t));
      timersRef.current.clear();
    };
  }, [push]);

  const dismiss = (id: string) => {
    setItems(prev => prev.filter(p => p.id !== id));
    const t = timersRef.current.get(id);
    if (t) { clearTimeout(t); timersRef.current.delete(id); }
  };

  return (
    <div className="fixed bottom-9 right-3 z-[140] flex flex-col gap-2 items-end pointer-events-none">
      {items.map(item => {
        const s = LEVEL_STYLE[item.level];
        return (
          <div
            key={item.id}
            className={`pointer-events-auto group relative w-[340px] max-w-[90vw] flex items-start gap-2 p-2.5 rounded-lg bg-surface border ${s.border} shadow-lg animate-slide-in-right overflow-hidden`}
            onMouseEnter={() => {
              const t = timersRef.current.get(item.id);
              if (t) { clearTimeout(t); timersRef.current.delete(item.id); }
            }}
          >
            <div className={`shrink-0 w-7 h-7 rounded-full ${s.bg} border ${s.border} flex items-center justify-center`}>
              <span className={`material-symbols-outlined text-sm ${s.color}`}>{s.icon}</span>
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-xs font-semibold text-text">{item.title}</div>
              {item.message && (
                <div className="text-[10px] text-text-secondary mt-0.5 break-words">{item.message}</div>
              )}
              {item.action && (
                <button
                  onClick={() => { item.action?.onClick(); dismiss(item.id); }}
                  className="mt-1 text-[10px] text-primary hover:underline font-medium"
                >
                  {item.action.label} →
                </button>
              )}
            </div>
            <button
              onClick={() => dismiss(item.id)}
              className="shrink-0 opacity-0 group-hover:opacity-100 material-symbols-outlined text-xs text-text-secondary hover:text-text transition-opacity"
            >close</button>
            {item.duration && item.duration > 0 && (
              <div className="absolute bottom-0 left-0 right-0 h-0.5 rounded-b-lg overflow-hidden bg-border-light/30">
                <div
                  className={`h-full ${s.bg.replace('/10', '/60')} animate-toast-shrink origin-left`}
                  style={{ animationDuration: `${item.duration}ms` }}
                />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
