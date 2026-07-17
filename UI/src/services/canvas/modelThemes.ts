/**
 * modelThemes.ts — 3D 模型主题样式系统
 *
 * 为 3D 模型提供多套颜色主题 (银色/金色/蓝色/黑色/绿色钛金属等)。
 *
 * 两种应用方式:
 *   1. iPhone 15 Pro Max (分部位 mesh):
 *      按主题调整 body/back/边框/Apple logo 等部位的颜色和金属度。
 *      程序化贴图保持不变 (磨砂/拉丝纹理), 只改 baseColor。
 *
 *   2. iPhone 11 Pro Max (整体 mesh + 贴图):
 *      模型本身有 baseColorTexture (完整手机外观贴图),
 *      通过 color 属性叠加色调, 实现整体换色效果。
 *
 * 主题切换不重新加载 GLB, 只修改材质属性 (color/metalness/roughness),
 * 切换是即时的, 无闪烁。
 */

// ───────────────────────────── 主题类型 ─────────────────────────────

export type ThemeId =
  | 'natural-titanium'   // 原色钛金属 (银灰)
  | 'blue-titanium'      // 蓝色钛金属
  | 'black-titanium'     // 黑色钛金属
  | 'white-titanium'     // 白色钛金属
  | 'gold'               // 金色
  | 'midnight-green'     // 暗夜绿
  | 'silver'             // 银色
  | 'space-gray'         // 深空灰
  | 'glass-clear'        // 玻璃后盖 (透明)
  | 'leather-brown'      // 皮革棕
  | 'leather-black';     // 皮革黑

export interface ModelTheme {
  id: ThemeId;
  label: string;
  /** 主题色块 (UI 按钮显示用) */
  swatch: string;
}

// ───────────────────────────── 主题预设列表 ─────────────────────────────

export const MODEL_THEMES: ModelTheme[] = [
  { id: 'natural-titanium', label: '原色钛', swatch: '#E8E8E8' },
  { id: 'blue-titanium',    label: '蓝色钛', swatch: '#5A7A9A' },
  { id: 'black-titanium',   label: '黑色钛', swatch: '#3A3A3C' },
  { id: 'white-titanium',   label: '白色钛', swatch: '#F2F2F2' },
  { id: 'gold',             label: '金色',   swatch: '#D4AF6A' },
  { id: 'midnight-green',   label: '暗夜绿', swatch: '#4E5A50' },
  { id: 'silver',           label: '银色',   swatch: '#C0C0C0' },
  { id: 'space-gray',       label: '深空灰', swatch: '#535150' },
  { id: 'glass-clear',      label: '玻璃后盖', swatch: '#A8C8E0' },
  { id: 'leather-brown',    label: '皮革棕', swatch: '#8B5A3C' },
  { id: 'leather-black',    label: '皮革黑', swatch: '#2A2A2A' },
];

// ───────────────────────────── 主题颜色配置 ─────────────────────────────

/**
 * iPhone 15 Pro Max 分部位颜色配置
 *
 * 每个主题定义各部位的颜色 (hex number)。
 * applyThemeToMeshes 根据主题查表, 设置对应部位的 color。
 *
 * ★★★ 2026-07-18 新增 backFinish 字段: 背板材质工艺
 *   - 'matte':   磨砂钛金属 (程序化噪点贴图)
 *   - 'glass':   玻璃后盖 (高光低粗糙度, 无贴图)
 *   - 'leather': 皮革质感 (程序化皮革纹理贴图)
 */
export type BackFinish = 'matte' | 'glass' | 'leather';

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
  /** 背板材质工艺 */
  backFinish: BackFinish;
}

const IPHONE15_THEME_COLORS: Record<ThemeId, Iphone15ThemeColors> = {
  'natural-titanium': {
    back: 0xE8E8E8, frame: 0xC8C8C8, logo: 0x606060, cameraRing: 0xC0C0C0, flashMetal: 0xE0E0E0,
    backFinish: 'matte',
  },
  'blue-titanium': {
    back: 0x6B8AAB, frame: 0x5A7A9A, logo: 0x2A3A4A, cameraRing: 0xA0B8CC, flashMetal: 0xC0C8D0,
    backFinish: 'matte',
  },
  'black-titanium': {
    back: 0x3A3A3C, frame: 0x2A2A2C, logo: 0x808080, cameraRing: 0x505052, flashMetal: 0x606062,
    backFinish: 'matte',
  },
  'white-titanium': {
    back: 0xF2F2F2, frame: 0xE0E0E0, logo: 0x808080, cameraRing: 0xD0D0D0, flashMetal: 0xE8E8E8,
    backFinish: 'matte',
  },
  'gold': {
    back: 0xD4AF6A, frame: 0xC9A55C, logo: 0x8A7440, cameraRing: 0xDCC080, flashMetal: 0xE0D0A0,
    backFinish: 'matte',
  },
  'midnight-green': {
    back: 0x4E5A50, frame: 0x3E4A40, logo: 0x8A9A8A, cameraRing: 0x6A7A60, flashMetal: 0x7A8A70,
    backFinish: 'matte',
  },
  'silver': {
    back: 0xE0E0E0, frame: 0xC8C8C8, logo: 0x606060, cameraRing: 0xC0C0C0, flashMetal: 0xE0E0E0,
    backFinish: 'matte',
  },
  'space-gray': {
    back: 0x535150, frame: 0x434140, logo: 0x909088, cameraRing: 0x636260, flashMetal: 0x737270,
    backFinish: 'matte',
  },
  'glass-clear': {
    // 玻璃后盖: 透明青蓝色, 高透高光
    back: 0xA8C8E0, frame: 0xC0C8D0, logo: 0x606060, cameraRing: 0xC0C0C0, flashMetal: 0xE0E0E0,
    backFinish: 'glass',
  },
  'leather-brown': {
    // 皮革棕: 背板皮革, 边框金色
    back: 0x8B5A3C, frame: 0xC9A55C, logo: 0x8A7440, cameraRing: 0xDCC080, flashMetal: 0xE0D0A0,
    backFinish: 'leather',
  },
  'leather-black': {
    // 皮革黑: 背板皮革, 边框黑色钛
    back: 0x2A2A2A, frame: 0x2A2A2C, logo: 0x808080, cameraRing: 0x505052, flashMetal: 0x606062,
    backFinish: 'leather',
  },
};

/**
 * iPhone 11 Pro Max 主题颜色配置
 *
 * ★★★ 2026-07-18 重构: 从 RGB 乘数模式改为纯色替换模式
 *
 * 原方案 (RGB 乘数): material.color 作为贴图的 RGB multiplier
 *   最终颜色 = 贴图像素 × color
 *   问题: iPhone 11 GLB 的 baseColorTexture 本身是暗色贴图 (sRGB ~0.1 → linear ~0.01)
 *   color ≤ 1.0 只能让贴图更暗, 无法提亮 → 手机永远看起来是黑的
 *   color > 1.0 在 sRGB 空间被截断 → 也无法提亮
 *
 * 新方案 (纯色替换): 完全移除暗色贴图, 用 material.color 作为纯色 + 程序化磨砂纹理
 *   最终颜色 = 程序化磨砂纹理(浅灰噪点) × color(hex 主题色)
 *   和 iPhone 15 背板处理方式一致, 颜色干净、主题切换效果明显
 */
export interface Iphone11ThemeTint {
  /** 主题颜色 (hex number, 替换原始暗色贴图) */
  color: number;
  /** 金属度 (0~1) */
  metalness: number;
  /** 粗糙度 (0~1) */
  roughness: number;
  /** 环境反射强度 (0~2) */
  envMapIntensity: number;
}

const IPHONE11_THEME_TINT: Record<ThemeId, Iphone11ThemeTint> = {
  'natural-titanium': {
    // 原色钛: 银灰 (与 iPhone 15 背板色一致)
    color: 0xE8E8E8, metalness: 0.25, roughness: 0.55, envMapIntensity: 1.2,
  },
  'blue-titanium': {
    // 蓝色钛: 冷蓝
    color: 0x6B8AAB, metalness: 0.3, roughness: 0.55, envMapIntensity: 1.2,
  },
  'black-titanium': {
    // 黑色钛: 深灰
    color: 0x3A3A3C, metalness: 0.35, roughness: 0.5, envMapIntensity: 1.0,
  },
  'white-titanium': {
    // 白色钛: 纯白
    color: 0xF2F2F2, metalness: 0.2, roughness: 0.6, envMapIntensity: 1.4,
  },
  'gold': {
    // 金色: 暖金
    color: 0xD4AF6A, metalness: 0.35, roughness: 0.55, envMapIntensity: 1.3,
  },
  'midnight-green': {
    // 暗夜绿
    color: 0x4E5A50, metalness: 0.3, roughness: 0.55, envMapIntensity: 1.2,
  },
  'silver': {
    // 银色: 纯银白
    color: 0xE0E0E0, metalness: 0.2, roughness: 0.45, envMapIntensity: 1.4,
  },
  'space-gray': {
    // 深空灰
    color: 0x535150, metalness: 0.3, roughness: 0.55, envMapIntensity: 1.1,
  },
  'glass-clear': {
    // 玻璃后盖: iPhone 11 用浅蓝灰模拟玻璃质感
    color: 0xA8C8E0, metalness: 0.1, roughness: 0.15, envMapIntensity: 1.5,
  },
  'leather-brown': {
    // 皮革棕
    color: 0x8B5A3C, metalness: 0.1, roughness: 0.7, envMapIntensity: 1.0,
  },
  'leather-black': {
    // 皮革黑
    color: 0x2A2A2A, metalness: 0.1, roughness: 0.7, envMapIntensity: 1.0,
  },
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
