/**
 * modelThemes.ts — 3D 模型主题样式系统
 *
 * ★★★ 2026-07-19 重构: 颜色主题与材质工艺解耦
 *
 *   颜色主题 (ThemeId): 8 种颜色 — 原色钛/蓝色钛/黑色钛/白色钛/金色/暗夜绿/银色/深空灰
 *   材质工艺 (MaterialFinish): 3 种材质 — 原色(磨砂)/玻璃/皮革
 *
 *   组合示例: 白色钛 + 玻璃 = 白色玻璃后盖, 白色钛 + 皮革 = 白色皮革后盖
 *   切换材质时颜色不变, 切换颜色时材质不变
 *
 * 两种应用方式:
 *   1. iPhone 15 Pro Max (分部位 mesh):
 *      按主题调整 body/back/边框/Apple logo 等部位的颜色。
 *      材质工艺只影响背板 (back mesh)。
 *
 *   2. iPhone 11 Pro Max (整体 mesh):
 *      移除暗色贴图, 用纯主题色 + 材质工艺对应的程序化纹理。
 */

// ───────────────────────────── 颜色主题类型 ─────────────────────────────

export type ThemeId =
  | 'natural-titanium'   // 原色钛金属 (银灰)
  | 'blue-titanium'      // 蓝色钛金属
  | 'black-titanium'     // 黑色钛金属
  | 'white-titanium'     // 白色钛金属
  | 'gold'               // 金色
  | 'midnight-green'     // 暗夜绿
  | 'silver'             // 银色
  | 'space-gray';        // 深空灰

export interface ModelTheme {
  id: ThemeId;
  label: string;
  /** 主题色块 (UI 按钮显示用) */
  swatch: string;
}

// ───────────────────────────── 颜色主题预设列表 ─────────────────────────────

export const MODEL_THEMES: ModelTheme[] = [
  { id: 'natural-titanium', label: '原色钛', swatch: '#E8E8E8' },
  { id: 'blue-titanium',    label: '蓝色钛', swatch: '#5A7A9A' },
  { id: 'black-titanium',   label: '黑色钛', swatch: '#3A3A3C' },
  { id: 'white-titanium',   label: '白色钛', swatch: '#F2F2F2' },
  { id: 'gold',             label: '金色',   swatch: '#D4AF6A' },
  { id: 'midnight-green',   label: '暗夜绿', swatch: '#4E5A50' },
  { id: 'silver',           label: '银色',   swatch: '#C0C0C0' },
  { id: 'space-gray',       label: '深空灰', swatch: '#535150' },
];

// ───────────────────────────── 材质工艺类型 ─────────────────────────────

/**
 * 材质工艺 (与颜色主题独立组合)
 *   - 'matte':   原色磨砂 (程序化噪点贴图, 钛金属质感)
 *   - 'glass':   玻璃后盖 (高光低粗糙度, 无贴图, 半透明)
 *   - 'leather': 皮革质感 (程序化皮革纹理贴图, 高粗糙度)
 */
export type MaterialFinish = 'matte' | 'glass' | 'leather';

export interface MaterialFinishOption {
  id: MaterialFinish;
  label: string;
}

export const MATERIAL_FINISHES: MaterialFinishOption[] = [
  { id: 'matte',   label: '原色' },
  { id: 'glass',   label: '玻璃' },
  { id: 'leather', label: '皮革' },
];

/**
 * 材质工艺对应的渲染参数
 *
 * 颜色由 ThemeId 决定, 材质参数由 MaterialFinish 决定。
 * 这样新增颜色主题时不需要重复定义 3 套材质参数。
 */
export interface FinishParams {
  /** 金属度 (0~1) */
  metalness: number;
  /** 粗糙度 (0~1) */
  roughness: number;
  /** 环境反射强度 (0~2) */
  envMapIntensity: number;
  /** 是否半透明 */
  transparent: boolean;
  /** 不透明度 (0~1, transparent=true 时生效) */
  opacity: number;
}

const FINISH_PARAMS: Record<MaterialFinish, FinishParams> = {
  matte: {
    metalness: 0.25, roughness: 0.55, envMapIntensity: 1.0,
    transparent: false, opacity: 1.0,
  },
  glass: {
    // ★★★ 不使用真正半透明 (transparent: true 会暴露 GLB 模型内部组件 → 杂乱白线)
    //   GLB 模型不是为透明渲染设计的, 内部有电池/电路板/螺丝等结构
    //   半透明后这些内部结构透过玻璃可见, 看起来就是杂乱的线条
    //
    //   改用不透明 + 高反射 + 低粗糙度模拟玻璃光泽感:
    //   视觉上仍然是玻璃 (强反射环境、锐利高光), 但不暴露内部结构
    metalness: 0.1, roughness: 0.08, envMapIntensity: 1.8,
    transparent: false, opacity: 1.0,
  },
  leather: {
    metalness: 0.0, roughness: 0.75, envMapIntensity: 0.8,
    transparent: false, opacity: 1.0,
  },
};

export function getFinishParams(finish: MaterialFinish): FinishParams {
  return FINISH_PARAMS[finish] ?? FINISH_PARAMS.matte;
}

// ───────────────────────────── 颜色配置 ─────────────────────────────

/**
 * iPhone 15 Pro Max 分部位颜色配置 (纯颜色, 不含材质参数)
 *
 * 材质参数由 MaterialFinish 独立决定, 不再耦合在颜色主题中。
 */
export interface Iphone15ThemeColors {
  /** 背板颜色 */
  back: number;
  /** 边框颜色 */
  frame: number;
  /** Apple logo 颜色 */
  logo: number;
  /** 摄像头金属环颜色 */
  cameraRing: number;
  /** 闪光灯金属底座颜色 */
  flashMetal: number;
}

const IPHONE15_THEME_COLORS: Record<ThemeId, Iphone15ThemeColors> = {
  'natural-titanium': {
    back: 0xE8E8E8, frame: 0xC8C8C8, logo: 0x606060, cameraRing: 0xC0C0C0, flashMetal: 0xE0E0E0,
  },
  'blue-titanium': {
    back: 0x6B8AAB, frame: 0x5A7A9A, logo: 0x2A3A4A, cameraRing: 0xA0B8CC, flashMetal: 0xC0C8D0,
  },
  'black-titanium': {
    back: 0x3A3A3C, frame: 0x2A2A2C, logo: 0x808080, cameraRing: 0x505052, flashMetal: 0x606062,
  },
  'white-titanium': {
    back: 0xF2F2F2, frame: 0xE0E0E0, logo: 0x808080, cameraRing: 0xD0D0D0, flashMetal: 0xE8E8E8,
  },
  'gold': {
    back: 0xD4AF6A, frame: 0xC9A55C, logo: 0x8A7440, cameraRing: 0xDCC080, flashMetal: 0xE0D0A0,
  },
  'midnight-green': {
    back: 0x4E5A50, frame: 0x3E4A40, logo: 0x8A9A8A, cameraRing: 0x6A7A60, flashMetal: 0x7A8A70,
  },
  'silver': {
    back: 0xE0E0E0, frame: 0xC8C8C8, logo: 0x606060, cameraRing: 0xC0C0C0, flashMetal: 0xE0E0E0,
  },
  'space-gray': {
    back: 0x535150, frame: 0x434140, logo: 0x909088, cameraRing: 0x636260, flashMetal: 0x737270,
  },
};

/**
 * iPhone 11 Pro Max 主题颜色配置 (纯颜色)
 *
 * ★★★ 2026-07-18 重构: 从 RGB 乘数模式改为纯色替换模式
 *   移除暗色贴图, 用 material.color 作为纯色 + 材质工艺对应的程序化纹理
 *   最终颜色 = 纹理(浅灰噪点/皮革) × color(hex 主题色) = 干净的主题色
 *
 * ★★★ 2026-07-19 重构: 材质参数(metalness/roughness/envMapIntensity) 移到 FinishParams
 *   这里只保留颜色, 材质参数由 MaterialFinish 决定
 */
export interface Iphone11ThemeTint {
  /** 主题颜色 (hex number, 替换原始暗色贴图) */
  color: number;
}

const IPHONE11_THEME_TINT: Record<ThemeId, Iphone11ThemeTint> = {
  'natural-titanium': { color: 0xE8E8E8 },
  'blue-titanium':    { color: 0x6B8AAB },
  'black-titanium':   { color: 0x3A3A3C },
  'white-titanium':   { color: 0xF2F2F2 },
  'gold':             { color: 0xD4AF6A },
  'midnight-green':   { color: 0x4E5A50 },
  'silver':           { color: 0xE0E0E0 },
  'space-gray':       { color: 0x535150 },
};

// ───────────────────────────── 查询函数 ─────────────────────────────

export function getIphone15ThemeColors(theme: ThemeId): Iphone15ThemeColors {
  return IPHONE15_THEME_COLORS[theme] ?? IPHONE15_THEME_COLORS['natural-titanium'];
}

export function getIphone11ThemeTint(theme: ThemeId): Iphone11ThemeTint {
  return IPHONE11_THEME_TINT[theme] ?? IPHONE11_THEME_TINT['natural-titanium'];
}

export function getDefaultTheme(): ThemeId {
  return 'natural-titanium';
}

export function getDefaultFinish(): MaterialFinish {
  return 'matte';
}
