/**
 * htmlTranslator.ts — HTML → Universal AST 翻译器
 *
 * 将 HTML 字符串解析成 UniversalNode 树, 让画布能渲染任意 HTML 页面。
 * 纯本地解析 (cheerio), 不消耗 LLM token。
 *
 * 支持的 HTML 标签:
 *   - div/section/article/nav/header/footer/main → container
 *   - display:flex + flex-direction:row 的 div → row
 *   - display:flex 的 div (默认) → column
 *   - p/h1-h6/span/label/a/strong/em → text
 *   - button → button
 *   - input/textarea → input
 *   - img → image
 *   - hr → divider
 *   - ul/ol → column (children 是 li)
 *   - li → container
 *   - svg → 透传 (Flutter 端 flutter_svg 已支持)
 *
 * Style 解析 (inline style 属性):
 *   padding:16px → padding: 16
 *   margin:8px 12px → margin: [8, 12]
 *   color:red → color: "red"
 *   background:#fff → background: "#fff"
 *   font-size:14px → fontSize: 14
 *   border-radius:8px → radius: 8
 *   display:flex + flex-direction:row → 决定容器类型 (row)
 *
 * 不支持 (保持简单):
 *   - <style> 标签里的 CSS (只解析 inline style)
 *   - <script> 标签 (忽略)
 *   - CSS 选择器 (.class / #id)
 *   - 响应式布局 (media query)
 */

import * as cheerio from 'cheerio';
import type { CheerioAPI, AnyNode, Element } from 'cheerio';
import type { UniversalNode, UniversalStyle, ButtonVariant, InputKind } from '../services/canvas/UniversalAST';
import { TranslateError, type Translator } from './types';

// ──────────────────────────── 工具函数 ────────────────────────────

/**
 * 解析 CSS 数字值 "16px" → 16, "1.5em" → 1.5
 * 非数字返回 undefined
 */
function parseCssNumber(value: string): number | undefined {
  if (!value) return undefined;
  const match = value.match(/^(-?\d*\.?\d+)\s*(px|em|rem|pt|%)?$/);
  if (!match) return undefined;
  const num = parseFloat(match[1]);
  return Number.isFinite(num) ? num : undefined;
}

/**
 * 解析 CSS 四边值 "8px 12px" → [8, 12], "1px 2px 3px 4px" → [1,2,3,4]
 * 单值 "16px" → 16
 */
function parseCssBox(value: string): number | [number, number] | [number, number, number, number] | undefined {
  if (!value) return undefined;
  const parts = value.trim().split(/\s+/).map(parseCssNumber);
  if (parts.some(p => p === undefined)) return undefined;

  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return [parts[0]!, parts[1]!];
  if (parts.length === 4) return [parts[0]!, parts[1]!, parts[2]!, parts[3]!];
  // 3 个值时简化为 2 个 (top/bottom, left/right)
  if (parts.length === 3) return [parts[0]!, parts[1]!];
  return undefined;
}

/**
 * 解析 inline style 字符串为 UniversalStyle 对象
 * "padding:16px;color:red;font-size:14px" → { padding: 16, color: "red", fontSize: 14 }
 */
function parseInlineStyle(styleStr: string | undefined): { style: UniversalStyle; isFlexRow: boolean; isFlex: boolean } {
  const result: UniversalStyle = {};
  let isFlexRow = false;
  let isFlex = false;

  if (!styleStr) return { style: result, isFlexRow, isFlex };

  // 分号分隔, 注意可能有 background:linear-gradient(..., ...) 这种带逗号的值
  const declarations = styleStr.split(/;(?![^()]*\))/);

  for (const decl of declarations) {
    const colonIdx = decl.indexOf(':');
    if (colonIdx < 0) continue;

    const key = decl.slice(0, colonIdx).trim().toLowerCase();
    const value = decl.slice(colonIdx + 1).trim();

    if (!key || !value) continue;

    switch (key) {
      case 'padding':
        result.padding = parseCssBox(value);
        break;
      case 'margin':
        result.margin = parseCssBox(value);
        break;
      case 'color':
        result.color = value;
        break;
      case 'background':
      case 'background-color':
        result.background = value;
        break;
      case 'font-size':
        result.fontSize = parseCssNumber(value);
        break;
      case 'font-weight':
        if (/^\d+$/.test(value)) {
          const w = parseInt(value, 10);
          if (w >= 100 && w <= 900) result.fontWeight = w as any;
        } else if (value === 'bold') {
          result.fontWeight = 700;
        } else if (value === 'normal') {
          result.fontWeight = 400;
        }
        break;
      case 'text-align':
        if (value === 'left' || value === 'center' || value === 'right') {
          result.textAlign = value;
        }
        break;
      case 'line-height':
        result.lineHeight = parseCssNumber(value);
        break;
      case 'letter-spacing':
        result.letterSpacing = parseCssNumber(value);
        break;
      case 'border-radius':
        result.radius = parseCssNumber(value);
        break;
      case 'border':
        result.border = value;
        break;
      case 'box-shadow':
        result.shadow = value;
        break;
      case 'opacity':
        result.opacity = parseCssNumber(value);
        break;
      case 'width':
        result.width = parseCssNumber(value) ?? value;
        break;
      case 'height':
        result.height = parseCssNumber(value) ?? value;
        break;
      case 'flex':
        result.flex = parseCssNumber(value);
        break;
      case 'gap':
        result.gap = parseCssNumber(value);
        break;
      case 'display':
        if (value === 'flex') isFlex = true;
        break;
      case 'flex-direction':
        if (value === 'row') isFlexRow = true;
        break;
      case 'align-items':
        if (value === 'flex-start') result.align = 'start';
        else if (value === 'center') result.align = 'center';
        else if (value === 'flex-end') result.align = 'end';
        else if (value === 'stretch') result.align = 'stretch';
        break;
      case 'justify-content':
        if (value === 'flex-start' || value === 'start') result.justify = 'start';
        else if (value === 'center') result.justify = 'center';
        else if (value === 'flex-end' || value === 'end') result.justify = 'end';
        else if (value === 'space-between') result.align = 'space-between';
        else if (value === 'space-around') result.align = 'space-around';
        break;
      // 忽略不支持的属性
    }
  }

  return { style: result, isFlexRow, isFlex };
}

/**
 * 解析 button variant 从 class 或 style 推断
 */
function inferButtonVariant($: CheerioAPI, el: AnyNode): ButtonVariant {
  const $el = $(el);
  const cls = $el.attr('class') || '';
  const style = $el.attr('style') || '';

  // class 优先
  if (/btn-(outline|text)/.test(cls) || /outline|text/.test(cls)) {
    if (/text/.test(cls)) return 'text';
    if (/outline/.test(cls)) return 'outlined';
  }
  // style 推断: 有 background → filled, 有 border 无 background → outlined
  if (/background[^:]*:\s*[^;]+/.test(style) && !/background:\s*(transparent|none)/.test(style)) {
    return 'filled';
  }
  if (/border[^:]*:\s*[^;]+/.test(style)) {
    return 'outlined';
  }
  return 'filled';
}

/**
 * 解析 input kind 从 type 属性
 */
function inferInputKind(typeAttr: string | undefined): InputKind {
  switch (typeAttr) {
    case 'password': return 'password';
    case 'email': return 'email';
    case 'number': return 'number';
    default: return 'text';
  }
}

// ──────────────────────────── 核心翻译 ────────────────────────────

/**
 * 递归解析 cheerio 节点为 UniversalNode
 */
function parseNode($: CheerioAPI, el: AnyNode): UniversalNode | null {
  // 只处理 Element 节点 (跳过 text/comment/processing instruction)
  if (el.type !== 'tag') {
    return null;
  }

  const tag = (el as Element).tagName?.toLowerCase();
  if (!tag) return null;

  // 显式忽略 script/style (不渲染)
  if (tag === 'script' || tag === 'style') {
    return null;
  }

  const $el = $(el);
  const styleStr = $el.attr('style');
  const { style, isFlexRow, isFlex } = parseInlineStyle(styleStr);

  // ── 容器类标签 → container / row / column ──
  const containerTags = ['div', 'section', 'article', 'nav', 'header', 'footer', 'main', 'aside', 'form', 'li'];
  if (containerTags.includes(tag)) {
    // 决定容器类型: flex + row → row, flex (默认 column) → column, 其他 → container
    let containerType: 'container' | 'row' | 'column' = 'container';
    if (isFlex) {
      containerType = isFlexRow ? 'row' : 'column';
    }

    const children: UniversalNode[] = [];
    $(el).children().each((_, child) => {
      const node = parseNode($, child);
      if (node) children.push(node);
    });

    return {
      type: containerType,
      style: Object.keys(style).length > 0 ? style : undefined,
      children: children.length > 0 ? children : undefined,
    };
  }

  // ── 列表 → column + children ──
  if (tag === 'ul' || tag === 'ol') {
    const children: UniversalNode[] = [];
    $(el).children('li').each((_, li) => {
      const node = parseNode($, li);
      if (node) children.push(node);
    });
    return {
      type: 'column',
      style: Object.keys(style).length > 0 ? style : undefined,
      children: children.length > 0 ? children : undefined,
    };
  }

  // ── 文本类标签 → text ──
  const textTags = ['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'span', 'label', 'a', 'strong', 'em', 'b', 'i', 'small', 'code', 'pre'];
  if (textTags.includes(tag)) {
    const content = $el.text().trim();
    // 标题字号推断
    if (tag.startsWith('h')) {
      const hLevel = parseInt(tag.slice(1), 10);
      const sizeMap: Record<number, number> = { 1: 32, 2: 24, 3: 20, 4: 16, 5: 14, 6: 12 };
      if (!style.fontSize) style.fontSize = sizeMap[hLevel] || 16;
      if (!style.fontWeight) style.fontWeight = 700;
    }
    return {
      type: 'text',
      content: content || '',
      style: Object.keys(style).length > 0 ? style : undefined,
    };
  }

  // ── button → button ──
  if (tag === 'button') {
    const label = $el.text().trim();
    return {
      type: 'button',
      label: label || 'Button',
      variant: inferButtonVariant($, el),
      style: Object.keys(style).length > 0 ? style : undefined,
    };
  }

  // ── input/textarea → input ──
  if (tag === 'input' || tag === 'textarea') {
    const inputKind = inferInputKind($el.attr('type'));
    const placeholder = $el.attr('placeholder') || undefined;
    const value = $el.attr('value') || undefined;
    return {
      type: 'input',
      placeholder,
      value,
      kind: inputKind,
      style: Object.keys(style).length > 0 ? style : undefined,
    };
  }

  // ── img → image ──
  if (tag === 'img') {
    return {
      type: 'image',
      src: $el.attr('src') || undefined,
      alt: $el.attr('alt') || undefined,
      style: Object.keys(style).length > 0 ? style : undefined,
    };
  }

  // ── hr → divider ──
  if (tag === 'hr') {
    return {
      type: 'divider',
      style: Object.keys(style).length > 0 ? style : undefined,
    };
  }

  // ── br → spacer (小间距) ──
  if (tag === 'br') {
    return { type: 'spacer', style: { height: 8 } };
  }

  // ── svg → 透传 (Flutter flutter_svg 已支持)
  //    把整个 SVG 元素的 outerHTML 作为 content 传给 svg 节点
  if (tag === 'svg') {
    const svgHtml = $.html(el);
    return {
      type: 'svg' as any,  // UniversalAST.ts 还没加 svg 类型, 用 any 兜底
      props: { content: svgHtml, width: style.width, height: style.height },
    } as any;
  }

  // ── 未知标签 → container (兜底, 递归解析子节点) ──
  const children: UniversalNode[] = [];
  $(el).children().each((_, child) => {
    const node = parseNode($, child);
    if (node) children.push(node);
  });
  return {
    type: 'container',
    style: Object.keys(style).length > 0 ? style : undefined,
    children: children.length > 0 ? children : undefined,
  };
}

// ──────────────────────────── 翻译器实现 ────────────────────────────

export const htmlTranslator: Translator = {
  language: 'html',
  displayName: 'HTML',

  /**
   * 检测代码是否为 HTML
   * 置信度:
   *   0.9 — 以 <html 或 <!DOCTYPE html> 开头
   *   0.7 — 包含 <div>/<p>/<button>/<input>/<section> 等常见标签
   *   0.3 — 包含任意 <tag> 模式
   *   0 — 不匹配
   */
  detect(code: string): number {
    if (!code || typeof code !== 'string') return 0;
    const trimmed = code.trim();

    // 完整 HTML 文档
    if (/^<!doctype\s+html>/i.test(trimmed) || /^<html[\s>]/i.test(trimmed)) return 0.9;

    // 常见 HTML 标签 (必须以 < 开头, 排除 JSX/React)
    const hasHtmlTag = /<(div|section|article|nav|header|footer|main|p|span|button|input|img|form|ul|ol|li|h[1-6])\b[\s>]/i.test(trimmed);
    const looksLikeHtml = trimmed.startsWith('<') && !/^\s*</.test(trimmed.replace(/^\s+/, ''));
    if (hasHtmlTag) return 0.7;

    // 任意 <tag> 模式 (低置信度, 可能是 JSX/XML)
    if (/^<[\w-]+[\s>]/.test(trimmed)) return 0.3;

    return 0;
  },

  /**
   * 翻译 HTML 为 Universal AST
   * @throws TranslateError 当 cheerio 解析失败时
   */
  translate(code: string): UniversalNode {
    if (!code || typeof code !== 'string') {
      throw new TranslateError('html', 'code 为空');
    }

    let $: CheerioAPI;
    try {
      $ = cheerio.load(code, { decodeEntities: true });
    } catch (err: any) {
      throw new TranslateError('html', `cheerio 解析失败: ${err.message}`, code);
    }

    // 找根节点: 优先 body > 直接子元素, 否则用第一个顶级标签
    let rootEl: AnyNode | null = null;

    const bodyChildren = $('body').children().toArray();
    if (bodyChildren.length > 0) {
      // body 有子元素: 取第一个作为根 (或把 body 内容包成一个 container)
      if (bodyChildren.length === 1) {
        rootEl = bodyChildren[0];
      } else {
        // 多个顶级元素: 包成 column 容器
        const children: UniversalNode[] = [];
        for (const child of bodyChildren) {
          const node = parseNode($, child);
          if (node) children.push(node);
        }
        return {
          type: 'column',
          children,
        };
      }
    } else {
      // body 无标签子节点: 检查是否有纯文本
      const bodyText = $('body').text().trim();
      if (bodyText) {
        return { type: 'text', content: bodyText };
      }

      // 没有 body (可能是 HTML 片段): 找第一个顶级标签
      const topTags = $.root().children().toArray().filter(n => n.type === 'tag');
      if (topTags.length === 0) {
        // 纯文本: 包成 text 节点
        const text = $.root().text().trim();
        return { type: 'text', content: text || '(空 HTML)' };
      }
      if (topTags.length === 1) {
        rootEl = topTags[0];
      } else {
        const children: UniversalNode[] = [];
        for (const child of topTags) {
          const node = parseNode($, child);
          if (node) children.push(node);
        }
        return { type: 'column', children };
      }
    }

    if (!rootEl) {
      throw new TranslateError('html', '无法找到根元素', code);
    }

    const result = parseNode($, rootEl);
    if (!result) {
      throw new TranslateError('html', '根元素解析返回 null', code);
    }

    return result;
  },
};
