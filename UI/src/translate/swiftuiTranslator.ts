/**
 * swiftuiTranslator.ts — SwiftUI → Universal AST 翻译器
 *
 * 将 SwiftUI 代码解析成 UniversalNode 树。
 * 纯本地解析 (正则 + 括号匹配), 不消耗 LLM token。
 *
 * SwiftUI 语法特点:
 *   - 隐式 children: VStack { Text("a"); Text("b") } (ViewBuilder)
 *   - 修饰符链: Text("hi").font(.title).padding()
 *   - 尾随闭包: Button("Click") { action } / VStack { content }
 *
 * 支持的 View:
 *   - VStack / HStack / ZStack       → column / row / stack
 *   - ScrollView / List / ForEach    → column (简化)
 *   - Text                           → text
 *   - Button                         → button
 *   - TextField / SecureField        → input
 *   - Image                          → image
 *   - Divider                        → divider
 *   - Spacer                         → spacer
 *   - Color                          → container (带背景色)
 *
 * 修饰符解析 (链式 .modifier()):
 *   - .padding(16) / .padding(.horizontal, 8)  → padding
 *   - .background(Color.red)                   → background
 *   - .foregroundColor(.red)                   → color
 *   - .font(.title) / .font(.system(size: 20)) → fontSize
 *   - .fontWeight(.bold)                       → fontWeight
 *   - .frame(width: 100, height: 50)           → width/height
 *   - .cornerRadius(8) / .clipShape(RoundedRectangle(...)) → radius
 *   - .border(.red, width: 2)                  → border
 *   - .shadow(...)                             → shadow
 *   - .opacity(0.5)                            → opacity
 */

import type { UniversalNode, UniversalStyle, ButtonVariant, InputKind } from '../services/canvas/UniversalAST';
import { TranslateError, type Translator } from './types';

// ──────────────────────────── Swift Tokenizer ────────────────────────────

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

    // 单行注释 //
    if (ch === '/' && code[i + 1] === '/') {
      while (i < n && code[i] !== '\n') i++;
      continue;
    }
    // 多行注释 /* */
    if (ch === '/' && code[i + 1] === '*') {
      i += 2;
      while (i < n && !(code[i] === '*' && code[i + 1] === '/')) i++;
      i += 2;
      continue;
    }

    // 字符串 "..." (Swift 多行字符串 """ 也简化处理)
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

    // 标识符 / 关键字 (含 .)
    if (/[a-zA-Z_$]/.test(ch)) {
      let id = '';
      while (i < n && /[\w$]/.test(code[i])) { id += code[i]; i++; }
      const keywords = ['var', 'let', 'func', 'return', 'struct', 'class', 'extension', 'import', 'some', 'if', 'else', 'guard', 'for', 'in', 'switch', 'case', 'default', 'private', 'public', 'internal', 'static', 'var', 'let', 'true', 'false', 'nil'];
      tokens.push({
        type: keywords.includes(id) ? 'keyword' : 'ident',
        value: id,
        pos: i,
      });
      continue;
    }

    // .ident (枚举值 / 修饰符前缀 .red / .padding)
    if (ch === '.' && /[a-zA-Z_]/.test(code[i + 1] || '')) {
      let id = '.';
      i++;
      while (i < n && /[\w$]/.test(code[i])) { id += code[i]; i++; }
      tokens.push({ type: 'ident', value: id, pos: i });
      continue;
    }

    tokens.push({ type: 'punct', value: ch, pos: i });
    i++;
  }

  return tokens;
}

// ──────────────────────────── Swift AST (中间表示) ────────────────────────────

interface SwiftViewNode {
  /** View 类型名, 如 'VStack' / 'Text' / 'Button' */
  type: string;
  /** 位置参数 (如 Text("hello") 的 "hello") */
  positionalArgs: SwiftValue[];
  /** 命名参数 (如 TextField("hint", text: $value) 的 text:) */
  namedArgs: Record<string, SwiftValue>;
  /** 隐式 children (尾随闭包内容) */
  children: SwiftViewNode[];
  /** 修饰符链 (.padding() / .background() ...) */
  modifiers: SwiftModifier[];
}

interface SwiftModifier {
  name: string; // 'padding' / 'background' / 'font' ...
  positionalArgs: SwiftValue[];
  namedArgs: Record<string, SwiftValue>;
}

type SwiftValue =
  | { kind: 'literal'; value: string | number | boolean | null }
  | { kind: 'enumCase'; value: string } // .red / .title / .bold
  | { kind: 'ident'; name: string }
  | { kind: 'call'; name: string; positionalArgs: SwiftValue[]; namedArgs: Record<string, SwiftValue> };

// ──────────────────────────── Swift Parser ────────────────────────────

class SwiftParser {
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
   * 解析一个值: 字面量 / 枚举值 / 标识符 / 函数调用
   */
  parseValue(): SwiftValue {
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
    if (t.value === 'nil') {
      this.consume();
      return { kind: 'literal', value: null };
    }

    // 枚举值 .red / .title / .bold / .horizontal
    if (t.type === 'ident' && t.value.startsWith('.')) {
      this.consume();
      return { kind: 'enumCase', value: t.value.slice(1) };
    }

    // 标识符 / 函数调用
    if (t.type === 'ident') {
      const name = t.value;
      this.consume();

      // 成员访问: Color.red (后面 .red 是独立 token)
      // 把 Color.red 合并成一个 ident, 防止 .red 被误当修饰符
      if (this.peek()?.type === 'ident' && this.peek()!.value.startsWith('.')) {
        const member = this.consume().value; // ".red"
        const fullName = `${name}${member}`; // "Color.red"
        // 后面可能还有 () 如 Color.red.something()
        if (this.peek()?.value === '(') {
          return this.parseCall(fullName);
        }
        return { kind: 'ident', name: fullName };
      }

      // 函数调用 Color(...)
      if (this.peek()?.value === '(') {
        return this.parseCall(name);
      }
      return { kind: 'ident', name };
    }

    this.consume();
    return { kind: 'literal', value: null };
  }

  /**
   * 解析函数调用 Name(args)
   */
  parseCall(name: string): SwiftValue {
    this.expect('(');
    const positionalArgs: SwiftValue[] = [];
    const namedArgs: Record<string, SwiftValue> = {};

    if (this.peek()?.value === ')') {
      this.consume();
      return { kind: 'call', name, positionalArgs, namedArgs };
    }

    while (true) {
      // 检查命名参数 argName: value
      const t = this.peek();
      const next = this.peek(1);
      if (t?.type === 'ident' && !t.value.startsWith('.') && next?.value === ':') {
        const argName = t.value;
        this.consume(); // ident
        this.consume(); // :
        const val = this.parseValue();
        namedArgs[argName] = val;
      } else {
        positionalArgs.push(this.parseValue());
      }

      const sep = this.peek();
      if (sep?.value === ',') { this.consume(); continue; }
      if (sep?.value === ')') break;
      if (!sep) break;
    }

    this.expect(')');
    return { kind: 'call', name, positionalArgs, namedArgs };
  }

  /**
   * 解析 View 表达式
   *
   * View = PrimaryView (modifier)*
   * PrimaryView = ViewName (args)? trailingClosure?
   *
   * 尾随闭包: VStack { ... } / Button("label") { action }
   */
  parseView(): SwiftViewNode | null {
    const t = this.peek();
    if (!t || t.type !== 'ident' || t.value.startsWith('.')) return null;

    const typeName = t.value;
    this.consume();

    const node: SwiftViewNode = {
      type: typeName,
      positionalArgs: [],
      namedArgs: {},
      children: [],
      modifiers: [],
    };

    // 位置/命名参数 (...)
    if (this.peek()?.value === '(') {
      const callVal = this.parseCall(typeName);
      node.positionalArgs = callVal.positionalArgs;
      node.namedArgs = callVal.namedArgs;
    }

    // 尾随闭包 { ... }
    if (this.peek()?.value === '{') {
      this.consume(); // {
      node.children = this.parseViewList();
      if (this.peek()?.value === '}') this.consume();
    }

    // 修饰符链 .modifier() / .modifier { }
    while (this.peek()?.type === 'ident' && this.peek()!.value.startsWith('.') && this.peek()!.value.length > 1) {
      const modName = this.consume().value.slice(1);
      const mod: SwiftModifier = { name: modName, positionalArgs: [], namedArgs: {} };

      if (this.peek()?.value === '(') {
        const modCall = this.parseCall(modName);
        mod.positionalArgs = modCall.positionalArgs;
        mod.namedArgs = modCall.namedArgs;
      }

      // 修饰符也可能有尾随闭包 (如 .background { ... }) — 简化: 跳过
      if (this.peek()?.value === '{') {
        this.consume(); // {
        // 跳过整个闭包内容 (按括号匹配)
        let depth = 1;
        while (depth > 0 && this.peek()) {
          const v = this.consume().value;
          if (v === '{') depth++;
          else if (v === '}') depth--;
        }
      }

      node.modifiers.push(mod);
    }

    return node;
  }

  /**
   * 解析 View 列表 (闭包内的多个 view)
   * 语法: View1 \n View2 \n View3 (Swift 用换行分隔, 不需要分号)
   */
  parseViewList(): SwiftViewNode[] {
    const views: SwiftViewNode[] = [];

    while (this.peek() && this.peek()!.value !== '}') {
      // 跳过分号
      if (this.peek()!.value === ';') { this.consume(); continue; }

      const v = this.parseView();
      if (v) {
        views.push(v);
      } else {
        // 无法解析的 token → 跳过 (防止死循环)
        this.consume();
      }
    }

    return views;
  }
}

// ──────────────────────────── SwiftValue → UniversalNode ────────────────────────────

/**
 * 解析 Color 值
 *   .red / .blue / .green (SwiftUI 颜色枚举) → "red" / "blue"
 *   Color.red → "red"
 *   Color(red: 0.5, green: 0.5, blue: 0.5) → "#808080" (简化)
 */
function parseColor(val: SwiftValue): string | undefined {
  if (val.kind === 'enumCase') {
    return val.value;
  }
  if (val.kind === 'call' && val.name === 'Color') {
    // Color.red  (不应该是 call, 但兜底)
    if (val.positionalArgs.length === 0) return undefined;
  }
  if (val.kind === 'ident' && val.name.startsWith('Color.')) {
    return val.name.slice('Color.'.length);
  }
  return undefined;
}

function parseNumber(val: SwiftValue | undefined): number | undefined {
  if (!val) return undefined;
  if (val.kind === 'literal' && typeof val.value === 'number') return val.value;
  return undefined;
}

function parseString(val: SwiftValue | undefined): string | undefined {
  if (!val) return undefined;
  if (val.kind === 'literal' && typeof val.value === 'string') return val.value;
  return undefined;
}

/**
 * 解析 .font() 修饰符 → fontSize
 *   .font(.title) → 28 (SwiftUI title ≈ 28)
 *   .font(.system(size: 20)) → 20
 *   .font(.headline) → 17
 */
function parseFont(mod: SwiftModifier): { fontSize?: number; fontWeight?: number } {
  const result: { fontSize?: number; fontWeight?: number } = {};

  // .font(.title)
  if (mod.positionalArgs.length > 0) {
    const arg = mod.positionalArgs[0];
    if (arg.kind === 'enumCase') {
      const sizeMap: Record<string, number> = {
        largeTitle: 34, title: 28, title2: 22, title3: 20,
        headline: 17, subheadline: 15, body: 17, callout: 16,
        footnote: 13, caption: 12, caption2: 11,
      };
      if (sizeMap[arg.value]) result.fontSize = sizeMap[arg.value];
    }
    // .font(.system(size: 20))
    if (arg.kind === 'call' && arg.name === '.system') {
      const size = parseNumber(arg.namedArgs.size);
      if (size) result.fontSize = size;
    }
  }

  return result;
}

/**
 * 解析 .padding() 修饰符 → padding 值
 *   .padding() → 16 (默认)
 *   .padding(20) → 20
 *   .padding(.horizontal, 8) → [0, 8]
 *   .padding(.all, 16) → 16
 */
function parsePadding(mod: SwiftModifier): number | [number, number] | [number, number, number, number] | undefined {
  // .padding(20)
  if (mod.positionalArgs.length === 1) {
    const n = parseNumber(mod.positionalArgs[0]);
    if (n !== undefined) return n;
  }

  // .padding(.horizontal, 8) / .padding(.vertical, 4)
  if (mod.positionalArgs.length === 2) {
    const edge = mod.positionalArgs[0];
    const amount = parseNumber(mod.positionalArgs[1]) ?? 16;
    if (edge.kind === 'enumCase') {
      if (edge.value === 'horizontal') return [0, amount];
      if (edge.value === 'vertical') return [amount, 0];
      if (edge.value === 'all') return amount;
    }
  }

  // .padding() → 默认 16
  if (mod.positionalArgs.length === 0) return 16;

  return undefined;
}

/**
 * 应用修饰符链到 style
 */
function applyModifiers(node: SwiftViewNode, style: UniversalStyle): void {
  for (const mod of node.modifiers) {
    switch (mod.name) {
      case 'padding': {
        const p = parsePadding(mod);
        if (p !== undefined) style.padding = p;
        break;
      }
      case 'background': {
        if (mod.positionalArgs.length > 0) {
          const c = parseColor(mod.positionalArgs[0]);
          if (c) style.background = c;
        }
        break;
      }
      case 'foregroundColor':
      case 'foregroundStyle': {
        if (mod.positionalArgs.length > 0) {
          const c = parseColor(mod.positionalArgs[0]);
          if (c) style.color = c;
        }
        break;
      }
      case 'font': {
        const f = parseFont(mod);
        if (f.fontSize) style.fontSize = f.fontSize;
        if (f.fontWeight) style.fontWeight = f.fontWeight as any;
        break;
      }
      case 'fontWeight': {
        if (mod.positionalArgs.length > 0) {
          const arg = mod.positionalArgs[0];
          if (arg.kind === 'enumCase') {
            const map: Record<string, number> = {
              bold: 700, semibold: 600, medium: 500, regular: 400, light: 300, heavy: 800, black: 900,
            };
            if (map[arg.value]) style.fontWeight = map[arg.value] as any;
          }
        }
        break;
      }
      case 'frame': {
        const w = parseNumber(mod.namedArgs.width);
        const h = parseNumber(mod.namedArgs.height);
        if (w) style.width = w;
        if (h) style.height = h;
        break;
      }
      case 'cornerRadius':
      case 'clipShape': {
        if (mod.name === 'cornerRadius') {
          const r = parseNumber(mod.positionalArgs[0]);
          if (r) style.radius = r;
        } else {
          // .clipShape(RoundedRectangle(cornerRadius: 8))
          if (mod.positionalArgs.length > 0 && mod.positionalArgs[0].kind === 'call') {
            const r = parseNumber(mod.positionalArgs[0].namedArgs.cornerRadius);
            if (r) style.radius = r;
          }
        }
        break;
      }
      case 'border': {
        if (mod.positionalArgs.length >= 1) {
          const c = parseColor(mod.positionalArgs[0]);
          const w = parseNumber(mod.positionalArgs[1]) ?? 1;
          if (c) style.border = `${w}px solid ${c}`;
        }
        break;
      }
      case 'shadow': {
        if (mod.positionalArgs.length > 0 && mod.positionalArgs[0].kind === 'call') {
          const shadowCall = mod.positionalArgs[0];
          const radius = parseNumber(shadowCall.namedArgs.radius) ?? 4;
          style.shadow = `0 0 ${radius}px rgba(0,0,0,0.25)`;
        }
        break;
      }
      case 'opacity': {
        const o = parseNumber(mod.positionalArgs[0]);
        if (o !== undefined) style.opacity = o;
        break;
      }
    }
  }
}

/**
 * 把 SwiftViewNode 转为 UniversalNode
 */
function viewToNode(node: SwiftViewNode): UniversalNode | null {
  const style: UniversalStyle = {};

  // 先应用修饰符
  applyModifiers(node, style);

  const t = node.type;

  // ── VStack / HStack / ZStack → column / row / stack ──
  if (t === 'VStack' || t === 'HStack' || t === 'ZStack') {
    // alignment
    if (node.positionalArgs.length > 0) {
      const align = node.positionalArgs[0];
      if (align.kind === 'enumCase') {
        if (align.value === 'top' || align.value === 'leading') style.align = 'start';
        else if (align.value === 'center') style.align = 'center';
        else if (align.value === 'bottom' || align.value === 'trailing') style.align = 'end';
      }
    }

    const children = node.children
      .map(viewToNode)
      .filter((c): c is UniversalNode => c !== null);

    return {
      type: t === 'VStack' ? 'column' : t === 'HStack' ? 'row' : 'stack',
      style: Object.keys(style).length > 0 ? style : undefined,
      children: children.length > 0 ? children : undefined,
    };
  }

  // ── ScrollView / List / Group → column ──
  if (t === 'ScrollView' || t === 'List' || t === 'Group' || t === 'Section') {
    const children = node.children
      .map(viewToNode)
      .filter((c): c is UniversalNode => c !== null);
    return {
      type: 'column',
      style: Object.keys(style).length > 0 ? style : undefined,
      children: children.length > 0 ? children : undefined,
    };
  }

  // ── Text → text ──
  if (t === 'Text') {
    let content = '';
    if (node.positionalArgs.length > 0) {
      const arg = node.positionalArgs[0];
      if (arg.kind === 'literal' && typeof arg.value === 'string') {
        content = arg.value;
      } else if (arg.kind === 'ident') {
        content = `{${arg.name}}`;
      }
    }
    return {
      type: 'text',
      content,
      style: Object.keys(style).length > 0 ? style : undefined,
    };
  }

  // ── Button → button ──
  if (t === 'Button') {
    let label = 'Button';
    // Button("Click") { action }
    if (node.positionalArgs.length > 0) {
      const arg = node.positionalArgs[0];
      if (arg.kind === 'literal' && typeof arg.value === 'string') {
        label = arg.value;
      }
    }
    // Button(action: {}) { Text("Click") } — label 在闭包里
    if (!label || label === 'Button') {
      const firstChild = node.children[0];
      if (firstChild && firstChild.type === 'Text' && firstChild.positionalArgs.length > 0) {
        const arg = firstChild.positionalArgs[0];
        if (arg.kind === 'literal' && typeof arg.value === 'string') {
          label = arg.value;
        }
      }
    }
    return {
      type: 'button',
      label,
      variant: 'filled',
      style: Object.keys(style).length > 0 ? style : undefined,
    };
  }

  // ── TextField / SecureField → input ──
  if (t === 'TextField' || t === 'SecureField') {
    let placeholder: string | undefined;
    // TextField("hint", text: $value)
    if (node.positionalArgs.length > 0) {
      placeholder = parseString(node.positionalArgs[0]);
    }
    const kind: InputKind = t === 'SecureField' ? 'password' : 'text';
    return {
      type: 'input',
      placeholder,
      kind,
      style: Object.keys(style).length > 0 ? style : undefined,
    };
  }

  // ── Image → image ──
  if (t === 'Image') {
    // Image("icon") / Image(systemName: "star")
    let src: string | undefined;
    if (node.positionalArgs.length > 0) {
      src = parseString(node.positionalArgs[0]);
    }
    if (node.namedArgs.systemName) {
      src = 'system:' + (parseString(node.namedArgs.systemName) || '');
    }
    return {
      type: 'image',
      src,
      style: Object.keys(style).length > 0 ? style : undefined,
    };
  }

  // ── Divider → divider ──
  if (t === 'Divider') {
    return { type: 'divider', style: Object.keys(style).length > 0 ? style : undefined };
  }

  // ── Spacer → spacer ──
  if (t === 'Spacer') {
    return { type: 'spacer', style: Object.keys(style).length > 0 ? style : undefined };
  }

  // ── Color → container (带背景色) ──
  if (t === 'Color') {
    const c = node.positionalArgs.length > 0 ? parseColor(node.positionalArgs[0]) : undefined;
    if (c) style.background = c;
    return {
      type: 'container',
      style: Object.keys(style).length > 0 ? style : undefined,
    };
  }

  // ── 未知 View → container (递归 children) ──
  const children = node.children
    .map(viewToNode)
    .filter((c): c is UniversalNode => c !== null);
  return {
    type: 'container',
    style: Object.keys(style).length > 0 ? style : undefined,
    children: children.length > 0 ? children : undefined,
  };
}

// ──────────────────────────── 根节点查找 ────────────────────────────

/**
 * 在 Swift 代码中找第一个 View 表达式
 * 查找: var body: some View { ... } / return View
 */
function findRootView(tokens: Token[]): UniversalNode | null {
  const parser = new SwiftParser(tokens);

  // 策略 1: 找 `var body: some View {` 后面的第一个 view
  for (let i = 0; i < tokens.length - 3; i++) {
    if (tokens[i].value === 'var' && tokens[i + 1]?.value === 'body' &&
        tokens[i + 2]?.value === ':' && tokens[i + 3]?.value === 'some') {
      // 跳到 { 后面
      let j = i + 4;
      while (j < tokens.length && tokens[j].value !== '{') j++;
      j++; // 跳过 {
      const subParser = new SwiftParser(tokens.slice(j));
      const view = subParser.parseView();
      if (view) {
        const node = viewToNode(view);
        if (node) return node;
      }
    }
  }

  // 策略 2: 找 return 后面的 view
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].type === 'keyword' && tokens[i].value === 'return') {
      const subParser = new SwiftParser(tokens.slice(i + 1));
      const view = subParser.parseView();
      if (view) {
        const node = viewToNode(view);
        if (node) return node;
      }
    }
  }

  // 策略 3: 直接尝试从开头解析
  const view = parser.parseView();
  if (view) {
    const node = viewToNode(view);
    if (node) return node;
  }

  return null;
}

// ──────────────────────────── 翻译器实现 ────────────────────────────

export const swiftuiTranslator: Translator = {
  language: 'swiftui',
  displayName: 'SwiftUI',

  /**
   * 检测代码是否为 SwiftUI
   * 置信度:
   *   0.9 — import SwiftUI + View 类型
   *   0.8 — var body: some View
   *   0.6 — VStack / HStack / Text / Button 等
   */
  detect(code: string): number {
    if (!code || typeof code !== 'string') return 0;
    const trimmed = code.trim();
    if (trimmed.length < 10) return 0;

    const hasSwiftUIImport = /import\s+SwiftUI/.test(trimmed);
    const hasView = /\b(VStack|HStack|ZStack|Text\(|Button\(|TextField\(|Image\(|ScrollView|List\(|Divider|Spacer)\b/.test(trimmed);
    const hasBody = /var\s+body\s*:\s*some\s+View/.test(trimmed);

    if (hasSwiftUIImport && hasView) return 0.9;
    if (hasBody) return 0.8;
    if (hasView) return 0.6;

    return 0;
  },

  /**
   * 翻译 SwiftUI 代码为 Universal AST
   */
  translate(code: string): UniversalNode {
    if (!code || typeof code !== 'string') {
      throw new TranslateError('swiftui', 'code 为空');
    }

    let tokens: Token[];
    try {
      tokens = tokenize(code);
    } catch (err: any) {
      throw new TranslateError('swiftui', `词法分析失败: ${err.message}`, code);
    }

    const root = findRootView(tokens);
    if (!root) {
      throw new TranslateError('swiftui', '未找到 View 根节点', code);
    }

    return root;
  },
};
