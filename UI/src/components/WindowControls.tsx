// ─────────────────────────────────────────────────────────────────
// SoloForge 自定义窗口控件
// titleBarStyle:'hidden' (无 overlay): 系统不画按钮, 三个按钮全部自绘
// ─────────────────────────────────────────────────────────────────

import React, { useEffect, useState, useCallback } from 'react';
import { Minus, Square, Copy, X } from '../utils/icons';

const noopWindowApi = {
  minimize: () => {},
  toggleMaximize: () => Promise.resolve(false),
  close: () => {},
  isMaximized: () => Promise.resolve(false),
  onMaximizeStateChange: () => () => {},
};

function getWindowApi() {
  if (typeof window === 'undefined') return noopWindowApi;
  return (window as any).soloforge?.window || noopWindowApi;
}

export const WindowControls: React.FC = () => {
  const [isMaximized, setIsMaximized] = useState(false);
  const api = getWindowApi();

  useEffect(() => {
    let cancelled = false;
    api.isMaximized().then((v: boolean) => {
      if (!cancelled) setIsMaximized(!!v);
    }).catch(() => {});
    const off = api.onMaximizeStateChange((v: boolean) => {
      if (!cancelled) setIsMaximized(!!v);
    });
    return () => {
      cancelled = true;
      if (typeof off === 'function') off();
    };
  }, []);

  const onMinimize = useCallback(() => {
    api.minimize();
  }, [api]);

  const onToggleMaximize = useCallback(() => {
    api.toggleMaximize();
  }, [api]);

  const onClose = useCallback(() => {
    api.close();
  }, [api]);

  const btnBase: React.CSSProperties = {
    width: 46,
    height: 48,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'transparent',
    color: '#a8b0b8',
    border: 'none',
    outline: 'none',
    cursor: 'pointer',
    transition: 'background 120ms ease, color 120ms ease, transform 80ms ease',
    padding: 0,
    WebkitAppRegion: 'no-drag',
  } as React.CSSProperties;

  return (
    <div
      data-window-controls
      className="flex items-stretch shrink-0 select-none"
      style={{
        WebkitAppRegion: 'no-drag',
      } as React.CSSProperties}
    >
      <button
        type="button"
        aria-label="最小化"
        title="最小化"
        onClick={onMinimize}
        style={btnBase}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = 'rgba(255, 255, 255, 0.1)';
          e.currentTarget.style.color = '#e6ebf0';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = 'transparent';
          e.currentTarget.style.color = '#a8b0b8';
          e.currentTarget.style.transform = 'scale(1)';
        }}
        onMouseDown={(e) => { e.currentTarget.style.transform = 'scale(0.88)'; }}
        onMouseUp={(e) => { e.currentTarget.style.transform = 'scale(1)'; }}
      >
        <Minus className="w-3.5 h-3.5" strokeWidth={1.5} />
      </button>

      <button
        type="button"
        aria-label={isMaximized ? '还原' : '最大化'}
        title={isMaximized ? '还原' : '最大化'}
        onClick={onToggleMaximize}
        style={btnBase}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = 'rgba(255, 255, 255, 0.1)';
          e.currentTarget.style.color = '#e6ebf0';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = 'transparent';
          e.currentTarget.style.color = '#a8b0b8';
          e.currentTarget.style.transform = 'scale(1)';
        }}
        onMouseDown={(e) => { e.currentTarget.style.transform = 'scale(0.88)'; }}
        onMouseUp={(e) => { e.currentTarget.style.transform = 'scale(1)'; }}
      >
        {isMaximized ? <Copy className="w-[13px] h-[13px]" strokeWidth={1.5} /> : <Square className="w-[13px] h-[13px]" strokeWidth={1.5} />}
      </button>

      <button
        type="button"
        aria-label="关闭"
        title="关闭"
        onClick={onClose}
        style={btnBase}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = '#c42b1c';
          e.currentTarget.style.color = '#ffffff';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = 'transparent';
          e.currentTarget.style.color = '#a8b0b8';
          e.currentTarget.style.transform = 'scale(1)';
        }}
        onMouseDown={(e) => { e.currentTarget.style.transform = 'scale(0.88)'; }}
        onMouseUp={(e) => { e.currentTarget.style.transform = 'scale(1)'; }}
      >
        <X className="w-4 h-4" strokeWidth={1.5} />
      </button>
    </div>
  );
};

export default WindowControls;
