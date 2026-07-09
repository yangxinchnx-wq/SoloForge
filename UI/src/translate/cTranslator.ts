/**
 * cTranslator.ts — C 语言 UI 源码 → Universal AST 翻译器
 *
 * 直接翻译 C 源代码, 不依赖运行时, 不消耗 LLM token。
 *
 * 覆盖的 UI 框架 (识别函数调用模式):
 *   - Win32 API:    CreateWindowEx / CreateWindow / SendMessage / SetWindowText
 *   - GTK (C 接口): gtk_button_new / gtk_label_new / gtk_box_pack_start
 *   - LVGL:         lv_obj_create / lv_label_create / lv_btn_create
 *
 * 翻译策略:
 *   1. tokenizer 切词 (C 词法, 含 #include / #define / 字符串)
 *   2. 扫描所有函数调用 Name(args)
 *   3. CreateWindow* / gtk_*_new / lv_*_create → 构造调用, 提取类名 + label
 *   4. SendMessage(WM_SETTEXT) / SetWindowText → 文本更新
 *   5. gtk_box_pack_start / lv_obj_set_parent → 父子关系
 *   6. HWND/GtkWidget* 变量传递 → 重建父子树
 *
 * Win32 参数位置 (CreateWindowEx):
 *   CreateWindowEx(dwExStyle, lpClassName, lpWindowName, dwStyle,
 *                  x, y, w, h, hWndParent, hMenu, hInstance, lpParam)
 *   → 第 2 参数是类型 (button/edit/static/...),
 *     第 3 参数是文字,
 *     第 8 参数是父窗口 HWND 变量
 *
 * GTK 参数:
 *   GtkWidget *btn = gtk_button_new_with_label("Click");
 *   gtk_box_pack_start(GTK_BOX(box), btn, TRUE, FALSE, 0);
 *   → 第一参数是容器, 第二参数是子控件
 *
 * LVGL 参数:
 *   lv_obj_t * btn = lv_btn_create(parent);
 *   lv_label_create(btn);
 *   → 第一参数就是父对象
 */

import type { UniversalNode, UniversalStyle, ButtonVariant, InputKind } from '../services/canvas/UniversalAST';
import { TranslateError, type Translator } from './types';

// ──────────────────────────── C Tokenizer ────────────────────────────

interface Token {
  type: 'ident' | 'number' | 'string' | 'punct' | 'keyword' | 'op' | 'preproc';
  value: string;
  pos: number;
  line: number;
}

const C_KEYWORDS = new Set([
  'int', 'char', 'void', 'long', 'short', 'float', 'double', 'unsigned', 'signed',
  'struct', 'union', 'enum', 'typedef', 'const', 'static', 'extern', 'register',
  'volatile', 'auto', 'if', 'else', 'switch', 'case', 'default', 'for', 'while',
  'do', 'break', 'continue', 'return', 'goto', 'sizeof', 'HWND', 'GtkWidget',
  'GtkWidget*', 'lv_obj_t', 'lv_obj_t*', 'HMENU', 'HINSTANCE', 'LPARAM', 'WPARAM',
  'LRESULT', 'UINT', 'BOOL', 'TRUE', 'FALSE', 'NULL', 'LPSTR', 'LPCSTR', 'DWORD',
]);

function tokenize(code: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = code.length;
  let line = 1;

  while (i < n) {
    const ch = code[i];

    if (ch === '\n') { line++; i++; continue; }
    if (ch === '\r') { i++; continue; }
    if (ch === ' ' || ch === '\t') { i++; continue; }

    // 预处理指令 #include / #define / #ifdef ...
    if (ch === '#') {
      let val = '';
      while (i < n && code[i] !== '\n') {
        // 行连接
        if (code[i] === '\\' && code[i + 1] === '\n') { line++; i += 2; continue; }
        val += code[i];
        i++;
      }
      tokens.push({ type: 'preproc', value: val, pos: i, line });
      continue;
    }

    // 块注释 /* ... */
    if (ch === '/' && code[i + 1] === '*') {
      i += 2;
      while (i < n && !(code[i] === '*' && code[i + 1] === '/')) {
        if (code[i] === '\n') line++;
        i++;
      }
      i += 2;
      continue;
    }
    // 行注释 //
    if (ch === '/' && code[i + 1] === '/') {
      while (i < n && code[i] !== '\n') i++;
      continue;
    }

    // 字符串 "..." (C 转义)
    if (ch === '"') {
      let val = '';
      i++;
      while (i < n && code[i] !== '"') {
        if (code[i] === '\\' && i + 1 < n) {
          // 简化转义: \n \t \" \\ 等
          const next = code[i + 1];
          if (next === 'n') val += '\n';
          else if (next === 't') val += '\t';
          else if (next === 'r') val += '\r';
          else val += next;
          i += 2;
          continue;
        }
        if (code[i] === '\n') { line++; break; }
        val += code[i];
        i++;
      }
      i++; // 结束引号
      tokens.push({ type: 'string', value: val, pos: i, line });
      continue;
    }

    // 字符 'a' / '\n'
    if (ch === "'") {
      let val = '';
      i++;
      while (i < n && code[i] !== "'") {
        if (code[i] === '\\' && i + 1 < n) {
          val += code[i + 1];
          i += 2;
          continue;
        }
        val += code[i];
        i++;
      }
      i++;
      tokens.push({ type: 'string', value: val, pos: i, line });
      continue;
    }

    // 数字 (含 0x / 浮点 / 后缀 UL)
    if (/[\d]/.test(ch) || (ch === '-' && /[\d]/.test(code[i + 1]))) {
      let num = '';
      if (ch === '-') { num += ch; i++; }
      if (code[i] === '0' && (code[i + 1] === 'x' || code[i + 1] === 'X')) {
        num += code[i] + code[i + 1];
        i += 2;
        while (i < n && /[\da-fA-F]/.test(code[i])) { num += code[i]; i++; }
      } else {
        while (i < n && /[\d.]/.test(code[i])) { num += code[i]; i++; }
        // 科学计数 e+5
        if (i < n && /[eE]/.test(code[i])) {
          num += code[i]; i++;
          if (code[i] === '+' || code[i] === '-') { num += code[i]; i++; }
          while (i < n && /[\d]/.test(code[i])) { num += code[i]; i++; }
        }
      }
      // 类型后缀 UL / L / F
      while (i < n && /[uUlLfF]/.test(code[i])) { num += code[i]; i++; }
      tokens.push({ type: 'number', value: num, pos: i, line });
      continue;
    }

    // 标识符 / 关键字 (含下划线, 含 . 访问用于宏调用)
    if (/[a-zA-Z_]/.test(ch)) {
      let id = '';
      while (i < n && /[\w]/.test(code[i])) { id += code[i]; i++; }
      // 成员访问 Foo.bar / obj->field 合并
      // -> 访问
      while (code[i] === '-' && code[i + 1] === '>' && /[a-zA-Z_]/.test(code[i + 2] || '')) {
        i += 2;
        id += '->';
        while (i < n && /[\w]/.test(code[i])) { id += code[i]; i++; }
      }
      // . 访问
      while (code[i] === '.' && /[a-zA-Z_]/.test(code[i + 1] || '')) {
        id += '.';
        i++;
        while (i < n && /[\w]/.test(code[i])) { id += code[i]; i++; }
      }
      tokens.push({
        type: C_KEYWORDS.has(id) ? 'keyword' : 'ident',
        value: id,
        pos: i,
        line,
      });
      continue;
    }

    // 多字符运算符
    const three = code.slice(i, i + 3);
    const two = code.slice(i, i + 2);
    if (['<<=', '>>=', '...'].includes(three)) {
      tokens.push({ type: 'op', value: three, pos: i, line });
      i += 3;
      continue;
    }
    if (['->', '<<', '>>', '<=', '>=', '==', '!=', '&&', '||', '++', '--',
         '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^='].includes(two)) {
      tokens.push({ type: 'op', value: two, pos: i, line });
      i += 2;
      continue;
    }

    tokens.push({ type: 'punct', value: ch, pos: i, line });
    i++;
  }

  return tokens;
}

// ──────────────────────────── C 调用解析 ────────────────────────────

interface CCall {
  name: string;
  positionalArgs: CValue[];
  line: number;
}

type CValue =
  | { kind: 'literal'; value: string | number | boolean | null }
  | { kind: 'ident'; name: string }
  | { kind: 'call'; call: CCall }
  | { kind: 'cast'; typeName: string; value: CValue };

class CParser {
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

  /** 跳过类型转换 (TYPE) expr */
  private skipCast(): void {
    // (GtkWidget*) / (HWND) / (int)
    while (this.peek()?.value === '(' &&
           (this.peek(1)?.type === 'keyword' || this.peek(1)?.type === 'ident') &&
           this.peek(2)?.value === ')') {
      this.consume(); // (
      this.consume(); // type
      this.consume(); // )
      // 跳过可选的 *
      while (this.peek()?.value === '*') this.consume();
    }
  }

  parseValue(): CValue {
    const t = this.peek();
    if (!t) return { kind: 'literal', value: null };

    // 类型转换 (GtkWidget*)expr / (HWND)var
    if (t.value === '(' &&
        (this.peek(1)?.type === 'keyword' || this.peek(1)?.type === 'ident') &&
        this.peek(2)?.value === ')') {
      this.consume(); // (
      const typeName = this.consume().value;
      this.consume(); // )
      while (this.peek()?.value === '*') this.consume();
      const inner = this.parseValue();
      return { kind: 'cast', typeName, value: inner };
    }

    if (t.type === 'string') { this.consume(); return { kind: 'literal', value: t.value }; }
    if (t.type === 'number') {
      this.consume();
      const clean = t.value.replace(/[uUlLfF]+$/, '');
      const num = clean.startsWith('0x') || clean.startsWith('0X')
        ? parseInt(clean, 16)
        : (clean.includes('.') || clean.includes('e') || clean.includes('E')
          ? parseFloat(clean)
          : parseInt(clean, 10));
      return { kind: 'literal', value: num };
    }
    if (t.value === 'NULL' || t.value === '0' && this.peek(-1)?.value === '(') {
      this.consume();
      return { kind: 'literal', value: null };
    }
    if (t.value === 'TRUE' || t.value === 'true') {
      this.consume();
      return { kind: 'literal', value: true };
    }
    if (t.value === 'FALSE' || t.value === 'false') {
      this.consume();
      return { kind: 'literal', value: false };
    }

    // 标识符 / 函数调用
    if (t.type === 'ident') {
      const name = t.value;
      this.consume();
      if (this.peek()?.value === '(') {
        return { kind: 'call', call: this.parseCallArgs(name, t.line) };
      }
      return { kind: 'ident', name };
    }

    this.consume();
    return { kind: 'literal', value: null };
  }

  parseCallArgs(name: string, line: number): CCall {
    this.expect('(');
    const call: CCall = { name, positionalArgs: [], line };

    if (this.peek()?.value === ')') { this.consume(); return call; }

    while (true) {
      // 跳过类型转换
      this.skipCast();
      const val = this.parseValue();

      // 合并位运算符 | (Win32 风格标志: WS_CHILD | WS_VISIBLE | SS_CENTER)
      // 这些应该作为一个值处理, 不能拆成多个位置参数
      if (this.peek()?.value === '|') {
        const merged: CValue = { kind: 'ident', name: this.collectBitwiseOr(val) };
        call.positionalArgs.push(merged);
      } else {
        call.positionalArgs.push(val);
      }

      const sep = this.peek();
      if (sep?.value === ',') { this.consume(); continue; }
      if (sep?.value === ')') break;
      if (!sep) break;
    }
    this.expect(')');
    return call;
  }

  /**
   * 收集位运算符 | 链: WS_CHILD | WS_VISIBLE | SS_CENTER
   * 返回合并后的字符串 "WS_CHILD|WS_VISIBLE|SS_CENTER"
   * 调用前已消费第一个值, 此方法从 | 开始消费
   */
  private collectBitwiseOr(firstVal: CValue): string {
    const parts: string[] = [this.cValueToString(firstVal)];
    while (this.peek()?.value === '|') {
      this.consume(); // |
      const next = this.parseValue();
      parts.push(this.cValueToString(next));
    }
    return parts.join('|');
  }

  /** CValue → 字符串 (用于位运算符合并) */
  private cValueToString(v: CValue): string {
    if (v.kind === 'literal') return String(v.value);
    if (v.kind === 'ident') return v.name;
    if (v.kind === 'cast') return this.cValueToString(v.value);
    if (v.kind === 'call') return v.call.name;
    return '';
  }
}

// ──────────────────────────── 调用收集 ────────────────────────────

interface CollectedCalls {
  /** 函数调用, 按行号排序 */
  calls: CCall[];
  /** 变量赋值: varName → CCall (GtkWidget *btn = gtk_button_new_with_label(...)) */
  assignments: Map<string, CCall>;
  /** 方法调用: var.method(args) — C 里几乎没有, 但宏调用 GTK_BOX(box) 是 cast 不算方法 */
}

function collectCalls(tokens: Token[]): CollectedCalls {
  const result: CollectedCalls = {
    calls: [],
    assignments: new Map(),
  };
  const parser = new CParser(tokens);

  while (parser.peek()) {
    const t = parser.peek();
    if (!t) break;

    // 跳过类型关键字 (int/char/HWND/GtkWidget*/...)
    // GtkWidget *btn = gtk_button_new_with_label("Click");
    // HWND btn = CreateWindowEx(0, "button", "Click", ...);
    if (t.type === 'keyword') {
      // 收集类型名, 找到 = 后的赋值
      parser.consume();
      // 跳过 *
      while (parser.peek()?.value === '*') parser.consume();
      // 下一 token 是变量名
      const varTok = parser.peek();
      if (varTok?.type === 'ident' && parser.peek(1)?.value === '=') {
        const varName = varTok.value;
        parser.consume(); // var
        parser.consume(); // =
        // 右值应该是函数调用
        if (parser.peek()?.type === 'ident' && parser.peek(1)?.value === '(') {
          const callName = parser.consume().value;
          const call = parser.parseCallArgs(callName, t.line);
          result.calls.push(call);
          result.assignments.set(varName, call);
        } else {
          // 非调用赋值, 跳过
          parser.consume();
        }
        continue;
      }
      continue;
    }

    // 直接函数调用 (无赋值): CreateWindowEx(...) / gtk_box_pack_start(...)
    if (t.type === 'ident' && parser.peek(1)?.value === '(') {
      const name = t.value;
      parser.consume();
      const call = parser.parseCallArgs(name, t.line);
      result.calls.push(call);
      continue;
    }

    parser.consume();
  }

  return result;
}

// ──────────────────────────── Win32 / GTK / LVGL 识别 ────────────────────────────

type WidgetFramework = 'win32' | 'gtk' | 'lvgl' | 'unknown';

/** Win32 CreateWindowEx / CreateWindow → { kind, label, parentVar } */
function parseWin32Create(call: CCall): {
  className: string;
  label: string;
  parentVar: string | null;
} | null {
  if (call.name !== 'CreateWindowEx' && call.name !== 'CreateWindowW' &&
      call.name !== 'CreateWindowA' && call.name !== 'CreateWindow') return null;

  // CreateWindowEx(dwExStyle, lpClassName, lpWindowName, dwStyle, x, y, w, h, hWndParent, ...)
  // CreateWindow(lpClassName, lpWindowName, dwStyle, x, y, w, h, hWndParent, ...)
  const offset = call.name === 'CreateWindowEx' ? 1 : 0;
  const classNameArg = call.positionalArgs[offset];
  const labelArg = call.positionalArgs[offset + 1];
  const parentArg = call.positionalArgs[offset + 7];

  let className = '';
  if (classNameArg) {
    if (classNameArg.kind === 'literal' && typeof classNameArg.value === 'string') {
      className = classNameArg.value.toLowerCase();
    } else if (classNameArg.kind === 'ident') {
      className = classNameArg.name.toLowerCase();
    }
  }

  let label = '';
  if (labelArg) {
    if (labelArg.kind === 'literal' && typeof labelArg.value === 'string') {
      label = labelArg.value;
    }
  }

  let parentVar: string | null = null;
  if (parentArg) {
    if (parentArg.kind === 'ident' && parentArg.name !== 'NULL' && parentArg.name !== '0') {
      parentVar = parentArg.name;
    } else if (parentArg.kind === 'cast') {
      // (HWND)NULL
      if (parentArg.value.kind === 'ident' && parentArg.value.name !== 'NULL') {
        parentVar = parentArg.value.name;
      }
    }
  }

  return { className, label, parentVar };
}

/** GTK gtk_*_new / gtk_*_new_with_label → 节点类型 + label */
function parseGtkCreate(call: CCall): {
  widgetType: string;
  label: string;
  parentVar: string | null;
} | null {
  const name = call.name;
  if (!name.startsWith('gtk_') || !name.includes('_new')) return null;

  let widgetType = 'container';
  let label = '';

  if (name === 'gtk_button_new_with_label' || name === 'gtk_button_new_with_mnemonic') {
    widgetType = 'button';
    if (call.positionalArgs.length > 0) {
      const arg = call.positionalArgs[0];
      if (arg.kind === 'literal' && typeof arg.value === 'string') label = arg.value;
    }
  } else if (name === 'gtk_button_new') {
    widgetType = 'button';
  } else if (name === 'gtk_label_new') {
    widgetType = 'text';
    if (call.positionalArgs.length > 0) {
      const arg = call.positionalArgs[0];
      if (arg.kind === 'literal' && typeof arg.value === 'string') label = arg.value;
    }
  } else if (name === 'gtk_entry_new') {
    widgetType = 'input';
  } else if (name === 'gtk_window_new') {
    widgetType = 'container';
  } else if (name === 'gtk_box_new' || name === 'gtk_hbox_new') {
    widgetType = 'row';
  } else if (name === 'gtk_vbox_new') {
    widgetType = 'column';
  } else if (name === 'gtk_grid_new') {
    widgetType = 'container';
  } else if (name === 'gtk_frame_new') {
    widgetType = 'container';
  } else if (name === 'gtk_image_new') {
    widgetType = 'image';
  } else if (name === 'gtk_separator_new') {
    widgetType = 'divider';
  } else if (name === 'gtk_check_button_new' || name === 'gtk_check_button_new_with_label') {
    widgetType = 'input';
    if (call.positionalArgs.length > 0) {
      const arg = call.positionalArgs[0];
      if (arg.kind === 'literal' && typeof arg.value === 'string') label = arg.value;
    }
  } else {
    widgetType = 'container';
  }

  return { widgetType, label, parentVar: null };
}

/** LVGL lv_*_create(parent) → 节点类型 */
function parseLvglCreate(call: CCall): {
  widgetType: string;
  label: string;
  parentVar: string | null;
} | null {
  const name = call.name;
  if (!name.startsWith('lv_') || !name.endsWith('_create')) return null;

  let widgetType = 'container';
  let label = '';

  if (name === 'lv_btn_create') widgetType = 'button';
  else if (name === 'lv_label_create') {
    widgetType = 'text';
    // LVGL label 通常创建后再 set text
  } else if (name === 'lv_textarea_create') widgetType = 'input';
  else if (name === 'lv_obj_create') widgetType = 'container';
  else if (name === 'lv_img_create') widgetType = 'image';
  else if (name === 'lv_led_create') widgetType = 'container';
  else if (name === 'lv_bar_create') widgetType = 'container';
  else if (name === 'lv_slider_create') widgetType = 'input';
  else if (name === 'lv_checkbox_create') widgetType = 'input';
  else if (name === 'lv_switch_create') widgetType = 'input';
  else widgetType = 'container';

  // 第一参数是 parent
  let parentVar: string | null = null;
  if (call.positionalArgs.length > 0) {
    const arg = call.positionalArgs[0];
    if (arg.kind === 'ident' && arg.name !== 'NULL' && arg.name !== '0') {
      parentVar = arg.name;
    } else if (arg.kind === 'cast' && arg.value.kind === 'ident' && arg.value.name !== 'NULL') {
      parentVar = arg.value.name;
    }
  }

  return { widgetType, label, parentVar };
}

// ──────────────────────────── 文本更新 (SendMessage / SetWindowText) ────────────────────────────

/**
 * 处理 SetWindowText(hwnd, "text") / SendMessage(hwnd, WM_SETTEXT, 0, "text")
 * 返回 varName → 文本 的映射
 */
function collectTextUpdates(calls: CCall[]): Map<string, string> {
  const updates = new Map<string, string>();

  for (const call of calls) {
    if (call.name === 'SetWindowText' || call.name === 'SetWindowTextA' || call.name === 'SetWindowTextW') {
      // SetWindowText(hwnd, "text")
      if (call.positionalArgs.length >= 2) {
        const hwnd = call.positionalArgs[0];
        const text = call.positionalArgs[1];
        if (hwnd.kind === 'ident' && text.kind === 'literal' && typeof text.value === 'string') {
          updates.set(hwnd.name, text.value);
        }
      }
    }

    if (call.name === 'SendMessage' || call.name === 'SendMessageA' || call.name === 'SendMessageW') {
      // SendMessage(hwnd, WM_SETTEXT, 0, "text")
      if (call.positionalArgs.length >= 4) {
        const hwnd = call.positionalArgs[0];
        const msg = call.positionalArgs[1];
        const text = call.positionalArgs[3];
        // WM_SETTEXT = 0x000C
        const isSettext =
          (msg.kind === 'ident' && msg.name === 'WM_SETTEXT') ||
          (msg.kind === 'literal' && (msg.value === 12 || msg.value === 0x0C));
        if (isSettext && hwnd.kind === 'ident' &&
            text.kind === 'literal' && typeof text.value === 'string') {
          updates.set(hwnd.name, text.value);
        }
      }
    }

    // LVGL: lv_label_set_text(label, "text")
    if (call.name === 'lv_label_set_text' || call.name === 'lv_label_set_text_fmt') {
      if (call.positionalArgs.length >= 2) {
        const obj = call.positionalArgs[0];
        const text = call.positionalArgs[1];
        if (obj.kind === 'ident' && text.kind === 'literal' && typeof text.value === 'string') {
          updates.set(obj.name, text.value);
        }
      }
    }
  }

  return updates;
}

// ──────────────────────────── 父子关系 (pack_start / set_parent) ────────────────────────────

/** gtk_box_pack_start(GTK_BOX(box), child, ...) → 收集 box 的子 */
function collectGtkPacking(calls: CCall[]): Map<string, string[]> {
  const parentToChildren = new Map<string, string[]>();

  for (const call of calls) {
    if (call.name === 'gtk_box_pack_start' || call.name === 'gtk_box_pack_end' ||
        call.name === 'gtk_container_add') {
      if (call.positionalArgs.length >= 2) {
        // gtk_box_pack_start(GTK_BOX(box), child, ...)
        // gtk_container_add(container, child)
        const parentArg = call.positionalArgs[0];
        const childArg = call.positionalArgs[1];
        let parentName: string | null = null;
        if (parentArg.kind === 'cast' && parentArg.value.kind === 'ident') {
          parentName = parentArg.value.name;
        } else if (parentArg.kind === 'ident') {
          parentName = parentArg.name;
        } else if (parentArg.kind === 'call') {
          // GTK_BOX(box) / GTK_CONTAINER(c) 等包装宏 → 取内部 ident
          const inner = parentArg.call.positionalArgs[0];
          if (inner && inner.kind === 'ident') {
            parentName = inner.name;
          }
        }
        let childName: string | null = null;
        if (childArg.kind === 'ident') {
          childName = childArg.name;
        }
        if (parentName && childName) {
          const list = parentToChildren.get(parentName) || [];
          list.push(childName);
          parentToChildren.set(parentName, list);
        }
      }
    }
  }

  return parentToChildren;
}

// ──────────────────────────── 调用 → UniversalNode ────────────────────────────

interface CWidget {
  varName: string;
  framework: WidgetFramework;
  /** Win32 className: button / edit / static / ... */
  win32Class?: string;
  /** 节点类型 (从函数名推断) */
  widgetType: string;
  /** 初始 label */
  label: string;
  /** 父变量名 */
  parentVar: string | null;
  node: UniversalNode;
}

function win32ClassToNode(className: string, label: string, style: UniversalStyle): UniversalNode {
  // Win32 窗口类名映射
  // button → button (但 button 也可能是 checkbox/radio, 简化)
  // edit → input
  // static → text (空 label 的 static 通常是分组面板 → container)
  // Button / Edit / Static 等大小写变体
  const lower = className.toLowerCase();

  if (lower === 'button' || lower === 'buttonclass') {
    return { type: 'button', label, variant: 'filled', style: Object.keys(style).length > 0 ? style : undefined };
  }
  if (lower === 'edit' || lower === 'editclass') {
    return { type: 'input', placeholder: label || undefined, kind: 'text', style: Object.keys(style).length > 0 ? style : undefined };
  }
  if (lower === 'static' || lower === 'staticclass') {
    // 空 label 的 static 通常是分组面板/容器 (Win32 常见模式)
    if (!label) {
      return { type: 'container', style: Object.keys(style).length > 0 ? style : undefined, children: [] };
    }
    return { type: 'text', content: label, style: Object.keys(style).length > 0 ? style : undefined };
  }
  // 复选/单选通过 BS_CHECKBOX / BS_RADIOBUTTON 风格, 这里简化为 button
  if (lower.includes('button')) {
    return { type: 'button', label, variant: 'filled', style: Object.keys(style).length > 0 ? style : undefined };
  }
  // 默认 container
  return { type: 'container', style: Object.keys(style).length > 0 ? style : undefined, children: [] };
}

function gtkTypeToNode(widgetType: string, label: string, style: UniversalStyle): UniversalNode {
  switch (widgetType) {
    case 'button':
      return { type: 'button', label, variant: 'filled', style: Object.keys(style).length > 0 ? style : undefined };
    case 'text':
      return { type: 'text', content: label, style: Object.keys(style).length > 0 ? style : undefined };
    case 'input':
      return { type: 'input', placeholder: label || undefined, kind: 'text', style: Object.keys(style).length > 0 ? style : undefined };
    case 'image':
      return { type: 'image', style: Object.keys(style).length > 0 ? style : undefined };
    case 'divider':
      return { type: 'divider', style: Object.keys(style).length > 0 ? style : undefined };
    case 'row':
      return { type: 'row', style: Object.keys(style).length > 0 ? style : undefined, children: [] };
    case 'column':
      return { type: 'column', style: Object.keys(style).length > 0 ? style : undefined, children: [] };
    default:
      return { type: 'container', style: Object.keys(style).length > 0 ? style : undefined, children: [] };
  }
}

function lvglTypeToNode(widgetType: string, style: UniversalStyle): UniversalNode {
  switch (widgetType) {
    case 'button':
      return { type: 'button', label: '', variant: 'filled', style: Object.keys(style).length > 0 ? style : undefined };
    case 'text':
      return { type: 'text', content: '', style: Object.keys(style).length > 0 ? style : undefined };
    case 'input':
      return { type: 'input', kind: 'text', style: Object.keys(style).length > 0 ? style : undefined };
    case 'image':
      return { type: 'image', style: Object.keys(style).length > 0 ? style : undefined };
    default:
      return { type: 'container', style: Object.keys(style).length > 0 ? style : undefined, children: [] };
  }
}

// ──────────────────────────── 根节点构建 ────────────────────────────

function buildTree(calls: CollectedCalls): UniversalNode | null {
  if (calls.calls.length === 0) return null;

  const widgets: CWidget[] = [];
  const varToWidget = new Map<string, CWidget>();
  let anonCounter = 0;

  // 1. 识别所有构造调用, 转为 CWidget
  for (const call of calls.calls) {
    let widget: Omit<CWidget, 'varName'> | null = null;

    // Win32
    const win32 = parseWin32Create(call);
    if (win32) {
      const style: UniversalStyle = {};
      const node = win32ClassToNode(win32.className, win32.label, style);
      widget = {
        framework: 'win32',
        win32Class: win32.className,
        widgetType: node.type as string,
        label: win32.label,
        parentVar: win32.parentVar,
        node,
      };
    }

    // GTK
    if (!widget) {
      const gtk = parseGtkCreate(call);
      if (gtk) {
        const style: UniversalStyle = {};
        const node = gtkTypeToNode(gtk.widgetType, gtk.label, style);
        widget = {
          framework: 'gtk',
          widgetType: gtk.widgetType,
          label: gtk.label,
          parentVar: gtk.parentVar,
          node,
        };
      }
    }

    // LVGL
    if (!widget) {
      const lvgl = parseLvglCreate(call);
      if (lvgl) {
        const style: UniversalStyle = {};
        const node = lvglTypeToNode(lvgl.widgetType, style);
        widget = {
          framework: 'lvgl',
          widgetType: lvgl.widgetType,
          label: lvgl.label,
          parentVar: lvgl.parentVar,
          node,
        };
      }
    }

    if (!widget) continue;

    // 找变量名 (从 assignments 反查)
    let varName: string | null = null;
    for (const [v, c] of calls.assignments) {
      if (c === call) { varName = v; break; }
    }
    if (!varName) varName = `__anon_${anonCounter++}`;

    const w: CWidget = { varName, ...widget };
    widgets.push(w);
    varToWidget.set(varName, w);
  }

  if (widgets.length === 0) return null;

  // 2. 应用文本更新 (SetWindowText / lv_label_set_text)
  const textUpdates = collectTextUpdates(calls.calls);
  for (const [varName, text] of textUpdates) {
    const w = varToWidget.get(varName);
    if (w) {
      const node = w.node as any;
      if (node.type === 'text') node.content = text;
      else if (node.type === 'button') node.label = text;
      else if (node.type === 'input') node.placeholder = text;
    }
  }

  // 3. GTK 父子关系 (pack_start / container_add)
  const gtkPacking = collectGtkPacking(calls.calls);

  // 4. 建立父子树
  //    方式 A: Win32 CreateWindow 的 hWndParent 参数
  //    方式 B: LVGL lv_*_create 的第一参数
  //    方式 C: GTK gtk_box_pack_start / gtk_container_add
  const varToChildren = new Map<string, CWidget[]>();

  for (const w of widgets) {
    if (w.parentVar && varToWidget.has(w.parentVar)) {
      const parent = varToWidget.get(w.parentVar)!;
      // 只挂到容器
      if (parent.node.type === 'container' || parent.node.type === 'row' ||
          parent.node.type === 'column' || parent.node.type === 'stack') {
        const list = varToChildren.get(parent.varName) || [];
        list.push(w);
        varToChildren.set(parent.varName, list);
      }
    }
  }

  for (const [parentVar, childVars] of gtkPacking) {
    const parent = varToWidget.get(parentVar);
    if (!parent) continue;
    for (const childVar of childVars) {
      const child = varToWidget.get(childVar);
      if (child) {
        const list = varToChildren.get(parent.varName) || [];
        list.push(child);
        varToChildren.set(parent.varName, list);
      }
    }
  }

  // 挂载 children
  for (const w of widgets) {
    const kids = varToChildren.get(w.varName);
    if (kids && kids.length > 0) {
      const node = w.node as any;
      if (node.children !== undefined) {
        node.children = kids.map(k => k.node);
      }
    }
  }

  // 5. 找根: 没有 parent 的容器
  //    Win32 常见模式: CreateWindow(..., hwnd, ...) 中 hwnd 是 WndProc 参数,
  //    不是 CreateWindow 创建的 → varToWidget.has('hwnd') = false
  //    这些 widget 实际上是顶层窗口的子控件, 需要包到一个合成根容器里
  const parentless: CWidget[] = [];
  for (const w of widgets) {
    const hasParent = w.parentVar && varToWidget.has(w.parentVar);
    const addedByParent = Array.from(gtkPacking.values()).flat().includes(w.varName);
    if (!hasParent && !addedByParent) {
      parentless.push(w);
    }
  }

  if (parentless.length === 0) {
    return widgets[0].node;
  }

  // 单个 parentless 且是容器 → 直接用作根
  if (parentless.length === 1) {
    return parentless[0].node;
  }

  // 多个 parentless (典型 Win32 场景: hwnd 作为父变量但未注册为 widget)
  // → 包到合成根容器里, 保持声明顺序
  const syntheticRoot: UniversalNode = {
    type: 'container',
    children: parentless.map(w => w.node),
  };
  return syntheticRoot;
}

// ──────────────────────────── 翻译器实现 ────────────────────────────

export const cTranslator: Translator = {
  language: 'c',
  displayName: 'C (Win32 / GTK / LVGL)',

  /**
   * 检测代码是否为 C UI 代码
   * 置信度:
   *   0.9 — #include <windows.h> / <gtk.h> / "lvgl.h" + 构造调用
   *   0.7 — CreateWindow* / gtk_*_new / lv_*_create 调用
   *   0.4 — C 语法特征但无 UI
   */
  detect(code: string): number {
    if (!code || typeof code !== 'string') return 0;
    const trimmed = code.trim();
    if (trimmed.length < 10) return 0;

    const hasWin32Include = /#include\s*[<"]windows\.h[>"]/.test(trimmed);
    const hasGtkInclude = /#include\s*[<"]gtk\/gtk\.h[>"]/.test(trimmed);
    const hasLvglInclude = /#include\s*[<"]lvgl\.h[>"]/.test(trimmed);

    const hasWin32Call = /\bCreateWindow(?:Ex|W|A)?\s*\(/.test(trimmed);
    const hasGtkCall = /\bgtk_\w*_new\w*\s*\(/.test(trimmed);
    const hasLvglCall = /\blv_\w+_create\s*\(/.test(trimmed);

    if ((hasWin32Include && hasWin32Call) || (hasGtkInclude && hasGtkCall) || (hasLvglInclude && hasLvglCall)) {
      return 0.9;
    }
    if (hasWin32Call || hasGtkCall || hasLvglCall) return 0.7;

    // C 语法特征
    const hasCSyntax = /#include|#define|int\s+main\s*\(/.test(trimmed);
    if (hasCSyntax) return 0.3;

    return 0;
  },

  translate(code: string): UniversalNode {
    if (!code || typeof code !== 'string') {
      throw new TranslateError('c', 'code 为空');
    }

    let tokens: Token[];
    try {
      tokens = tokenize(code);
    } catch (err: any) {
      throw new TranslateError('c', `词法分析失败: ${err.message}`, code);
    }

    let calls: CollectedCalls;
    try {
      calls = collectCalls(tokens);
    } catch (err: any) {
      throw new TranslateError('c', `语法分析失败: ${err.message}`, code);
    }

    const root = buildTree(calls);
    if (!root) {
      throw new TranslateError('c', '未找到 UI 构造调用 (CreateWindow / gtk_*_new / lv_*_create)', code);
    }

    return root;
  },
};
