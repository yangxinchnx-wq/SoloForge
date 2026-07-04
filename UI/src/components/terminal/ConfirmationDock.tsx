/**
 * ConfirmationDock — 待 AI 触发的命令, 用户在此决定
 *
 * - 渲染位置: TerminalPanelWithWorkdir 顶部 (theme 自适应)
 * - 数据源: useConfirmQueueStore.snapshot(activeChatId) + 全局队列长度
 * - 行为:
 *     allow-once     → resolve(id, 'allow-once')
 *     allow-for-chat → resolve(id, 'allow-for-chat')
 *     deny           → resolve(id, 'deny')
 */
import { useEffect, useRef, useState } from 'react';
import { Check, ShieldAlert, ShieldCheck, XCircle } from 'lucide-react';
import { useConfirmQueueStore, type PendingCommand } from './store/confirmQueueStore';
import { useHotTheme } from '../../context/ThemeContext';

const EVT_FOCUS = 'soloforge-confirm-focus';

export interface ConfirmationDockProps {
  chatId: string;
}

const REASON_LABEL: Record<string, string> = {
  '写盘/安装': '✎',
  '网络外发': '⤴',
  '硬拦截': '⛔',
  '未识别': '?',
  '只读': '□',
};

export default function ConfirmationDock({ chatId }: ConfirmationDockProps) {
  const queue = useConfirmQueueStore((s) => s.queue);
  const resolve = useConfirmQueueStore((s) => s.resolve);
  const remove = useConfirmQueueStore((s) => s.remove);
  const { currentThemeId } = useHotTheme();
  const isLight = currentThemeId === 'light';
  const rootRef = useRef<HTMLDivElement>(null);
  const [pulse, setPulse] = useState(false);

  useEffect(() => {
    if (!pulse) return;
    const t = setTimeout(() => setPulse(false), 1200);
    return () => clearTimeout(t);
  }, [pulse]);

  useEffect(() => {
    const handler = (ev: Event) => {
      const detail = (ev as CustomEvent<{ chatId?: string }>).detail;
      if (detail?.chatId && detail.chatId !== chatId) return;
      const node = rootRef.current;
      if (!node) return;
      node.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      setPulse(true);
    };
    window.addEventListener(EVT_FOCUS, handler as EventListener);
    return () => window.removeEventListener(EVT_FOCUS, handler as EventListener);
  }, [chatId]);

  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => (t + 1) % 1e9), 1000);
    return () => clearInterval(id);
  }, []);

  const pending = queue.filter((q) => q.chatId === chatId && q.resolution === 'pending');
  const total = queue.filter((q) => q.resolution === 'pending').length;

  if (pending.length === 0 && total === 0) return null;

  const wrap: React.CSSProperties = {
    borderBottom: isLight ? '1px solid rgba(220,38,38,0.3)' : '1px solid rgba(248,113,113,0.25)',
    background: isLight ? 'rgba(254,242,242,0.96)' : 'rgba(40,18,18,0.65)',
    padding: '6px 10px',
    fontSize: 12,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    color: isLight ? '#7f1d1d' : '#fecaca',
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
  };

  const row: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '6px 8px',
    borderRadius: 6,
    background: isLight ? 'rgba(255,255,255,0.7)' : 'rgba(0,0,0,0.35)',
  };

  const btn: React.CSSProperties = {
    border: 'none',
    padding: '3px 8px',
    fontSize: 11,
    borderRadius: 4,
    cursor: 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    background: 'transparent',
  };

  return (
    <div
      ref={rootRef}
      data-confirm-dock="1"
      style={{
        ...wrap,
        ...(pulse
          ? {
              boxShadow: isLight
                ? '0 0 0 2px rgba(220,38,38,0.5), 0 0 16px rgba(220,38,38,0.25)'
                : '0 0 0 2px rgba(248,113,113,0.55), 0 0 16px rgba(248,113,113,0.3)',
              transition: 'box-shadow 280ms ease-out',
            }
          : { transition: 'box-shadow 600ms ease-in' }),
      }}
      role="region"
      aria-label="AI 命令待确认"
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 600 }}>
        <ShieldAlert size={14} />
        <span>
          等待确认 ({pending.length}/{total})
          {total > pending.length ? ' · 其它会话 ' + (total - pending.length) : ''}
        </span>
      </div>
      {pending.map((q) => (
        <PendingRow
          key={q.id}
          item={q}
          isLight={isLight}
          onAllowOnce={() => resolve(q.id, 'allow-once')}
          onAllowChat={() => resolve(q.id, 'allow-for-chat')}
          onDeny={() => resolve(q.id, 'deny')}
          btn={btn}
          rowStyle={row}
          onClearChatHistory={() => remove(chatId)}
        />
      ))}
    </div>
  );
}

interface PendingRowProps {
  item: PendingCommand;
  isLight: boolean;
  rowStyle: React.CSSProperties;
  btn: React.CSSProperties;
  onAllowOnce: () => void;
  onAllowChat: () => void;
  onDeny: () => void;
  onClearChatHistory: () => void;
}

function PendingRow({ item, isLight, rowStyle, btn, onAllowOnce, onAllowChat, onDeny, onClearChatHistory }: PendingRowProps) {
  const firstLine = item.command.split('\n')[0];
  const icon = REASON_LABEL[item.decision.label] ?? '·';
  const tone = item.decision.risk === 'deny' ? '#dc2626' : item.decision.risk === 'mutate' ? '#d97706' : '#64748b';

  return (
    <div style={rowStyle}>
      <span style={{ color: tone, fontWeight: 600, width: 18 }}>{icon}</span>
      <span style={{ flex: 1, color: isLight ? '#0f172a' : '#f8fafc', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        $ {firstLine}
      </span>
      <span style={{ color: isLight ? '#6b7280' : '#94a3b8', fontSize: 10 }}>
        [{item.decision.label}]
      </span>
      <button style={{ ...btn, color: isLight ? '#047857' : '#34d399' }} onClick={onAllowOnce} title="本次放行">
        <Check size={12} /> 放行
      </button>
      <button style={{ ...btn, color: isLight ? '#0e7490' : '#22d3ee' }} onClick={onAllowChat} title="本会话永不再问">
        <ShieldCheck size={12} /> 永不再问
      </button>
      <button style={{ ...btn, color: isLight ? '#b91c1c' : '#f87171' }} onClick={onDeny} title="拒绝">
        <XCircle size={12} /> 拒绝
      </button>
      <button style={{ ...btn, color: isLight ? '#6b7280' : '#94a3b8' }} onClick={onClearChatHistory} title="清空本会话全部待确认">
        清空
      </button>
    </div>
  );
}
