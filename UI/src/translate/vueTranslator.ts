/**
 * vueTranslator.ts — Vue SFC → Universal AST 翻译器
 *
 * 将 Vue 单文件组件 (.vue) 解析成 UniversalNode 树, 让画布能渲染 LLM 生成的 Vue 组件。
 * 纯本地解析 (@vue/compiler-sfc), 不消耗 LLM token。
 *
 * 支持的输入形态:
 *   1. 完整 SFC:  <template>...</template><script>...</script><style>...</style>
 *   2. 仅 template 片段:  <template><div>...</div></template>
 *   3. 裸 HTML 片段 (无 <template> 包裹): 回退到 cheerio-style 解析
 *
 * 标签映射 (与 htmlTranslator / reactTranslator 一致):
 *   - div/section/article/nav/header/footer/main/form/li → container / row / column
 *   - p/h1-h6/span/label/a/strong/em → text
 *   - button → button
 *   - input/textarea → input
 *   - img → image
 *   - hr → divider
 *   - 自定义组件 <MyComponent /> → container (不透明盒子)
 *
 * Vue 特定指令处理:
 *   - :style="{ padding:16 }" (v-bind:style)  → UniversalStyle (对象字面量)
 *   - style="padding:16px" (静态)             → UniversalStyle (CSS 字符串)
 *   - :class="..."                            → 跳过 (动态 class 无法静态求值)
 *   - class="btn-primary"                     → button variant 推断
 *   - {{ expression }}                        → text 节点 (变量作为占位 '{{expr}}')
 *   - v-if="cond"                             → 保留 (无法静态求值时默认渲染)
 *   - v-for="item in list"                    → 只渲染第一个子节点 (列表占位)
 *   - @click / v-on:click                     → 忽略 (事件绑定不影响布局)
 *
 * 不支持 (保持简单):
 *   - <style scoped> 里的 CSS (只解析 inline style + :style 绑定)
 *   - slot / scoped slot
 *   - <script setup> 的响应式数据求值
 *   - 动态组件 <component :is="...">
 */

import { parse as parseSfc } from '@vue/compiler-sfc';
import { parse as parseTemplate } from '@vue/compiler-dom';
import type {
  ElementNode,
  TextNode,
  InterpolationNode,
  CommentNode,
  AttributeNode,
  DirectiveNode,
  TemplateChildNode,
  RootNode,
} from '@vue/compiler-core';
import type { UniversalNode, UniversalStyle, ButtonVariant, InputKind } from '../services/canvas/UniversalAST';
import { TranslateError, type Translator } from './types';

// ──────────────────────────── 工具函数 ────────────────────────────

const CONTAINER_TAGS = ['div', 'section', 'article', 'nav', 'header', 'footer', 'main', 'aside', 'form', 'li'];
const TEXT_TAGS = ['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'span', 'label', 'a', 'strong', 'em', 'b', 'i', 'small', 'code', 'pre'];

/**
 * 判断标签名是否为 HTML 原生标签 (小写开头, 含连字符)
 * Vue 组件: <MyComponent /> 或 <my-component />
 */
function isHtmlTag(name: string): boolean {
  return /^[a-z]/.test(name);
}

/**
 * 解析 CSS 数字值: 16 → 16, "16px" → 16, "1.5em" → 1.5
 */
function parseCssNumber(value: string | number): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (!value) return undefined;
  const match = value.match(/^(-?\d*\.?\d+)\s*(px|em|rem|pt|%)?$/);
  if (!match) return undefined;
  const num = parseFloat(match[1]);
  return Number.isFinite(num) ? num : undefined;
}

/**
 * 解析 CSS 四边值: "8px 12px" → [8, 12]
 */
function parseCssBox(value: string | number): number | [number, number] | [number, number, number, number] | undefined {
  if (typeof value === 'number') return value;
  if (!value) return undefined;
  const parts = value.trim().split(/\s+/).map(parseCssNumber);
  if (parts.some(p => p === undefined)) return undefined;
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return [parts[0]!, parts[1]!];
  if (parts.length === 4) return [parts[0]!, parts[1]!, parts[2]!, parts[3]!];
  if (parts.length === 3) return [parts[0]!, parts[1]!];
  return undefined;
}

/**
 * 解析静态 style 字符串 "padding:16px;color:red"
 * (与 htmlTranslator 的 parseInlineStyle 同逻辑)
 */
function parseStaticStyle(styleStr: string): { style: UniversalStyle; isFlexRow: boolean; isFlex: boolean } {
  const style: UniversalStyle = {};
  let isFlexRow = false;
  let isFlex = false;

  if (!styleStr) return { style, isFlexRow, isFlex };

  const declarations = styleStr.split(/;(?![^()]*\))/);

  for (const decl of declarations) {
    const colonIdx = decl.indexOf(':');
    if (colonIdx < 0) continue;
    const key = decl.slice(0, colonIdx).trim().toLowerCase();
    const value = decl.slice(colonIdx + 1).trim();
    if (!key || !value) continue;

    switch (key) {
      case 'padding': style.padding = parseCssBox(value); break;
      case 'margin': style.margin = parseCssBox(value); break;
      case 'color': style.color = value; break;
      case 'background':
      case 'background-color': style.background = value; break;
      case 'font-size': style.fontSize = parseCssNumber(value); break;
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
      case 'line-height': style.lineHeight = parseCssNumber(value); break;
      case 'letter-spacing': style.letterSpacing = parseCssNumber(value); break;
      case 'border-radius': style.radius = parseCssNumber(value); break;
      case 'border': style.border = value; break;
      case 'box-shadow': style.shadow = value; break;
      case 'opacity': style.opacity = parseCssNumber(value); break;
      case 'width': style.width = parseCssNumber(value) ?? value; break;
      case 'height': style.height = parseCssNumber(value) ?? value; break;
      case 'flex': style.flex = parseCssNumber(value); break;
      case 'gap': style.gap = parseCssNumber(value); break;
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

  return { style, isFlexRow, isFlex };
}

/**
 * 从 :style="{...}" 绑定表达式提取 style 对象
 * 表达式是 JS 对象字面量字符串: "{ padding: 16, color: 'red' }"
 *
 * 简单解析: 用正则提取 key:value 对 (不依赖完整 JS parser)
 * 能处理: 字符串值 'red'/数字 16/布尔 true
 */
function parseBoundStyle(exp: string): { style: UniversalStyle; isFlexRow: boolean; isFlex: boolean } {
  const style: UniversalStyle = {};
  let isFlexRow = false;
  let isFlex = false;

  if (!exp) return { style, isFlexRow, isFlex };

  // 去掉外层 {}
  let inner = exp.trim();
  if (inner.startsWith('{')) inner = inner.slice(1);
  if (inner.endsWith('}')) inner = inner.slice(0, -1);

  // 匹配 key: value (key 可能带引号, value 可能是字符串/数字/布尔)
  // 简单分词: 按逗号分割 (但忽略对象/数组内的逗号 — 这里保持简单, 不处理嵌套对象)
  const pairs = inner.split(/,(?![^{}[\]]*[}\]])/);

  for (const pair of pairs) {
    const colonIdx = pair.indexOf(':');
    if (colonIdx < 0) continue;
    let key = pair.slice(0, colonIdx).trim();
    const valStr = pair.slice(colonIdx + 1).trim();

    // 去掉 key 的引号
    if ((key.startsWith("'") && key.endsWith("'")) || (key.startsWith('"') && key.endsWith('"'))) {
      key = key.slice(1, -1);
    }
    key = key.toLowerCase();
    if (!key) continue;

    // 解析 value
    let val: string | number | boolean | undefined;
    if ((valStr.startsWith("'") && valStr.endsWith("'")) || (valStr.startsWith('"') && valStr.endsWith('"'))) {
      val = valStr.slice(1, -1);
    } else if (valStr === 'true') {
      val = true;
    } else if (valStr === 'false') {
      val = false;
    } else {
      const num = parseFloat(valStr);
      if (Number.isFinite(num) && /^\s*-?\d*\.?\d+\s*$/.test(valStr)) val = num;
    }
    if (val === undefined) continue;

    switch (key) {
      case 'padding': style.padding = typeof val === 'string' ? parseCssBox(val) : val; break;
      case 'margin': style.margin = typeof val === 'string' ? parseCssBox(val) : val; break;
      case 'color': if (typeof val === 'string') style.color = val; break;
      case 'background':
      case 'backgroundcolor': if (typeof val === 'string') style.background = val; break;
      case 'fontsize': style.fontSize = typeof val === 'string' ? parseCssNumber(val) : val; break;
      case 'fontweight':
        if (typeof val === 'number' && val >= 100 && val <= 900) style.fontWeight = val as any;
        else if (val === 'bold') style.fontWeight = 700;
        else if (val === 'normal') style.fontWeight = 400;
        break;
      case 'textalign':
        if (val === 'left' || val === 'center' || val === 'right') style.textAlign = val;
        break;
      case 'lineheight': style.lineHeight = typeof val === 'string' ? parseCssNumber(val) : val; break;
      case 'letterspacing': style.letterSpacing = typeof val === 'string' ? parseCssNumber(val) : val; break;
      case 'borderradius':
      case 'radius': style.radius = typeof val === 'string' ? parseCssNumber(val) : val; break;
      case 'border': if (typeof val === 'string') style.border = val; break;
      case 'boxshadow':
      case 'shadow': if (typeof val === 'string') style.shadow = val; break;
      case 'opacity': style.opacity = typeof val === 'string' ? parseCssNumber(val) : val; break;
      case 'width': style.width = typeof val === 'string' ? (parseCssNumber(val) ?? val) : val; break;
      case 'height': style.height = typeof val === 'string' ? (parseCssNumber(val) ?? val) : val; break;
      case 'flex': style.flex = typeof val === 'string' ? parseCssNumber(val) : val; break;
      case 'gap': style.gap = typeof val === 'string' ? parseCssNumber(val) : val; break;
      case 'display': if (val === 'flex') isFlex = true; break;
      case 'flexdirection': if (val === 'row') isFlexRow = true; break;
      case 'alignitems':
        if (val === 'flex-start' || val === 'start') style.align = 'start';
        else if (val === 'center') style.align = 'center';
        else if (val === 'flex-end' || val === 'end') style.align = 'end';
        else if (val === 'stretch') style.align = 'stretch';
        break;
      case 'justifycontent':
        if (val === 'flex-start' || val === 'start') style.justify = 'start';
        else if (val === 'center') style.justify = 'center';
        else if (val === 'flex-end' || val === 'end') style.justify = 'end';
        else if (val === 'space-between') style.align = 'space-between';
        else if (val === 'space-around') style.align = 'space-around';
        break;
    }
  }

  return { style, isFlexRow, isFlex };
}

/**
 * 从 className 字符串推断 button variant
 */
function inferVariantFromClassName(cls: string): ButtonVariant {
  if (/\b(text|ghost|link)\b/i.test(cls)) return 'text';
  if (/\b(outline|outlined|border)\b/i.test(cls)) return 'outlined';
  return 'filled';
}

/**
 * 提取节点属性: style / class / 其他
 */
function extractProps(props: Array<AttributeNode | DirectiveNode>): {
  style: UniversalStyle;
  isFlexRow: boolean;
  isFlex: boolean;
  className: string | undefined;
  inputType: string | undefined;
  placeholder: string | undefined;
  src: string | undefined;
  alt: string | undefined;
  value: string | undefined;
} {
  let style: UniversalStyle = {};
  let isFlexRow = false;
  let isFlex = false;
  let className: string | undefined;
  let inputType: string | undefined;
  let placeholder: string | undefined;
  let src: string | undefined;
  let alt: string | undefined;
  let value: string | undefined;

  for (const prop of props) {
    // ── 静态属性: AttributeNode { name, value } ──
    if (prop.type === 6 /* ATTRIBUTE */) {
      const attr = prop as AttributeNode;
      const name = attr.name.toLowerCase();
      const val = attr.value ? attr.value.content : undefined;

      switch (name) {
        case 'style':
          if (val) {
            const parsed = parseStaticStyle(val);
            style = { ...style, ...parsed.style };
            if (parsed.isFlex) isFlex = true;
            if (parsed.isFlexRow) isFlexRow = true;
          }
          break;
        case 'class':
        case 'classname':
          if (val) className = val;
          break;
        case 'type':
          if (val) inputType = val;
          break;
        case 'placeholder':
          if (val) placeholder = val;
          break;
        case 'src':
          if (val) src = val;
          break;
        case 'alt':
          if (val) alt = val;
          break;
        case 'value':
          if (val) value = val;
          break;
      }
      continue;
    }

    // ── 指令: DirectiveNode (v-bind / v-on / v-if / v-for) ──
    if (prop.type === 7 /* DIRECTIVE */) {
      const dir = prop as DirectiveNode;
      const dirName = dir.name; // 'bind' | 'on' | 'if' | 'for' | 'show' | ...

      // :style="..." (v-bind:style)
      if (dirName === 'bind' && dir.arg && dir.arg.type === 4 /* SIMPLE_EXPRESSION */) {
        const argName = (dir.arg as any).content.toLowerCase();
        const exp = dir.exp && dir.exp.type === 4 ? (dir.exp as any).content : '';

        if (argName === 'style' && exp) {
          const parsed = parseBoundStyle(exp);
          style = { ...style, ...parsed.style };
          if (parsed.isFlex) isFlex = true;
          if (parsed.isFlexRow) isFlexRow = true;
        } else if (argName === 'class' && exp) {
          // 动态 class 无法静态求值, 跳过 (除非是字符串字面量)
          const m = exp.match(/^['"](.+)['"]$/);
          if (m) className = m[1];
        } else if (argName === 'type' && exp) {
          const m = exp.match(/^['"](\w+)['"]$/);
          if (m) inputType = m[1];
        } else if (argName === 'placeholder' && exp) {
          const m = exp.match(/^['"](.+)['"]$/);
          if (m) placeholder = m[1];
        } else if (argName === 'src' && exp) {
          const m = exp.match(/^['"](.+)['"]$/);
          if (m) src = m[1];
        } else if (argName === 'alt' && exp) {
          const m = exp.match(/^['"](.+)['"]$/);
          if (m) alt = m[1];
        } else if (argName === 'value' && exp) {
          const m = exp.match(/^['"](.*)['"]$/);
          if (m) value = m[1];
        }
      }
      // v-if / v-for / v-on / v-show — 忽略 (不影响布局结构)
      continue;
    }
  }

  return { style, isFlexRow, isFlex, className, inputType, placeholder, src, alt, value };
}

// ──────────────────────────── 核心: 模板节点解析 ────────────────────────────

/**
 * 递归解析 Vue 模板子节点数组
 */
function parseTemplateChildren(children: TemplateChildNode[]): UniversalNode[] {
  const result: UniversalNode[] = [];
  for (const child of children) {
    const node = parseTemplateChild(child);
    if (node) result.push(node);
  }
  return result;
}

/**
 * 解析单个模板子节点
 */
function parseTemplateChild(child: TemplateChildNode): UniversalNode | null {
  // ── ElementNode ──
  if (child.type === 1 /* ELEMENT */) {
    return parseElementNode(child as ElementNode);
  }

  // ── TextNode → text 节点 ──
  if (child.type === 2 /* TEXT */) {
    const text = (child as TextNode).content.replace(/\s+/g, ' ').trim();
    if (!text) return null;
    return { type: 'text', content: text };
  }

  // ── InterpolationNode {{ expr }} → text 占位 ──
  if (child.type === 5 /* INTERPOLATION */) {
    const interp = child as InterpolationNode;
    // 提取表达式内容
    const exp = interp.content && (interp.content as any).content;
    if (exp) {
      // 尝试提取字面量 (字符串/数字)
      const strMatch = exp.match(/^['"](.*)['"]$/);
      if (strMatch) return { type: 'text', content: strMatch[1] };
      const numMatch = exp.match(/^-?\d*\.?\d+$/);
      if (numMatch) return { type: 'text', content: exp };
      // 变量/表达式 → 占位
      return { type: 'text', content: `{{ ${exp} }}` };
    }
    return null;
  }

  // ── CommentNode → 跳过 ──
  if (child.type === 3 /* COMMENT */) {
    return null;
  }

  return null;
}

/**
 * 解析 ElementNode
 */
function parseElementNode(el: ElementNode): UniversalNode | null {
  const tag = el.tag;
  if (!tag) return null;

  const props = extractProps(el.props);

  // ── 自定义组件 <MyComponent> 或 <my-component> → container ──
  // Vue 组件命名: PascalCase 或 kebab-case (含连字符)
  if (!isHtmlTag(tag) || tag.includes('-')) {
    const children = parseTemplateChildren(el.children);
    return {
      type: 'container',
      style: Object.keys(props.style).length > 0 ? props.style : undefined,
      children: children.length > 0 ? children : undefined,
    };
  }

  const lowerTag = tag.toLowerCase();

  // ── 容器类标签 → container / row / column ──
  if (CONTAINER_TAGS.includes(lowerTag)) {
    let containerType: 'container' | 'row' | 'column' = 'container';
    if (props.isFlex) {
      containerType = props.isFlexRow ? 'row' : 'column';
    }
    const children = parseTemplateChildren(el.children);
    return {
      type: containerType,
      style: Object.keys(props.style).length > 0 ? props.style : undefined,
      children: children.length > 0 ? children : undefined,
    };
  }

  // ── 列表 ul/ol → column ──
  if (lowerTag === 'ul' || lowerTag === 'ol') {
    const children = parseTemplateChildren(el.children);
    return {
      type: 'column',
      style: Object.keys(props.style).length > 0 ? props.style : undefined,
      children: children.length > 0 ? children : undefined,
    };
  }

  // ── 文本类标签 → text ──
  if (TEXT_TAGS.includes(lowerTag)) {
    // 提取所有子文本
    const textParts: string[] = [];
    for (const child of el.children) {
      if (child.type === 2 /* TEXT */) {
        const t = (child as TextNode).content.replace(/\s+/g, ' ').trim();
        if (t) textParts.push(t);
      } else if (child.type === 5 /* INTERPOLATION */) {
        const exp = (child as InterpolationNode).content && (child as InterpolationNode).content as any;
        const expStr = exp?.content || '';
        const strMatch = expStr.match(/^['"](.*)['"]$/);
        if (strMatch) textParts.push(strMatch[1]);
        else if (/^-?\d*\.?\d+$/.test(expStr)) textParts.push(expStr);
        else if (expStr) textParts.push(`{{ ${expStr} }}`);
      }
    }
    const content = textParts.join(' ');

    const style = { ...props.style };
    // 标题字号推断
    if (lowerTag.startsWith('h')) {
      const hLevel = parseInt(lowerTag.slice(1), 10);
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
  if (lowerTag === 'button') {
    const textParts: string[] = [];
    for (const child of el.children) {
      if (child.type === 2 /* TEXT */) {
        const t = (child as TextNode).content.replace(/\s+/g, ' ').trim();
        if (t) textParts.push(t);
      } else if (child.type === 5 /* INTERPOLATION */) {
        const exp = (child as InterpolationNode).content && (child as InterpolationNode).content as any;
        const expStr = exp?.content || '';
        const strMatch = expStr.match(/^['"](.*)['"]$/);
        if (strMatch) textParts.push(strMatch[1]);
        else if (expStr) textParts.push(`{{ ${expStr} }}`);
      }
    }
    const label = textParts.join(' ') || 'Button';
    const variant: ButtonVariant = props.className
      ? inferVariantFromClassName(props.className)
      : 'filled';
    return {
      type: 'button',
      label,
      variant,
      style: Object.keys(props.style).length > 0 ? props.style : undefined,
    };
  }

  // ── input/textarea → input ──
  if (lowerTag === 'input' || lowerTag === 'textarea') {
    const kind: InputKind = (() => {
      switch (props.inputType) {
        case 'password': return 'password';
        case 'email': return 'email';
        case 'number': return 'number';
        default: return 'text';
      }
    })();
    return {
      type: 'input',
      placeholder: props.placeholder,
      value: props.value,
      kind,
      style: Object.keys(props.style).length > 0 ? props.style : undefined,
    };
  }

  // ── img → image ──
  if (lowerTag === 'img') {
    return {
      type: 'image',
      src: props.src,
      alt: props.alt,
      style: Object.keys(props.style).length > 0 ? props.style : undefined,
    };
  }

  // ── hr → divider ──
  if (lowerTag === 'hr') {
    return {
      type: 'divider',
      style: Object.keys(props.style).length > 0 ? props.style : undefined,
    };
  }

  // ── br → spacer ──
  if (lowerTag === 'br') {
    return { type: 'spacer', style: { height: 8 } };
  }

  // ── 其他未知标签 → container (兜底) ──
  const children = parseTemplateChildren(el.children);
  return {
    type: 'container',
    style: Object.keys(props.style).length > 0 ? props.style : undefined,
    children: children.length > 0 ? children : undefined,
  };
}

// ──────────────────────────── 翻译器实现 ────────────────────────────

export const vueTranslator: Translator = {
  language: 'vue',
  displayName: 'Vue SFC',

  /**
   * 检测代码是否为 Vue SFC
   * 置信度:
   *   0.95 — 包含 <template> + <script> (典型 SFC 结构)
   *   0.85 — 包含 <template> 标签
   *   0.7  — 包含 .vue 文件标记 或 v-if/v-for/@click 指令
   *   0    — 不匹配
   */
  detect(code: string): number {
    if (!code || typeof code !== 'string') return 0;
    const trimmed = code.trim();
    if (trimmed.length < 10) return 0;

    // 完整 SFC: <template> + <script>
    const hasTemplate = /<template[\s>]/i.test(trimmed);
    const hasScript = /<script[\s>]/i.test(trimmed);
    if (hasTemplate && hasScript) return 0.95;

    // 只有 <template>
    if (hasTemplate) return 0.85;

    // Vue 指令特征
    if (/\bv-if\b|\bv-for\b|\bv-bind\b|\bv-on\b|@click|:class|:style/.test(trimmed)) return 0.7;

    return 0;
  },

  /**
   * 翻译 Vue SFC 代码为 Universal AST
   * @throws TranslateError 当解析失败时
   */
  translate(code: string): UniversalNode {
    if (!code || typeof code !== 'string') {
      throw new TranslateError('vue', 'code 为空');
    }

    // ── 1. 用 @vue/compiler-sfc 解析 SFC ──
    let descriptor: ReturnType<typeof parseSfc>['descriptor'];
    try {
      const result = parseSfc(code, { filename: 'anonymous.vue' });
      if (result.errors && result.errors.length > 0) {
        // 有错误但仍可能有 descriptor (容错)
        // 只有完全无法解析时才抛错
        if (!result.descriptor) {
          throw new TranslateError('vue', `SFC 解析失败: ${result.errors[0].message}`, code);
        }
      }
      descriptor = result.descriptor;
    } catch (err: any) {
      if (err instanceof TranslateError) throw err;
      throw new TranslateError('vue', `SFC 解析失败: ${err.message}`, code);
    }

    // ── 2. 提取 template 内容 ──
    let templateSource: string | null = null;
    if (descriptor.template && descriptor.template.content) {
      templateSource = descriptor.template.content;
    }

    // ── 3. 如果没有 <template>, 检查是否是裸 HTML/JSX ──
    if (!templateSource) {
      // 尝试把整个代码当 template (可能是 <div>...</div> 无 <template> 包裹)
      // 但要先去掉 <script>/<style> 块
      const stripped = code
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .trim();
      if (stripped && /^<[\w-]+[\s>]/.test(stripped)) {
        templateSource = stripped;
      } else {
        throw new TranslateError('vue', '未找到 <template> 块, 且代码不是有效的 HTML', code);
      }
    }

    // ── 4. 解析 template → 原始 AST (不编译, 保留 {{ expr }} 原样) ──
    //    用 @vue/compiler-dom 的 parse (而非 compileTemplate),
    //    因为 compileTemplate 会把 {{ count }} 转成 _ctx.count
    let templateAst: RootNode;
    try {
      templateAst = parseTemplate(templateSource);
    } catch (err: any) {
      throw new TranslateError('vue', `模板解析失败: ${err.message}`, code);
    }

    // ── 5. 遍历 AST, 转成 UniversalNode ──
    // templateAst 是 RootNode, children 是顶级节点数组
    const children: TemplateChildNode[] = templateAst.children || [];

    if (children.length === 0) {
      return { type: 'container' };
    }

    if (children.length === 1) {
      const node = parseTemplateChild(children[0]);
      if (node) return node;
      return { type: 'container' };
    }

    // 多个顶级节点 → 包成 column
    const nodes = parseTemplateChildren(children);
    return {
      type: 'column',
      children: nodes.length > 0 ? nodes : undefined,
    };
  },
};
