/**
 * xamlTranslator.ts — XAML (WPF/MAUI/UWP) → Universal AST 翻译器
 *
 * 将 XAML 标记解析成 UniversalNode 树。
 * 纯本地解析 (cheerio xmlMode), 不消耗 LLM token。
 *
 * 支持的 XAML 元素:
 *   - StackPanel (Orientation=Horizontal/Vertical) → row / column
 *   - Grid / WrapPanel / DockPanel / Canvas        → container / stack
 *   - TextBlock / Label                            → text
 *   - Button                                       → button
 *   - TextBox / PasswordBox                        → input
 *   - Image                                        → image
 *   - Separator / Border                           → divider / container
 *   - ContentControl / GroupBox                    → container
 *   - ScrollView / ScrollViewer                    → column (透传)
 *
 * 属性解析:
 *   - Text="Hello"             → content / label
 *   - Background="Red"         → background (支持颜色名 + #RGB)
 *   - Foreground="#FF0000"     → color
 *   - FontSize="14"            → fontSize
 *   - FontWeight="Bold"        → fontWeight
 *   - Padding="16" / "8,4"     → padding
 *   - Margin="8,4,8,4"         → margin
 *   - Width / Height           → width / height
 *   - CornerRadius="8"         → radius
 *   - Orientation="Horizontal" → row vs column
 *   - BorderBrush / BorderThickness → border
 */

import * as cheerio from 'cheerio';
import type { CheerioAPI, AnyNode, Element } from 'cheerio';
import type { UniversalNode, UniversalStyle, ButtonVariant, InputKind } from '../services/canvas/UniversalAST';
import { TranslateError, type Translator } from './types';

// ──────────────────────────── 工具函数 ────────────────────────────

/**
 * 解析 XAML 尺寸 "16" / "16px" / "Auto" → number | undefined
 */
function parseXamlDim(value: string | undefined): number | undefined {
  if (!value) return undefined;
  if (value === 'Auto' || value === 'NaN') return undefined;
  const match = value.match(/^(-?\d*\.?\d+)/);
  if (!match) return undefined;
  const num = parseFloat(match[1]);
  return Number.isFinite(num) ? num : undefined;
}

/**
 * 解析 XAML 颜色
 *   "Red" / "Blue"     → "Red"
 *   "#FF0000"          → "#FF0000"
 *   "#FFAABBCC"        → "#FFAABBCC"
 *   "{StaticResource Brush}" → undefined
 */
function parseXamlColor(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (value.startsWith('{')) return undefined; // Markup extension, 无法静态求值
  if (value.startsWith('#')) return value;
  // 颜色名
  if (/^[a-zA-Z]+$/.test(value)) return value;
  return undefined;
}

/**
 * 解析 XAML 四边值
 *   "16"   → 16 (统一)
 *   "8,4"  → [4, 8] (horizontal, vertical → [v, h])
 *   "1,2,3,4" → [1,2,3,4] (left, top, right, bottom → [t,r,b,l])
 */
function parseXamlThickness(value: string | undefined): number | [number, number] | [number, number, number, number] | undefined {
  if (!value) return undefined;
  const parts = value.split(',').map(s => parseXamlDim(s.trim()));
  if (parts.some(p => p === undefined)) return undefined;

  if (parts.length === 1) return parts[0];
  if (parts.length === 2) {
    // XAML "8,4" = horizontal=8, vertical=4 → [v, h] = [4, 8]
    return [parts[1]!, parts[0]!];
  }
  if (parts.length === 4) {
    // XAML "left,top,right,bottom" → UniversalStyle [top, right, bottom, left]
    const [left, top, right, bottom] = parts as number[];
    return [top, right, bottom, left];
  }
  return undefined;
}

// ──────────────────────────── 核心解析 ────────────────────────────

function parseElement($: CheerioAPI, el: AnyNode): UniversalNode | null {
  if (el.type !== 'tag') return null;

  const tag = (el as Element).tagName || '';
  // 去掉 XAML 命名空间前缀 (如 x:StackPanel 不常见, 但 wpf:Grid 可能)
  const localTag = tag.includes(':') ? tag.split(':').pop()! : tag;

  const $el = $(el);
  const style: UniversalStyle = {};

  // 通用属性
  const padding = parseXamlThickness($el.attr('Padding'));
  if (padding !== undefined) style.padding = padding;
  const margin = parseXamlThickness($el.attr('Margin'));
  if (margin !== undefined) style.margin = margin;
  const bg = parseXamlColor($el.attr('Background'));
  if (bg) style.background = bg;
  const width = parseXamlDim($el.attr('Width'));
  if (width) style.width = width;
  const height = parseXamlDim($el.attr('Height'));
  if (height) style.height = height;
  const opacity = parseXamlDim($el.attr('Opacity'));
  if (opacity !== undefined) style.opacity = opacity;

  // ── StackPanel → row / column ──
  if (localTag === 'StackPanel') {
    const orientation = $el.attr('Orientation') || 'Vertical';
    const children = parseChildren($, el);
    return {
      type: orientation === 'Horizontal' ? 'row' : 'column',
      style: Object.keys(style).length > 0 ? style : undefined,
      children: children.length > 0 ? children : undefined,
    };
  }

  // ── Grid → container (简化, 不处理 RowDefinitions/ColumnDefinitions) ──
  if (localTag === 'Grid' || localTag === 'WrapPanel' || localTag === 'DockPanel') {
    const children = parseChildren($, el).filter(c => {
      // 跳过 Grid.RowDefinitions / ColumnDefinitions
      return true;
    });
    return {
      type: 'container',
      style: Object.keys(style).length > 0 ? style : undefined,
      children: children.length > 0 ? children : undefined,
    };
  }

  // ── Canvas → stack ──
  if (localTag === 'Canvas') {
    const children = parseChildren($, el);
    return {
      type: 'stack',
      style: Object.keys(style).length > 0 ? style : undefined,
      children: children.length > 0 ? children : undefined,
    };
  }

  // ── TextBlock / Label → text ──
  if (localTag === 'TextBlock' || localTag === 'Label' || localTag === 'AccessText') {
    // Text 属性优先, 否则取子文本
    let content = $el.attr('Text') || '';
    if (!content) {
      content = $el.text().trim();
    }
    const color = parseXamlColor($el.attr('Foreground'));
    if (color) style.color = color;
    const fontSize = parseXamlDim($el.attr('FontSize'));
    if (fontSize) style.fontSize = fontSize;
    const fontWeight = $el.attr('FontWeight');
    if (fontWeight === 'Bold') style.fontWeight = 700;
    else if (fontWeight === 'Normal' || fontWeight === 'Regular') style.fontWeight = 400;
    else if (fontWeight === 'Light') style.fontWeight = 300;
    const textAlign = $el.attr('TextAlignment');
    if (textAlign === 'Center') style.textAlign = 'center';
    else if (textAlign === 'Right') style.textAlign = 'right';
    else if (textAlign === 'Left') style.textAlign = 'left';
    return {
      type: 'text',
      content,
      style: Object.keys(style).length > 0 ? style : undefined,
    };
  }

  // ── Button → button ──
  if (localTag === 'Button' || localTag === 'ButtonBase' || localTag === 'RepeatButton' || localTag === 'ToggleButton') {
    // Content 可能是字符串或子元素
    let label = $el.attr('Content') || '';
    if (!label) {
      // 尝试取子 TextBlock 的 Text
      const childText = $el.children('TextBlock').first().attr('Text');
      if (childText) label = childText;
      else label = $el.text().trim() || 'Button';
    }
    let variant: ButtonVariant = 'filled';
    // WPF 没有 variant 概念, 默认 filled
    const borderBrush = $el.attr('BorderBrush');
    if (borderBrush && !style.background) variant = 'outlined';
    return {
      type: 'button',
      label,
      variant,
      style: Object.keys(style).length > 0 ? style : undefined,
    };
  }

  // ── TextBox / PasswordBox → input ──
  if (localTag === 'TextBox' || localTag === 'PasswordBox' || localTag === 'RichTextBox') {
    const placeholder = $el.attr('Tag') || undefined; // WPF 没有 Placeholder, 用 Tag 兜底
    const kind: InputKind = localTag === 'PasswordBox' ? 'password' : 'text';
    return {
      type: 'input',
      placeholder,
      kind,
      style: Object.keys(style).length > 0 ? style : undefined,
    };
  }

  // ── Image → image ──
  if (localTag === 'Image') {
    // Source="image.png" 或 Source="{StaticResource ...}"
    let src = $el.attr('Source') || undefined;
    if (src && src.startsWith('{')) src = undefined;
    return {
      type: 'image',
      src,
      style: Object.keys(style).length > 0 ? style : undefined,
    };
  }

  // ── Separator → divider ──
  if (localTag === 'Separator') {
    return { type: 'divider', style: Object.keys(style).length > 0 ? style : undefined };
  }

  // ── Border → container (带圆角/边框) ──
  if (localTag === 'Border') {
    const radius = parseXamlDim($el.attr('CornerRadius'));
    if (radius) style.radius = radius;
    const borderBrush = parseXamlColor($el.attr('BorderBrush'));
    const borderThickness = parseXamlThickness($el.attr('BorderThickness'));
    if (borderBrush) {
      const w = typeof borderThickness === 'number' ? borderThickness : 1;
      style.border = `${w}px solid ${borderBrush}`;
    }
    const children = parseChildren($, el);
    return {
      type: 'container',
      style: Object.keys(style).length > 0 ? style : undefined,
      children: children.length > 0 ? children : undefined,
    };
  }

  // ── ContentControl / GroupBox / Expander → container ──
  if (localTag === 'ContentControl' || localTag === 'GroupBox' || localTag === 'Expander' || localTag === 'HeaderedContentControl') {
    const children = parseChildren($, el);
    return {
      type: 'container',
      style: Object.keys(style).length > 0 ? style : undefined,
      children: children.length > 0 ? children : undefined,
    };
  }

  // ── ScrollViewer → column (透传 content) ──
  if (localTag === 'ScrollViewer') {
    const children = parseChildren($, el);
    return {
      type: 'column',
      style: Object.keys(style).length > 0 ? style : undefined,
      children: children.length > 0 ? children : undefined,
    };
  }

  // ── 跳过非视觉元素 (RowDefinitions / ColumnDefinitions / Grid.RowDefinitions) ──
  if (localTag === 'RowDefinitions' || localTag === 'ColumnDefinitions' ||
      localTag === 'RowDefinition' || localTag === 'ColumnDefinition') {
    return null;
  }

  // ── 未知元素 → container (兜底) ──
  const children = parseChildren($, el);
  return {
    type: 'container',
    style: Object.keys(style).length > 0 ? style : undefined,
    children: children.length > 0 ? children : undefined,
  };
}

function parseChildren($: CheerioAPI, el: AnyNode): UniversalNode[] {
  const result: UniversalNode[] = [];
  $(el).children().each((_, child) => {
    const node = parseElement($, child);
    if (node) result.push(node);
  });
  return result;
}

// ──────────────────────────── 翻译器实现 ────────────────────────────

export const xamlTranslator: Translator = {
  language: 'xaml',
  displayName: 'XAML (WPF/MAUI)',

  /**
   * 检测代码是否为 XAML
   * 置信度:
   *   0.9  — 包含 WPF/MAUI 特征元素 + xmlns
   *   0.8  — 包含 StackPanel / Grid / TextBlock / Button 等
   *   0.5  — XML 标记 + WPF 属性 (Margin / Padding)
   */
  detect(code: string): number {
    if (!code || typeof code !== 'string') return 0;
    const trimmed = code.trim();
    if (trimmed.length < 20) return 0;

    const hasXamlNs = /xmlns[:=]/.test(trimmed) && /schemas\.microsoft\.com/.test(trimmed);
    const hasXamlElement = /<(?:StackPanel|Grid|TextBlock|Button|TextBox|Border|Canvas|DockPanel|WrapPanel|Window|Page|UserControl|MauiApp)\b/.test(trimmed);
    const hasXamlAttr = /\b(Margin|Padding|CornerRadius|TextAlignment|FontWeight|Foreground|Background)\s*=/.test(trimmed);

    if (hasXamlNs && hasXamlElement) return 0.9;
    if (hasXamlElement) return 0.8;
    if (hasXamlAttr && trimmed.startsWith('<')) return 0.5;

    return 0;
  },

  translate(code: string): UniversalNode {
    if (!code || typeof code !== 'string') {
      throw new TranslateError('xaml', 'code 为空');
    }

    let $: CheerioAPI;
    try {
      $ = cheerio.load(code, { xmlMode: true, decodeEntities: true });
    } catch (err: any) {
      throw new TranslateError('xaml', `XML 解析失败: ${err.message}`, code);
    }

    // 找根元素 (跳过 Window/Page 包装, 直接取 Content)
    const root = $.root().children().first();
    if (!root || root.length === 0) {
      throw new TranslateError('xaml', '未找到根元素', code);
    }

    const rootTag = (root[0] as Element).tagName || '';
    // Window / Page / UserControl / ShellContent 等: 取其子内容
    if (['Window', 'Page', 'UserControl', 'Application', 'ContentPage', 'ShellContent', 'MauiApp', 'FlyoutPage', 'NavigationPage', 'TabbedPage'].includes(rootTag)) {
      const children = parseChildren($, root[0]);
      if (children.length === 1) return children[0];
      if (children.length > 1) {
        return { type: 'column', children };
      }
      return { type: 'container' };
    }

    const node = parseElement($, root[0]);
    if (!node) {
      throw new TranslateError('xaml', '根元素无法解析', code);
    }
    return node;
  },
};
