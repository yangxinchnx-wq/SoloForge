// ─────────────────────────────────────────────────────────────────
// Theme 类型定义
// 每个主题 = 一组 CSS 变量值，运行时注入 <html>
// ─────────────────────────────────────────────────────────────────

export interface ThemeTokens {
  // 背景层
  bg: string;
  bgDim: string;

  // 表面层
  surface: string;
  surfaceLow: string;
  surfaceHigh: string;

  // 主色
  primary: string;
  onPrimary: string;
  primaryContainer: string;
  onPrimaryContainer: string;

  // 文字
  text: string;
  textSecondary: string;

  // 边框
  border: string;
  borderLight: string;

  // 语义色
  accent: string;
  success: string;
  warning: string;
  danger: string;
}

export interface Theme {
  id: string;
  name: string;
  tokens: ThemeTokens;
}
