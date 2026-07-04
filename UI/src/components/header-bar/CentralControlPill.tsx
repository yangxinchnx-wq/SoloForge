/**
 * CentralControlPill — 顶部中央"主模型 / 混合任务 / 副模型"集合胶囊
 *
 * 2026-07-02 主题色对齐:
 *   - 玻璃表面 / 金边 alpha / 内阴影全部走 useThemedSurface(),
 *     深色主题 vs 浅色主题自动切换
 *   - 金边颜色仍消费 --color-primary-rgb, 但 alpha 由 isDark 决定
 *
 * 设计原则(沿用):
 *   - 单一胶囊容器, 统一处理 draggable (默认 data-no-drag 内的 children 可点击)
 *   - children 自由组合, 不耦合具体业务组件
 *   - 暴露 open (模型菜单/副模型菜单展开) 控制 z-index
 */

import React, { memo } from 'react';
import { useThemedSurface } from './themeColors';

export interface CentralControlPillProps {
  /** 相对 sidebar 的左偏移, 形如 "clamp(...)" */
  leftPosition: string;
  /** sidebar 拖动中: 禁用 left transition, 避免抖动 */
  isResizing?: boolean;
  /** 是否有任何下拉打开, true 时 z-index 升到 50 */
  hasOpenDropdown?: boolean;
  /** 内部内容: 主模型选择器 / 副模型 / 混合开关等 */
  children: React.ReactNode;
}

function CentralControlPillImpl({
  leftPosition,
  isResizing = false,
  hasOpenDropdown = false,
  children,
}: CentralControlPillProps) {
  const { glass, isDark } = useThemedSurface();
  // 把 alpha 解析成 rgba 字符串
  const hairline = `rgba(var(--color-primary-rgb), ${glass.hairlineAlpha})`;
  const hairlineHover = `rgba(var(--color-primary-rgb), ${glass.hairlineHoverAlpha})`;
  const haloColor = `rgba(var(--color-primary-rgb), ${isDark ? 0.18 : 0.14})`;
  const haloColorHover = `rgba(var(--color-primary-rgb), ${isDark ? 0.25 : 0.18})`;
  // 阴影三件套(动态): 浅色主题顶部 inset highlight 改用白 0.55
  const topHighlightAlpha = isDark ? 'rgba(255,255,255,0.07)' : 'rgba(255,255,255,0.55)';
  const topHighlightAlphaHover = isDark ? 'rgba(255,255,255,0.10)' : 'rgba(255,255,255,0.65)';
  const bottomShadeAlpha = isDark ? 'rgba(0,0,0,0.30)' : 'rgba(0,0,0,0.06)';
  const ambientHover = isDark
    ? '0 12px 36px rgba(0,0,0,0.36)'
    : '0 8px 22px rgba(0,0,0,0.08)';

  const baseShadow = [
    glass.ambientShadow,
    glass.tightShadow,
    `inset 0 1px 0 ${topHighlightAlpha}`,
    `inset 0 -1px 0 ${bottomShadeAlpha}`,
  ].join(', ');
  const hoverShadow = [
    ambientHover,
    glass.tightShadow,
    `inset 0 1px 0 ${topHighlightAlphaHover}`,
    `inset 0 -1px 0 ${bottomShadeAlpha}`,
    `0 0 0 1px ${haloColor}`,
  ].join(', ');

  return (
    <div
      data-no-drag
      className={`absolute top-1/2 -translate-y-1/2 flex items-center overflow-visible transition-all duration-200 ease-out ${
        hasOpenDropdown ? 'z-50' : 'z-20'
      }`}
      style={{
        left: leftPosition,
        height: 42,
        padding: '0 18px',
        gap: 14,
        background: glass.surfaceGradient,
        backdropFilter: 'blur(14px) saturate(140%)',
        WebkitBackdropFilter: 'blur(14px) saturate(140%)',
        border: `1px solid ${hairline}`,
        borderTop: `1px solid ${hairlineHover}`,
        borderRadius: 14,
        boxShadow: baseShadow,
        // 拖动期间不动画 left/width, 避免抖动
        transition: isResizing
          ? 'none'
          : 'left 250ms cubic-bezier(0.4, 0, 0.2, 1), width 350ms cubic-bezier(0.4, 0, 0.2, 1), box-shadow 200ms ease-out, border-color 200ms ease-out',
        fontFamily: 'var(--font-sans)',
        fontSize: 13,
      } as React.CSSProperties}
      onMouseEnter={(e) => {
        if (hasOpenDropdown) return;
        e.currentTarget.style.borderColor = hairlineHover;
        e.currentTarget.style.boxShadow = [
          isDark ? glass.ambientShadow : '0 8px 22px rgba(0,0,0,0.08)',
          glass.tightShadow,
          `inset 0 1px 0 ${topHighlightAlpha}`,
          `inset 0 -1px 0 ${bottomShadeAlpha}`,
          `0 0 0 1px ${haloColor}`,
        ].join(', ');
      }}
      onMouseLeave={(e) => {
        if (hasOpenDropdown) return;
        e.currentTarget.style.borderColor = hairline;
        e.currentTarget.style.boxShadow = baseShadow;
      }}
    >
      {children}
    </div>
  );
}

export const CentralControlPill = memo(CentralControlPillImpl);
CentralControlPill.displayName = 'CentralControlPill';