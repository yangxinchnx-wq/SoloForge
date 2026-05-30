// ─────────────────────────────────────────────────────────────────
// SoloForge Theme Context
// 主题上下文 - 支持主题热切换
// ─────────────────────────────────────────────────────────────────

import React, { createContext, useContext, useState, useCallback, ReactNode } from 'react';

export interface ThemeConfig {
  name: string;
  path: string;
  colors: {
    bgPrimary: string;
    bgSecondary: string;
    bgTertiary: string;
    textPrimary: string;
    textSecondary: string;
    accentBlue: string;
    accentGreen: string;
    accentRed: string;
    accentYellow: string;
    borderColor: string;
  };
}

// 可用主题列表
export const AVAILABLE_THEMES: Record<string, ThemeConfig> = {
  'default-dark': {
    name: '默认深色主题',
    path: '..',  // 相对于 app/ 目录的路径
    colors: {
      bgPrimary: '#0d1117',
      bgSecondary: '#161b22',
      bgTertiary: '#21262d',
      textPrimary: '#c9d1d9',
      textSecondary: '#8b949e',
      accentBlue: '#58a6ff',
      accentGreen: '#3fb950',
      accentRed: '#f85149',
      accentYellow: '#d29922',
      borderColor: '#30363d'
    }
  }
};

interface ThemeContextType {
  currentTheme: ThemeConfig;
  setTheme: (themeName: string) => void;
  availableThemes: string[];
  iconsPath: string;
  emojisPath: string;
  decorationsPath: string;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

interface ThemeProviderProps {
  children: ReactNode;
  initialTheme?: string;
}

export function ThemeProvider({ children, initialTheme = 'default-dark' }: ThemeProviderProps) {
  const [currentThemeName, setCurrentThemeName] = useState(initialTheme);

  const currentTheme = AVAILABLE_THEMES[currentThemeName] || AVAILABLE_THEMES['default-dark'];

  const setTheme = useCallback((themeName: string) => {
    if (AVAILABLE_THEMES[themeName]) {
      setCurrentThemeName(themeName);
      console.log(`[Theme] 切换到主题: ${AVAILABLE_THEMES[themeName].name}`);
    }
  }, []);

  const value: ThemeContextType = {
    currentTheme,
    setTheme,
    availableThemes: Object.keys(AVAILABLE_THEMES),
    iconsPath: `${currentTheme.path}/icons`,
    emojisPath: `${currentTheme.path}/emojis`,
    decorationsPath: `${currentTheme.path}/decorations`
  };

  return (
    <ThemeContext.Provider value={value}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextType {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error('useTheme 必须在 ThemeProvider 内使用');
  }
  return context;
}

export default ThemeContext;
