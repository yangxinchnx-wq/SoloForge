/**
 * composeTranslator.ts — Jetpack Compose → Universal AST 翻译器
 *
 * 将 Jetpack Compose (Kotlin) 代码解析成 UniversalNode 树。
 * 纯本地解析 (正则 + 括号匹配), 不消耗 LLM token。
 *
 * Compose 语法特点 (与 SwiftUI 类似, 但用 Kotlin):
 *   - 隐式 children (尾随 lambda): Column { Text("a"); Text("b") }
 *   - 命名参数: Text(text = "hi", fontSize = 16.sp)
 *   - 修饰符: Text("hi", modifier = Modifier.padding(8.dp))
 *
 * 支持的 Composable:
 *   - Column / Row / Box           → column / row / stack
 *   - Text                         → text
 *   - Button / TextButton / OutlinedButton → button
 *   - TextField / OutlinedTextField → input
 *   - Image / Icon                 → image
 *   - Divider                      → divider
 *   - Spacer                       → spacer
 *   - Card                         → container (带圆角)
 *   - Surface                      → container
 *
 * Modifier 解析:
 *   - Modifier.padding(16.dp) / .padding(8.dp, 4.dp) → padding
 *   - Modifier.background(Color.Red)                 → background
 *   - Modifier.size(100.dp, 50.dp)                   → width/height
 *   - Modifier.fillMaxWidth() / .fillMaxSize()        → width="100%"
 *   - Modifier.clip(RoundedCornerShape(8.dp))        → radius
 *   - Modifier.border(2.dp, Color.Red)               → border
 *   - Modifier.shadow(4.dp)                          → shadow
 */

import type { UniversalNode, UniversalStyle, ButtonVariant, InputKind } from '../services/canvas/UniversalAST';
import { TranslateError, type Translator } from './types';

// ──────────────────────────── Kotlin Tokenizer (复用 Swift 风格) ────────────────────────────

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

    if (/[\d.]/.test(ch)) {
      let num = '';
      while (i < n && /[\d.]/.test(code[i])) { num += code[i]; i++; }
      // 跟随的 .dp / .sp 单位
      if (code[i] === '.' && /[a-z]/.test(code[i + 1] || '')) {
        let unit = '.';
        i++;
        while (i < n && /[a-z]/.test(code[i])) { unit += code[i]; i++; }
        // .dp / .sp 作为单位后缀, 保留在 value 里
        num += unit;
      }
      tokens.push({ type: 'number', value: num, pos: i });
      continue;
    }

    if (/[a-zA-Z_$]/.test(ch)) {
      let id = '';
      while (i < n && /[\w$]/.test(code[i])) { id += code[i]; i++; }
      const keywords = ['fun', 'val', 'var', 'return', 'if', 'else', 'for', 'in', 'when', 'is', 'as', 'true', 'false', 'null', 'object', 'class', 'override', 'private', 'public', 'internal', 'companion'];
      tokens.push({
        type: keywords.includes(id) ? 'keyword' : 'ident',
        value: id,
        pos: i,
      });
      continue;
    }

    tokens.push({ type: 'punct', value: ch, pos: i });
    i++;
  }

  return tokens;
}

// ──────────────────────────── Kotlin AST ────────────────────────────

interface ComposableNode {
  type: string;
  positionalArgs: KotlinValue[];
  namedArgs: Record<string, KotlinValue>;
  children: ComposableNode[];
  modifier?: ModifierChain;
}

interface ModifierChain {
  calls: ModifierCall[];
}

interface ModifierCall {
  name: string; // 'padding' / 'background' / 'size' ...
  positionalArgs: KotlinValue[];
  namedArgs: Record<string, KotlinValue>;
}

type KotlinValue =
  | { kind: 'literal'; value: string | number | boolean | null }
  | { kind: 'ident'; name: string }
  | { kind: 'call'; name: string; positionalArgs: KotlinValue[]; namedArgs: Record<string, KotlinValue> };

// ──────────────────────────── Kotlin Parser ────────────────────────────

class KotlinParser {
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
    if (t.value !== value) throw new Error(`期望 "${value}", 实际 "${t.value}"`);
    return t;
  }

  parseValue(): KotlinValue {
    const t = this.peek();
    if (!t) return { kind: 'literal', value: null };

    if (t.type === 'string') { this.consume(); return { kind: 'literal', value: t.value }; }
    if (t.type === 'number') {
      this.consume();
      // 解析 "16.dp" → 16
      const match = t.value.match(/^(-?\d*\.?\d+)/);
      const num = match ? parseFloat(match[1]) : 0;
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

    if (t.type === 'ident') {
      const name = t.value;
      this.consume();

      // Color.Red (成员访问, 简化为 ident "Color.Red")
      if (this.peek()?.value === '.' && /[A-Z]/.test(this.peek(1)?.value || '')) {
        this.consume(); // .
        const prop = this.consume().value;
        return { kind: 'ident', name: `${name}.${prop}` };
      }

      if (this.peek()?.value === '(') {
        return this.parseCall(name);
      }
      return { kind: 'ident', name };
    }

    this.consume();
    return { kind: 'literal', value: null };
  }

  parseCall(name: string): KotlinValue {
    this.expect('(');
    const positionalArgs: KotlinValue[] = [];
    const namedArgs: Record<string, KotlinValue> = {};

    if (this.peek()?.value === ')') {
      this.consume();
      return { kind: 'call', name, positionalArgs, namedArgs };
    }

    while (true) {
      const t = this.peek();
      const next = this.peek(1);
      // 命名参数 name = value
      if (t?.type === 'ident' && next?.value === '=') {
        const argName = t.value;
        this.consume(); // ident
        this.consume(); // =
        namedArgs[argName] = this.parseValue();
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
   * 解析 Modifier.xxx().yyy() 链
   */
  parseModifierChain(): ModifierChain | undefined {
    const t = this.peek();
    if (!t || t.type !== 'ident' || t.value !== 'Modifier') return undefined;
    this.consume();

    const calls: ModifierCall[] = [];
    while (this.peek()?.value === '.') {
      this.consume(); // .
      const modName = this.consume().value;
      const mod: ModifierCall = { name: modName, positionalArgs: [], namedArgs: {} };

      if (this.peek()?.value === '(') {
        const modCall = this.parseCall(modName);
        mod.positionalArgs = modCall.positionalArgs;
        mod.namedArgs = modCall.namedArgs;
      }
      calls.push(mod);
    }

    return { calls };
  }

  parseComposable(): ComposableNode | null {
    const t = this.peek();
    if (!t || t.type !== 'ident') return null;

    const typeName = t.value;
    this.consume();

    const node: ComposableNode = {
      type: typeName,
      positionalArgs: [],
      namedArgs: {},
      children: [],
    };

    // 参数 (...)
    if (this.peek()?.value === '(') {
      const callVal = this.parseCall(typeName);
      node.positionalArgs = callVal.positionalArgs;
      node.namedArgs = callVal.namedArgs;

      // 提取 modifier 参数
      if (node.namedArgs.modifier?.kind === 'call' && node.namedArgs.modifier.name === 'Modifier') {
        // 简化: Modifier.padding(8.dp).background(Color.Red)
        // 这里 parseValue 已经把 Modifier 当 ident 消费了, 需要重新解析
        // 实际上上面 parseValue 会把 Modifier.padding 当成 ident 处理
        // 为简化, 这里跳过 modifier 解析 (后面用 trailing lambda 的 modifier 提取)
      }
    }

    // 尾随 lambda { ... }
    if (this.peek()?.value === '{') {
      this.consume(); // {
      node.children = this.parseComposableList();
      if (this.peek()?.value === '}') this.consume();
    }

    return node;
  }

  parseComposableList(): ComposableNode[] {
    const nodes: ComposableNode[] = [];
    while (this.peek() && this.peek()!.value !== '}') {
      if (this.peek()!.value === ';') { this.consume(); continue; }
      const v = this.parseComposable();
      if (v) nodes.push(v);
      else this.consume(); // 跳过无法解析的 token
    }
    return nodes;
  }
}

// ──────────────────────────── 值解析工具 ────────────────────────────

function parseNumber(val: KotlinValue | undefined): number | undefined {
  if (!val) return undefined;
  if (val.kind === 'literal' && typeof val.value === 'number') return val.value;
  return undefined;
}

function parseString(val: KotlinValue | undefined): string | undefined {
  if (!val) return undefined;
  if (val.kind === 'literal' && typeof val.value === 'string') return val.value;
  return undefined;
}

/**
 * 解析颜色
 *   Color.Red → "Red" (小写化为 "red")
 *   Color(0xFF42A5F5) → "#42A5F5"
 */
function parseColor(val: KotlinValue | undefined): string | undefined {
  if (!val) return undefined;
  if (val.kind === 'ident' && val.name.startsWith('Color.')) {
    return val.name.slice('Color.'.length).toLowerCase();
  }
  if (val.kind === 'call' && val.name === 'Color' && val.positionalArgs.length > 0) {
    const arg = val.positionalArgs[0];
    if (arg.kind === 'literal' && typeof arg.value === 'number') {
      const hex = Math.floor(arg.value).toString(16).padStart(8, '0');
      return '#' + hex.slice(2).toUpperCase();
    }
  }
  return undefined;
}

/**
 * 解析 Dp 值 (Compose 的尺寸单位)
 *   16.dp → 16 (已在 parseValue 中处理)
 */
function parseDp(val: KotlinValue | undefined): number | undefined {
  return parseNumber(val);
}

// ──────────────────────────── Modifier 解析 ────────────────────────────

/**
 * 从 namedArgs.modifier 提取样式
 * Compose 的 modifier 是一个字符串如 "Modifier.padding(8.dp).background(Color.Red)"
 * 我们在 parseValue 中把它当 ident 处理了, 这里需要从原始 token 重新解析
 *
 * 简化方案: 直接从代码文本用正则提取 modifier
 */
function parseModifierFromText(code: string, style: UniversalStyle): void {
  // Modifier.padding(16.dp) / .padding(8.dp, 4.dp) / .padding(start = 8.dp, ...)
  const paddingMatch = code.match(/\.padding\s*\(\s*(\d+)?\.?\d*\.dp?\s*(?:,\s*(\d+)?\.?\d*\.dp?\s*)?/);
  // 简化: 正则匹配 Modifier 链
  const modMatch = code.match(/Modifier((?:\.\w+\([^)]*\))+)/);
  if (!modMatch) return;

  const chain = modMatch[1];
  // .padding(16.dp).background(Color.Red).size(100.dp, 50.dp)
  const callRe = /\.(\w+)\s*\(([^)]*)\)/g;
  let m: RegExpExecArray | null;
  while ((m = callRe.exec(chain)) !== null) {
    const name = m[1];
    const args = m[2].trim();

    switch (name) {
      case 'padding': {
        const nums = args.match(/(\d+\.?\d*)\.dp/g)?.map(s => parseFloat(s)) || [];
        if (nums.length === 1) style.padding = nums[0];
        else if (nums.length === 2) style.padding = [nums[0], nums[1]];
        else if (nums.length === 4) style.padding = [nums[0], nums[1], nums[2], nums[3]];
        else if (nums.length === 0) style.padding = 16; // .padding() 默认
        break;
      }
      case 'background': {
        const colorMatch = args.match(/Color\.(\w+)/);
        if (colorMatch) style.background = colorMatch[1].toLowerCase();
        break;
      }
      case 'size': {
        const nums = args.match(/(\d+\.?\d*)\.dp/g)?.map(s => parseFloat(s)) || [];
        if (nums.length === 1) { style.width = nums[0]; style.height = nums[0]; }
        else if (nums.length === 2) { style.width = nums[0]; style.height = nums[1]; }
        break;
      }
      case 'fillMaxWidth': style.width = '100%'; break;
      case 'fillMaxHeight': style.height = '100%'; break;
      case 'fillMaxSize': style.width = '100%'; style.height = '100%'; break;
      case 'clip': {
        const rMatch = args.match(/RoundedCornerShape\s*\(\s*(\d+\.?\d*)\.dp/);
        if (rMatch) style.radius = parseFloat(rMatch[1]);
        break;
      }
      case 'border': {
        const nums = args.match(/(\d+\.?\d*)\.dp/g)?.map(s => parseFloat(s)) || [];
        const colorMatch = args.match(/Color\.(\w+)/);
        const w = nums[0] ?? 1;
        const c = colorMatch ? colorMatch[1].toLowerCase() : '#000';
        style.border = `${w}px solid ${c}`;
        break;
      }
      case 'shadow': {
        const nums = args.match(/(\d+\.?\d*)\.dp/g)?.map(s => parseFloat(s)) || [];
        if (nums[0]) style.shadow = `0 0 ${nums[0]}px rgba(0,0,0,0.25)`;
        break;
      }
    }
  }
}

// ──────────────────────────── 节点转换 ────────────────────────────

function nodeToUniversal(node: ComposableNode, rawCode?: string): UniversalNode | null {
  const style: UniversalStyle = {};

  // 从原始代码提取 modifier (简化方案)
  if (rawCode) {
    parseModifierFromText(rawCode, style);
  }

  const t = node.type;

  // ── Column / Row / Box → column / row / stack ──
  if (t === 'Column' || t === 'Row' || t === 'Box') {
    // verticalArrangement / horizontalArrangement
    const arrange = node.namedArgs.verticalArrangement || node.namedArgs.horizontalArrangement;
    if (arrange?.kind === 'ident') {
      if (arrange.name.includes('Top') || arrange.name.includes('Start')) style.align = 'start';
      else if (arrange.name.includes('Center')) style.align = 'center';
      else if (arrange.name.includes('Bottom') || arrange.name.includes('End')) style.align = 'end';
    }

    const children = node.children
      .map(c => nodeToUniversal(c))
      .filter((c): c is UniversalNode => c !== null);

    return {
      type: t === 'Column' ? 'column' : t === 'Row' ? 'row' : 'stack',
      style: Object.keys(style).length > 0 ? style : undefined,
      children: children.length > 0 ? children : undefined,
    };
  }

  // ── Text → text ──
  if (t === 'Text') {
    let content = '';
    // Text("hello") 或 Text(text = "hello")
    if (node.positionalArgs.length > 0) {
      const s = parseString(node.positionalArgs[0]);
      if (s) content = s;
    }
    if (node.namedArgs.text) {
      const s = parseString(node.namedArgs.text);
      if (s) content = s;
    }
    // fontSize / color / fontWeight
    const fs = parseDp(node.namedArgs.fontSize);
    if (fs) style.fontSize = fs;
    const c = parseColor(node.namedArgs.color);
    if (c) style.color = c;
    if (node.namedArgs.fontWeight?.kind === 'ident') {
      const map: Record<string, number> = {
        Bold: 700, SemiBold: 600, Medium: 500, Normal: 400, Light: 300,
      };
      const fw = map[node.namedArgs.fontWeight.name];
      if (fw) style.fontWeight = fw as any;
    }
    return {
      type: 'text',
      content,
      style: Object.keys(style).length > 0 ? style : undefined,
    };
  }

  // ── Button / TextButton / OutlinedButton → button ──
  if (t === 'Button' || t === 'TextButton' || t === 'OutlinedButton' || t === 'FloatingActionButton') {
    let label = 'Button';
    // Button(onClick = {}) { Text("Click") }
    const firstChild = node.children[0];
    if (firstChild && firstChild.type === 'Text') {
      if (firstChild.positionalArgs.length > 0) {
        const s = parseString(firstChild.positionalArgs[0]);
        if (s) label = s;
      }
      if (firstChild.namedArgs.text) {
        const s = parseString(firstChild.namedArgs.text);
        if (s) label = s;
      }
    }
    let variant: ButtonVariant = 'filled';
    if (t === 'TextButton') variant = 'text';
    else if (t === 'OutlinedButton') variant = 'outlined';
    return {
      type: 'button',
      label,
      variant,
      style: Object.keys(style).length > 0 ? style : undefined,
    };
  }

  // ── TextField / OutlinedTextField → input ──
  if (t === 'TextField' || t === 'OutlinedTextField' || t === 'BasicTextField') {
    const placeholder = parseString(node.namedArgs.label) ||
      (node.namedArgs.placeholder ? parseString(node.namedArgs.placeholder) : undefined);
    let kind: InputKind = 'text';
    // 简化: 无法从静态代码判断 keyboardType, 默认 text
    if (node.namedArgs.visualTransformation?.kind === 'ident' &&
        node.namedArgs.visualTransformation.name.includes('Password')) {
      kind = 'password';
    }
    return {
      type: 'input',
      placeholder,
      kind,
      style: Object.keys(style).length > 0 ? style : undefined,
    };
  }

  // ── Image / Icon → image ──
  if (t === 'Image' || t === 'Icon') {
    let src: string | undefined;
    // Image(painter = resource("img.png")) 简化
    if (node.namedArgs.painter?.kind === 'call') {
      src = 'resource:' + (node.namedArgs.painter.positionalArgs[0] as any)?.value || '';
    }
    return {
      type: 'image',
      src,
      style: Object.keys(style).length > 0 ? style : undefined,
    };
  }

  // ── Divider → divider ──
  if (t === 'Divider' || t === 'HorizontalDivider') {
    return { type: 'divider', style: Object.keys(style).length > 0 ? style : undefined };
  }

  // ── Spacer → spacer ──
  if (t === 'Spacer') {
    return { type: 'spacer', style: Object.keys(style).length > 0 ? style : undefined };
  }

  // ── Card / Surface → container ──
  if (t === 'Card' || t === 'Surface') {
    if (!style.radius) style.radius = 8;
    if (!style.shadow) style.shadow = '0 2px 8px rgba(0,0,0,0.15)';
    const children = node.children
      .map(c => nodeToUniversal(c))
      .filter((c): c is UniversalNode => c !== null);
    return {
      type: 'container',
      style: Object.keys(style).length > 0 ? style : undefined,
      children: children.length > 0 ? children : undefined,
    };
  }

  // ── Scaffold → 提取 content ──
  if (t === 'Scaffold') {
    // Scaffold { content } — 尾随 lambda 是 content
    const children = node.children
      .map(c => nodeToUniversal(c))
      .filter((c): c is UniversalNode => c !== null);
    if (children.length === 1) return children[0];
    return {
      type: 'column',
      children: children.length > 0 ? children : undefined,
    };
  }

  // ── 未知 Composable → container (递归 children) ──
  const children = node.children
    .map(c => nodeToUniversal(c))
    .filter((c): c is UniversalNode => c !== null);
  return {
    type: 'container',
    style: Object.keys(style).length > 0 ? style : undefined,
    children: children.length > 0 ? children : undefined,
  };
}

// ──────────────────────────── 根节点查找 ────────────────────────────

function findRootComposable(tokens: Token[], rawCode: string): UniversalNode | null {
  const parser = new KotlinParser(tokens);

  // 策略 1: 找 @Composable fun Xxx() { ... } 内部的第一个 Composable
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].value === '@Composable' || (tokens[i].value === 'fun' && i > 0 && tokens[i - 1].value === '@Composable')) {
      // 跳到函数体 { 后面
      let j = i;
      while (j < tokens.length && tokens[j].value !== '{') j++;
      j++;
      const subParser = new KotlinParser(tokens.slice(j));
      const view = subParser.parseComposable();
      if (view) {
        const node = nodeToUniversal(view, rawCode);
        if (node) return node;
      }
    }
  }

  // 策略 2: 找第一个大写开头的 Composable
  const view = parser.parseComposable();
  if (view) {
    const node = nodeToUniversal(view, rawCode);
    if (node) return node;
  }

  return null;
}

// ──────────────────────────── 翻译器实现 ────────────────────────────

export const composeTranslator: Translator = {
  language: 'compose',
  displayName: 'Jetpack Compose',

  /**
   * 检测代码是否为 Jetpack Compose
   * 置信度:
   *   0.9 — @Composable + Column/Row/Text 等
   *   0.7 — Column/Row/Text + Modifier
   *   0.5 — androidx.compose 引用
   */
  detect(code: string): number {
    if (!code || typeof code !== 'string') return 0;
    const trimmed = code.trim();
    if (trimmed.length < 10) return 0;

    const hasComposable = /@Composable/.test(trimmed);
    const hasComposeView = /\b(Column|Row|Box|Text\(|Button\(|TextField\(|Image\(|Spacer|Divider|Card|Scaffold)\b/.test(trimmed);
    const hasModifier = /\bModifier\b/.test(trimmed);
    const hasComposeImport = /androidx\.compose/.test(trimmed);

    if (hasComposable && hasComposeView) return 0.9;
    if (hasComposeView && hasModifier) return 0.7;
    if (hasComposeImport) return 0.5;
    if (hasComposeView) return 0.6;

    return 0;
  },

  translate(code: string): UniversalNode {
    if (!code || typeof code !== 'string') {
      throw new TranslateError('compose', 'code 为空');
    }

    let tokens: Token[];
    try {
      tokens = tokenize(code);
    } catch (err: any) {
      throw new TranslateError('compose', `词法分析失败: ${err.message}`, code);
    }

    const root = findRootComposable(tokens, code);
    if (!root) {
      throw new TranslateError('compose', '未找到 Composable 根节点', code);
    }

    return root;
  },
};
