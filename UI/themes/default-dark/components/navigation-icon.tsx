// ─────────────────────────────────────────────────────────────────
// SoloForge NavigationIcon Component
// 导航图标组件
// ─────────────────────────────────────────────────────────────────

import React from 'react';
import { useTheme } from './theme-context';

interface NavigationIconProps {
  name: string;
  size?: number;
  className?: string;
  alt?: string;
}

// 导航图标映射
const NAV_ICON_MAP: Record<string, string> = {
  'dashboard': 'dashboard.svg',
  'database': 'database.svg',
  'scheduler': 'scheduler.svg',
  'events': 'events.svg',
  'observation': 'observation.svg',  // 文明观测占位
  'settings': 'settings.svg',
  'home': 'home.svg',
  'user': 'user.svg',
  'search': 'search.svg',
  'menu': 'menu.svg',
  'close': 'close.svg',
  'back': 'back.svg',
  'forward': 'forward.svg',
  'up': 'up.svg',
  'down': 'down.svg',
};

export function NavigationIcon({ name, size = 20, className, alt }: NavigationIconProps) {
  const { iconsPath } = useTheme();

  const iconFile = NAV_ICON_MAP[name] || `${name}.svg`;

  return (
    <img
      src={`${iconsPath}/navigation/${iconFile}`}
      alt={alt || name}
      width={size}
      height={size}
      className={className}
      style={{ objectFit: 'contain' }}
    />
  );
}

export default NavigationIcon;
