import { useState, useRef, useEffect, useMemo } from 'react';
import { FolderTree, RefreshCw } from '../../utils/icons';
import TerminalPanel from '../TerminalPanel';
import { useChatWorkdir } from './hooks/useChatWorkdir';
import { useHotTheme } from '../../context/ThemeContext';
import { normalizeForIndex } from './service/chatWorkdirService';
import ConfirmationDock from './ConfirmationDock';

function shortPath(p: string, maxLen = 60): string {
  if (!p) return '';
  if (p.length <= maxLen) return p;
  const sep = p.includes('\\') ? '\\' : '/';
  const parts = p.split(sep).filter(Boolean);
  if (parts.length <= 3) return p;
  return `${parts[0]}${sep}…${sep}${parts[parts.length - 2]}${sep}${parts[parts.length - 1]}`;
}

export interface TerminalPanelWithWorkdirProps {
  chatId: string;
  permissionMode?: 'normal' | 'performance' | 'expert' | 'ultimate';
}

export default function TerminalPanelWithWorkdir({
  chatId,
  permissionMode = 'normal',
}: TerminalPanelWithWorkdirProps) {
  const { workdir, entry, setWorkdir } = useChatWorkdir(chatId);
  const { currentThemeId } = useHotTheme();
  const isLight = currentThemeId === 'light';

  const [pickerOpen, setPickerOpen] = useState(false);
  const [pendingPath, setPendingPath] = useState('');
  const [errorText, setErrorText] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const displayPath = useMemo(() => shortPath(workdir || entry.workdir), [workdir, entry.workdir]);
  const pathKey = useMemo(() => normalizeForIndex(workdir || ''), [workdir]);

  useEffect(() => {
    if (pickerOpen) {
      setPendingPath(workdir || '');
      setErrorText('');
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [pickerOpen, workdir]);

  useEffect(() => {
    const handler = (ev: Event) => {
      const detail = (ev as CustomEvent<{ chatId?: string }>).detail;
      if (detail?.chatId && detail.chatId !== chatId) {
        const ev2 = new CustomEvent('soloforge-terminal-state-changed', {
          detail: { isCollapsed: true, workdir: '', chatId: detail.chatId },
        });
        window.dispatchEvent(ev2);
      }
    };
    window.addEventListener('soloforge-chat-changed', handler as EventListener);
    return () => window.removeEventListener('soloforge-chat-changed', handler as EventListener);
  }, [chatId]);

  const wrapperStyle: React.CSSProperties = {
    position: 'relative',
    borderTop: isLight ? '1px solid rgba(0,0,0,0.08)' : '1px solid rgba(255,255,255,0.06)',
    background: isLight ? 'rgba(250,250,250,0.96)' : 'rgba(15,17,21,0.96)',
  };

  return (
    <div data-chat-id={chatId} data-path-key={pathKey} style={wrapperStyle}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '4px 10px',
          borderBottom: isLight ? '1px solid rgba(0,0,0,0.06)' : '1px solid rgba(255,255,255,0.05)',
          fontSize: 11,
          color: isLight ? '#525252' : '#94a3b8',
          userSelect: 'none',
        }}
      >
        <FolderTree className="w-3 h-3" />
        <span style={{ flex: 1, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>
          {displayPath || '(尚未设置工作目录)'}
        </span>
        <button
          onClick={() => setPickerOpen((v) => !v)}
          style={{
            background: 'transparent',
            border: 'none',
            cursor: 'pointer',
            color: 'inherit',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            padding: '2px 6px',
            borderRadius: 4,
          }}
          title="切换工作目录"
          aria-label="切换工作目录"
        >
          <RefreshCw className="w-3 h-3" />
          <span>切换</span>
        </button>
      </div>

      {pickerOpen && (
        <div
          style={{
            display: 'flex',
            gap: 6,
            padding: '6px 10px',
            borderBottom: isLight ? '1px solid rgba(0,0,0,0.06)' : '1px solid rgba(255,255,255,0.05)',
            background: isLight ? 'rgba(245,245,245,0.96)' : 'rgba(20,22,28,0.96)',
          }}
        >
          <input
            ref={inputRef}
            value={pendingPath}
            onChange={(e) => setPendingPath(e.target.value)}
            placeholder="C:\Users\you\projects\foo  或  /home/you/foo"
            spellCheck={false}
            style={{
              flex: 1,
              padding: '4px 8px',
              fontSize: 12,
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
              borderRadius: 4,
              border: isLight ? '1px solid rgba(0,0,0,0.12)' : '1px solid rgba(255,255,255,0.12)',
              background: 'transparent',
              color: isLight ? '#111' : '#e5e7eb',
              outline: 'none',
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                try {
                  setWorkdir(pendingPath.trim(), { source: 'manual' });
                  setErrorText('');
                  setPickerOpen(false);
                } catch (err: any) {
                  setErrorText(err?.message ?? String(err));
                }
              } else if (e.key === 'Escape') {
                setPickerOpen(false);
              }
            }}
          />
          <button
            onClick={async () => {
              try {
                const dirHandle = await (window as any).showDirectoryPicker?.();
                if (dirHandle) {
                  const path = await dirHandle.name;
                  setWorkdir(path, { source: 'manual' });
                  setPickerOpen(false);
                }
              } catch {
                /* user cancel */
              }
            }}
            style={{
              padding: '4px 10px',
              fontSize: 12,
              borderRadius: 4,
              border: isLight ? '1px solid rgba(0,0,0,0.12)' : '1px solid rgba(255,255,255,0.12)',
              background: 'transparent',
              cursor: 'pointer',
              color: 'inherit',
            }}
          >
            选目录
          </button>
          {errorText && (
            <span style={{ color: '#f87171', fontSize: 11, alignSelf: 'center' }}>{errorText}</span>
          )}
        </div>
      )}

      <TerminalPanel permissionMode={permissionMode} />

      <ConfirmationDock chatId={chatId} />
    </div>
  );
}
