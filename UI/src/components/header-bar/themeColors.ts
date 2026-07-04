/**
 * themeColors —— 顶部栏/中央胶囊/主模型面板的主题感知色值工具
 *
 * 2026-07-02 之前的问题:
 *   Header / CentralControlPill / MainModelSelector 里所有色值都是硬编码
 *   rgba(18,20,20,0.86)、#ffde82、#22c55e、#050505 等。用户切到 sakura
 *   / nord / cyberpunk / light 等主题时,顶部栏仍显示黑色 + 金色,不跟随
 *   界面色,体验割裂。
 *
 * 设计原则:
 *   1. 一切可主题化的色值都从 --color-* token 派生
 *      --color-bg / --color-surface / --color-surface-bright /
 *      --color-on-surface / --color-outline / --color-primary /
 *      --color-primary-rgb
 *   2. 状态色(绿点/错误/警告)保留硬编码 —— 它们表示"通用语义"
 *      (online/offline/error),不与品牌主题混为一谈
 *   3. 阴影、玻璃 alpha 分两类: isDark → 深色玻璃(黑半透明 + 黑阴影);
 *      isLight → 浅色玻璃(白半透明 + 极淡黑阴影)
 *   4. 头像渐变三段色全部从 var(--color-primary) 派生:
 *      primary → primary + 白 25% → primary + 黑 30%
 *      不再硬编码 #f5b461 / #c97f3a / #121414
 *   5. 文字对比度: 在 isLight 主题下, 浅金(primary)文字需要更深的描边/底色,
 *      所以 primary 文字 alpha 在 isLight 时略低,在 isDark 时略高
 */

import { useTheme } from '../../context/ThemeContext';

/**
 * 给定一个 token 名(对应 --color-*-rgb)和一个 alpha,
 * 返回 "rgba(R, G, B, alpha)" 字符串 —— 配合 var(--color-*-rgb) 组合使用
 *
 * 注意: CSS rgba() 函数需要 (R, G, B, alpha) 四参数,所以最终字符串形如:
 *   `rgba(var(--color-primary-rgb), 0.32)`
 * 但这只在 --color-primary-rgb 存 "R, G, B" 时才正确,而项目正是这么用的。
 */
export const themedRgba = (token: string, alpha: number): string =>
  `rgba(var(${token}), ${alpha})`;

/**
 * isDark 时: 黑色阴影、半透黑玻璃; isLight 时: 极淡黑阴影、白玻璃
 *
 * 返回的字符串可直接喂给 style.boxShadow / style.background
 */
export interface ThemedGlass {
  /** 表面渐变(玻璃) */
  surfaceGradient: string;
  /** 表面渐变(更亮的容器 / 内嵌面板) */
  brightSurfaceGradient: string;
  /** 表面渐变(暗的内嵌面板 —— 浅色主题下不适用) */
  darkSurfaceGradient: string;
  /** 头部 inset 高光(玻璃顶) */
  topHighlight: string;
  /** 头部 inset 深度(玻璃底) */
  bottomShade: string;
  /** 主阴影字符串 */
  ambientShadow: string;
  tightShadow: string;
  /** 金边 alpha(深色更淡、浅色更深以保证对比) */
  hairlineAlpha: number;
  hairlineHoverAlpha: number;
  /** 内嵌组件底色 alpha */
  innerGlassAlpha: number;
  /** 文字色(主要) */
  textPrimary: string;
  /** 文字色(次要) */
  textSecondary: string;
  /** 文字色(三要 / 弱化) */
  textTertiary: string;
}

export function getThemedGlass(isDark: boolean): ThemedGlass {
  if (isDark) {
    return {
      // 玻璃底: 半透 surface-bright → 半透 surface,模拟玻璃厚度
      surfaceGradient: `linear-gradient(180deg, ${themedRgba('--color-surface-bright', 0.78)} 0%, ${themedRgba('--color-surface', 0.62)} 100%)`,
      brightSurfaceGradient: `linear-gradient(180deg, ${themedRgba('--color-surface-bright', 0.55)} 0%, ${themedRgba('--color-surface', 0.55)} 100%)`,
      darkSurfaceGradient: `linear-gradient(180deg, ${themedRgba('--color-surface-bright', 0.92)} 0%, ${themedRgba('--color-surface', 0.92)} 100%)`,
      topHighlight: 'inset 0 1px 0 rgba(255,255,255,0.07)',
      bottomShade: 'inset 0 -1px 0 rgba(0,0,0,0.30)',
      ambientShadow: '0 10px 32px rgba(0,0,0,0.32)',
      tightShadow: '0 2px 8px rgba(0,0,0,0.18)',
      hairlineAlpha: 0.32,
      hairlineHoverAlpha: 0.55,
      innerGlassAlpha: 0.20,
      textPrimary: 'var(--color-on-surface)',
      textSecondary: 'color-mix(in srgb, var(--color-on-surface) 70%, transparent)',
      textTertiary: 'color-mix(in srgb, var(--color-on-surface) 45%, transparent)',
    };
  }
  // 浅色主题: 玻璃白底 + 极淡黑阴影 + 金边 alpha 略高(浅底上需要更显眼)
  return {
    surfaceGradient: `linear-gradient(180deg, ${themedRgba('--color-surface-bright', 0.92)} 0%, ${themedRgba('--color-surface', 0.82)} 100%)`,
    brightSurfaceGradient: `linear-gradient(180deg, ${themedRgba('--color-surface', 0.78)} 0%, ${themedRgba('--color-surface-bright', 0.78)} 100%)`,
    darkSurfaceGradient: `linear-gradient(180deg, ${themedRgba('--color-surface-bright', 0.94)} 0%, ${themedRgba('--color-surface', 0.94)} 100%)`,
    topHighlight: 'inset 0 1px 0 rgba(255,255,255,0.55)',
    bottomShade: 'inset 0 -1px 0 rgba(0,0,0,0.06)',
    ambientShadow: '0 6px 18px rgba(0,0,0,0.06)',
    tightShadow: '0 1px 3px rgba(0,0,0,0.04)',
    hairlineAlpha: 0.42,
    hairlineHoverAlpha: 0.62,
    innerGlassAlpha: 0.28,
    textPrimary: 'var(--color-on-surface)',
    textSecondary: 'color-mix(in srgb, var(--color-on-surface) 65%, transparent)',
    textTertiary: 'color-mix(in srgb, var(--color-on-surface) 40%, transparent)',
  };
}

/**
 * 头像渐变 —— 三段色全部从 var(--color-primary) 派生
 * 通过 color-mix 把 primary 调亮/调暗,生成视觉上更有层次的三色渐变
 */
export function getAvatarGradient(): string {
  // primary 主导 → 中间段 primary + 白 25% (highlight) → 末段 primary + 黑 30% (shadow)
  return `linear-gradient(135deg,
    var(--color-primary) 0%,
    color-mix(in srgb, var(--color-primary) 60%, white 40%) 50%,
    color-mix(in srgb, var(--color-primary) 70%, black 30%) 100%)`;
}

/**
 * 头像文字色 —— primary 通常较亮,文字需要暗底才能读清。
 * 用 bg = primary,文字 = surface (暗主题时 surface 偏暗) 或 bg (浅色主题时 bg 偏白)
 */
export function getAvatarTextColor(isDark: boolean): string {
  // 简单粗暴: 深色主题头像文字用 on-surface 暗端, 浅色主题文字用白
  // 但 on-surface 在深色主题下偏亮, 所以这里反转一下
  return isDark ? 'var(--color-bg)' : 'var(--color-bg)';
}

/**
 * 状态点边色 —— 在线点的 2px 外圈描边需要跟 header 底色一致
 * 深色主题下是 --color-bg 黑边, 浅色主题下也是 --color-bg(浅色)
 */
export function getStatusDotBorder(isDark: boolean): string {
  return isDark ? 'var(--color-bg)' : 'var(--color-surface)';
}

/**
 * 头部底色 —— 主 header 容器的渐变, 不同于胶囊的表面
 * 这是宽度最大、需要"贴底"在窗口上的表面, 所以更克制(更接近 bg, 更不透明)
 */
export function getHeaderSurface(isDark: boolean): string {
  if (isDark) {
    // 深色: 半透 surface → 半透 bg (顶亮底暗, 让 header 像漂浮)
    return `linear-gradient(180deg, ${themedRgba('--color-surface', 0.86)} 0%, ${themedRgba('--color-bg', 0.92)} 100%)`;
  }
  // 浅色: 半透 surface-bright → 半透 surface
  return `linear-gradient(180deg, ${themedRgba('--color-surface-bright', 0.85)} 0%, ${themedRgba('--color-surface', 0.78)} 100%)`;
}

/**
 * hook —— 把 useTheme() + isDark 判断 + ThemedGlass 合并成一个返回值
 */
export function useThemedSurface(): {
  isDark: boolean;
  currentThemeId: string;
  primaryHex: string;
  glass: ThemedGlass;
  /** 便捷调用 —— 任意 token 的 rgba */
  rgba: (token: string, alpha: number) => string;
  /** 头部底色渐变 */
  headerSurface: string;
  /** 头像渐变 */
  avatarGradient: string;
  /** 头像文字色 */
  avatarTextColor: string;
  /** 状态点外圈描边 */
  statusDotBorder: string;
} {
  const theme = useTheme();
  const isDark = theme.activeTheme?.isDark ?? true;
  const currentThemeId = theme.currentThemeId ?? 'dark';
  const primaryHex = theme.primaryColor ?? '#ffde82';
  const glass = getThemedGlass(isDark);
  return {
    isDark,
    currentThemeId,
    primaryHex,
    glass,
    rgba: themedRgba,
    headerSurface: getHeaderSurface(isDark),
    avatarGradient: getAvatarGradient(),
    avatarTextColor: getAvatarTextColor(isDark),
    statusDotBorder: getStatusDotBorder(isDark),
  };
}