// ─────────────────────────────────────────────────────────────────
// SoloForge 自定义窗口控件(替代 Electron titleBarOverlay)
// 原因:Windows 11 22H2+ DWM 会对 titleBarOverlay 区域强行加暗色 tint,
//      即使设置 color: '#121414' 也会变成接近纯黑,跟我们的 --color-surface 不一致。
// 解决:完全不用 native overlay,自己用 React 画按钮,背景 100% 跟 Header 一致,
//      切换主题时也自动跟随(用 CSS 变量)。
// ─────────────────────────────────────────────────────────────────

import React, { useEffect, useState, useCallback } from 'react';
import { Minus, Square, Copy, X } from 'lucide-react';

// 浏览器(非 Electron)走 noop,不挂事件,不报错
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

  // 共享按钮基础样式
  const btnBase: React.CSSProperties = {
    width: 46,
    height: 48,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'transparent',
    color: '#a8b0b8',
    border: 'none',
    cursor: 'pointer',
    transition: 'background 120ms ease, color 120ms ease',
    padding: 0,
    // ★ 关键:控件区域不能被 header 的 -webkit-app-region: drag 捕获,
    // 否则点击不会触发 onClick,而是被 OS 当成"拖动窗口"处理
    WebkitAppRegion: 'no-drag',
  } as React.CSSProperties;

  return (
    <div
      data-window-controls
      className="flex items-stretch shrink-0 select-none"
      // 2026: 关键 — 把整个控件条从屏幕绝对右上角挪开 ~12px
      // OS 在 explorer.exe 里探测"最大化按钮区"用的就是右上角
      // ~100×48 px 的矩形;我们自己的 React 按钮只要不贴边,explorer 就
      // 不会把它当成 maximize button,snap layout popup 不会触发
      style={{
        WebkitAppRegion: 'no-drag',
        paddingRight: 8,
        marginRight: 4,
      } as React.CSSProperties}
    >
      <button
        type="button"
        aria-label="最小化"
        title="最小化"
        onClick={onMinimize}
        style={btnBase}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = 'rgba(255, 255, 255, 0.06)';
          e.currentTarget.style.color = '#e6ebf0';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = 'transparent';
          e.currentTarget.style.color = '#a8b0b8';
        }}
      >
        <Minus size={14} strokeWidth={1.5} />
      </button>

      <button
        type="button"
        aria-label={isMaximized ? '还原' : '最大化'}
        title={isMaximized ? '还原' : '最大化'}
        onClick={onToggleMaximize}
        style={btnBase}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = 'rgba(255, 255, 255, 0.06)';
          e.currentTarget.style.color = '#e6ebf0';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = 'transparent';
          e.currentTarget.style.color = '#a8b0b8';
        }}
      >
        {isMaximized ? <Copy size={13} strokeWidth={1.5} /> : <Square size={13} strokeWidth={1.5} />}
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
        }}
      >
        <X size={15} strokeWidth={1.5} />
      </button>
    </div>
  );
};

export default WindowControls;
