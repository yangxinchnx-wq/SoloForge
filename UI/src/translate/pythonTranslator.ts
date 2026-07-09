/**
 * pythonTranslator.ts — Python UI 源码 → Universal AST 翻译器
 *
 * 直接翻译 Python 源代码, 不依赖运行时, 不消耗 LLM token。
 *
 * 覆盖的 UI 框架 (识别 Widget 构造调用):
 *   - Tkinter:    Label/Button/Entry/Frame/Canvas/Checkbutton/Radiobutton
 *   - PyQt/PySide: QLabel/QPushButton/QLineEdit/QFrame/QCheckBox/QComboBox
 *   - Kivy:       Label/Button/TextInput/BoxLayout/GridLayout/StackLayout
 *
 * 翻译策略:
 *   1. tokenizer 切词 (Python 词法, 含 f-string / 装饰器 / 缩进块标记)
 *   2. 找所有 Widget(parent, **kwargs) 构造调用
 *   3. 第一位置参数 = parent 变量名 → 重建父子关系
 *   4. text= / text / title 等参数 → 节点内容
 *   5. 容器类 (Frame/Box/VBoxLayout/...) 的 addWidget/pack 调用也算父子
 *
 * 支持的节点类型:
 *   - Frame/Box/GridLayout/StackLayout/QFrame/Tk() → container/row/column
 *   - Label/QLabel/Label(kivy)        → text
 *   - Button/QPushButton/Button(kivy) → button
 *   - Entry/QLineEdit/TextInput       → input
 *   - Checkbutton/QCheckBox           → input (kind=text, 标记 placeholder)
 *   - Canvas/QComboBox                → container (简化)
 *
 * 属性解析:
 *   - text= / text / title=           → content / label
 *   - bg= / background= / stylesheet  → background
 *   - fg= / foreground= / color=      → color
 *   - font=('Arial', 16) / font=QFont → fontSize / fontWeight
 *   - width= / height=                → width / height
 *   - padx= / pady=                   → padding
 */

import type { UniversalNode, UniversalStyle, ButtonVariant, InputKind } from '../services/canvas/UniversalAST';
import { TranslateError, type Translator } from './types';

// ──────────────────────────── Python Tokenizer ────────────────────────────

interface Token {
  type: 'ident' | 'number' | 'string' | 'punct' | 'keyword' | 'op';
  value: string;
  pos: number;
  line: number;
}

const PYTHON_KEYWORDS = new Set([
  'def', 'class', 'return', 'if', 'elif', 'else', 'for', 'while', 'in', 'not',
  'and', 'or', 'is', 'None', 'True', 'False', 'import', 'from', 'as', 'with',
  'try', 'except', 'finally', 'raise', 'pass', 'break', 'continue', 'lambda',
  'global', 'nonlocal', 'yield', 'async', 'await', 'self',
]);

function tokenize(code: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = code.length;
  let line = 1;

  while (i < n) {
    const ch = code[i];

    // 换行 (保留以感知语句分隔)
    if (ch === '\n') { line++; i++; continue; }
    if (ch === '\r') { i++; continue; }

    // 空白
    if (ch === ' ' || ch === '\t') { i++; continue; }

    // 行连接符 \ 后跟换行
    if (ch === '\\' && code[i + 1] === '\n') { i += 2; line++; continue; }

    // 注释 #...
    if (ch === '#') {
      while (i < n && code[i] !== '\n') i++;
      continue;
    }

    // 三引号字符串 """...""" / '''...'''
    if ((ch === '"' && code[i + 1] === '"' && code[i + 2] === '"') ||
        (ch === "'" && code[i + 1] === "'" && code[i + 2] === "'")) {
      const quote = ch + ch + ch;
      let val = '';
      i += 3;
      while (i < n && code.slice(i, i + 3) !== quote) {
        if (code[i] === '\n') line++;
        if (code[i] === '\\' && i + 1 < n) { val += code[i + 1]; i += 2; continue; }
        val += code[i];
        i++;
      }
      i += 3;
      tokens.push({ type: 'string', value: val, pos: i, line });
      continue;
    }

    // 普通字符串 / f-string / r-string / b-string
    if (ch === '"' || ch === "'") {
      let val = '';
      const quote = ch;
      i++;
      while (i < n && code[i] !== quote) {
        if (code[i] === '\n') { line++; break; } // 未闭合, 简化处理
        if (code[i] === '\\' && i + 1 < n) { val += code[i + 1]; i += 2; continue; }
        val += code[i];
        i++;
      }
      i++; // 跳过结束引号
      tokens.push({ type: 'string', value: val, pos: i, line });
      continue;
    }

    // 字符串前缀 (f/r/b/u)
    if (/[frbuFRBU]/.test(ch) && (code[i + 1] === '"' || code[i + 1] === "'")) {
      i++; // 跳过前缀, 后面字符串处理会接上
      continue;
    }

    // 数字 (含小数 / 科学计数)
    if (/[\d]/.test(ch)) {
      let num = '';
      while (i < n && /[\d.eE+\-xXa-fA-F_]/.test(code[i])) {
        // 简化: 只吃连续数字相关字符, 防止吃太多
        if (code[i] === '-' || code[i] === '+') {
          // 仅在 e/E 后才吃
          if (num[num.length - 1] === 'e' || num[num.length - 1] === 'E') {
            num += code[i]; i++; continue;
          }
          break;
        }
        num += code[i];
        i++;
      }
      tokens.push({ type: 'number', value: num, pos: i, line });
      continue;
    }

    // 标识符 / 关键字
    if (/[a-zA-Z_]/.test(ch)) {
      let id = '';
      while (i < n && /[\w]/.test(code[i])) { id += code[i]; i++; }
      // 成员访问 Foo.bar 合并 (简化, 不递归)
      while (code[i] === '.' && /[a-zA-Z_]/.test(code[i + 1] || '')) {
        id += '.';
        i++;
        while (i < n && /[\w]/.test(code[i])) { id += code[i]; i++; }
      }
      tokens.push({
        type: PYTHON_KEYWORDS.has(id) ? 'keyword' : 'ident',
        value: id,
        pos: i,
        line,
      });
      continue;
    }

    // 多字符运算符
    const three = code.slice(i, i + 3);
    const two = code.slice(i, i + 2);
    if (['**=', '//=', '>>=', '<<=', '...'].includes(three)) {
      tokens.push({ type: 'op', value: three, pos: i, line });
      i += 3;
      continue;
    }
    if (['==', '!=', '<=', '>=', '+=', '-=', '*=', '/=', '//', '**', '->', ':=', '<<', '>>', '&=', '|=', '^='].includes(two)) {
      tokens.push({ type: 'op', value: two, pos: i, line });
      i += 2;
      continue;
    }

    // 单字符
    tokens.push({ type: 'punct', value: ch, pos: i, line });
    i++;
  }

  return tokens;
}

// ──────────────────────────── Python 调用解析 ────────────────────────────

interface PyCall {
  /** 函数/构造器名, 如 'Label' / 'QPushButton' / 'Tk' */
  name: string;
  /** 位置参数 (Tk(parent, text) 的 parent / text) */
  positionalArgs: PyValue[];
  /** 关键字参数 { text: ..., bg: ... } */
  kwargs: Record<string, PyValue>;
  /** 调用所在行号 */
  line: number;
}

type PyValue =
  | { kind: 'literal'; value: string | number | boolean | null }
  | { kind: 'ident'; name: string }
  | { kind: 'call'; call: PyCall }
  | { kind: 'tuple'; items: PyValue[] }
  | { kind: 'list'; items: PyValue[] };

class PyParser {
  private tokens: Token[];
  private pos = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  peek(offset = 0): Token | null {
    return this.tokens[this.pos + offset] || null;
  }

  consume(): Token {
    return this.tokens[this.pos++];
  }

  expect(value: string): Token {
    const t = this.consume();
    if (t.value !== value) {
      throw new Error(`期望 "${value}", 实际 "${t.value}" (line ${t.line})`);
    }
    return t;
  }

  /** 解析一个值 */
  parseValue(): PyValue {
    const t = this.peek();
    if (!t) return { kind: 'literal', value: null };

    // 字面量
    if (t.type === 'string') { this.consume(); return { kind: 'literal', value: t.value }; }
    if (t.type === 'number') {
      this.consume();
      const num = t.value.includes('.') || t.value.includes('e') || t.value.includes('E')
        ? parseFloat(t.value)
        : parseInt(t.value, 10);
      return { kind: 'literal', value: num };
    }
    if (t.value === 'True' || t.value === 'False') {
      this.consume();
      return { kind: 'literal', value: t.value === 'True' };
    }
    if (t.value === 'None') {
      this.consume();
      return { kind: 'literal', value: null };
    }

    // 元组 / 列表
    if (t.value === '(') return this.parseTupleOrCall();
    if (t.value === '[') return this.parseList();

    // 标识符 / 函数调用
    if (t.type === 'ident') {
      const name = t.value;
      this.consume();
      if (this.peek()?.value === '(') {
        return { kind: 'call', call: this.parseCallArgs(name, t.line) };
      }
      return { kind: 'ident', name };
    }

    // 未知 → 跳过
    this.consume();
    return { kind: 'literal', value: null };
  }

  /** (a, b) 元组 或 (expr) 单值 */
  private parseTupleOrCall(): PyValue {
    this.expect('(');
    const items: PyValue[] = [];
    if (this.peek()?.value === ')') { this.consume(); return { kind: 'tuple', items }; }

    while (true) {
      items.push(this.parseValue());
      const sep = this.peek();
      if (sep?.value === ',') {
        this.consume();
        if (this.peek()?.value === ')') break; // 尾逗号
        continue;
      }
      if (sep?.value === ')') break;
      if (!sep) break;
    }
    this.expect(')');
    // 单元素元组退化为值 (简化)
    if (items.length === 1) return items[0];
    return { kind: 'tuple', items };
  }

  private parseList(): PyValue {
    this.expect('[');
    const items: PyValue[] = [];
    if (this.peek()?.value === ']') { this.consume(); return { kind: 'list', items }; }
    while (true) {
      items.push(this.parseValue());
      const sep = this.peek();
      if (sep?.value === ',') { this.consume(); if (this.peek()?.value === ']') break; continue; }
      if (sep?.value === ']') break;
      if (!sep) break;
    }
    this.expect(']');
    return { kind: 'list', items };
  }

  /** 解析 Name(arg1, arg2, kw=value, ...) */
  parseCallArgs(name: string, line: number): PyCall {
    this.expect('(');
    const call: PyCall = {
      name,
      positionalArgs: [],
      kwargs: {},
      line,
    };

    if (this.peek()?.value === ')') { this.consume(); return call; }

    while (true) {
      // 检查 kwargs: ident = value (注意 Python 用 = 不是 :)
      const t = this.peek();
      const next = this.peek(1);
      if (t?.type === 'ident' && next?.value === '=' &&
          !(this.peek(2)?.value === '=')) { // 排除 ==
        const argName = t.value;
        this.consume(); // ident
        this.consume(); // =
        const val = this.parseValue();
        call.kwargs[argName] = val;
      } else {
        call.positionalArgs.push(this.parseValue());
      }

      const sep = this.peek();
      if (sep?.value === ',') { this.consume(); if (this.peek()?.value === ')') break; continue; }
      if (sep?.value === ')') break;
      if (!sep) break;
    }
    this.expect(')');
    return call;
  }
}

// ──────────────────────────── 调用收集 ────────────────────────────

/**
 * 从 token 流中收集所有顶层调用 (Name(...))
 * 同时记录: 赋值 var = Call(...) / var.method(...) 调用 (用于 pack/grid/addWidget)
 */
interface CollectedCalls {
  /** 所有构造调用 Name(args), 按 line 排序 */
  constructors: PyCall[];
  /** 变量赋值: varName → PyCall (最近一次赋值) */
  assignments: Map<string, PyCall>;
  /** 方法调用: varName.method(args), 如 btn.pack() / layout.addWidget(label) */
  methodCalls: Array<{ varName: string; method: string; args: PyValue[]; line: number }>;
}

function collectCalls(tokens: Token[]): CollectedCalls {
  const result: CollectedCalls = {
    constructors: [],
    assignments: new Map(),
    methodCalls: [],
  };
  const parser = new PyParser(tokens);

  while (parser.peek()) {
    const t = parser.peek();
    if (!t) break;

    // 跳过非 ident
    if (t.type !== 'ident' && t.type !== 'keyword') {
      parser.consume();
      continue;
    }

    // 检测赋值: ident = Call(...)
    //   btn = Button(root, text="Click")
    if (t.type === 'ident' && parser.peek(1)?.value === '=' &&
        parser.peek(2)?.type === 'ident' && parser.peek(3)?.value === '(') {
      const varName = t.value;
      parser.consume(); // var
      parser.consume(); // =
      const callName = parser.consume().value;
      const call = parser.parseCallArgs(callName, t.line);
      result.constructors.push(call);
      result.assignments.set(varName, call);
      continue;
    }

    // 检测方法调用: ident.method(args)
    if (t.type === 'ident' && parser.peek(1)?.value === '.' && parser.peek(2)?.type === 'ident') {
      const varName = t.value;
      const method = parser.peek(2)!.value;
      // 合并 ident.method 后再判断是否有 (
      parser.consume(); // var
      parser.consume(); // .
      parser.consume(); // method
      if (parser.peek()?.value === '(') {
        const argsCall = parser.parseCallArgs(`${varName}.${method}`, t.line);
        result.methodCalls.push({
          varName,
          method,
          args: argsCall.positionalArgs,
          line: t.line,
        });
      }
      continue;
    }

    // 直接构造调用 (无赋值): Button(root, text="Click")
    if (t.type === 'ident' && parser.peek(1)?.value === '(') {
      const name = t.value;
      parser.consume();
      const call = parser.parseCallArgs(name, t.line);
      result.constructors.push(call);
      continue;
    }

    parser.consume();
  }

  return result;
}

// ──────────────────────────── Widget 识别 ────────────────────────────

/** 容器类 Widget → 节点类型 */
function containerKind(name: string): 'container' | 'row' | 'column' | null {
  // 归一化: tk.Label / QtWidgets.QLabel → Label / QLabel
  const n = name.split('.').pop() || name;
  // Tkinter
  if (n === 'Tk' || n === 'Frame' || n === 'Canvas' || n === 'Toplevel') return 'container';
  // PyQt
  if (n === 'QMainWindow' || n === 'QWidget' || n === 'QFrame' || n === 'QDialog') return 'container';
  if (n === 'QHBoxLayout') return 'row';
  if (n === 'QVBoxLayout' || n === 'QFormLayout') return 'column';
  if (n === 'QGridLayout') return 'container';
  // Kivy
  if (n === 'BoxLayout') return 'container';
  if (n === 'GridLayout') return 'container';
  if (n === 'StackLayout') return 'stack';
  if (n === 'AnchorLayout' || n === 'FloatLayout') return 'container';
  return null;
}

/** 文本类 Widget */
function isLabel(name: string): boolean {
  const n = name.split('.').pop() || name;
  return n === 'Label' || n === 'QLabel' || n === 'QTextBrowser' ||
         n === 'Message' || n === 'LabelledLabel';
}

/** 按钮类 Widget */
function isButton(name: string): boolean {
  const n = name.split('.').pop() || name;
  return n === 'Button' || n === 'QPushButton' || n === 'QToolButton' ||
         n === 'Button' /* kivy 同名 */ || n === 'ToggleButton';
}

/** 输入类 Widget */
function isInput(name: string): boolean {
  const n = name.split('.').pop() || name;
  return n === 'Entry' || n === 'QLineEdit' || n === 'QTextEdit' ||
         n === 'TextInput' || n === 'QPlainTextEdit';
}

/** 复选/单选 → input (text kind, 用 placeholder 标记) */
function isCheckable(name: string): boolean {
  const n = name.split('.').pop() || name;
  return n === 'Checkbutton' || n === 'Radiobutton' ||
         n === 'QCheckBox' || n === 'QRadioButton';
}

// ──────────────────────────── 属性解析 ────────────────────────────

function pyStr(v: PyValue | undefined): string | undefined {
  if (!v) return undefined;
  if (v.kind === 'literal' && typeof v.value === 'string') return v.value;
  return undefined;
}

function pyNum(v: PyValue | undefined): number | undefined {
  if (!v) return undefined;
  if (v.kind === 'literal' && typeof v.value === 'number') return v.value;
  return undefined;
}

function pyColor(v: PyValue | undefined): string | undefined {
  const s = pyStr(v);
  if (!s) return undefined;
  // '#FF0000' / 'red' / 'gray90' 直接返回
  if (s.startsWith('#') || /^[a-zA-Z]+$/.test(s)) return s;
  return s;
}

/** font=('Arial', 16) / font=('Arial', 16, 'bold') */
function pyFont(v: PyValue | undefined): { fontSize?: number; fontWeight?: number } {
  const r: { fontSize?: number; fontWeight?: number } = {};
  if (!v) return r;
  if (v.kind === 'tuple' || v.kind === 'list') {
    const items = v.items;
    // 第二个是 size
    if (items.length >= 2) {
      const size = pyNum(items[1]);
      if (size) r.fontSize = size;
    }
    // 第三个是 weight (字符串 'bold' / 'normal')
    if (items.length >= 3) {
      const w = pyStr(items[2]);
      if (w === 'bold') r.fontWeight = 700;
      else if (w === 'normal') r.fontWeight = 400;
    }
  }
  return r;
}

/** padding 元组 (padx, pady) → [px, py] */
function pyPadding(padx: PyValue | undefined, pady: PyValue | undefined): UniversalStyle['padding'] {
  const x = pyNum(padx);
  const y = pyNum(pady);
  if (x === undefined && y === undefined) return undefined;
  if (x !== undefined && y !== undefined) return [y, x]; // [top, right] 简化
  if (x !== undefined) return x;
  return y;
}

// ──────────────────────────── 调用 → UniversalNode ────────────────────────────

interface WidgetInstance {
  /** 变量名 (赋值时) 或匿名 id */
  varName: string;
  /** 构造调用 */
  call: PyCall;
  /** 父变量名 (第一个位置参数如果是 ident) */
  parentVar: string | null;
  /** 转换出的 UniversalNode (不含 children, 后面再挂) */
  node: UniversalNode;
  /** 子节点变量名列表 (通过 pack/addWidget 收集) */
  childVars: string[];
}

function callToNode(call: PyCall): { node: UniversalNode; isContainer: boolean } {
  const name = call.name;
  const style: UniversalStyle = {};

  // 颜色 / 字体 / 尺寸
  const bg = pyColor(call.kwargs.bg) || pyColor(call.kwargs.background);
  if (bg) style.background = bg;
  const fg = pyColor(call.kwargs.fg) || pyColor(call.kwargs.foreground) || pyColor(call.kwargs.color);
  if (fg) style.color = fg;
  const font = pyFont(call.kwargs.font);
  if (font.fontSize) style.fontSize = font.fontSize;
  if (font.fontWeight) style.fontWeight = font.fontWeight as any;
  const w = pyNum(call.kwargs.width);
  const h = pyNum(call.kwargs.height);
  if (w) style.width = w;
  if (h) style.height = h;
  const pad = pyPadding(call.kwargs.padx, call.kwargs.pady);
  if (pad !== undefined) style.padding = pad;

  // 容器
  const ck = containerKind(name);
  if (ck) {
    return {
      node: {
        type: ck,
        style: Object.keys(style).length > 0 ? style : undefined,
        children: [],
      },
      isContainer: true,
    };
  }

  // 文本
  if (isLabel(name)) {
    let content = '';
    // Tkinter: text="..." / PyQt: QLabel("...")
    content = pyStr(call.kwargs.text) || pyStr(call.kwargs.title) ||
              (call.positionalArgs.length > 0 ? pyStr(call.positionalArgs[0]) || '' : '');
    return {
      node: {
        type: 'text',
        content,
        style: Object.keys(style).length > 0 ? style : undefined,
      },
      isContainer: false,
    };
  }

  // 按钮
  if (isButton(name)) {
    let label = '';
    label = pyStr(call.kwargs.text) ||
            (call.positionalArgs.length > 0 ? pyStr(call.positionalArgs[0]) || '' : '');
    let variant: ButtonVariant = 'filled';
    if (name === 'QToolButton') variant = 'text';
    return {
      node: {
        type: 'button',
        label,
        variant,
        style: Object.keys(style).length > 0 ? style : undefined,
      },
      isContainer: false,
    };
  }

  // 输入框
  if (isInput(name)) {
    const placeholder = pyStr(call.kwargs.text) || pyStr(call.kwargs.placeholder);
    const kind: InputKind = name === 'QTextEdit' || name === 'QPlainTextEdit' ? 'text' : 'text';
    return {
      node: {
        type: 'input',
        placeholder,
        kind,
        style: Object.keys(style).length > 0 ? style : undefined,
      },
      isContainer: false,
    };
  }

  // 复选/单选 → input (标记)
  if (isCheckable(name)) {
    const label = pyStr(call.kwargs.text) || '';
    return {
      node: {
        type: 'input',
        placeholder: label,
        kind: 'text',
        style: Object.keys(style).length > 0 ? style : undefined,
      },
      isContainer: false,
    };
  }

  // 未知 → container (兜底)
  return {
    node: {
      type: 'container',
      style: Object.keys(style).length > 0 ? style : undefined,
      children: [],
    },
    isContainer: true,
  };
}

// ──────────────────────────── 根节点构建 ────────────────────────────

function buildTree(calls: CollectedCalls): UniversalNode | null {
  if (calls.constructors.length === 0) return null;

  // 1. 为每个构造调用创建 WidgetInstance
  //    变量名: 通过 assignments 反查 (varName → call)
  const callToVar = new Map<PyCall, string>();
  for (const [varName, call] of calls.assignments) {
    callToVar.set(call, varName);
  }

  const instances: WidgetInstance[] = [];
  let anonCounter = 0;
  for (const call of calls.constructors) {
    const varName = callToVar.get(call) || `__anon_${anonCounter++}`;
    const { node, isContainer } = callToNode(call);
    // parent: 第一个位置参数是 ident → 提取变量名
    let parentVar: string | null = null;
    if (call.positionalArgs.length > 0) {
      const firstArg = call.positionalArgs[0];
      if (firstArg.kind === 'ident') {
        parentVar = firstArg.name;
      }
    }
    instances.push({
      varName,
      call,
      parentVar,
      node,
      childVars: [],
    });
  }

  // 2. 处理方法调用: btn.pack() / layout.addWidget(label)
  //    pack() 无参 → 找到 btn 的 parent (通过构造时的第一参数)
  //    addWidget(label) → 把 label 加到 layout 的 childVars
  const varToInstance = new Map<string, WidgetInstance>();
  for (const inst of instances) {
    if (!inst.varName.startsWith('__anon_')) {
      varToInstance.set(inst.varName, inst);
    }
  }

  for (const mc of calls.methodCalls) {
    const target = varToInstance.get(mc.varName);
    if (!target) continue;

    if (mc.method === 'pack' || mc.method === 'grid' || mc.method === 'place') {
      // Tkinter: btn.pack() — btn 已经在构造时通过 firstArg 指定了 parent
      // 这里不需要额外处理 (parent 关系已建立)
      continue;
    }

    if (mc.method === 'addWidget' || mc.method === 'add' || mc.method === 'add_widget') {
      // PyQt: layout.addWidget(widget) / kivy: box.add(widget)
      if (mc.args.length > 0) {
        const arg = mc.args[0];
        if (arg.kind === 'ident') {
          target.childVars.push(arg.name);
        }
      }
    }
  }

  // 3. 建立父子关系
  //    方式 A: 构造时第一参数 = parent 变量 (Tkinter / 部分 PyQt)
  //    方式 B: addWidget 调用 (PyQt / Kivy)
  const varToChildren = new Map<string, WidgetInstance[]>();

  for (const inst of instances) {
    // 方式 A: parent 来自构造参数
    if (inst.parentVar && varToInstance.has(inst.parentVar)) {
      const parent = varToInstance.get(inst.parentVar)!;
      // 只挂到容器
      if (parent.node.type === 'container' || parent.node.type === 'row' ||
          parent.node.type === 'column' || parent.node.type === 'stack') {
        const list = varToChildren.get(parent.varName) || [];
        list.push(inst);
        varToChildren.set(parent.varName, list);
      }
    }
  }

  // 方式 B: addWidget 收集的 childVars
  for (const inst of instances) {
    for (const childVar of inst.childVars) {
      const child = varToInstance.get(childVar);
      if (child) {
        const list = varToChildren.get(inst.varName) || [];
        list.push(child);
        varToChildren.set(inst.varName, list);
      }
    }
  }

  // 4. 挂载 children
  for (const inst of instances) {
    const kids = varToChildren.get(inst.varName);
    if (kids && kids.length > 0) {
      const node = inst.node as any;
      if (node.children !== undefined) {
        node.children = kids.map(k => k.node);
      }
    }
  }

  // 5. 找根: 没有 parent 或 parent 不在 instances 中的容器
  //    优先选第一个容器类 (Tk / QMainWindow / QWidget)
  let root: WidgetInstance | null = null;
  for (const inst of instances) {
    const hasParent = inst.parentVar && varToInstance.has(inst.parentVar);
    const addedByParent = instances.some(other => other.childVars.includes(inst.varName));
    if (!hasParent && !addedByParent) {
      // 优先容器
      if (inst.node.type === 'container' || inst.node.type === 'row' ||
          inst.node.type === 'column' || inst.node.type === 'stack') {
        root = inst;
        break;
      }
      if (!root) root = inst;
    }
  }

  // 兜底: 第一个
  if (!root) root = instances[0];

  return root.node;
}

// ──────────────────────────── 翻译器实现 ────────────────────────────

export const pythonTranslator: Translator = {
  language: 'python',
  displayName: 'Python (Tkinter / PyQt / Kivy)',

  /**
   * 检测代码是否为 Python UI 代码
   * 置信度:
   *   0.9 — Tkinter/PyQt/Kivy import + Widget 构造
   *   0.7 — Widget 构造调用 (无 import)
   *   0.4 — Python 语法特征 (def/import/None) 但无 Widget
   */
  detect(code: string): number {
    if (!code || typeof code !== 'string') return 0;
    const trimmed = code.trim();
    if (trimmed.length < 10) return 0;

    const hasTkinter = /\bimport\s+(tkinter|tkinter\.\w+|from\s+tkinter)\b/.test(trimmed) ||
                       /\bfrom\s+tkinter\b/.test(trimmed);
    const hasPyQt = /\bfrom\s+PyQt\d?\b/.test(trimmed) || /\bimport\s+PyQt\d?\b/.test(trimmed) ||
                    /\bfrom\s+PySide\d?\b/.test(trimmed);
    const hasKivy = /\bfrom\s+kivy\b/.test(trimmed) || /\bimport\s+kivy\b/.test(trimmed);

    const widgetPattern = /\b(Tk|Frame|Label|Button|Entry|Canvas|Checkbutton|Radiobutton|Toplevel|QLabel|QPushButton|QLineEdit|QFrame|QCheckBox|QRadioButton|QComboBox|QMainWindow|QWidget|QHBoxLayout|QVBoxLayout|QGridLayout|QFormLayout|BoxLayout|GridLayout|StackLayout|TextInput)\s*\(/;
    const hasWidget = widgetPattern.test(trimmed);

    if ((hasTkinter || hasPyQt || hasKivy) && hasWidget) return 0.9;
    if (hasWidget) return 0.7;

    // Python 语法特征 (但无 Widget → 低置信度, 可能误判)
    const hasPythonSyntax = /\b(def\s+\w+|import\s+\w+|from\s+\w+\s+import|None|True|False|self\b)/.test(trimmed);
    if (hasPythonSyntax) return 0.3;

    return 0;
  },

  translate(code: string): UniversalNode {
    if (!code || typeof code !== 'string') {
      throw new TranslateError('python', 'code 为空');
    }

    let tokens: Token[];
    try {
      tokens = tokenize(code);
    } catch (err: any) {
      throw new TranslateError('python', `词法分析失败: ${err.message}`, code);
    }

    let calls: CollectedCalls;
    try {
      calls = collectCalls(tokens);
    } catch (err: any) {
      throw new TranslateError('python', `语法分析失败: ${err.message}`, code);
    }

    const root = buildTree(calls);
    if (!root) {
      throw new TranslateError('python', '未找到 UI Widget 构造调用', code);
    }

    return root;
  },
};
