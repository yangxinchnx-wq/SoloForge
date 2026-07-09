/**
 * qmlTranslator.ts — Qt QML → Universal AST 翻译器
 *
 * 将 QML 代码解析成 UniversalNode 树。
 * 纯本地解析 (正则 + 括号匹配), 不消耗 LLM token。
 *
 * QML 语法特点:
 *   - 类 JSON 块结构: TypeName { property: value; child: TypeName {} }
 *   - 属性赋值用冒号 (不是等号): width: 100
 *   - 子元素直接嵌套 (无 children 属性)
 *
 * 支持的 QML 类型:
 *   - Rectangle / Item              → container
 *   - Row / Column / RowLayout / ColumnLayout → row / column
 *   - Flow / Grid                   → column (简化)
 *   - Text                          → text
 *   - Button / ToolButton           → button
 *   - TextField / TextInput         → input
 *   - Image                         → image
 *   - Rectangle (小高度)             → divider
 *
 * 属性解析:
 *   - text: "Hello"                 → content / label
 *   - color: "red" / "#FF0000"      → background (Rectangle) 或 color (Text)
 *   - width / height                → width / height
 *   - anchors.centerIn: parent      → align: center
 *   - font.pixelSize: 14            → fontSize
 *   - font.bold: true               → fontWeight
 *   - radius: 8                     → radius
 *   - border.color / border.width   → border
 *   - padding: 16                   → padding
 */

import type { UniversalNode, UniversalStyle, ButtonVariant, InputKind } from '../services/canvas/UniversalAST';
import { TranslateError, type Translator } from './types';

// ──────────────────────────── QML Tokenizer ────────────────────────────

interface Token {
  type: 'ident' | 'number' | 'string' | 'punct' | 'keyword';
  value: string;
  pos: number;
}

function tokenize(code: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = code.length;

  while (i < n) {
    const ch = code[i];

    if (/\s/.test(ch)) { i++; continue; }

    // 注释 // 和 /*
    if (ch === '/' && code[i + 1] === '/') {
      while (i < n && code[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && code[i + 1] === '*') {
      i += 2;
      while (i < n && !(code[i] === '*' && code[i + 1] === '/')) i++;
      i += 2;
      continue;
    }

    // 字符串
    if (ch === '"') {
      let val = '';
      i++;
      while (i < n && code[i] !== '"') {
        if (code[i] === '\\' && i + 1 < n) { val += code[i + 1]; i += 2; continue; }
        val += code[i];
        i++;
      }
      i++;
      tokens.push({ type: 'string', value: val, pos: i });
      continue;
    }

    // 数字
    if (/[\d.]/.test(ch)) {
      let num = '';
      while (i < n && /[\d.]/.test(code[i])) { num += code[i]; i++; }
      tokens.push({ type: 'number', value: num, pos: i });
      continue;
    }

    // 标识符 (含 . 成员访问, 如 font.pixelSize 作为一个 ident)
    if (/[a-zA-Z_$]/.test(ch)) {
      let id = '';
      while (i < n && /[\w$.]/.test(code[i])) { id += code[i]; i++; }
      tokens.push({ type: 'ident', value: id, pos: i });
      continue;
    }

    tokens.push({ type: 'punct', value: ch, pos: i });
    i++;
  }

  return tokens;
}

// ──────────────────────────── QML AST ────────────────────────────

interface QmlObjectNode {
  typeName: string;
  properties: Record<string, QmlValue>;
  children: QmlObjectNode[];
}

type QmlValue =
  | { kind: 'literal'; value: string | number | boolean | null }
  | { kind: 'ident'; name: string }
  | { kind: 'object'; node: QmlObjectNode };

// ──────────────────────────── QML Parser ────────────────────────────

class QmlParser {
  private tokens: Token[];
  private pos = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(offset = 0): Token | null {
    return this.tokens[this.pos + offset] || null;
  }

  private consume(): Token {
    return this.tokens[this.pos++];
  }

  /**
   * 解析 QML 对象: TypeName { properties... children... }
   */
  parseObject(): QmlObjectNode | null {
    const t = this.peek();
    if (!t || t.type !== 'ident') return null;

    const typeName = t.value;
    this.consume();

    // 期望 {
    if (this.peek()?.value !== '{') {
      // 可能是 id 引用, 不是对象定义
      return null;
    }
    this.consume(); // {

    const node: QmlObjectNode = {
      typeName,
      properties: {},
      children: [],
    };

    while (this.peek() && this.peek()!.value !== '}') {
      // 跳过分号
      if (this.peek()!.value === ';') { this.consume(); continue; }

      // 解析 property / child
      // 区分: property 是 ident: value, child 是 ident { ... } (类型名开头大写)
      const propToken = this.peek();
      if (!propToken || propToken.type !== 'ident') {
        this.consume();
        continue;
      }

      const nextToken = this.peek(1);

      // 属性赋值: ident : value
      if (nextToken?.value === ':') {
        const propName = propToken.value;
        this.consume(); // ident
        this.consume(); // :
        const val = this.parseValue();
        node.properties[propName] = val;
        continue;
      }

      // 子对象: TypeName { ... }
      if (nextToken?.value === '{') {
        const child = this.parseObject();
        if (child) node.children.push(child);
        continue;
      }

      // property <type> <name>: value (QML 属性声明) — 跳过
      if (propToken.value === 'property') {
        this.consume(); // property
        // 跳过类型和名字, 直到 :
        while (this.peek() && this.peek()!.value !== ':' && this.peek()!.value !== '}') {
          this.consume();
        }
        if (this.peek()?.value === ':') {
          this.consume();
          this.parseValue();
        }
        continue;
      }

      // id: value (特殊)
      if (propToken.value === 'id' && nextToken?.value === ':') {
        this.consume(); this.consume();
        const val = this.parseValue();
        node.properties['id'] = val;
        continue;
      }

      // 未知 → 跳过
      this.consume();
    }

    if (this.peek()?.value === '}') this.consume();

    return node;
  }

  parseValue(): QmlValue {
    const t = this.peek();
    if (!t) return { kind: 'literal', value: null };

    // 字面量
    if (t.type === 'string') { this.consume(); return { kind: 'literal', value: t.value }; }
    if (t.type === 'number') {
      this.consume();
      return { kind: 'literal', value: parseFloat(t.value) };
    }
    if (t.value === 'true' || t.value === 'false') {
      this.consume();
      return { kind: 'literal', value: t.value === 'true' };
    }

    // 标识符 (parent / red / Qt.center 等)
    if (t.type === 'ident') {
      // 检查后面是否是 { (对象定义)
      if (this.peek(1)?.value === '{') {
        const obj = this.parseObject();
        if (obj) return { kind: 'object', node: obj };
      }
      this.consume();
      return { kind: 'ident', name: t.value };
    }

    // 数组 [ ... ] (anchors 等) — 简化跳过
    if (t.value === '[') {
      this.consume();
      let depth = 1;
      while (depth > 0 && this.peek()) {
        const v = this.consume().value;
        if (v === '[') depth++;
        else if (v === ']') depth--;
      }
      return { kind: 'literal', value: null };
    }

    // 括号 (表达式) — 简化跳过
    if (t.value === '(') {
      this.consume();
      let depth = 1;
      while (depth > 0 && this.peek()) {
        const v = this.consume().value;
        if (v === '(') depth++;
        else if (v === ')') depth--;
      }
      return { kind: 'literal', value: null };
    }

    this.consume();
    return { kind: 'literal', value: null };
  }
}

// ──────────────────────────── 值解析工具 ────────────────────────────

function parseString(val: QmlValue | undefined): string | undefined {
  if (!val) return undefined;
  if (val.kind === 'literal' && typeof val.value === 'string') return val.value;
  return undefined;
}

function parseNumber(val: QmlValue | undefined): number | undefined {
  if (!val) return undefined;
  if (val.kind === 'literal' && typeof val.value === 'number') return val.value;
  return undefined;
}

function parseBool(val: QmlValue | undefined): boolean | undefined {
  if (!val) return undefined;
  if (val.kind === 'literal' && typeof val.value === 'boolean') return val.value;
  return undefined;
}

/**
 * 解析颜色
 *   "red" / "#FF0000" → 原样
 *   Qt.rgba(0.5, 0.5, 0.5, 1) → 简化为 "#808080"
 */
function parseColor(val: QmlValue | undefined): string | undefined {
  if (!val) return undefined;
  if (val.kind === 'literal' && typeof val.value === 'string') {
    return val.value;
  }
  return undefined;
}

// ──────────────────────────── 节点转换 ────────────────────────────

function qmlToUniversal(node: QmlObjectNode): UniversalNode | null {
  const style: UniversalStyle = {};
  const t = node.typeName;

  // 提取通用属性
  const width = parseNumber(node.properties.width);
  if (width) style.width = width;
  const height = parseNumber(node.properties.height);
  if (height) style.height = height;
  const radius = parseNumber(node.properties.radius);
  if (radius) style.radius = radius;
  const opacity = parseNumber(node.properties.opacity);
  if (opacity !== undefined) style.opacity = opacity;
  const padding = parseNumber(node.properties.padding);
  if (padding !== undefined) style.padding = padding;

  // anchors.centerIn: parent → align + justify center
  if (node.properties['anchors.centerIn']?.kind === 'ident') {
    style.align = 'center';
    style.justify = 'center';
  }

  // ── Rectangle / Item → container ──
  if (t === 'Rectangle' || t === 'Item' || t === 'FocusScope') {
    const color = parseColor(node.properties.color);
    if (color) style.background = color;

    const borderColor = parseColor(node.properties['border.color']);
    const borderWidth = parseNumber(node.properties['border.width']) ?? 1;
    if (borderColor) style.border = `${borderWidth}px solid ${borderColor}`;

    // 小高度的 Rectangle → divider
    if (height !== undefined && height <= 4 && !node.children.length) {
      return { type: 'divider', style: { height } };
    }

    const children = node.children
      .map(qmlToUniversal)
      .filter((c): c is UniversalNode => c !== null);
    return {
      type: 'container',
      style: Object.keys(style).length > 0 ? style : undefined,
      children: children.length > 0 ? children : undefined,
    };
  }

  // ── Row / Column → row / column ──
  if (t === 'Row' || t === 'Column' || t === 'RowLayout' || t === 'ColumnLayout' || t === 'GridLayout') {
    const spacing = parseNumber(node.properties.spacing);
    if (spacing) style.gap = spacing;
    const children = node.children
      .map(qmlToUniversal)
      .filter((c): c is UniversalNode => c !== null);
    return {
      type: (t === 'Row' || t === 'RowLayout') ? 'row' : 'column',
      style: Object.keys(style).length > 0 ? style : undefined,
      children: children.length > 0 ? children : undefined,
    };
  }

  // ── Flow / Grid → column (简化) ──
  if (t === 'Flow' || t === 'Grid') {
    const children = node.children
      .map(qmlToUniversal)
      .filter((c): c is UniversalNode => c !== null);
    return {
      type: 'column',
      style: Object.keys(style).length > 0 ? style : undefined,
      children: children.length > 0 ? children : undefined,
    };
  }

  // ── Text → text ──
  if (t === 'Text' || t === 'Label' || t === 'TextEdit') {
    let content = parseString(node.properties.text) || '';
    const color = parseColor(node.properties.color);
    if (color) style.color = color;
    // font.pixelSize / font.bold
    if (node.properties['font.pixelSize']) {
      const fs = parseNumber(node.properties['font.pixelSize']);
      if (fs) style.fontSize = fs;
    }
    if (node.properties['font.bold']) {
      const bold = parseBool(node.properties['font.bold']);
      if (bold) style.fontWeight = 700;
    }
    return {
      type: 'text',
      content,
      style: Object.keys(style).length > 0 ? style : undefined,
    };
  }

  // ── Button / ToolButton → button ──
  if (t === 'Button' || t === 'ToolButton' || t === 'RoundButton' || t === 'DelayButton') {
    const label = parseString(node.properties.text) || 'Button';
    let variant: ButtonVariant = 'filled';
    if (t === 'ToolButton') variant = 'text';
    return {
      type: 'button',
      label,
      variant,
      style: Object.keys(style).length > 0 ? style : undefined,
    };
  }

  // ── TextField / TextInput → input ──
  if (t === 'TextField' || t === 'TextInput') {
    const placeholder = parseString(node.properties.placeholderText) ||
      parseString(node.properties.text) || undefined;
    let kind: InputKind = 'text';
    if (node.properties.echoMode?.kind === 'ident' && node.properties.echoMode.name === 'Password') {
      kind = 'password';
    }
    return {
      type: 'input',
      placeholder,
      kind,
      style: Object.keys(style).length > 0 ? style : undefined,
    };
  }

  // ── Image → image ──
  if (t === 'Image' || t === 'AnimatedImage' || t === 'SVG') {
    let src = parseString(node.properties.source) || undefined;
    return {
      type: 'image',
      src,
      style: Object.keys(style).length > 0 ? style : undefined,
    };
  }

  // ── Flickable / ScrollView → column (透传) ──
  if (t === 'Flickable' || t === 'ScrollView' || t === 'ListView' || t === 'GridView') {
    const children = node.children
      .map(qmlToUniversal)
      .filter((c): c is UniversalNode => c !== null);
    return {
      type: 'column',
      style: Object.keys(style).length > 0 ? style : undefined,
      children: children.length > 0 ? children : undefined,
    };
  }

  // ── 未知类型 → container (递归 children) ──
  const children = node.children
    .map(qmlToUniversal)
    .filter((c): c is UniversalNode => c !== null);
  return {
    type: 'container',
    style: Object.keys(style).length > 0 ? style : undefined,
    children: children.length > 0 ? children : undefined,
  };
}

// ──────────────────────────── 根节点查找 ────────────────────────────

function findRootObject(tokens: Token[]): UniversalNode | null {
  // 跳过开头的 import 语句: import QtQuick 2.15 / import QtQuick.Controls 2.15
  // import 语句格式: import <Module.Name> <version>
  // tokens: import, Module, ., Name, version, (下一个 import 或 根对象)
  let start = 0;
  while (start < tokens.length && tokens[start].value === 'import') {
    // 跳过整个 import 语句, 直到遇到下一个大写开头的 ident (根对象) 或 import
    let j = start + 1;
    // 跳过模块名 (可能含 . ): Module.Sub.Sub
    while (j < tokens.length) {
      const tj = tokens[j];
      if (tj.type === 'ident') {
        j++;
        // 允许 . 后跟 ident
        while (j < tokens.length && tokens[j].value === '.' && tokens[j + 1]?.type === 'ident') {
          j += 2;
        }
        // 版本号 (数字)
        if (j < tokens.length && tokens[j].type === 'number') {
          j++;
        }
        // 可能还有 as 别名
        if (j < tokens.length && tokens[j].value === 'as') {
          j++;
          if (j < tokens.length && tokens[j].type === 'ident') j++;
        }
        break;
      }
      j++;
    }
    start = j;
  }

  const parser = new QmlParser(tokens.slice(start));

  // QML 文件根对象就是第一个 parseObject()
  const root = parser.parseObject();
  if (root) {
    const node = qmlToUniversal(root);
    if (node) return node;
  }

  return null;
}

// ──────────────────────────── 翻译器实现 ────────────────────────────

export const qmlTranslator: Translator = {
  language: 'qml',
  displayName: 'Qt QML',

  /**
   * 检测代码是否为 Qt QML
   * 置信度:
   *   0.9  — import QtQuick + QML 类型
   *   0.8  — Rectangle / Item / Column / Row + 属性语法
   *   0.5  — anchors: / color: 等 QML 风格属性
   */
  detect(code: string): number {
    if (!code || typeof code !== 'string') return 0;
    const trimmed = code.trim();
    if (trimmed.length < 10) return 0;

    const hasQtImport = /import\s+QtQuick/.test(trimmed);
    const hasQmlType = /\b(Rectangle|Item|Row|Column|Text|Button|TextField|Image|Flickable|ListView)\s*\{/.test(trimmed);
    const hasQmlAttr = /\b(anchors|color:|width:|height:|radius:|font\.pixelSize:)\b/.test(trimmed);

    if (hasQtImport && hasQmlType) return 0.9;
    if (hasQmlType && hasQmlAttr) return 0.8;
    if (hasQmlAttr) return 0.5;

    return 0;
  },

  translate(code: string): UniversalNode {
    if (!code || typeof code !== 'string') {
      throw new TranslateError('qml', 'code 为空');
    }

    let tokens: Token[];
    try {
      tokens = tokenize(code);
    } catch (err: any) {
      throw new TranslateError('qml', `词法分析失败: ${err.message}`, code);
    }

    const root = findRootObject(tokens);
    if (!root) {
      throw new TranslateError('qml', '未找到 QML 根对象', code);
    }

    return root;
  },
};
