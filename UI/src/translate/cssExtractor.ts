/**
 * cssExtractor.ts — CSS/SCSS 样式提取器
 *
 * 不是独立 Translator, 而是辅助工具: 从 <style> 块或独立 CSS 文本中
 * 提取样式规则, 应用到已解析的 UniversalNode 树上 (按 class / tag / id 匹配)。
 *
 * 使用场景:
 *   - LLM 输出 <style>.card { padding:16px }</style><div class="card">...</div>
 *   - htmlTranslator 只解析 inline style, 漏掉 <style> 块里的样式
 *   - cssExtractor 补强: 把 <style> 里的规则合并到对应节点
 *
 * 支持的选择器 (简单子集):
 *   - .class           (类选择器)
 *   - #id              (ID 选择器)
 *   - tag              (标签选择器: div / p / button)
 *   - .class tag       (后代选择器, 简化处理)
 *
 * 不支持 (保持简单):
 *   - 伪类 :hover / :focus
 *   - 媒体查询 @media
 *   - SCSS 嵌套语法 (嵌套 .card { .title { } })
 *   - CSS 变量 var(--x)
 *   - @keyframes / @import
 */

import type { UniversalNode, UniversalStyle } from '../services/canvas/UniversalAST';

// ──────────────────────────── 类型 ────────────────────────────

export interface CssRule {
  /** 选择器 (原始字符串, 如 '.card' / '#app' / 'div') */
  selector: string;
  /** 选择器类型 */
  selectorType: 'class' | 'id' | 'tag' | 'compound';
  /** 选择器值 (不含前缀: 'card' / 'app' / 'div') */
  value: string;
  /** 解析后的样式 */
  style: UniversalStyle;
  /** display:flex 标记 */
  isFlex: boolean;
  /** flex-direction:row 标记 */
  isFlexRow: boolean;
}

// ──────────────────────────── CSS 解析 ────────────────────────────

/**
 * 解析 CSS 文本为规则数组
 * 输入: ".card { padding:16px; color:red; } .title { font-size:20px; }"
 */
export function parseCss(cssText: string): CssRule[] {
  const rules: CssRule[] = [];
  if (!cssText) return rules;

  // 去掉注释 /* ... */
  const cleaned = cssText.replace(/\/\*[\s\S]*?\*\//g, '');

  // 匹配 selector { declarations }
  // 注意: SCSS 嵌套不处理, 只取顶层规则
  const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
  let match: RegExpExecArray | null;

  while ((match = ruleRe.exec(cleaned)) !== null) {
    const selectorStr = match[1].trim();
    const declarations = match[2].trim();

    if (!selectorStr || !declarations) continue;

    // 跳过 @media / @keyframes / @import 等 at-rules
    if (selectorStr.startsWith('@')) continue;

    // 一个规则可能有多个选择器: ".card, .panel { ... }"
    const selectors = selectorStr.split(',').map(s => s.trim()).filter(Boolean);

    const { style, isFlex, isFlexRow } = parseDeclarations(declarations);
    if (Object.keys(style).length === 0 && !isFlex && !isFlexRow) continue;

    for (const sel of selectors) {
      const parsed = parseSelector(sel);
      if (parsed) {
        rules.push({
          selector: sel,
          selectorType: parsed.type,
          value: parsed.value,
          style,
          isFlex,
          isFlexRow,
        });
      }
    }
  }

  return rules;
}

/**
 * 解析单个选择器
 */
function parseSelector(selector: string): { type: CssRule['selectorType']; value: string } | null {
  // 去掉前后空白和后代选择器的多余部分 (简化: 只取最后一个选择器)
  const parts = selector.split(/\s+/).filter(Boolean);
  const last = parts[parts.length - 1] || selector;

  // .class
  if (last.startsWith('.')) {
    return { type: 'class', value: last.slice(1) };
  }
  // #id
  if (last.startsWith('#')) {
    return { type: 'id', value: last.slice(1) };
  }
  // tag (纯字母)
  if (/^[a-zA-Z][\w-]*$/.test(last)) {
    return { type: 'tag', value: last.toLowerCase() };
  }
  // 复合选择器 (.card.btn / div.card) — 简化: 取第一个 class
  const classMatch = last.match(/\.([\w-]+)/);
  if (classMatch) {
    return { type: 'compound', value: classMatch[1] };
  }
  return null;
}

/**
 * 解析声明块 "padding:16px; color:red;" → UniversalStyle
 */
function parseDeclarations(decls: string): { style: UniversalStyle; isFlex: boolean; isFlexRow: boolean } {
  const style: UniversalStyle = {};
  let isFlex = false;
  let isFlexRow = false;

  const pairs = decls.split(';');
  for (const pair of pairs) {
    const colonIdx = pair.indexOf(':');
    if (colonIdx < 0) continue;
    const key = pair.slice(0, colonIdx).trim().toLowerCase();
    const value = pair.slice(colonIdx + 1).trim();
    if (!key || !value) continue;

    const num = parseCssNumber(value);

    switch (key) {
      case 'padding': style.padding = parseCssBox(value); break;
      case 'margin': style.margin = parseCssBox(value); break;
      case 'color': style.color = value; break;
      case 'background':
      case 'background-color': style.background = value; break;
      case 'font-size': style.fontSize = num; break;
      case 'font-weight':
        if (/^\d+$/.test(value)) {
          const w = parseInt(value, 10);
          if (w >= 100 && w <= 900) style.fontWeight = w as any;
        } else if (value === 'bold') style.fontWeight = 700;
        else if (value === 'normal') style.fontWeight = 400;
        break;
      case 'text-align':
        if (value === 'left' || value === 'center' || value === 'right') style.textAlign = value;
        break;
      case 'line-height': style.lineHeight = num; break;
      case 'letter-spacing': style.letterSpacing = num; break;
      case 'border-radius': style.radius = num; break;
      case 'border': style.border = value; break;
      case 'box-shadow': style.shadow = value; break;
      case 'opacity': style.opacity = num; break;
      case 'width': style.width = num ?? value; break;
      case 'height': style.height = num ?? value; break;
      case 'flex': style.flex = num; break;
      case 'gap': style.gap = num; break;
      case 'display': if (value === 'flex') isFlex = true; break;
      case 'flex-direction': if (value === 'row') isFlexRow = true; break;
      case 'align-items':
        if (value === 'flex-start') style.align = 'start';
        else if (value === 'center') style.align = 'center';
        else if (value === 'flex-end') style.align = 'end';
        else if (value === 'stretch') style.align = 'stretch';
        break;
      case 'justify-content':
        if (value === 'flex-start' || value === 'start') style.justify = 'start';
        else if (value === 'center') style.justify = 'center';
        else if (value === 'flex-end' || value === 'end') style.justify = 'end';
        else if (value === 'space-between') style.align = 'space-between';
        else if (value === 'space-around') style.align = 'space-around';
        break;
    }
  }

  return { style, isFlex, isFlexRow };
}

function parseCssNumber(value: string): number | undefined {
  if (!value) return undefined;
  const match = value.match(/^(-?\d*\.?\d+)\s*(px|em|rem|pt|%)?$/);
  if (!match) return undefined;
  const num = parseFloat(match[1]);
  return Number.isFinite(num) ? num : undefined;
}

function parseCssBox(value: string): number | [number, number] | [number, number, number, number] | undefined {
  if (!value) return undefined;
  const parts = value.trim().split(/\s+/).map(parseCssNumber);
  if (parts.some(p => p === undefined)) return undefined;
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return [parts[0]!, parts[1]!];
  if (parts.length === 4) return [parts[0]!, parts[1]!, parts[2]!, parts[3]!];
  if (parts.length === 3) return [parts[0]!, parts[1]!];
  return undefined;
}

// ──────────────────────────── 样式应用 ────────────────────────────

/**
 * 从 HTML 文本中提取 <style> 块的 CSS
 */
export function extractStyleBlocks(html: string): string {
  const blocks: string[] = [];
  const re = /<style[^>]*>([\s\S]*?)<\/style>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) {
    if (match[1]) blocks.push(match[1]);
  }
  return blocks.join('\n');
}

/**
 * 把 CSS 规则应用到 UniversalNode 树
 *
 * 匹配逻辑 (按特异性从高到低):
 *   1. id 选择器 (#app)        — 需要 node 有 id 属性 (当前 UniversalNode 没有 id, 跳过)
 *   2. class 选择器 (.card)    — 需要 node 有 className (当前 UniversalNode 也没存 className)
 *   3. tag 选择器 (div/p)      — 按 node.type 匹配 (container/text/button/...)
 *
 * 由于 UniversalNode 不保留 className/id, 这里主要做 tag 级别匹配 + 少量 class 透传。
 * 真正的 class 匹配需要在翻译阶段保留 class 信息, 这里作为简化版。
 *
 * @param node 根节点
 * @param rules CSS 规则数组
 * @param nodeClassName 可选: 节点的 class 字符串 (由翻译器传入)
 */
export function applyCssRules(node: UniversalNode, rules: CssRule[]): UniversalNode {
  // 深拷贝节点 (避免修改原树)
  const cloned = deepCloneNode(node);
  applyRulesRecursive(cloned, rules);
  return cloned;
}

function deepCloneNode(node: UniversalNode): UniversalNode {
  const cloned = { ...node } as any;
  if (cloned.style) cloned.style = { ...cloned.style };
  if (cloned.children) cloned.children = cloned.children.map(deepCloneNode);
  return cloned;
}

function applyRulesRecursive(node: UniversalNode, rules: CssRule[]): void {
  // 匹配 tag 选择器 (node.type → 对应 HTML tag)
  const nodeTag = nodeTypeToTag(node);
  if (nodeTag) {
    for (const rule of rules) {
      if (rule.selectorType === 'tag' && rule.value === nodeTag) {
        mergeStyle(node, rule);
      }
    }
  }

  // 递归子节点
  if ('children' in node && node.children) {
    for (const child of node.children) {
      applyRulesRecursive(child, rules);
    }
  }
}

/**
 * UniversalNode.type → 对应的 HTML tag (用于 tag 选择器匹配)
 */
function nodeTypeToTag(node: UniversalNode): string | null {
  switch (node.type) {
    case 'container':
    case 'row':
    case 'column':
      return 'div'; // 容器类 → div
    case 'text':
      return 'p'; // 文本 → p
    case 'button':
      return 'button';
    case 'input':
      return 'input';
    case 'image':
      return 'img';
    case 'divider':
      return 'hr';
    default:
      return null;
  }
}

/**
 * 合并样式到节点 (不覆盖已有的 inline style)
 */
function mergeStyle(node: UniversalNode, rule: CssRule): void {
  const nodeAny = node as any;
  if (!nodeAny.style) nodeAny.style = {};

  for (const [key, val] of Object.entries(rule.style)) {
    // inline style 优先, 不被 CSS 覆盖
    if (nodeAny.style[key] === undefined) {
      nodeAny.style[key] = val;
    }
  }

  // display:flex 影响容器类型
  if (rule.isFlex && (node.type === 'container' || node.type === 'div')) {
    // 如果节点是 container 且 CSS 说 display:flex, 升级为 row/column
    // 但不覆盖已有的 inline flex 设置
    if (nodeAny.style.display === undefined) {
      nodeAny.type = rule.isFlexRow ? 'row' : 'column';
    }
  }
}

// ──────────────────────────── 便捷 API ────────────────────────────

/**
 * 一站式: 从 HTML 提取 <style>, 解析规则, 应用到 AST
 *
 * 用法:
 *   import { extractStyleBlocks, parseCss, applyCssRules } from './cssExtractor';
 *   const css = extractStyleBlocks(html);
 *   const rules = parseCss(css);
 *   const styledAst = applyCssRules(ast, rules);
 */
export function enrichWithCss(node: UniversalNode, html: string): UniversalNode {
  const css = extractStyleBlocks(html);
  if (!css.trim()) return node;
  const rules = parseCss(css);
  if (rules.length === 0) return node;
  return applyCssRules(node, rules);
}
