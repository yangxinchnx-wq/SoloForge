// ─────────────────────────────────────────────────────────────────
// 多窗口拖出 (Popup Window + BroadcastChannel)
// - 弹出独立浏览器窗口, 内容可与主窗口实时同步
// - 通过 BroadcastChannel + storage 事件
// - 主窗口管理所有子窗口的注册/同步
// ─────────────────────────────────────────────────────────────────

import { useEffect, useRef, useState } from 'react';
import { pushToast } from './Notifications';

const CHANNEL_NAME = 'soloforge.detached';
const REGISTRY_KEY = 'soloforge.detached.registry';

export type DetachedKind = 'terminal' | 'chat' | 'stream' | 'preview' | 'court' | 'git';

interface DetachedConfig {
  id: string;
  kind: DetachedKind;
  title: string;
  width: number;
  height: number;
  createdAt: number;
}

interface Registry {
  windows: DetachedConfig[];
}

function loadRegistry(): Registry {
  try {
    const raw = localStorage.getItem(REGISTRY_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return { windows: [] };
}
function saveRegistry(r: Registry) {
  try { localStorage.setItem(REGISTRY_KEY, JSON.stringify(r)); } catch { /* ignore */ }
}

let channel: BroadcastChannel | null = null;
function getChannel(): BroadcastChannel {
  if (!channel) channel = new BroadcastChannel(CHANNEL_NAME);
  return channel;
}

export interface DetachedSyncMessage {
  type: 'state' | 'request-state' | 'register' | 'unregister' | 'user-action';
  from: string;
  payload?: any;
}

/** 主窗口侧: 注册新 popup 窗口 */
export function openDetachedWindow(config: Omit<DetachedConfig, 'createdAt'>): Window | null {
  // 打开 popup
  const url = new URL(window.location.href);
  url.hash = url.hash || '#';
  url.searchParams.set('detached', config.id);
  url.searchParams.set('kind', config.kind);
  const win = window.open(
    url.toString(),
    `soloforge-${config.id}`,
    `width=${config.width},height=${config.height},menubar=no,toolbar=no,location=no,status=no`,
  );
  if (!win) {
    pushToast({ level: 'error', title: '弹出被拦截', message: '请允许浏览器弹出窗口', duration: 3000 });
    return null;
  }
  // 注册到 registry
  const reg = loadRegistry();
  if (!reg.windows.find(w => w.id === config.id)) {
    reg.windows.push({ ...config, createdAt: Date.now() });
    saveRegistry(reg);
  }
  // 通知子窗口
  const ch = getChannel();
  ch.postMessage({ type: 'register', from: 'main', payload: config } as DetachedSyncMessage);
  return win;
}

/** 主窗口侧: 主动推送状态到所有子窗口 */
export function broadcastState(payload: any) {
  const ch = getChannel();
  ch.postMessage({ type: 'state', from: 'main', payload } as DetachedSyncMessage);
}

/** 主窗口侧: 关闭所有子窗口并清空注册 */
export function closeAllDetached() {
  const reg = loadRegistry();
  // 通过 channel 通知子窗口关闭
  const ch = getChannel();
  reg.windows.forEach(w => {
    ch.postMessage({ type: 'unregister', from: 'main', payload: { id: w.id } } as DetachedSyncMessage);
  });
  saveRegistry({ windows: [] });
}

// ─── 弹出窗口专用组件 (在子窗口中渲染) ───
export function DetachedWindowView({ kind, id, onClose }: { kind: DetachedKind; id: string; onClose: () => void }) {
  const [lastSync, setLastSync] = useState<number>(0);
  const [state, setState] = useState<any>(null);
  const channelRef = useRef<BroadcastChannel | null>(null);

  useEffect(() => {
    document.title = `SoloForge · ${kind} · ${id}`;
    document.body.classList.add('detached-window');
    // 设置暗色背景
    const root = document.getElementById('root');
    if (root) root.classList.add('detached-root');
  }, [kind, id]);

  useEffect(() => {
    const ch = getChannel();
    channelRef.current = ch;
    const onMsg = (e: MessageEvent<DetachedSyncMessage>) => {
      const msg = e.data;
      if (msg.from === id) return;
      if (msg.type === 'state') {
        setState(msg.payload);
        setLastSync(Date.now());
      } else if (msg.type === 'unregister' && msg.payload?.id === id) {
        window.close();
      } else if (msg.type === 'request-state') {
        // 回应: 请求主窗口重新发送 state
        ch.postMessage({ type: 'request-state', from: id });
      }
    };
    ch.addEventListener('message', onMsg);
    // 入场请求最新 state
    ch.postMessage({ type: 'request-state', from: id });
    return () => ch.removeEventListener('message', onMsg);
  }, [id]);

  // 关闭按钮
  useEffect(() => {
    const onBeforeUnload = () => {
      const ch = getChannel();
      ch.postMessage({ type: 'unregister', from: id, payload: { id } } as DetachedSyncMessage);
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [id]);

  return (
    <div className="flex flex-col h-screen bg-bg text-text font-sans overflow-hidden">
      {/* header */}
      <div className="flex items-center gap-2 px-3 h-9 bg-surface border-b border-border shrink-0">
        <span className="material-symbols-outlined text-sm text-primary">open_in_new</span>
        <span className="text-xs font-semibold text-text">SoloForge · {labelForKind(kind)}</span>
        <span className="text-[10px] text-text-secondary font-mono">· {id}</span>
        <div className="flex-1" />
        <span className="text-[10px] text-text-secondary font-mono flex items-center gap-1">
          <span className={`w-1.5 h-1.5 rounded-full ${lastSync > 0 ? 'bg-success' : 'bg-text-secondary'}`} />
          {lastSync > 0 ? `同步于 ${(Date.now() - lastSync) / 1000}s 前` : '等待主窗口...'}
        </span>
        <button
          onClick={onClose}
          className="material-symbols-outlined text-text-secondary hover:text-text text-sm"
        >close</button>
      </div>
      {/* body */}
      <div className="flex-1 overflow-auto p-3 scrollbar-thin">
        {state ? (
          <pre className="text-[10px] text-text font-mono whitespace-pre-wrap break-all leading-relaxed">
{JSON.stringify(state, null, 2)}
          </pre>
        ) : (
          <div className="flex flex-col items-center justify-center h-full text-text-secondary">
            <span className="material-symbols-outlined text-4xl mb-2 opacity-40">{iconForKind(kind)}</span>
            <p className="text-sm">独立 {labelForKind(kind)} 窗口</p>
            <p className="text-[11px] text-text-secondary/70 mt-1">主窗口内容会同步到这里</p>
            <p className="text-[10px] text-text-secondary/50 mt-3 font-mono">id: {id}</p>
          </div>
        )}
      </div>
    </div>
  );
}

function labelForKind(k: DetachedKind): string {
  return k === 'terminal' ? '终端' :
         k === 'chat' ? '对话' :
         k === 'stream' ? '流送' :
         k === 'preview' ? '预览' :
         k === 'court' ? '法庭' : 'Git';
}
function iconForKind(k: DetachedKind): string {
  return k === 'terminal' ? 'terminal' :
         k === 'chat' ? 'forum' :
         k === 'stream' ? 'stream' :
         k === 'preview' ? 'preview' :
         k === 'court' ? 'gavel' : 'account_tree';
}

// ─── 弹出窗口选择器 (主窗口) ───
export function DetachSelector({ open, onSelect, onClose }: { open: boolean; onSelect: (kind: DetachedKind) => void; onClose: () => void }) {
  if (!open) return null;
  const kinds: { kind: DetachedKind; label: string; icon: string; desc: string }[] = [
    { kind: 'terminal', label: '终端', icon: 'terminal', desc: '在独立窗口中显示终端面板' },
    { kind: 'chat',     label: '对话', icon: 'forum',    desc: '在独立窗口中显示当前对话' },
    { kind: 'stream',   label: '流送', icon: 'stream',   desc: '在独立窗口中显示流送区' },
    { kind: 'preview',  label: '预览', icon: 'preview',  desc: '在独立窗口中显示预览面板' },
    { kind: 'court',    label: '法庭', icon: 'gavel',    desc: '在独立窗口中显示法庭面板' },
    { kind: 'git',      label: 'Git',  icon: 'account_tree', desc: '在独立窗口中显示源码管理' },
  ];
  return (
    <div
      className="fixed inset-0 z-[230] flex items-center justify-center bg-black/60 backdrop-blur-sm animate-fade-in"
      onClick={onClose}
    >
      <div
        className="w-[440px] max-w-[90vw] bg-surface border border-border rounded-xl shadow-2xl overflow-hidden animate-slide-in-up"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-3 h-10 border-b border-border">
          <span className="material-symbols-outlined text-primary">open_in_new</span>
          <h3 className="text-sm font-semibold text-text">拖出独立窗口</h3>
          <div className="flex-1" />
          <button onClick={onClose} className="material-symbols-outlined text-text-secondary hover:text-text text-sm">close</button>
        </div>
        <div className="p-2 grid grid-cols-2 gap-1.5">
          {kinds.map(k => (
            <button
              key={k.kind}
              onClick={() => onSelect(k.kind)}
              className="group flex items-start gap-2 px-2.5 py-2 rounded-lg bg-bg-dim hover:bg-surface-high border border-border-light hover:border-primary/40 transition-colors text-left"
            >
              <span className="material-symbols-outlined text-base text-primary mt-0.5">{k.icon}</span>
              <div className="flex-1 min-w-0">
                <div className="text-xs font-semibold text-text">{k.label}</div>
                <div className="text-[10px] text-text-secondary/80 leading-snug mt-0.5">{k.desc}</div>
              </div>
              <span className="material-symbols-outlined text-xs text-text-secondary opacity-0 group-hover:opacity-100 mt-1">north_east</span>
            </button>
          ))}
        </div>
        <div className="px-3 py-2 text-[10px] text-text-secondary/70 bg-bg-dim border-t border-border-light">
          独立窗口通过 <code className="px-1 rounded bg-surface border border-border-light">BroadcastChannel</code> 与主窗口实时同步状态。
        </div>
      </div>
    </div>
  );
}
