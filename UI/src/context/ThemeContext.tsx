import React, { createContext, useContext, useState, useEffect, useRef, useMemo } from 'react';
import { ThemePreset } from '../types';

// ── 自托管字体 ───────────────────────────────────────────────
// 6 个中文字体放在 src/assets/fonts/，Vite 通过 ?url 让浏览器运行时加载
// 不打进 JS bundle（每个文件 2-28MB，不能 inline）
import OPPOSansUrl from '../assets/fonts/OPPOSans-Medium.otf?url';
import SourceHanSansSCUrl from '../assets/fonts/SourceHanSansSC-Regular-2.otf?url';
import LXGWWenKaiMonoUrl from '../assets/fonts/LXGWWenKaiMono-Light.ttf?url';
import SmileySansUrl from '../assets/fonts/SmileySans-Oblique.ttf?url';
import DinglieXidaUrl from '../assets/fonts/dingliexidafont-20250329V2)-2.ttf?url';
import DinglieZhuHaiUrl from '../assets/fonts/dingliezhuhaifont-20240831GengXinBan)-2.ttf?url';

// 注：StaticThemeContext 在下方 ThemeContext 创建后定义

interface PresetFontMeta {
  /** Settings UI 显示名（必须是合法的 font-family 字符串）*/
  name: string;
  /** 唯一 css font-family 名（实际用于 @font-face）*/
  cssFamily: string;
  url: string;
  /** 文件格式（用于 CSS src format hint）*/
  format: 'truetype' | 'opentype';
  /** Settings UI 上展示的副标题/说明 */
  desc: string;
}

const PRESET_FONT_META: PresetFontMeta[] = [
  { name: '思源黑体 SC (默认)', cssFamily: 'SourceHanSansSC', url: SourceHanSansSCUrl, format: 'opentype',
    desc: 'Adobe/Google 开源黑体，覆盖最完整，默认字体' },
  { name: 'OPPO Sans', cssFamily: 'OPPOSans', url: OPPOSansUrl, format: 'opentype',
    desc: 'OPPO 手机系统中文' },
  { name: '霞鹜文楷等宽', cssFamily: 'LXGWWenKaiMono', url: LXGWWenKaiMonoUrl, format: 'truetype',
    desc: '霞鹜文楷等宽版，轻量阅读友好' },
  { name: '得意黑 SmileySans', cssFamily: 'SmileySans', url: SmileySansUrl, format: 'truetype',
    desc: '得意黑，标题用黑体' },
  { name: '丁列西达', cssFamily: 'DinglieXida', url: DinglieXidaUrl, format: 'truetype',
    desc: '手写装饰' },
  { name: '丁列筑海', cssFamily: 'DinglieZhuHai', url: DinglieZhuHaiUrl, format: 'truetype',
    desc: '手写装饰' },
];

/** 默认值 —— “加载第一个”就是 SourceHanSansSC（思源黑体） */
const DEFAULT_FONT_NAME = PRESET_FONT_META[0].name;
const DEFAULT_FONT_URL = PRESET_FONT_META[0].url;
export { DEFAULT_FONT_URL };

/** display name -> css font-family */
const FONT_NAME_TO_CSS: Record<string, string> = Object.fromEntries(
  PRESET_FONT_META.map(p => [p.name, p.cssFamily])
);

/** module-level dedup set：preload 过的 URL 不重复创建 <link> */
const preloadedFontUrls = new Set<string>();

/**
 * 通过 <link rel="preload" as="font"> 预取字体文件，浏览器在用户真正切换前就下载。
 * - 用 Set 去重，避免 hover / focus 重复触发时反复插入 DOM
 * - data: / blob: 不走预取（已经是内存对象）
 */
export function preloadFontByUrl(url: string): void {
  if (typeof document === 'undefined') return;
  if (!url || url.startsWith('data:') || url.startsWith('blob:')) return;
  if (preloadedFontUrls.has(url)) return;
  preloadedFontUrls.add(url);
  const link = document.createElement('link');
  link.rel = 'preload';
  link.as = 'font';
  link.href = url;
  link.crossOrigin = 'anonymous';
  document.head.appendChild(link);
}

/** 根据 display name 预取字体（支持预设 + 自定义导入的 local 字体） */
export function preloadFontByName(name: string, customFonts: CustomFont[] = []): void {
  const preset = PRESET_FONT_META.find(p => p.name === name);
  if (preset) { preloadFontByUrl(preset.url); return; }
  const custom = customFonts.find(f => f.name === name);
  if (custom?.url) preloadFontByUrl(custom.url);
}

export const THEME_PRESETS: ThemePreset[] = [
  {
    id: 'light',
    name: '纯净浅色 (Clean Light)',
    bg: '#fafafa',         // 极淡灰白底色
    surface: '#ffffff',    // 纯白卡面
    surfaceBright: '#f4f4f5', // 浅灰白过渡
    primary: '#6366f1',    // 靛蓝紫
    onSurface: '#18181b',  // 深炭黑文字
    outline: '#e4e4e7'     // 极浅灰边
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
    name: '纯净浅色 (Clean Light)',
    isDark: false,
    bg: '#ffffff',
    surface: '#fafafa',
    surfaceBright: '#f4f4f5',
    onSurface: '#18181b',
    outline: '#e4e4e7',
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
  { name: '默认 (Default)', url: '', isPreset: true },
  ...PRESET_FONT_META.map(p => ({ name: p.name, url: p.url, isPreset: true })),
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

// 静态上下文：字体 / syntax theme 等"极少变化"字段
// 单独切出后,主色变化 (主色频繁) 不会让不订阅主色的组件重建。
// 子集 + setter 类型,不再需要包含 hot 字段
type StaticThemeContextType = Pick<
  ThemeContextType,
  'syntaxThemeId' | 'customFonts' | 'selectedFont' |
  'setSyntaxThemeId' | 'addCustomFont' | 'deleteCustomFont' | 'setSelectedFont'
>;

export const StaticThemeContext = createContext<StaticThemeContextType | undefined>(undefined);

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
      if (stored) {
        // 迁移老用户: "默认 (Default)" 之前指向 Inter，后改为 OPPOSans，现已改为 SourceHanSansSC（思源黑体）
        if (stored === '默认 (Default)' || stored === 'OPPO Sans (默认)') return DEFAULT_FONT_NAME;
        return stored;
      }
    }
    return DEFAULT_FONT_NAME;
  });

  // ── 启动时注入 6 个预设字体的 @font-face（font-display: swap，
  //    避免切换瞬间出现“未加载文字不可见”） ─────────────────────
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const styleId = 'preset-font-faces';
    if (document.getElementById(styleId)) return;
    const styleEl = document.createElement('style');
    styleEl.id = styleId;
    const rules = PRESET_FONT_META.map(p => `
@font-face {
  font-family: "${p.cssFamily}";
  src: url("${p.url}") format("${p.format === 'opentype' ? 'opentype' : 'truetype'}");
  font-weight: normal;
  font-style: normal;
  font-display: swap;
}`).join('\n');
    styleEl.textContent = rules;
    document.head.appendChild(styleEl);
  }, []);

  // 选中字体后: 1) 对自定义字体注入 <style>/<link>; 2) 写 --font-sans/--font-display
  useEffect(() => {
    if (typeof window === 'undefined') return;

    const allFonts = [...PRESET_FONTS, ...customFonts];
    const activeF = allFonts.find(f => f.name === selectedFont);
    const isPreset = activeF?.isPreset === true;

    // 自定义字体（非预设）按需注入；预设字体已由启动 useEffect 注入，跳过
    if (activeF && activeF.url && !isPreset) {
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
    // 预设字体 -> 用 FONT_NAME_TO_CSS 表查 css family 名
    // 自定义字体 -> 用 display name 作为 css family 名
    // "默认 (Default)" -> 清除全局变量，回落到 index.css 的 Inter/系统字体
    if (selectedFont === '默认 (Default)') {
      document.documentElement.style.removeProperty('--font-sans');
      document.documentElement.style.removeProperty('--font-display');
    } else {
      let cssFontName: string;
      const fromMap = FONT_NAME_TO_CSS[selectedFont];
      if (fromMap) {
        cssFontName = fromMap;
      } else if (selectedFont === '系统默认 (System UI)') {
        cssFontName = 'system-ui, -apple-system, sans-serif';
      } else if (selectedFont.includes('(')) {
        // e.g. "马山政体 (Ma Shan Zheng)" -> "Ma Shan Zheng"
        const match = selectedFont.match(/\(([^)]+)\)/);
        cssFontName = match ? match[1] : selectedFont;
      } else {
        cssFontName = selectedFont;
      }
      document.documentElement.style.setProperty('--font-sans', `"${cssFontName}", "Inter", sans-serif`);
      document.documentElement.style.setProperty('--font-display', `"${cssFontName}", "Hanken Grotesk", sans-serif`);
    }

    // Also persist — useIdle 写, 避免主线程长同步 cost
    const persistFonts = () => {
      if (typeof window === 'undefined') return;
      localStorage.setItem('soloforge_selectedFont', selectedFont);
      localStorage.setItem('soloforge_customFonts', JSON.stringify(customFonts));
    };
    const ric: any = (typeof (window as any).requestIdleCallback === 'function')
      ? (window as any).requestIdleCallback
      : null;
    if (ric) ric(persistFonts, { timeout: 1000 });
    else setTimeout(persistFonts, 200);
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

  // 1) Memo context value - 阻止 Provider 内子组件不必要的 re-render。
  // 2) 拆分 hot / static 双 Context:
  //    - HotContext 包含 color/theme (主色切换时变) — 仅订阅主色细节的组件重建
  //    - StaticContext 包含 font/syntax (极少变化) — 多数组件挂这层,主色切换不影响它们
  // 注:对象 Spread 来保证 hotValue/stableValue 引用在依赖未变时稳定。
  // setPrimaryColor 等 setState setter 被 useState 直接返回,引用稳定。
  const hotSetterRef = useRef({
    setPrimaryColor,
    setPrimaryColorTargets,
    setCurrentThemeId,
    syncTheme,
  });
  hotSetterRef.current = { setPrimaryColor, setPrimaryColorTargets, setCurrentThemeId, syncTheme };

  const staticSetterRef = useRef({
    setSyntaxThemeId,
    addCustomFont,
    deleteCustomFont,
    setSelectedFont,
  });
  staticSetterRef.current = { setSyntaxThemeId, addCustomFont, deleteCustomFont, setSelectedFont };

  const hotValue = useMemo(() => ({
    primaryColor,
    primaryColorTargets,
    currentThemeId,
    activeTheme,
    ...hotSetterRef.current,
  }), [primaryColor, primaryColorTargets, currentThemeId, activeTheme]);

  const staticValue = useMemo(() => ({
    syntaxThemeId,
    customFonts,
    selectedFont,
    ...staticSetterRef.current,
  }), [syntaxThemeId, customFonts, selectedFont]);

  return (
    <ThemeContext.Provider value={hotValue}>
      <StaticThemeContext.Provider value={staticValue}>
        {children}
      </StaticThemeContext.Provider>
    </ThemeContext.Provider>
  );
};

// 旧 useTheme() — 合并 hot + static, 完全向后兼容 (老代码照样能调 setter / 取 static 字段)
// 合并成本:仅当 hot/static 任一变化时才返回新对象(两 useMemo 都有 cross-memo 检查)
export const useTheme = () => {
  const hot = useContext(ThemeContext);
  const st = useContext(StaticThemeContext);
  if (!hot) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return useMemo(() => ({ ...hot, ...st }), [hot, st]);
};

// 仅订阅静态资源 (字体 / syntax theme) — 在主色变化时不需要 re-render
export const useStaticTheme = () => {
  const ctx = useContext(StaticThemeContext);
  if (!ctx) {
    throw new Error('useStaticTheme must be used within a ThemeProvider');
  }
  return ctx;
};

// 仅订阅主色 / 主题 — 在字体变化时不需要 re-render
export const useHotTheme = () => {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    throw new Error('useHotTheme must be used within a ThemeProvider');
  }
  return ctx;
};
