import React, { createContext, useContext, useState, useEffect, useRef, useMemo } from 'react';
import { ThemePreset } from '../types';

export const THEME_PRESETS: ThemePreset[] = [
  {
    id: 'light',
    name: '护眼浅色 (Warm Light)',
    bg: '#f1ede4',         // 科学滤蓝光温润米白底色
    surface: '#fbf9f5',    // 视网膜减眩光抗疲劳象牙白
    surfaceBright: '#e4decb', // 舒适柔和分割过渡色
    primary: '#0d5d91',    // 降荧光高 legible 专业深蓝
    onSurface: '#1f2022',  // 漫反射低发光度墨炭黑
    outline: '#d8cfbe'     // 护眼低反差柔和边框
  },
  {
    id: 'dark',
    name: '深色模式 (Dark)',
    bg: '#1e1e1e',
    surface: '#252526',
    surfaceBright: '#2d2d30',
    primary: '#007acc',
    onSurface: '#d4d4d4',
    outline: '#3c3c3c'
  },
  {
    id: 'gruvbox',
    name: '黄金时代 (Gruvbox)',
    bg: '#141617',
    surface: '#1d2021',
    surfaceBright: '#2c2927',
    primary: '#fabd2f',
    onSurface: '#ebdbb2',
    outline: '#504945'
  },
  {
    id: 'cyberpunk',
    name: '赛博霓虹 (Cyberpunk)',
    bg: '#0a0512',
    surface: '#120b24',
    surfaceBright: '#1d123a',
    primary: '#ff007f',
    onSurface: '#e2e0e7',
    outline: '#361b5c'
  },
  {
    id: 'nord',
    name: '北欧冰霜 (Nord Frost)',
    bg: '#232831',
    surface: '#2e3440',
    surfaceBright: '#3b4252',
    primary: '#88c0d0',
    onSurface: '#eceff4',
    outline: '#434c5e'
  },
  {
    id: 'sakura',
    name: '浪漫樱花 (Sakura Garden)',
    bg: '#1c1316',
    surface: '#261b20',
    surfaceBright: '#35252c',
    primary: '#ff79c6',
    onSurface: '#faeff3',
    outline: '#4a2b37'
  }
];

export interface SyntaxThemePreset {
  id: string;
  name: string;
  isDark: boolean;
  bg: string;
  surface: string;
  surfaceBright: string;
  onSurface: string;
  outline: string;
  syntaxString: string;
  syntaxType: string;
  syntaxNumber: string;
}

export const SYNTAX_THEMES: SyntaxThemePreset[] = [
  {
    id: 'auto',
    name: '跟随应用主题 (Sync UI Theme)',
    isDark: true,
    bg: '',
    surface: '',
    surfaceBright: '',
    onSurface: '',
    outline: '',
    syntaxString: '',
    syntaxType: '',
    syntaxNumber: ''
  },
  {
    id: 'light',
    name: '护眼温和浅色 (Warm Light)',
    isDark: false,
    bg: '#fbf9f5',
    surface: '#f1ede4',
    surfaceBright: '#e4decb',
    onSurface: '#1f2022',
    outline: '#d8cfbe',
    syntaxString: '#a31515',
    syntaxType: '#267f99',
    syntaxNumber: '#098658'
  },
  {
    id: 'dark',
    name: '经典暗色 (VS Code Dark)',
    isDark: true,
    bg: '#1e1e1e',
    surface: '#252526',
    surfaceBright: '#2d2d30',
    onSurface: '#d4d4d4',
    outline: '#3c3c3c',
    syntaxString: '#ce9178',
    syntaxType: '#4ec9b0',
    syntaxNumber: '#b5cea8'
  },
  {
    id: 'gruvbox',
    name: '极客复古 (Gruvbox Retro)',
    isDark: true,
    bg: '#1d2021',
    surface: '#141617',
    surfaceBright: '#2c2927',
    onSurface: '#ebdbb2',
    outline: '#504945',
    syntaxString: '#b8bb26',
    syntaxType: '#fe8019',
    syntaxNumber: '#d3869b'
  },
  {
    id: 'cyberpunk',
    name: '赛博霓虹 (Cyberpunk Neon)',
    isDark: true,
    bg: '#120b24',
    surface: '#0a0512',
    surfaceBright: '#1d123a',
    onSurface: '#e2e0e7',
    outline: '#361b5c',
    syntaxString: '#00ffcc',
    syntaxType: '#ff00ff',
    syntaxNumber: '#ffff00'
  },
  {
    id: 'nord',
    name: '北欧雪洁 (Nordic Frost)',
    isDark: true,
    bg: '#2e3440',
    surface: '#232831',
    surfaceBright: '#3b4252',
    onSurface: '#eceff4',
    outline: '#434c5e',
    syntaxString: '#a3be8c',
    syntaxType: '#8fbcbb',
    syntaxNumber: '#b48ead'
  },
  {
    id: 'sakura',
    name: '春日绯樱 (Sakura Garden)',
    isDark: true,
    bg: '#261b20',
    surface: '#1c1316',
    surfaceBright: '#35252c',
    onSurface: '#faeff3',
    outline: '#4a2b37',
    syntaxString: '#f368e0',
    syntaxType: '#ff9f43',
    syntaxNumber: '#ff4757'
  }
];

export interface CustomFont {
  name: string;
  url?: string;
  isPreset?: boolean;
}

export const PRESET_FONTS: CustomFont[] = [
  { name: '默认 (Default)', url: '', isPreset: true }
];

interface ThemeColorTargets {
  activityBar: boolean;
  skillBar: boolean;
  header: boolean;
  chatPanel: boolean;
  editorAndExplorer: boolean;
  statusBar: boolean;
}

interface ThemeContextType {
  primaryColor: string;
  primaryColorTargets: ThemeColorTargets;
  currentThemeId: string;
  activeTheme: ThemePreset;
  syntaxThemeId: string;
  customFonts: CustomFont[];
  selectedFont: string;
  setSyntaxThemeId: (id: string) => void;
  setPrimaryColor: (color: string) => void;
  setPrimaryColorTargets: React.Dispatch<React.SetStateAction<ThemeColorTargets>>;
  setCurrentThemeId: (id: string) => void;
  syncTheme: (themeId: string, color: string, targets: ThemeColorTargets) => void;
  addCustomFont: (name: string, url?: string) => void;
  deleteCustomFont: (name: string) => void;
  setSelectedFont: (name: string) => void;
}

export const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

const getRGBNumbers = (color: string): string => {
  let cleanHex = color.trim().replace('#', '');
  if (cleanHex.length === 3) {
    cleanHex = cleanHex.split('').map(char => char + char).join('');
  }
  if (cleanHex.length !== 6) return '255, 222, 130';
  const num = parseInt(cleanHex, 16);
  return `${(num >> 16) & 255}, ${(num >> 8) & 255},  ${num & 255}`;
};

export const ThemeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [currentThemeId, setCurrentThemeIdState] = useState(() => {
    if (typeof window !== 'undefined') {
      const stored = localStorage.getItem('soloforge_themeId');
      if (stored) return stored;
      
      // Auto-detect system preferred color scheme for first-time entries
      try {
        const prefersLight = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches;
        return prefersLight ? 'light' : 'gruvbox';
      } catch (e) {
        return 'gruvbox';
      }
    }
    return 'gruvbox';
  });

  const [customColors, setCustomColors] = useState<Record<string, string>>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('soloforge_customColors');
      if (saved) {
        try {
          return JSON.parse(saved);
        } catch (e) {}
      }
    }
    return {};
  });

  const [primaryColor, setPrimaryColorState] = useState(() => {
    if (typeof window !== 'undefined') {
      const storedThemeId = localStorage.getItem('soloforge_themeId');
      let savedThemeId = storedThemeId || 'gruvbox';
      if (!storedThemeId) {
        try {
          const prefersLight = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches;
          savedThemeId = prefersLight ? 'light' : 'gruvbox';
        } catch (e) {}
      }
      const savedCustomColors = localStorage.getItem('soloforge_customColors');
      if (savedCustomColors) {
        try {
          const parsed = JSON.parse(savedCustomColors);
          if (parsed[savedThemeId]) {
            return parsed[savedThemeId].toLowerCase();
          }
        } catch (e) {}
      }
      const legacyColor = localStorage.getItem('soloforge_primaryColor');
      if (legacyColor && storedThemeId) {
        return legacyColor.toLowerCase();
      }
      const preset = THEME_PRESETS.find(t => t.id === savedThemeId) || THEME_PRESETS[0];
      return preset.primary.toLowerCase();
    }
    return '#fabd2f';
  });

  const [primaryColorTargets, setPrimaryColorTargets] = useState<ThemeColorTargets>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('soloforge_primaryColorTargets');
      if (saved) {
        try {
          return JSON.parse(saved);
        } catch (e) {}
      }
    }
    return {
      activityBar: true,
      skillBar: true,
      header: true,
      chatPanel: true,
      editorAndExplorer: true,
      statusBar: true,
    };
  });

  const [syntaxThemeId, setSyntaxThemeId] = useState<string>(() => {
    if (typeof window !== 'undefined') {
      const storedVal = localStorage.getItem('soloforge_syntaxThemeId');
      if (storedVal) return storedVal;
    }
    return 'auto';
  });

  const [customFonts, setCustomFonts] = useState<CustomFont[]>(() => {
    if (typeof window !== 'undefined') {
      const stored = localStorage.getItem('soloforge_customFonts');
      if (stored) {
        try {
          const parsed = JSON.parse(stored);
          if (Array.isArray(parsed)) {
            return parsed.filter((f: CustomFont) => {
              if (!f || !f.name) return false;
              const name = f.name.toLowerCase();
              return !name.includes('geekfont') &&
                     !name.includes('techmono') &&
                     !name.includes('yaku') &&
                     !name.includes('ma shan') &&
                     !name.includes('ma_shan') &&
                     !name.includes('zcool') &&
                     !name.includes('站酷') &&
                     !name.includes('黄油') &&
                     !name.includes('雅雅') &&
                     !name.includes('雅雅黑') &&
                     !name.includes('雅酷') &&
                     !name.includes('政体') &&
                     !name.includes('炫美');
            });
          }
        } catch (e) {}
      }
    }
    return [];
  });

  const [selectedFont, setSelectedFont] = useState<string>(() => {
    if (typeof window !== 'undefined') {
      const stored = localStorage.getItem('soloforge_selectedFont');
      if (stored) return stored;
    }
    return '默认 (Default)';
  });

  // Load dynamic google fonts and apply to root element
  useEffect(() => {
    if (typeof window === 'undefined') return;

    // Combine preset fonts and custom fonts
    const allFonts = [...PRESET_FONTS, ...customFonts];
    const activeF = allFonts.find(f => f.name === selectedFont);

    if (activeF && activeF.url) {
      if (activeF.url.startsWith('data:')) {
        const fontId = `dynamic-font-face-${encodeURIComponent(activeF.name)}`;
        let styleEl = document.getElementById(fontId) as HTMLStyleElement;
        if (!styleEl) {
          styleEl = document.createElement('style');
          styleEl.id = fontId;
          const format = activeF.url.includes('woff2') ? 'woff2' : activeF.url.includes('woff') ? 'woff' : activeF.url.includes('ttf') ? 'truetype' : 'opentype';
          styleEl.textContent = `
            @font-face {
              font-family: "${activeF.name}";
              src: url("${activeF.url}") format("${format}");
              font-weight: normal;
              font-style: normal;
            }
          `;
          document.head.appendChild(styleEl);
        }
      } else {
        // Check if link is already loaded
        const existingLink = document.getElementById(`font-link-${encodeURIComponent(activeF.name)}`);
        if (!existingLink) {
          const link = document.createElement('link');
          link.id = `font-link-${encodeURIComponent(activeF.name)}`;
          link.rel = 'stylesheet';
          link.href = activeF.url;
          document.head.appendChild(link);
        }
      }
    }

    // Apply selected font family globally!
    if (selectedFont && selectedFont !== '默认 (Default)') {
      let cssFontName = selectedFont;
      // Strip brackets or descriptions from system presets
      if (selectedFont === '系统默认 (System UI)') {
        cssFontName = 'system-ui, -apple-system, sans-serif';
      } else if (selectedFont.includes('(')) {
        // e.g. "马山政体 (Ma Shan Zheng)" -> "Ma Shan Zheng"
        const match = selectedFont.match(/\(([^)]+)\)/);
        if (match) {
          cssFontName = match[1];
        }
      }
      
      document.documentElement.style.setProperty('--font-sans', `"${cssFontName}", "Inter", sans-serif`);
      document.documentElement.style.setProperty('--font-display', `"${cssFontName}", "Hanken Grotesk", sans-serif`);
    } else {
      document.documentElement.style.removeProperty('--font-sans');
      document.documentElement.style.removeProperty('--font-display');
    }

    // Also persist
    localStorage.setItem('soloforge_selectedFont', selectedFont);
    localStorage.setItem('soloforge_customFonts', JSON.stringify(customFonts));
  }, [selectedFont, customFonts]);

  const addCustomFont = (name: string, url?: string) => {
    setCustomFonts(prev => {
      if (prev.some(f => f.name.toLowerCase() === name.toLowerCase())) {
        return prev;
      }
      return [...prev, { name, url }];
    });
  };

  const deleteCustomFont = (name: string) => {
    setCustomFonts(prev => prev.filter(f => f.name !== name));
    if (selectedFont === name) {
      setSelectedFont('默认 (Default)');
    }
  };

  const activeTheme = useMemo(() => {
    return THEME_PRESETS.find(t => t.id === currentThemeId) || THEME_PRESETS[0];
  }, [currentThemeId]);

  const isRemoteUpdateRef = useRef(false);

  const setCurrentThemeId = (themeId: string) => {
    setCurrentThemeIdState(themeId);
    let targetColor = '';
    if (customColors[themeId]) {
      targetColor = customColors[themeId];
    } else {
      const preset = THEME_PRESETS.find(t => t.id === themeId) || THEME_PRESETS[0];
      targetColor = preset.primary;
    }
    setPrimaryColorState(targetColor.toLowerCase());
  };

  const syncTheme = (themeId: string, color: string, targets: ThemeColorTargets) => {
    isRemoteUpdateRef.current = true;
    setCurrentThemeIdState(themeId);
    setPrimaryColorState(color.toLowerCase());
    setPrimaryColorTargets(targets);
    setCustomColors(prev => ({
      ...prev,
      [themeId]: color.toLowerCase()
    }));
  };

  // Handle color change instantly in style/variables for high performance
  const setPrimaryColor = (color: string) => {
    const cleanColor = color.toLowerCase();
    setPrimaryColorState(cleanColor);
    setCustomColors(prev => ({
      ...prev,
      [currentThemeId]: cleanColor
    }));
  };

  // Synchronize CSS custom properties instantly on change
  useEffect(() => {
    if (typeof document !== 'undefined') {
      document.documentElement.style.setProperty('--color-bg', activeTheme.bg);
      document.documentElement.style.setProperty('--color-surface', activeTheme.surface);
      document.documentElement.style.setProperty('--color-surface-bright', activeTheme.surfaceBright);
      document.documentElement.style.setProperty('--color-on-surface', activeTheme.onSurface);
      document.documentElement.style.setProperty('--color-outline', activeTheme.outline);
      document.documentElement.style.setProperty('--color-primary', primaryColor);
      document.documentElement.style.setProperty('--color-main-primary', primaryColor);
      
      // Determine editor specifically variables (supporting independent light/dark syntax themes)
      let rEdBg = activeTheme.bg;
      let rEdSurface = activeTheme.surface;
      let rEdSurfaceBright = activeTheme.surfaceBright;
      let rEdOnSurface = activeTheme.onSurface;
      let rEdOutline = activeTheme.outline;
      let rSynStr = '';
      let rSynType = '';
      let rSynNum = '';

      const synPreset = SYNTAX_THEMES.find(s => s.id === syntaxThemeId);
      if (synPreset && synPreset.id !== 'auto') {
        rEdBg = synPreset.bg;
        rEdSurface = synPreset.surface;
        rEdSurfaceBright = synPreset.surfaceBright;
        rEdOnSurface = synPreset.onSurface;
        rEdOutline = synPreset.outline;
        rSynStr = synPreset.syntaxString;
        rSynType = synPreset.syntaxType;
        rSynNum = synPreset.syntaxNumber;
      } else {
        // 'auto' setup synced directly to the UI theme
        if (currentThemeId === 'light') {
          rSynStr = '#a31515'; // Deep red string
          rSynType = '#267f99';   // Deep teal class/type
          rSynNum = '#098658'; // Forest green series
        } else if (currentThemeId === 'cyberpunk') {
          rSynStr = '#00ffcc'; // Neon cyan
          rSynType = '#ff00ff';   // Neon magenta
          rSynNum = '#ffff00'; // Neon yellow
        } else if (currentThemeId === 'sakura') {
          rSynStr = '#f368e0'; // Cherry pink
          rSynType = '#ff9f43';   // Salmon orange
          rSynNum = '#ff4757'; // Dark coral red
        } else if (currentThemeId === 'nord') {
          rSynStr = '#a3be8c'; // Sage green
          rSynType = '#8fbcbb';   // Frosty teal
          rSynNum = '#b48ead'; // Ice purple
        } else if (currentThemeId === 'gruvbox') {
          rSynStr = '#b8bb26'; // Olive string
          rSynType = '#fe8019';   // Rusty orange
          rSynNum = '#d3869b'; // Gruv berry
        } else {
          // Standard Dark
          rSynStr = '#ce9178'; // Peach
          rSynType = '#4ec9b0';   // Vivid teal
          rSynNum = '#b5cea8'; // Pale green
        }
      }

      // Apply specifically to editor and syntax properties
      document.documentElement.style.setProperty('--editor-bg', rEdBg);
      document.documentElement.style.setProperty('--editor-surface', rEdSurface);
      document.documentElement.style.setProperty('--editor-surface-bright', rEdSurfaceBright);
      document.documentElement.style.setProperty('--editor-on-surface', rEdOnSurface);
      document.documentElement.style.setProperty('--editor-outline', rEdOutline);
      document.documentElement.style.setProperty('--syntax-string', rSynStr);
      document.documentElement.style.setProperty('--syntax-type', rSynType);
      document.documentElement.style.setProperty('--syntax-number', rSynNum);

      const rgbNums = getRGBNumbers(primaryColor);
      document.documentElement.style.setProperty('--color-primary-rgb', rgbNums);
      
      // Dynamic calculations for card borders & glowing active shadows
      document.documentElement.style.setProperty('--theme-card-border-color', `rgba(${rgbNums}, 0.15)`);
      document.documentElement.style.setProperty('--theme-active-glow-shadow', `0 0 16px rgba(${rgbNums}, 0.3)`);

      // Avoid echo feedback loop
      if (isRemoteUpdateRef.current) {
        isRemoteUpdateRef.current = false;
        return;
      }

      // Broadcast changes for multi-window synchronized UI
      try {
        const channel = new BroadcastChannel('soloforge-editor-sync-channel');
        channel.postMessage({
          type: 'THEME_SYNC',
          themeId: currentThemeId,
          color: primaryColor,
          targets: primaryColorTargets
        });
        channel.close();
      } catch (e) {}
    }
  }, [currentThemeId, activeTheme, primaryColor, primaryColorTargets, syntaxThemeId]);

  // Debounced write helper for localStorage to significantly minimize key-value I/O overhead on fast drags
  useEffect(() => {
    const handler = setTimeout(() => {
      if (typeof window !== 'undefined') {
        localStorage.setItem('soloforge_themeId', currentThemeId);
        localStorage.setItem('soloforge_syntaxThemeId', syntaxThemeId);
        localStorage.setItem('soloforge_primaryColor', primaryColor);
        localStorage.setItem('soloforge_primaryColorTargets', JSON.stringify(primaryColorTargets));
        localStorage.setItem('soloforge_customColors', JSON.stringify(customColors));
      }
    }, 100);

    return () => {
      clearTimeout(handler);
    };
  }, [currentThemeId, primaryColor, primaryColorTargets, customColors, syntaxThemeId]);

  const value = useMemo(() => ({
    primaryColor,
    primaryColorTargets,
    currentThemeId,
    activeTheme,
    syntaxThemeId,
    customFonts,
    selectedFont,
    setSyntaxThemeId,
    setPrimaryColor,
    setPrimaryColorTargets,
    setCurrentThemeId,
    syncTheme,
    addCustomFont,
    deleteCustomFont,
    setSelectedFont
  }), [primaryColor, primaryColorTargets, currentThemeId, activeTheme, syntaxThemeId, customFonts, selectedFont]);

  return (
    <ThemeContext.Provider value={value}>
      {children}
    </ThemeContext.Provider>
  );
};

export const useTheme = () => {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return context;
};
