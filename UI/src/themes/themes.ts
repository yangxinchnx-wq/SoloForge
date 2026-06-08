// ─────────────────────────────────────────────────────────────────
// 主题注册表
// 新增主题：只需在这里加一个 Theme 对象，无需改任何组件代码
// ─────────────────────────────────────────────────────────────────

import { Theme } from './types';

// ─── 暗金（默认深色） ───
export const defaultDark: Theme = {
  id: 'default-dark',
  name: '暗金',
  tokens: {
    bg:             '#121414',
    bgDim:          '#0d0e0f',
    surface:        '#1e2020',
    surfaceLow:     '#1a1c1c',
    surfaceHigh:    '#292a2a',
    primary:        '#e7c35a',
    onPrimary:      '#3d2f00',
    primaryContainer:    '#e5c158',
    onPrimaryContainer:  '#241a00',
    text:           '#e3e2e2',
    textSecondary:  '#99907d',
    border:         '#4d4636',
    borderLight:    '#343535',
    accent:         '#58a6ff',
    success:        '#3fb950',
    warning:        '#d29922',
    danger:         '#f85149',
  },
};

// ─── 深海（蓝调深色） ───
export const oceanDark: Theme = {
  id: 'ocean-dark',
  name: '深海',
  tokens: {
    bg:             '#0d1117',
    bgDim:          '#010409',
    surface:        '#161b22',
    surfaceLow:     '#0d1117',
    surfaceHigh:    '#21262d',
    primary:        '#58a6ff',
    onPrimary:      '#ffffff',
    primaryContainer:    '#1f6feb',
    onPrimaryContainer:  '#dbe9ff',
    text:           '#c9d1d9',
    textSecondary:  '#8b949e',
    border:         '#30363d',
    borderLight:    '#21262d',
    accent:         '#bc8cff',
    success:        '#3fb950',
    warning:        '#d29922',
    danger:         '#f85149',
  },
};

// ─── 晨光（浅色主题） ───
export const morningLight: Theme = {
  id: 'morning-light',
  name: '晨光',
  tokens: {
    bg:             '#ffffff',
    bgDim:          '#f5f5f5',
    surface:        '#ffffff',
    surfaceLow:     '#f9fafb',
    surfaceHigh:    '#f3f4f6',
    primary:        '#d97706',
    onPrimary:      '#ffffff',
    primaryContainer:    '#fef3c7',
    onPrimaryContainer:  '#92400e',
    text:           '#111827',
    textSecondary:  '#6b7280',
    border:         '#e5e7eb',
    borderLight:    '#f3f4f6',
    accent:         '#2563eb',
    success:        '#059669',
    warning:        '#d97706',
    danger:         '#dc2626',
  },
};

// ─── 紫晶（紫色调深色） ───
export const amethyst: Theme = {
  id: 'amethyst',
  name: '紫晶',
  tokens: {
    bg:             '#13111c',
    bgDim:          '#0e0c15',
    surface:        '#1d1a2e',
    surfaceLow:     '#171425',
    surfaceHigh:    '#2a2640',
    primary:        '#c084fc',
    onPrimary:      '#1a0033',
    primaryContainer:    '#7c3aed',
    onPrimaryContainer:  '#ede9fe',
    text:           '#e2e0f0',
    textSecondary:  '#9892a6',
    border:         '#3d3760',
    borderLight:    '#2a2640',
    accent:         '#f472b6',
    success:        '#34d399',
    warning:        '#fbbf24',
    danger:         '#fb7185',
  },
};

// ─── 主题注册表 ───
export const themes: Theme[] = [
  defaultDark,
  oceanDark,
  morningLight,
  amethyst,
];

export const themesMap = Object.fromEntries(themes.map(t => [t.id, t]));
