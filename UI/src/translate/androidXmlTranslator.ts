/**
 * androidXmlTranslator.ts — Android XML 布局 → Universal AST 翻译器
 *
 * 将 Android XML 布局文件解析成 UniversalNode 树。
 * 纯本地解析 (cheerio, 已安装), 不消耗 LLM token。
 *
 * 支持的 Android View:
 *   - LinearLayout (horizontal/vertical) → row / column
 *   - RelativeLayout / ConstraintLayout / FrameLayout → container / stack
 *   - TextView                      → text
 *   - Button / ImageButton          → button
 *   - EditText                      → input
 *   - ImageView                     → image
 *   - View (divider 作用)           → divider
 *   - Space                         → spacer
 *   - CardView / MaterialCard       → container (带圆角)
 *   - ScrollView / NestedScrollView → column (透传子节点)
 *
 * 属性解析:
 *   - android:text="Hello"              → content / label
 *   - android:hint="Enter name"         → placeholder
 *   - android:textColor="#FF0000"       → color
 *   - android:background="#FFFFFF"      → background
 *   - android:textSize="14sp"           → fontSize
 *   - android:padding="16dp"            → padding
 *   - android:layout_margin="8dp"       → margin
 *   - android:orientation="horizontal"  → row vs column
 *   - android:src="@drawable/ic"        → src
 *   - android:inputType="textPassword"  → kind=password
 */

import * as cheerio from 'cheerio';
import type { CheerioAPI, AnyNode, Element } from 'cheerio';
import type { UniversalNode, UniversalStyle, ButtonVariant, InputKind } from '../services/canvas/UniversalAST';
import { TranslateError, type Translator } from './types';

// ──────────────────────────── 工具函数 ────────────────────────────

/**
 * 解析 Android 尺寸值 "16dp" / "14sp" / "100px" → number
 */
function parseAndroidDim(value: string | undefined): number | undefined {
  if (!value) return undefined;
  // @dimen/foo → undefined (无法静态求值)
  if (value.startsWith('@')) return undefined;
  const match = value.match(/^(-?\d*\.?\d+)\s*(dp|sp|px|dip)?$/);
  if (!match) return undefined;
  const num = parseFloat(match[1]);
  return Number.isFinite(num) ? num : undefined;
}

/**
 * 解析 Android 颜色值
 *   "#FF0000" / "#FFRRGGBB" / "#FFAABBCC" → 原样
 *   "@color/red" → "red" (提取名字, 但不准确, 仅占位)
 */
function parseAndroidColor(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (value.startsWith('#')) return value;
  if (value.startsWith('@color/')) return value.slice('@color/'.length);
  return undefined;
}

/**
 * 从 android: 命名空间提取属性
 * cheerio 的 attr() 对带冒号的属性名需要转义, 用属性选择器或直接访问
 */
function getAndroidAttr($: CheerioAPI, el: AnyNode, name: string): string | undefined {
  const $el = $(el);
  // 尝试 android:name
  return $el.attr(`android:${name}`) || $el.attr(name) || undefined;
}

/**
 * 解析 padding/margin (支持四边独立属性)
 */
function parseAndroidBox($: CheerioAPI, el: AnyNode, prefix: string): number | [number, number] | [number, number, number, number] | undefined {
  // android:padding (统一)
  const all = getAndroidAttr($, el, prefix);
  if (all) {
    const n = parseAndroidDim(all);
    if (n !== undefined) return n;
  }

  // android:paddingLeft / Top / Right / Bottom
  const left = parseAndroidDim(getAndroidAttr($, el, `${prefix}Left`));
  const top = parseAndroidDim(getAndroidAttr($, el, `${prefix}Top`));
  const right = parseAndroidDim(getAndroidAttr($, el, `${prefix}Right`));
  const bottom = parseAndroidDim(getAndroidAttr($, el, `${prefix}Bottom`));

  if (left !== undefined || top !== undefined || right !== undefined || bottom !== undefined) {
    return [top ?? 0, right ?? 0, bottom ?? 0, left ?? 0];
  }

  return undefined;
}

// ──────────────────────────── 核心解析 ────────────────────────────

/**
 * 递归解析 XML 元素为 UniversalNode
 */
function parseElement($: CheerioAPI, el: AnyNode): UniversalNode | null {
  if (el.type !== 'tag') return null;

  const tag = (el as Element).tagName || '';
  // 去掉命名空间前缀 (如 androidx:LinearLayout → LinearLayout, 但通常命名空间在属性上)
  const localTag = tag.includes(':') ? tag.split(':').pop()! : tag;

  const $el = $(el);
  const style: UniversalStyle = {};

  // 通用属性: padding / margin / background
  const padding = parseAndroidBox($, el, 'padding');
  if (padding !== undefined) style.padding = padding;
  const margin = parseAndroidBox($, el, 'layout_margin');
  if (margin !== undefined) style.margin = margin;

  const bg = parseAndroidColor(getAndroidAttr($, el, 'background'));
  if (bg) style.background = bg;

  // layout_width / height: "match_parent" → "100%", "wrap_content" → 省略, "100dp" → 100
  const width = getAndroidAttr($, el, 'layout_width');
  if (width) {
    if (width === 'match_parent' || width === 'fill_parent') style.width = '100%';
    else { const w = parseAndroidDim(width); if (w) style.width = w; }
  }
  const height = getAndroidAttr($, el, 'layout_height');
  if (height) {
    if (height === 'match_parent' || height === 'fill_parent') style.height = '100%';
    else { const h = parseAndroidDim(height); if (h) style.height = h; }
  }

  // ── LinearLayout → row / column ──
  if (localTag === 'LinearLayout') {
    const orientation = getAndroidAttr($, el, 'orientation') || 'horizontal';
    // gravity → align
    const gravity = getAndroidAttr($, el, 'gravity');
    if (gravity) {
      if (gravity.includes('center')) style.align = 'center';
      else if (gravity.includes('start') || gravity.includes('left')) style.align = 'start';
      else if (gravity.includes('end') || gravity.includes('right')) style.align = 'end';
    }
    const children = parseChildren($, el);
    return {
      type: orientation === 'vertical' ? 'column' : 'row',
      style: Object.keys(style).length > 0 ? style : undefined,
      children: children.length > 0 ? children : undefined,
    };
  }

  // ── RelativeLayout / ConstraintLayout / FrameLayout → container / stack ──
  if (localTag === 'RelativeLayout' || localTag === 'ConstraintLayout' || localTag === 'FrameLayout' || localTag === 'CoordinatorLayout') {
    const children = parseChildren($, el);
    return {
      type: localTag === 'FrameLayout' ? 'stack' : 'container',
      style: Object.keys(style).length > 0 ? style : undefined,
      children: children.length > 0 ? children : undefined,
    };
  }

  // ── TextView → text ──
  if (localTag === 'TextView' || localTag === 'AppCompatTextView') {
    const content = getAndroidAttr($, el, 'text') || '';
    const color = parseAndroidColor(getAndroidAttr($, el, 'textColor'));
    if (color) style.color = color;
    const fontSize = parseAndroidDim(getAndroidAttr($, el, 'textSize'));
    if (fontSize) style.fontSize = fontSize;
    const textStyleAttr = getAndroidAttr($, el, 'textStyle');
    if (textStyleAttr === 'bold') style.fontWeight = 700;
    else if (textStyleAttr === 'normal') style.fontWeight = 400;
    const align = getAndroidAttr($, el, 'gravity');
    if (align) {
      if (align.includes('center')) style.textAlign = 'center';
      else if (align.includes('right') || align.includes('end')) style.textAlign = 'right';
      else if (align.includes('left') || align.includes('start')) style.textAlign = 'left';
    }
    return {
      type: 'text',
      content: content || '',
      style: Object.keys(style).length > 0 ? style : undefined,
    };
  }

  // ── Button → button ──
  if (localTag === 'Button' || localTag === 'ImageButton' || localTag === 'MaterialButton' || localTag === 'AppCompatButton') {
    const label = getAndroidAttr($, el, 'text') || 'Button';
    // style 推断: MaterialButton has style attr
    const styleAttr = getAndroidAttr($, el, 'style');
    let variant: ButtonVariant = 'filled';
    if (styleAttr?.includes('Borderless') || styleAttr?.includes('Text')) variant = 'text';
    else if (styleAttr?.includes('Outline')) variant = 'outlined';
    return {
      type: 'button',
      label,
      variant,
      style: Object.keys(style).length > 0 ? style : undefined,
    };
  }

  // ── EditText → input ──
  if (localTag === 'EditText' || localTag === 'TextInputEditText' || localTag === 'AutoCompleteTextView') {
    const placeholder = getAndroidAttr($, el, 'hint');
    const inputType = getAndroidAttr($, el, 'inputType') || '';
    let kind: InputKind = 'text';
    if (inputType.includes('textPassword')) kind = 'password';
    else if (inputType.includes('number')) kind = 'number';
    else if (inputType.includes('textEmailAddress')) kind = 'email';
    return {
      type: 'input',
      placeholder,
      kind,
      style: Object.keys(style).length > 0 ? style : undefined,
    };
  }

  // ── ImageView → image ──
  if (localTag === 'ImageView' || localTag === 'ImageButton') {
    let src = getAndroidAttr($, el, 'src') || undefined;
    if (src && src.startsWith('@drawable/')) {
      src = 'drawable:' + src.slice('@drawable/'.length);
    }
    const alt = getAndroidAttr($, el, 'contentDescription') || undefined;
    return {
      type: 'image',
      src,
      alt,
      style: Object.keys(style).length > 0 ? style : undefined,
    };
  }

  // ── View (作为 divider) → divider ──
  if (localTag === 'View' && getAndroidAttr($, el, 'layout_height')?.match(/^\d+dp$/)) {
    // 小高度的 View → divider
    const h = parseAndroidDim(getAndroidAttr($, el, 'layout_height'));
    if (h !== undefined && h <= 4) {
      return { type: 'divider', style: { height: h } };
    }
  }

  // ── Space → spacer ──
  if (localTag === 'Space') {
    return { type: 'spacer', style: Object.keys(style).length > 0 ? style : undefined };
  }

  // ── CardView → container (带圆角) ──
  if (localTag === 'CardView' || localTag === 'MaterialCardView') {
    const radius = parseAndroidDim(getAndroidAttr($, el, 'cardCornerRadius'));
    if (radius) style.radius = radius;
    if (!style.shadow) style.shadow = '0 2px 8px rgba(0,0,0,0.15)';
    const children = parseChildren($, el);
    return {
      type: 'container',
      style: Object.keys(style).length > 0 ? style : undefined,
      children: children.length > 0 ? children : undefined,
    };
  }

  // ── ScrollView / NestedScrollView → column (透传) ──
  if (localTag === 'ScrollView' || localTag === 'NestedScrollView' || localTag === 'HorizontalScrollView') {
    const children = parseChildren($, el);
    return {
      type: 'column',
      style: Object.keys(style).length > 0 ? style : undefined,
      children: children.length > 0 ? children : undefined,
    };
  }

  // ── WebView / 其他 → container (兜底) ──
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

export const androidXmlTranslator: Translator = {
  language: 'android',
  displayName: 'Android XML',

  /**
   * 检测代码是否为 Android XML 布局
   * 置信度:
   *   0.95 — 包含 android: 命名空间属性 + 布局根元素
   *   0.85 — 根元素是常见 Android Layout
   *   0.5 — 包含 android: 属性
   */
  detect(code: string): number {
    if (!code || typeof code !== 'string') return 0;
    const trimmed = code.trim();
    if (trimmed.length < 20) return 0;

    const hasAndroidNs = /xmlns:android=/.test(trimmed);
    const hasAndroidAttr = /\bandroid:\w+=/.test(trimmed);
    const hasLayout = /<(?:LinearLayout|RelativeLayout|ConstraintLayout|FrameLayout|CoordinatorLayout|ScrollView|CardView)\b/.test(trimmed);

    if (hasAndroidNs && hasLayout) return 0.95;
    if (hasLayout) return 0.85;
    if (hasAndroidAttr) return 0.5;

    return 0;
  },

  translate(code: string): UniversalNode {
    if (!code || typeof code !== 'string') {
      throw new TranslateError('android', 'code 为空');
    }

    let $: CheerioAPI;
    try {
      $ = cheerio.load(code, { xmlMode: true, decodeEntities: true });
    } catch (err: any) {
      throw new TranslateError('android', `XML 解析失败: ${err.message}`, code);
    }

    // 找根元素 (xmlMode 下第一个 tag)
    const root = $.root().children().first();
    if (!root || root.length === 0) {
      throw new TranslateError('android', '未找到根元素', code);
    }

    const node = parseElement($, root[0]);
    if (!node) {
      throw new TranslateError('android', '根元素无法解析', code);
    }
    return node;
  },
};
