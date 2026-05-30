// ─────────────────────────────────────────────────────────────────
// SoloForge ActionIcon Component
// 操作图标组件
// ─────────────────────────────────────────────────────────────────

import React from 'react';
import { useTheme } from './theme-context';

type ActionType = 'add' | 'edit' | 'delete' | 'refresh' | 'play' | 'stop' | 'save' | 'cancel' | 'confirm' | 'send' | 'download' | 'upload';

interface ActionIconProps {
  action: ActionType;
  size?: number;
  className?: string;
  disabled?: boolean;
}

const ACTION_ICON_MAP: Record<ActionType, string> = {
  'add': 'add.svg',
  'edit': 'edit.svg',
  'delete': 'delete.svg',
  'refresh': 'refresh.svg',
  'play': 'play.svg',
  'stop': 'stop.svg',
  'save': 'save.svg',
  'cancel': 'cancel.svg',
  'confirm': 'confirm.svg',
  'send': 'send.svg',
  'download': 'download.svg',
  'upload': 'upload.svg'
};

// 内联 SVG 备用图标
const INLINE_ICONS: Record<ActionType, React.ReactNode> = {
  'add': <svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>,
  'edit': <svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>,
  'delete': <svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>,
  'refresh': <svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg>,
  'play': <svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M8 5v14l11-7z"/></svg>,
  'stop': <svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M6 6h12v12H6z"/></svg>,
  'save': <svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M17 3H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V7l-4-4zm-5 16c-1.66 0-3-1.34-3-3s1.34-3 3-3 3 1.34 3 3-1.34 3-3 3zm3-10H5V5h10v4z"/></svg>,
  'cancel': <svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M12 2C6.47 2 2 6.47 2 12s4.47 10 10 10 10-4.47 10-10S17.53 2 12 2zm5 13.59L15.59 17 12 13.41 8.41 17 7 15.59 10.59 12 7 8.41 8.41 7 12 10.59 15.59 7 17 8.41 13.41 12 17 15.59z"/></svg>,
  'confirm': <svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>,
  'send': <svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>,
  'download': <svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>,
  'upload': <svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M9 16h6v-6h4l-7-7-7 7h4v6zm-4 2h14v2H5v-2z"/></svg>
};

export function ActionIcon({ action, size = 24, className, disabled = false }: ActionIconProps) {
  const { iconsPath } = useTheme();

  const iconFile = ACTION_ICON_MAP[action];

  const style: React.CSSProperties = {
    width: size,
    height: size,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    opacity: disabled ? 0.5 : 1,
    cursor: disabled ? 'not-allowed' : 'pointer',
    transition: 'opacity 0.2s'
  };

  if (iconFile) {
    return (
      <div style={style} className={className}>
        <img
          src={`${iconsPath}/actions/${iconFile}`}
          alt={action}
          width={size}
          height={size}
          style={{ objectFit: 'contain' }}
        />
      </div>
    );
  }

  return (
    <div style={style} className={className}>
      {INLINE_ICONS[action]}
    </div>
  );
}

export default ActionIcon;
