import { useEffect, useMemo } from 'react';
import TerminalPanel from '../TerminalPanel';
import { useChatWorkdir } from './hooks/useChatWorkdir';
import { useHotTheme } from '../../context/ThemeContext';
import { normalizeForIndex } from './service/chatWorkdirService';
import ConfirmationDock from './ConfirmationDock';

export interface TerminalPanelWithWorkdirProps {
  chatId: string;
  permissionMode?: 'normal' | 'performance' | 'expert' | 'ultimate';
}

export default function TerminalPanelWithWorkdir({
  chatId,
  permissionMode = 'normal',
}: TerminalPanelWithWorkdirProps) {
  const { workdir, entry } = useChatWorkdir(chatId);
  const { currentThemeId } = useHotTheme();
  const isLight = currentThemeId === 'light';

  const pathKey = useMemo(() => normalizeForIndex(workdir || ''), [workdir]);

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
      <TerminalPanel chatId={chatId} permissionMode={permissionMode} workdir={workdir || entry.workdir} />

      <ConfirmationDock chatId={chatId} />
    </div>
  );
}
