/**
 * flutterTranslator.ts — Flutter/Dart Widget → Universal AST 翻译器
 *
 * 将 Flutter Widget 代码解析成 UniversalNode 树。
 * 纯本地解析 (正则 + 括号匹配), 不消耗 LLM token。
 *
 * 支持的 Widget:
 *   - Container / SizedBox          → container
 *   - Row / Column                  → row / column
 *   - Stack / Positioned            → stack
 *   - Text                          → text
 *   - ElevatedButton / TextButton / OutlinedButton → button
 *   - TextField / TextFormField     → input
 *   - Image / Image.network         → image
 *   - Divider                       → divider
 *   - SizedBox(height:8)            → spacer
 *   - Padding / EdgeInsets          → 解析 padding 值
 *   - Scaffold / AppBar / body      → 提取 body 内容
 *
 * 属性解析 (命名参数):
 *   - padding: EdgeInsets.all(16)           → padding: 16
 *   - padding: EdgeInsets.symmetric(h:8,v:4) → padding: [4, 8]
 *   - color: Colors.red                     → color: "red"
 *   - color: Color(0xFF42A5F5)               → color: "#42A5F5"
 *   - decoration: BoxDecoration(...)        → background / radius / border
 *   - child: Widget                         → 递归
 *   - children: [Widget, Widget]            → 递归数组
 *
 * 不支持 (保持简单):
 *   - ListView / GridView (转为 column)
 *   - Builder / StatefulWidget 的状态逻辑
 *   - 自定义 Widget (透传为 container)
 *   - 动画 / Tween
 */

import type { UniversalNode, UniversalStyle, ButtonVariant, InputKind } from '../services/canvas/UniversalAST';
import { TranslateError, type Translator } from './types';

// ──────────────────────────── Dart Tokenizer ────────────────────────────

interface Token {
  type: 'ident' | 'number' | 'string' | 'punct' | 'keyword';
  value: string;
  pos: number;
}

/**
 * 简单 Dart 词法分析器
 * 识别: 标识符 / 数字 / 字符串 / 标点 / 关键字
 */
function tokenize(code: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = code.length;

  while (i < n) {
    const ch = code[i];

    // 跳过空白
    if (/\s/.test(ch)) { i++; continue; }

    // 跳过单行注释 //
    if (ch === '/' && code[i + 1] === '/') {
      while (i < n && code[i] !== '\n') i++;
      continue;
    }
    // 跳过多行注释 /* */
    if (ch === '/' && code[i + 1] === '*') {
      i += 2;
      while (i < n && !(code[i] === '*' && code[i + 1] === '/')) i++;
      i += 2;
      continue;
    }

    // 字符串 '...' / "..."
    if (ch === "'" || ch === '"') {
      const quote = ch;
      let val = '';
      i++;
      while (i < n && code[i] !== quote) {
        if (code[i] === '\\' && i + 1 < n) { val += code[i + 1]; i += 2; continue; }
        val += code[i];
        i++;
      }
      i++; // 跳过结束引号
      tokens.push({ type: 'string', value: val, pos: i });
      continue;
    }

    // 数字 (含负数 / 小数 / 0x)
    if (ch === '-' && /[\d.]/.test(code[i + 1]) || /[\d.]/.test(ch)) {
      let num = '';
      if (ch === '-') { num += ch; i++; }
      // 0x 十六进制
      if (code[i] === '0' && (code[i + 1] === 'x' || code[i + 1] === 'X')) {
        num += code[i] + code[i + 1];
        i += 2;
        while (i < n && /[\da-fA-F]/.test(code[i])) { num += code[i]; i++; }
      } else {
        while (i < n && /[\d.]/.test(code[i])) { num += code[i]; i++; }
      }
      tokens.push({ type: 'number', value: num, pos: i });
      continue;
    }

    // 标识符 / 关键字 (含 $ 和 _)
    if (/[a-zA-Z_$]/.test(ch)) {
      let id = '';
      while (i < n && /[\w$]/.test(code[i])) { id += code[i]; i++; }
      // ?. 和 . 不是标识符部分, 但成员访问 Foo.bar 需要保留点
      // 这里把 Foo.bar 作为单个 ident (简化)
      while (code[i] === '.' && /[a-zA-Z_$]/.test(code[i + 1] || '')) {
        id += '.';
        i++;
        while (i < n && /[\w$]/.test(code[i])) { id += code[i]; i++; }
      }
      const keywords = ['const', 'final', 'var', 'new', 'return', 'class', 'extends', 'void', 'int', 'double', 'String', 'bool', 'Widget', 'BuildContext'];
      tokens.push({
        type: keywords.includes(id) ? 'keyword' : 'ident',
        value: id,
        pos: i,
      });
      continue;
    }

    // 标点 (单字符)
    tokens.push({ type: 'punct', value: ch, pos: i });
    i++;
  }

  return tokens;
}

// ──────────────────────────── AST 节点 (中间表示) ────────────────────────────

interface DartCallNode {
  /** 函数/构造器名, 如 'Container' / 'EdgeInsets.all' / 'Colors.red' */
  name: string;
  /** 命名参数 { padding: ..., color: ..., child: ..., children: [...] } */
  namedArgs: Record<string, DartValue>;
  /** 位置参数 (如 Text('hello') 的 'hello') */
  positionalArgs: DartValue[];
}

type DartValue =
  | { kind: 'call'; node: DartCallNode }
  | { kind: 'literal'; value: string | number | boolean | null }
  | { kind: 'ident'; name: string }
  | { kind: 'list'; items: DartValue[] }
  | { kind: 'member'; object: string; property: string };

// ──────────────────────────── Dart Parser (递归下降) ────────────────────────────

class DartParser {
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

  private expect(value: string): Token {
    const t = this.consume();
    if (t.value !== value) {
      throw new Error(`期望 "${value}", 实际 "${t.value}"`);
    }
    return t;
  }

  /**
   * 跳过 const / final / new 前缀
   */
  private skipPrefixs(): void {
    while (this.peek() && ['const', 'final', 'new'].includes(this.peek()!.value)) {
      this.consume();
    }
  }

  /**
   * 解析一个值 (字面量 / 标识符 / 函数调用 / 列表)
   */
  parseValue(): DartValue {
    this.skipPrefixs();
    const t = this.peek();
    if (!t) return { kind: 'literal', value: null };

    // 字面量
    if (t.type === 'string') {
      this.consume();
      return { kind: 'literal', value: t.value };
    }
    if (t.type === 'number') {
      this.consume();
      const num = t.value.startsWith('0x') || t.value.startsWith('0X')
        ? parseInt(t.value, 16)
        : parseFloat(t.value);
      return { kind: 'literal', value: num };
    }
    if (t.value === 'true' || t.value === 'false') {
      this.consume();
      return { kind: 'literal', value: t.value === 'true' };
    }
    if (t.value === 'null') {
      this.consume();
      return { kind: 'literal', value: null };
    }

    // 列表 [ ... ]
    if (t.value === '[') {
      return this.parseList();
    }

    // 标识符 / 函数调用 / 成员访问
    if (t.type === 'ident' || t.type === 'keyword') {
      // 先收集完整标识符 (含 . 访问, 如 Colors.red)
      let name = t.value;
      this.consume();

      // 检查是否是函数调用 (后面跟 ()
      if (this.peek()?.value === '(') {
        return this.parseCall(name);
      }

      // 成员访问 Colors.red (但没有 () → 是枚举值)
      // 注意: tokenizer 已经把 Colors.red 合并成一个 ident
      if (name.includes('.')) {
        const dotIdx = name.lastIndexOf('.');
        return {
          kind: 'member',
          object: name.slice(0, dotIdx),
          property: name.slice(dotIdx + 1),
        };
      }

      return { kind: 'ident', name };
    }

    // 其他 (unexpected)
    this.consume();
    return { kind: 'literal', value: null };
  }

  /**
   * 解析函数调用 Name(arg1, arg2, name: value, child: ...)
   */
  parseCall(name: string): DartValue {
    this.expect('(');

    const node: DartCallNode = {
      name,
      namedArgs: {},
      positionalArgs: [],
    };

    // 空参数 ()
    if (this.peek()?.value === ')') {
      this.consume();
      return { kind: 'call', node };
    }

    while (true) {
      // 检查是否命名参数 (ident: value)
      const t = this.peek();
      const next = this.peek(1);

      if (t?.type === 'ident' && next?.value === ':') {
        const argName = t.value;
        this.consume(); // ident
        this.consume(); // :
        const val = this.parseValue();
        node.namedArgs[argName] = val;
      } else {
        // 位置参数
        const val = this.parseValue();
        node.positionalArgs.push(val);
      }

      // 逗号 → 继续, 闭括号 → 结束
      const sep = this.peek();
      if (sep?.value === ',') {
        this.consume();
        // 允许尾逗号
        if (this.peek()?.value === ')') break;
        continue;
      }
      if (sep?.value === ')') break;
      // 其他情况 (可能语法错误) → 防止死循环
      if (!sep) break;
    }

    this.expect(')');
    return { kind: 'call', node };
  }

  /**
   * 解析列表 [item1, item2, ...]
   */
  parseList(): DartValue {
    this.expect('[');
    const items: DartValue[] = [];

    if (this.peek()?.value === ']') {
      this.consume();
      return { kind: 'list', items };
    }

    while (true) {
      items.push(this.parseValue());

      const sep = this.peek();
      if (sep?.value === ',') {
        this.consume();
        if (this.peek()?.value === ']') break;
        continue;
      }
      if (sep?.value === ']') break;
      if (!sep) break;
    }

    this.expect(']');
    return { kind: 'list', items };
  }
}

// ──────────────────────────── DartValue → UniversalNode ────────────────────────────

/**
 * 解析颜色值
 *   Colors.red → "red"
 *   Colors.blue.shade700 → "blue" (忽略 shade)
 *   Color(0xFF42A5F5) → "#42A5F5"
 *   Color.fromARGB(255, 66, 165, 245) → "#42A5F5"
 */
function parseColor(val: DartValue): string | undefined {
  if (val.kind === 'member' && val.object === 'Colors') {
    return val.property;
  }
  if (val.kind === 'call') {
    const node = val.node;
    if (node.name === 'Color' && node.positionalArgs.length > 0) {
      const arg = node.positionalArgs[0];
      if (arg.kind === 'literal' && typeof arg.value === 'number') {
        // 0xFF42A5F5 → #42A5F5
        const hex = Math.floor(arg.value).toString(16).padStart(8, '0');
        // 去掉 FF 前缀 (alpha)
        return '#' + hex.slice(2).toUpperCase();
      }
    }
    if (node.name === 'Color.fromARGB' && node.positionalArgs.length === 4) {
      const args = node.positionalArgs.map(a => a.kind === 'literal' && typeof a.value === 'number' ? a.value : 0);
      const [, r, g, b] = args;
      const toHex = (n: number) => Math.floor(n).toString(16).padStart(2, '0');
      return '#' + toHex(r) + toHex(g) + toHex(b);
    }
  }
  return undefined;
}

/**
 * 解析数字值
 */
function parseNumber(val: DartValue): number | undefined {
  if (val.kind === 'literal' && typeof val.value === 'number') {
    return val.value;
  }
  return undefined;
}

/**
 * 解析 EdgeInsets → padding 值
 *   EdgeInsets.all(16) → 16
 *   EdgeInsets.symmetric(horizontal: 8, vertical: 4) → [4, 8]
 *   EdgeInsets.only(top: 1, right: 2, bottom: 3, left: 4) → [1, 2, 3, 4]
 */
function parseEdgeInsets(val: DartValue): number | [number, number] | [number, number, number, number] | undefined {
  if (val.kind !== 'call') return undefined;
  const node = val.node;

  if (node.name === 'EdgeInsets.all' && node.positionalArgs.length > 0) {
    const n = parseNumber(node.positionalArgs[0]);
    return n;
  }

  if (node.name === 'EdgeInsets.symmetric') {
    const h = parseNumber(node.namedArgs.horizontal) ?? 0;
    const v = parseNumber(node.namedArgs.vertical) ?? 0;
    return [v, h];
  }

  if (node.name === 'EdgeInsets.only') {
    const t = parseNumber(node.namedArgs.top) ?? 0;
    const r = parseNumber(node.namedArgs.right) ?? 0;
    const b = parseNumber(node.namedArgs.bottom) ?? 0;
    const l = parseNumber(node.namedArgs.left) ?? 0;
    return [t, r, b, l];
  }

  return undefined;
}

/**
 * 解析 BoxDecoration → background / radius / border
 */
function parseBoxDecoration(val: DartValue, style: UniversalStyle): void {
  if (val.kind !== 'call') return;
  const node = val.node;

  // color: Colors.red
  const color = parseColor(node.namedArgs.color);
  if (color) style.background = color;

  // borderRadius: BorderRadius.circular(8) / BorderRadius.all(Radius.circular(8))
  const br = node.namedArgs.borderRadius;
  if (br?.kind === 'call') {
    if (br.node.name === 'BorderRadius.circular' && br.node.positionalArgs.length > 0) {
      style.radius = parseNumber(br.node.positionalArgs[0]);
    } else if (br.node.name === 'BorderRadius.all' && br.node.positionalArgs.length > 0) {
      const inner = br.node.positionalArgs[0];
      if (inner.kind === 'call' && inner.node.name === 'Radius.circular' && inner.node.positionalArgs.length > 0) {
        style.radius = parseNumber(inner.node.positionalArgs[0]);
      }
    }
  }

  // border: Border.all(color: ..., width: ...)
  const border = node.namedArgs.border;
  if (border?.kind === 'call' && border.node.name === 'Border.all') {
    const bc = parseColor(border.node.namedArgs.color);
    const bw = parseNumber(border.node.namedArgs.width) ?? 1;
    if (bc) style.border = `${bw}px solid ${bc}`;
    else style.border = `${bw}px solid #000`;
  }
}

/**
 * 解析 TextStyle → fontSize / fontWeight / color
 */
function parseTextStyle(val: DartValue, style: UniversalStyle): void {
  if (val.kind !== 'call') return;
  const node = val.node;

  const fontSize = parseNumber(node.namedArgs.fontSize);
  if (fontSize) style.fontSize = fontSize;

  const color = parseColor(node.namedArgs.color);
  if (color) style.color = color;

  if (node.namedArgs.fontWeight) {
    const fw = node.namedArgs.fontWeight;
    if (fw.kind === 'member' && fw.object === 'FontWeight') {
      const map: Record<string, number> = {
        w100: 100, w200: 200, w300: 300, w400: 400, normal: 400,
        w500: 500, w600: 600, w700: 700, bold: 700, w800: 800, w900: 900,
      };
      const w = map[fw.property];
      if (w) style.fontWeight = w as any;
    }
  }
}

/**
 * 解析 Alignment → align
 *   Alignment.center / Alignment.topLeft / ...
 */
function parseAlignment(val: DartValue): UniversalStyle['align'] | undefined {
  if (val.kind !== 'member' || val.object !== 'Alignment') return undefined;
  switch (val.property) {
    case 'topLeft': case 'topCenter': case 'topRight': return 'start';
    case 'centerLeft': case 'center': case 'centerRight': return 'center';
    case 'bottomLeft': case 'bottomCenter': case 'bottomRight': return 'end';
    default: return undefined;
  }
}

/**
 * 解析 MainAxisAlignment → justify
 */
function parseMainAxisAlignment(val: DartValue): UniversalStyle['justify'] | undefined {
  if (val.kind !== 'member' || val.object !== 'MainAxisAlignment') return undefined;
  switch (val.property) {
    case 'start': return 'start';
    case 'center': return 'center';
    case 'end': return 'end';
    default: return undefined;
  }
}

/**
 * 把 DartValue (期望是 call) 转为 UniversalNode
 */
function dartValueToNode(val: DartValue): UniversalNode | null {
  if (val.kind !== 'call') return null;
  return parseWidget(val.node);
}

/**
 * 核心: 解析 Widget 构造调用为 UniversalNode
 */
function parseWidget(node: DartCallNode): UniversalNode | null {
  const name = node.name;

  // ── Container / SizedBox / DecoratedBox → container ──
  if (name === 'Container' || name === 'SizedBox' || name === 'DecoratedBox') {
    const style: UniversalStyle = {};

    // padding (Container.padding)
    if (node.namedArgs.padding) {
      const p = parseEdgeInsets(node.namedArgs.padding);
      if (p !== undefined) style.padding = p;
    }

    // margin
    if (node.namedArgs.margin) {
      const m = parseEdgeInsets(node.namedArgs.margin);
      if (m !== undefined) style.margin = m;
    }

    // color (Container.color)
    if (node.namedArgs.color) {
      const c = parseColor(node.namedArgs.color);
      if (c) style.background = c;
    }

    // decoration (BoxDecoration)
    if (node.namedArgs.decoration) {
      parseBoxDecoration(node.namedArgs.decoration, style);
    }

    // width / height (SizedBox)
    if (node.namedArgs.width) {
      const w = parseNumber(node.namedArgs.width);
      if (w) style.width = w;
    }
    if (node.namedArgs.height) {
      const h = parseNumber(node.namedArgs.height);
      if (h) style.height = h;
    }

    // child → 递归
    const childNode = node.namedArgs.child ? dartValueToNode(node.namedArgs.child) : null;

    // SizedBox(height:8) 无 child → spacer
    if (name === 'SizedBox' && !childNode && style.height) {
      return { type: 'spacer', style: { height: style.height } };
    }

    return {
      type: 'container',
      style: Object.keys(style).length > 0 ? style : undefined,
      children: childNode ? [childNode] : undefined,
    };
  }

  // ── Padding → container (把 padding 下放到 style) ──
  if (name === 'Padding') {
    const style: UniversalStyle = {};
    if (node.namedArgs.padding) {
      const p = parseEdgeInsets(node.namedArgs.padding);
      if (p !== undefined) style.padding = p;
    }
    const childNode = node.namedArgs.child ? dartValueToNode(node.namedArgs.child) : null;
    return {
      type: 'container',
      style: Object.keys(style).length > 0 ? style : undefined,
      children: childNode ? [childNode] : undefined,
    };
  }

  // ── Row → row ──
  if (name === 'Row' || name === 'Column') {
    const style: UniversalStyle = {};
    if (node.namedArgs.mainAxisAlignment) {
      const j = parseMainAxisAlignment(node.namedArgs.mainAxisAlignment);
      if (j) style.justify = j;
    }
    if (node.namedArgs.crossAxisAlignment) {
      const a = parseAlignment(node.namedArgs.crossAxisAlignment);
      if (a) style.align = a;
    }

    const children: UniversalNode[] = [];
    if (node.namedArgs.children?.kind === 'list') {
      for (const item of node.namedArgs.children.items) {
        const child = dartValueToNode(item);
        if (child) children.push(child);
      }
    }

    return {
      type: name === 'Row' ? 'row' : 'column',
      style: Object.keys(style).length > 0 ? style : undefined,
      children: children.length > 0 ? children : undefined,
    };
  }

  // ── Stack → stack ──
  if (name === 'Stack') {
    const children: UniversalNode[] = [];
    if (node.namedArgs.children?.kind === 'list') {
      for (const item of node.namedArgs.children.items) {
        const child = dartValueToNode(item);
        if (child) children.push(child);
      }
    }
    return {
      type: 'stack',
      children: children.length > 0 ? children : undefined,
    };
  }

  // ── Text → text ──
  if (name === 'Text') {
    let content = '';
    if (node.positionalArgs.length > 0) {
      const arg = node.positionalArgs[0];
      if (arg.kind === 'literal' && typeof arg.value === 'string') {
        content = arg.value;
      } else if (arg.kind === 'ident') {
        content = `{${arg.name}}`;
      }
    }

    const style: UniversalStyle = {};
    if (node.namedArgs.style) {
      parseTextStyle(node.namedArgs.style, style);
    }

    return {
      type: 'text',
      content,
      style: Object.keys(style).length > 0 ? style : undefined,
    };
  }

  // ── ElevatedButton / TextButton / OutlinedButton → button ──
  if (name === 'ElevatedButton' || name === 'TextButton' || name === 'OutlinedButton' || name === 'FloatingActionButton') {
    let label = 'Button';
    // child: Text('...')
    if (node.namedArgs.child?.kind === 'call') {
      const childCall = node.namedArgs.child.node;
      if (childCall.name === 'Text' && childCall.positionalArgs.length > 0) {
        const arg = childCall.positionalArgs[0];
        if (arg.kind === 'literal' && typeof arg.value === 'string') {
          label = arg.value;
        }
      }
    }
    // onPressed: () {} (忽略)

    let variant: ButtonVariant = 'filled';
    if (name === 'TextButton') variant = 'text';
    else if (name === 'OutlinedButton') variant = 'outlined';

    return { type: 'button', label, variant };
  }

  // ── TextField / TextFormField → input ──
  if (name === 'TextField' || name === 'TextFormField') {
    const style: UniversalStyle = {};
    let placeholder: string | undefined;
    let kind: InputKind = 'text';

    // decoration: InputDecoration(hintText: '...', border: ...)
    if (node.namedArgs.decoration?.kind === 'call') {
      const deco = node.namedArgs.decoration.node;
      if (deco.namedArgs.hintText?.kind === 'literal' && typeof deco.namedArgs.hintText.value === 'string') {
        placeholder = deco.namedArgs.hintText.value;
      }
    }

    // obscureText: true → password
    if (node.namedArgs.obscureText?.kind === 'literal' && node.namedArgs.obscureText.value === true) {
      kind = 'password';
    }

    return { type: 'input', placeholder, kind, style: undefined };
  }

  // ── Image / Image.network → image ──
  if (name === 'Image' || name === 'Image.network' || name === 'Image.asset') {
    let src: string | undefined;
    if (node.positionalArgs.length > 0) {
      const arg = node.positionalArgs[0];
      if (arg.kind === 'literal' && typeof arg.value === 'string') {
        src = arg.value;
      }
    }
    return { type: 'image', src };
  }

  // ── Divider → divider ──
  if (name === 'Divider') {
    const style: UniversalStyle = {};
    if (node.namedArgs.height) {
      const h = parseNumber(node.namedArgs.height);
      if (h) style.height = h;
    }
    if (node.namedArgs.color) {
      const c = parseColor(node.namedArgs.color);
      if (c) style.background = c;
    }
    return { type: 'divider', style: Object.keys(style).length > 0 ? style : undefined };
  }

  // ── Scaffold → 提取 body ──
  if (name === 'Scaffold') {
    if (node.namedArgs.body) {
      return dartValueToNode(node.namedArgs.body);
    }
    // 无 body → 空容器
    return { type: 'container' };
  }

  // ── AppBar → container (简化) ──
  if (name === 'AppBar') {
    const style: UniversalStyle = { padding: 16, background: '#2196F3' };
    const children: UniversalNode[] = [];
    if (node.namedArgs.title) {
      const titleNode = dartValueToNode(node.namedArgs.title);
      if (titleNode) children.push(titleNode);
    }
    return {
      type: 'container',
      style,
      children: children.length > 0 ? children : undefined,
    };
  }

  // ── Card → container (带圆角阴影) ──
  if (name === 'Card') {
    const style: UniversalStyle = { radius: 8, shadow: '0 2px 8px rgba(0,0,0,0.15)' };
    if (node.namedArgs.color) {
      const c = parseColor(node.namedArgs.color);
      if (c) style.background = c;
    }
    const childNode = node.namedArgs.child ? dartValueToNode(node.namedArgs.child) : null;
    return {
      type: 'container',
      style,
      children: childNode ? [childNode] : undefined,
    };
  }

  // ── Center / Align → container (居中样式) ──
  if (name === 'Center') {
    const childNode = node.namedArgs.child ? dartValueToNode(node.namedArgs.child) : null;
    return {
      type: 'container',
      style: { align: 'center', justify: 'center' },
      children: childNode ? [childNode] : undefined,
    };
  }
  if (name === 'Align') {
    const childNode = node.namedArgs.child ? dartValueToNode(node.namedArgs.child) : null;
    const style: UniversalStyle = {};
    if (node.namedArgs.alignment) {
      const a = parseAlignment(node.namedArgs.alignment);
      if (a) style.align = a;
    }
    return {
      type: 'container',
      style: Object.keys(style).length > 0 ? style : undefined,
      children: childNode ? [childNode] : undefined,
    };
  }

  // ── Expanded / Flexible → 透传 child ──
  if (name === 'Expanded' || name === 'Flexible') {
    if (node.namedArgs.child) {
      const child = dartValueToNode(node.namedArgs.child);
      if (child) {
        // 给 child 加 flex 标记
        if (!child.style) (child as any).style = {};
        const flex = parseNumber(node.namedArgs.flex) ?? 1;
        (child as any).style.flex = flex;
        return child;
      }
    }
    return { type: 'container' };
  }

  // ── ListView / GridView → column (简化) ──
  if (name === 'ListView' || name === 'GridView') {
    const children: UniversalNode[] = [];
    if (node.namedArgs.children?.kind === 'list') {
      for (const item of node.namedArgs.children.items) {
        const child = dartValueToNode(item);
        if (child) children.push(child);
      }
    }
    return {
      type: 'column',
      children: children.length > 0 ? children : undefined,
    };
  }

  // ── 未知 Widget → container (透传 child) ──
  const childNode = node.namedArgs.child ? dartValueToNode(node.namedArgs.child) : null;
  const children: UniversalNode[] = [];
  if (node.namedArgs.children?.kind === 'list') {
    for (const item of node.namedArgs.children.items) {
      const child = dartValueToNode(item);
      if (child) children.push(child);
    }
  }
  if (childNode) children.push(childNode);

  return {
    type: 'container',
    children: children.length > 0 ? children : undefined,
  };
}

// ──────────────────────────── 根节点查找 ────────────────────────────

/**
 * 在 Dart 代码中查找第一个 Widget 构造调用
 *
 * 查找顺序:
 *   1. return Widget; (build 方法返回值)
 *   2. body: Widget (Scaffold 的 body)
 *   3. 任意位置的 Widget 调用
 */
function findRootWidget(tokens: Token[]): UniversalNode | null {
  // 策略: 找第一个 return 后面的 Widget 调用
  // 如果没有 return, 找第一个大写开头的 ident 后跟 (

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];

    // return Widget(...)
    if (t.type === 'keyword' && t.value === 'return') {
      // 跳过 const / new
      let j = i + 1;
      while (j < tokens.length && ['const', 'new', 'final'].includes(tokens[j].value)) j++;

      if (j < tokens.length && tokens[j].type === 'ident' && /^[A-Z]/.test(tokens[j].value)) {
        // 后面跟 (
        if (tokens[j + 1]?.value === '(') {
          const parser = new DartParser(tokens.slice(j));
          const val = parser.parseValue();
          if (val.kind === 'call') {
            return parseWidget(val.node);
          }
        }
        // return Colors.red; 这种非 Widget 返回值 → 跳过
      }
    }
  }

  // 没有 return → 找第一个 PascalCase ident 后跟 (
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === 'ident' && /^[A-Z]/.test(t.value) && !['String', 'Widget', 'BuildContext', 'Color', 'Colors', 'FontWeight', 'MainAxisAlignment', 'CrossAxisAlignment', 'Alignment', 'EdgeInsets', 'BorderRadius', 'Radius', 'Border', 'BoxDecoration', 'TextStyle', 'InputDecoration'].includes(t.value)) {
      if (tokens[i + 1]?.value === '(') {
        const parser = new DartParser(tokens.slice(i));
        const val = parser.parseValue();
        if (val.kind === 'call') {
          const node = parseWidget(val.node);
          if (node) return node;
        }
      }
    }
  }

  return null;
}

// ──────────────────────────── 翻译器实现 ────────────────────────────

export const flutterTranslator: Translator = {
  language: 'flutter',
  displayName: 'Flutter/Dart',

  /**
   * 检测代码是否为 Flutter/Dart
   * 置信度:
   *   0.9  — import 'package:flutter' + Widget 构造
   *   0.8  — Widget build(BuildContext) + return Widget
   *   0.6  — MaterialApp / Scaffold / Container / Row / Column 等
   *   0.3  — class X extends StatelessWidget/StatefulWidget
   */
  detect(code: string): number {
    if (!code || typeof code !== 'string') return 0;
    const trimmed = code.trim();
    if (trimmed.length < 10) return 0;

    const hasFlutterImport = /import\s+['"]package:flutter/.test(trimmed);
    const hasWidget = /\b(MaterialApp|Scaffold|Container|Row|Column|Stack|Text\(|ElevatedButton|TextButton|TextField|AppBar)\b/.test(trimmed);
    const hasBuildMethod = /\bWidget\s+build\s*\(\s*BuildContext/.test(trimmed);
    const hasStateless = /extends\s+(StatelessWidget|StatefulWidget|State)\b/.test(trimmed);

    if (hasFlutterImport && hasWidget) return 0.9;
    if (hasBuildMethod && hasWidget) return 0.8;
    if (hasWidget) return 0.6;
    if (hasStateless) return 0.3;

    return 0;
  },

  /**
   * 翻译 Flutter/Dart 代码为 Universal AST
   * @throws TranslateError 当解析失败时
   */
  translate(code: string): UniversalNode {
    if (!code || typeof code !== 'string') {
      throw new TranslateError('flutter', 'code 为空');
    }

    let tokens: Token[];
    try {
      tokens = tokenize(code);
    } catch (err: any) {
      throw new TranslateError('flutter', `词法分析失败: ${err.message}`, code);
    }

    const root = findRootWidget(tokens);
    if (!root) {
      throw new TranslateError('flutter', '未找到 Widget 根节点', code);
    }

    return root;
  },
};
