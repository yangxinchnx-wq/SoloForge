// ─────────────────────────────────────────────────────────────────
// ThemeProvider — 热替换主题引擎
//
// 原理：
//   1. 主题 = ThemeTokens 对象（纯数据）
//   2. 切换时将 tokens 映射为 CSS 变量注入 <html> 根节点
//   3. Tailwind 的颜色映射 var(--color-xxx)，变量一换全局跟着变
//   4. 零页面刷新、零重新渲染，纯 DOM 操作 < 1ms
// ─────────────────────────────────────────────────────────────────

import React, { createContext, useContext, useState, useCallback, useEffect, type ReactNode } from 'react';
import { type Theme, type ThemeTokens } from './types';
import { themes, themesMap, defaultDark } from './themes';

// tokens → CSS 变量映射规则
const TOKEN_TO_CSS_VAR: Record<keyof ThemeTokens, string> = {
  bg:                    '--color-bg',
  bgDim:                 '--color-bg-dim',
  surface:               '--color-surface',
  surfaceLow:            '--color-surface-low',
  surfaceHigh:           '--color-surface-high',
  primary:               '--color-primary',
  onPrimary:             '--color-on-primary',
  primaryContainer:      '--color-primary-container',
  onPrimaryContainer:    '--color-on-primary-container',
  text:                  '--color-text',
  textSecondary:         '--color-text-secondary',
  border:                '--color-border',
  borderLight:           '--color-border-light',
  accent:                '--color-accent',
  success:               '--color-success',
  warning:               '--color-warning',
  danger:                '--color-danger',
};

/** 将主题 tokens 写入 <html> 的 CSS 变量 */
function applyThemeTokens(tokens: ThemeTokens): void {
  const root = document.documentElement;
  for (const [key, cssVar] of Object.entries(TOKEN_TO_CSS_VAR)) {
    root.style.setProperty(cssVar, tokens[key as keyof ThemeTokens]);
  }
  // 同步 Tailwind dark mode class
  const isDark = isDarkTheme(tokens);
  root.classList.toggle('dark', isDark);
  root.classList.toggle('light', !isDark);
}

/** 根据背景色亮度判断是否深色 */
function isDarkTheme(tokens: ThemeTokens): boolean {
  const hex = tokens.bg.replace('#', '');
  const r = parseInt(hex.substring(0, 2), 16);
  const g = parseInt(hex.substring(2, 4), 16);
  const b = parseInt(hex.substring(4, 6), 16);
  return (r * 299 + g * 587 + b * 114) / 1000 < 128;
}

// ─── Context ───

interface ThemeContextValue {
  current: Theme;
  themeList: Theme[];
  setTheme: (id: string) => void;
  /** 实时调整个别 token (颜色 / 间距等) — 不切换主题 */
  customizeToken: <K extends keyof ThemeTokens>(key: K, value: string) => void;
  /** 批量覆盖 tokens */
  customizeTokens: (patch: Partial<ThemeTokens>) => void;
  /** 重置当前主题为默认 */
  resetCustom: () => void;
  /** 是否有自定义修改 */
  isCustomized: boolean;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

const CUSTOM_KEY = 'soloforge.theme.custom.v1';

// ─── Provider ───

interface ThemeProviderProps {
  defaultThemeId?: string;
  children: ReactNode;
}

export function ThemeProvider({ defaultThemeId = 'default-dark', children }: ThemeProviderProps) {
  const [baseId, setBaseId] = useState<string>(() => {
    const saved = typeof localStorage !== 'undefined' ? localStorage.getItem('soloforge-theme') : null;
    return saved || defaultThemeId;
  });

  // 加载已保存的 custom 覆盖
  const [custom, setCustom] = useState<Partial<ThemeTokens>>(() => {
    if (typeof localStorage === 'undefined') return {};
    try {
      const raw = localStorage.getItem(CUSTOM_KEY);
      if (raw) return JSON.parse(raw);
    } catch { /* ignore */ }
    return {};
  });

  const baseTheme = themesMap[baseId] || defaultDark;
  const merged: Theme = {
    ...baseTheme,
    tokens: { ...baseTheme.tokens, ...custom },
  };
  const isCustomized = Object.keys(custom).length > 0;

  // 初始化 + 切换时注入 CSS 变量
  useEffect(() => {
    applyThemeTokens(merged.tokens);
  }, [merged]);

  // 持久化 custom 覆盖
  useEffect(() => {
    if (typeof localStorage === 'undefined') return;
    if (Object.keys(custom).length === 0) {
      localStorage.removeItem(CUSTOM_KEY);
    } else {
      localStorage.setItem(CUSTOM_KEY, JSON.stringify(custom));
    }
  }, [custom]);

  const setTheme = useCallback((id: string) => {
    const next = themesMap[id];
    if (!next) {
      console.warn(`[Theme] 未知主题: ${id}`);
      return;
    }
    setBaseId(id);
    setCustom({}); // 切换主题时清空 custom
    localStorage.setItem('soloforge-theme', id);
  }, []);

  const customizeToken = useCallback(<K extends keyof ThemeTokens>(key: K, value: string) => {
    setCustom(prev => ({ ...prev, [key]: value }));
  }, []);

  const customizeTokens = useCallback((patch: Partial<ThemeTokens>) => {
    setCustom(prev => ({ ...prev, ...patch }));
  }, []);

  const resetCustom = useCallback(() => {
    setCustom({});
  }, []);

  return (
    <ThemeContext.Provider
      value={{
        current: merged,
        themeList: themes,
        setTheme,
        customizeToken,
        customizeTokens,
        resetCustom,
        isCustomized,
      }}
    >
      {children}
    </ThemeContext.Provider>
  );
}

// ─── Hook ───

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme 必须在 ThemeProvider 内使用');
  return ctx;
}
