/**
 * reactTranslator.ts — React JSX/TSX → Universal AST 翻译器
 *
 * 将 React JSX 代码解析成 UniversalNode 树, 让画布能渲染 LLM 生成的 React 组件。
 * 纯本地解析 (@babel/parser), 不消耗 LLM token。
 *
 * 支持的输入形态:
 *   1. 直接 JSX 片段:  <div><p>hello</p></div>
 *   2. 函数组件:        function Foo() { return <div>...</div> }
 *   3. 箭头函数组件:    const Foo = () => <div>...</div>
 *   4. JSX 片段:        <>...</>
 *
 * 标签映射 (与 htmlTranslator 一致):
 *   - div/section/article/nav/header/footer/main/form → container / row / column
 *   - p/h1-h6/span/label/a/strong/em → text
 *   - button → button
 *   - input/textarea → input
 *   - img → image
 *   - hr → divider
 *   - 自定义组件 <MyComponent /> → container (作为不透明盒子, 递归其 children)
 *
 * Props 解析:
 *   - style={{ padding:16, color:'red' }} → UniversalStyle (对象字面量)
 *   - className="btn-primary" → button variant 推断
 *   - disabled / type 属性 → 透传
 *
 * JSX 表达式处理:
 *   - {字符串字面量}  → text 节点
 *   - {变量名}        → text 节点, 内容 '{varName}' (占位)
 *   - {cond && <X/>}  → 静态 true 时渲染 <X/>, 否则跳过
 *   - {arr.map(...)}  → 跳过 (无法静态求值)
 *
 * 不支持 (保持简单):
 *   - 类组件 (class Foo extends Component) — 太复杂, 跳过
 *   - 高阶组件 / render props
 *   - hooks 状态求值 (useState 的值无法静态知道)
 *   - 条件渲染的动态分支 (只取静态可确定的部分)
 */

import { parse } from '@babel/parser';
import type { File as BabelFile } from '@babel/types';
import type {
  JSXElement,
  JSXFragment,
  JSXOpeningElement,
  JSXAttribute,
  JSXSpreadAttribute,
  JSXExpressionContainer,
  JSXText,
  JSXChild,
  ObjectExpression,
  ObjectProperty,
  Expression,
  StringLiteral,
  NumericLiteral,
  BooleanLiteral,
  Identifier,
  MemberExpression,
  Node,
} from '@babel/types';
import type { UniversalNode, UniversalStyle, ButtonVariant, InputKind } from '../services/canvas/UniversalAST';
import { TranslateError, type Translator } from './types';

// ──────────────────────────── 工具函数 ────────────────────────────

/**
 * 判断标签名是否为 HTML 原生标签 (小写开头)
 * 自定义组件是大写开头 (React 约定): <MyComponent /> vs <div />
 */
function isHtmlTag(name: string): boolean {
  return /^[a-z]/.test(name);
}

/**
 * 获取 JSX 元素的标签名 (字符串)
 * 支持: <div> → 'div', <Foo.Bar> → 'Foo.Bar', <Foo> → 'Foo'
 */
function getTagName(opening: JSXOpeningElement): string | null {
  const nameNode = opening.name;
  if (nameNode.type === 'JSXIdentifier') {
    return nameNode.name;
  }
  if (nameNode.type === 'JSXMemberExpression') {
    // <Foo.Bar.Baz> → 'Foo.Bar.Baz'
    const parts: string[] = [];
    let cur: Node = nameNode;
    while (cur.type === 'JSXMemberExpression') {
      parts.unshift(cur.property.name);
      cur = cur.object;
    }
    if (cur.type === 'JSXIdentifier') parts.unshift(cur.name);
    return parts.join('.');
  }
  return null;
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
 * 从 babel ObjectExpression 提取 style 对象
 * style={{ padding:16, color:'red', fontSize:14, display:'flex', flexDirection:'row' }}
 */
function parseStyleObject(expr: ObjectExpression): { style: UniversalStyle; isFlexRow: boolean; isFlex: boolean } {
  const style: UniversalStyle = {};
  let isFlexRow = false;
  let isFlex = false;

  for (const prop of expr.properties) {
    if (prop.type !== 'ObjectProperty') continue;

    // key 可能是 Identifier (padding) 或 StringLiteral ('padding')
    let key: string;
    if (prop.key.type === 'Identifier') {
      key = prop.key.name;
    } else if (prop.key.type === 'StringLiteral') {
      key = prop.key.value;
    } else {
      continue;
    }
    key = key.toLowerCase();

    // value 提取 (只处理字面量, 跳过变量/表达式)
    const val = extractLiteralValue(prop.value);
    if (val === undefined) continue;

    switch (key) {
      case 'padding':
        style.padding = typeof val === 'string' ? parseCssBox(val) : val;
        break;
      case 'margin':
        style.margin = typeof val === 'string' ? parseCssBox(val) : val;
        break;
      case 'color':
        if (typeof val === 'string') style.color = val;
        break;
      case 'background':
      case 'backgroundcolor':
        if (typeof val === 'string') style.background = val;
        break;
      case 'fontsize':
        style.fontSize = typeof val === 'string' ? parseCssNumber(val) : val;
        break;
      case 'fontweight':
        if (typeof val === 'number' && val >= 100 && val <= 900) {
          style.fontWeight = val as any;
        } else if (typeof val === 'string') {
          if (val === 'bold') style.fontWeight = 700;
          else if (val === 'normal') style.fontWeight = 400;
        }
        break;
      case 'textalign':
        if (val === 'left' || val === 'center' || val === 'right') {
          style.textAlign = val;
        }
        break;
      case 'lineheight':
        style.lineHeight = typeof val === 'string' ? parseCssNumber(val) : val;
        break;
      case 'letterspacing':
        style.letterSpacing = typeof val === 'string' ? parseCssNumber(val) : val;
        break;
      case 'borderradius':
      case 'radius':
        style.radius = typeof val === 'string' ? parseCssNumber(val) : val;
        break;
      case 'border':
        if (typeof val === 'string') style.border = val;
        break;
      case 'boxshadow':
      case 'shadow':
        if (typeof val === 'string') style.shadow = val;
        break;
      case 'opacity':
        style.opacity = typeof val === 'string' ? parseCssNumber(val) : val;
        break;
      case 'width':
        style.width = typeof val === 'string' ? (parseCssNumber(val) ?? val) : val;
        break;
      case 'height':
        style.height = typeof val === 'string' ? (parseCssNumber(val) ?? val) : val;
        break;
      case 'flex':
        style.flex = typeof val === 'string' ? parseCssNumber(val) : val;
        break;
      case 'gap':
        style.gap = typeof val === 'string' ? parseCssNumber(val) : val;
        break;
      case 'display':
        if (val === 'flex') isFlex = true;
        break;
      case 'flexdirection':
        if (val === 'row') isFlexRow = true;
        break;
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
 * 从 babel 表达式提取字面量值 (string | number | boolean)
 * 变量/函数调用等返回 undefined
 */
function extractLiteralValue(expr: Expression): string | number | boolean | undefined {
  switch (expr.type) {
    case 'StringLiteral':
      return expr.value;
    case 'NumericLiteral':
      return expr.value;
    case 'BooleanLiteral':
      return expr.value;
    case 'NullLiteral':
      return undefined;
    default:
      return undefined;
  }
}

/**
 * 从 className 字符串推断 button variant
 */
function inferVariantFromClassName(cls: string): ButtonVariant {
  if (/\b(text|ghost|link)\b/i.test(cls)) return 'text';
  if (/\b(outline|outlined|border)\b/i.test(cls)) return 'outlined';
  return 'filled';
}

// ──────────────────────────── 核心: JSX 节点解析 ────────────────────────────

const CONTAINER_TAGS = ['div', 'section', 'article', 'nav', 'header', 'footer', 'main', 'aside', 'form', 'li'];
const TEXT_TAGS = ['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'span', 'label', 'a', 'strong', 'em', 'b', 'i', 'small', 'code', 'pre'];

/**
 * 从 JSX 属性数组中提取 style / className / 其他常用属性
 */
function extractProps(attributes: Array<JSXAttribute | JSXSpreadAttribute>): {
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

  for (const attr of attributes) {
    // 跳过展开属性 {...props}
    if (attr.type !== 'JSXAttribute') continue;

    const name = attr.name.name;
    if (typeof name !== 'string') continue;

    // 属性值可能是: StringLiteral (attr="x") / JSXExpressionContainer (attr={x}) / null (disabled)
    let val: string | number | boolean | undefined;
    if (attr.value === null) {
      val = true; // <button disabled> → disabled=true
    } else if (attr.value.type === 'StringLiteral') {
      val = attr.value.value;
    } else if (attr.value.type === 'JSXExpressionContainer') {
      const inner = attr.value.expression;
      // style={{...}} 特殊处理
      if (name === 'style' && inner.type === 'ObjectExpression') {
        const parsed = parseStyleObject(inner);
        style = parsed.style;
        isFlexRow = parsed.isFlexRow;
        isFlex = parsed.isFlex;
        continue;
      }
      val = extractLiteralValue(inner);
    }

    switch (name.toLowerCase()) {
      case 'classname':
        if (typeof val === 'string') className = val;
        break;
      case 'type':
        if (typeof val === 'string') inputType = val;
        break;
      case 'placeholder':
        if (typeof val === 'string') placeholder = val;
        break;
      case 'src':
        if (typeof val === 'string') src = val;
        break;
      case 'alt':
        if (typeof val === 'string') alt = val;
        break;
      case 'value':
      case 'defaultvalue':
        if (typeof val === 'string') value = val;
        break;
      // 忽略其他属性 (onClick / onChange / data-* / key / ref 等)
    }
  }

  return { style, isFlexRow, isFlex, className, inputType, placeholder, src, alt, value };
}

/**
 * 递归解析 JSX 子节点数组
 */
function parseJsxChildren(children: JSXChild[]): UniversalNode[] {
  const result: UniversalNode[] = [];
  for (const child of children) {
    const node = parseJsxChild(child);
    if (node) result.push(node);
  }
  return result;
}

/**
 * 解析单个 JSX 子节点
 */
function parseJsxChild(child: JSXChild): UniversalNode | null {
  // ── JSXText → text 节点 (trim 空白) ──
  if (child.type === 'JSXText') {
    const text = child.value.replace(/\s+/g, ' ').trim();
    if (!text) return null;
    return { type: 'text', content: text };
  }

  // ── JSXElement → 递归 ──
  if (child.type === 'JSXElement') {
    return parseJsxElement(child);
  }

  // ── JSXFragment <>...</> → container ──
  if (child.type === 'JSXFragment') {
    return parseJsxFragment(child);
  }

  // ── JSXExpressionContainer {expr} → 尝试提取 ──
  if (child.type === 'JSXExpressionContainer') {
    return parseJsxExpression(child);
  }

  return null;
}

/**
 * 解析 JSX 表达式容器 {expr}
 *   - {字符串字面量}     → text
 *   - {数字字面量}       → text
 *   - {变量名}           → text (占位 '{varName}')
 *   - {cond && <X/>}     → true 时渲染 <X/>
 *   - {cond ? <A/> : <B/>} → 取第一个分支
 *   - {arr.map(...)}     → null (跳过)
 */
function parseJsxExpression(container: JSXExpressionContainer): UniversalNode | null {
  const expr = container.expression;

  // 字面量 → text
  if (expr.type === 'StringLiteral') {
    return { type: 'text', content: expr.value };
  }
  if (expr.type === 'NumericLiteral') {
    return { type: 'text', content: String(expr.value) };
  }
  if (expr.type === 'BooleanLiteral') {
    return expr.value ? { type: 'text', content: 'true' } : null;
  }
  if (expr.type === 'NullLiteral') {
    return null;
  }

  // {变量名} → text 占位
  if (expr.type === 'Identifier') {
    return { type: 'text', content: `{${expr.name}}` };
  }

  // {cond && <X/>} → 静态 true 或字面量 true 时渲染 <X/>
  if (expr.type === 'LogicalExpression' && expr.operator === '&&') {
    // 静态求值左操作数
    if (expr.left.type === 'BooleanLiteral' && expr.left.value) {
      // true && <X/> → 渲染 <X/>
      if (expr.right.type === 'JSXElement') return parseJsxElement(expr.right);
      if (expr.right.type === 'JSXFragment') return parseJsxFragment(expr.right);
    }
    // 无法静态确定 → 跳过
    return null;
  }

  // {cond ? <A/> : <B/>} → 取第一个分支
  if (expr.type === 'ConditionalExpression') {
    if (expr.consequent.type === 'JSXElement') return parseJsxElement(expr.consequent);
    if (expr.consequent.type === 'JSXFragment') return parseJsxFragment(expr.consequent);
    return null;
  }

  // 其他表达式 (CallExpression / MemberExpression / Array.map 等) → 跳过
  return null;
}

/**
 * 解析 JSX Fragment <>...</>
 */
function parseJsxFragment(frag: JSXFragment): UniversalNode {
  const children = parseJsxChildren(frag.children);
  return {
    type: 'container',
    children: children.length > 0 ? children : undefined,
  };
}

/**
 * 解析 JSX Element <div>...</div>
 */
function parseJsxElement(el: JSXElement): UniversalNode | null {
  const opening = el.openingElement;
  const tag = getTagName(opening);
  if (!tag) return null;

  const props = extractProps(opening.attributes);

  // ── 自定义组件 <MyComponent> → container (不透明盒子) ──
  // 递归解析其 children (children 通常是 JSX, 可以渲染)
  if (!isHtmlTag(tag)) {
    const children = parseJsxChildren(el.children);
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
    const children = parseJsxChildren(el.children);
    return {
      type: containerType,
      style: Object.keys(props.style).length > 0 ? props.style : undefined,
      children: children.length > 0 ? children : undefined,
    };
  }

  // ── 列表 ul/ol → column ──
  if (lowerTag === 'ul' || lowerTag === 'ol') {
    const children = parseJsxChildren(el.children);
    return {
      type: 'column',
      style: Object.keys(props.style).length > 0 ? props.style : undefined,
      children: children.length > 0 ? children : undefined,
    };
  }

  // ── 文本类标签 → text ──
  if (TEXT_TAGS.includes(lowerTag)) {
    // 提取所有子文本 (JSXText + 表达式)
    const textParts: string[] = [];
    for (const child of el.children) {
      if (child.type === 'JSXText') {
        const t = child.value.replace(/\s+/g, ' ').trim();
        if (t) textParts.push(t);
      } else if (child.type === 'JSXExpressionContainer') {
        const inner = child.expression;
        if (inner.type === 'StringLiteral') textParts.push(inner.value);
        else if (inner.type === 'NumericLiteral') textParts.push(String(inner.value));
        else if (inner.type === 'Identifier') textParts.push(`{${inner.name}}`);
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
    // 提取按钮文本
    const textParts: string[] = [];
    for (const child of el.children) {
      if (child.type === 'JSXText') {
        const t = child.value.replace(/\s+/g, ' ').trim();
        if (t) textParts.push(t);
      } else if (child.type === 'JSXExpressionContainer') {
        const inner = child.expression;
        if (inner.type === 'StringLiteral') textParts.push(inner.value);
        else if (inner.type === 'Identifier') textParts.push(`{${inner.name}}`);
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

  // ── 其他未知 HTML 标签 → container (兜底) ──
  const children = parseJsxChildren(el.children);
  return {
    type: 'container',
    style: Object.keys(props.style).length > 0 ? props.style : undefined,
    children: children.length > 0 ? children : undefined,
  };
}

// ──────────────────────────── 根节点查找 ────────────────────────────

/**
 * 在 babel AST 中查找第一个 JSX 元素/Fragment 作为根
 *
 * 查找顺序:
 *   1. return <X/> 语句 (函数组件)
 *   2. 变量声明 const Foo = () => <X/> 或 const Foo = <X/>
 *   3. 任意位置的 JSX 表达式
 */
function findRootJsx(ast: BabelFile): UniversalNode | null {
  // 深度优先遍历, 找第一个 JSXElement 或 JSXFragment
  let found: UniversalNode | null = null;

  function visit(node: Node): boolean {
    if (found) return true; // 已找到, 停止

    if (node.type === 'JSXElement') {
      found = parseJsxElement(node);
      return true;
    }
    if (node.type === 'JSXFragment') {
      found = parseJsxFragment(node);
      return true;
    }

    // 递归子节点
    for (const key of Object.keys(node)) {
      // 跳过非节点字段
      const val = (node as any)[key];
      if (Array.isArray(val)) {
        for (const child of val) {
          if (child && typeof child.type === 'string') {
            if (visit(child)) return true;
          }
        }
      } else if (val && typeof val.type === 'string') {
        if (visit(val)) return true;
      }
    }
    return false;
  }

  visit(ast);
  return found;
}

// ──────────────────────────── 翻译器实现 ────────────────────────────

export const reactTranslator: Translator = {
  language: 'react',
  displayName: 'React JSX/TSX',

  /**
   * 检测代码是否为 React JSX/TSX
   * 置信度:
   *   0.9  — 包含 import ... from 'react' + JSX 标签
   *   0.8  — 包含 function/const 组件 + JSX return
   *   0.6  — 包含 <X> (大写开头, 自定义组件)
   *   0.4  — 包含 <div>/<p> 等小写标签 + JSX 表达式 {expr}
   *   0    — 不匹配
   */
  detect(code: string): number {
    if (!code || typeof code !== 'string') return 0;
    const trimmed = code.trim();
    if (trimmed.length < 4) return 0;

    // import ... from 'react'
    const hasReactImport = /from\s+['"]react['"]/.test(trimmed) || /from\s+['"]react\/jsx-runtime['"]/.test(trimmed);
    const hasJsxTag = /<[A-Za-z][\w.]*[\s>\/]/.test(trimmed);
    const hasJsxExpr = /\{[A-Za-z_$][\w$]*\}/.test(trimmed);

    // 完整 React 组件: import + 组件定义 + JSX
    if (hasReactImport && hasJsxTag) return 0.9;

    // 函数组件定义 + JSX
    // 匹配: function Foo() { / const Foo = () => { / const Foo = () => (< / const Foo = () => <
    const hasComponentDef = /(?:function\s+\w+|const\s+\w+\s*=\s*(?:\([^)]*\)|\w+)\s*=>)\s*[{(<]/.test(trimmed);
    if (hasComponentDef && hasJsxTag) return 0.8;

    // 自定义组件 <MyComponent />
    if (/<[A-Z]\w*[\s>\/]/.test(trimmed)) return 0.6;

    // JSX 表达式 + 标签 (可能是 JSX 片段)
    if (hasJsxTag && hasJsxExpr) return 0.4;

    return 0;
  },

  /**
   * 翻译 React JSX 代码为 Universal AST
   * @throws TranslateError 当 babel 解析失败时
   */
  translate(code: string): UniversalNode {
    if (!code || typeof code !== 'string') {
      throw new TranslateError('react', 'code 为空');
    }

    let ast: BabelFile;
    try {
      ast = parse(code, {
        sourceType: 'module',
        plugins: [
          'jsx',
          'typescript',
          'objectRestSpread',
          'classProperties',
          'asyncGenerators',
          'dynamicImport',
          'optionalChaining',
          'nullishCoalescingOperator',
        ],
        errorRecovery: true, // 容错: 不完整的 JSX 也能解析
      });
    } catch (err: any) {
      throw new TranslateError('react', `babel 解析失败: ${err.message}`, code);
    }

    const root = findRootJsx(ast);
    if (!root) {
      throw new TranslateError('react', '未找到 JSX 根元素 (代码可能不是 React 组件)', code);
    }

    return root;
  },
};
