/**
 * incrementalCanvasPusher — 逐行实时翻译 + 多线程加速 + 最终一致性检查
 *
 * 核心设计 (2026-07-11 v3):
 *
 *  1. 逐行增量翻译
 *     - LLM 每吐出一个代码 chunk → 立即尝试翻译 → 推画布
 *     - 不等代码块闭合, 不等完整行, 有新代码就翻译
 *
 *  2. DSL 格式转换
 *     - 翻译器输出 UniversalNode {type, style, content, children}
 *     - Flutter 画布期望 {type, props, children}
 *     - pushToCanvas 做格式转换
 *
 *  3. 多线程加速
 *     - 用 translateCodeAsync (内部自动选 Worker / in-thread)
 *
 *  4. 最终一致性检查
 *     - done 事件时用完整代码做最终翻译 → 覆盖增量结果
 */

import { translateCode, isLanguageSupported } from '../translate';
import { translateCodeAsync } from '../translate/translatorWorker';
import { usePreviewStreamStore } from '../state/previewStreamStore';
import type { UniversalNode, UniversalStyle } from './canvas/UniversalAST';

// ── chatId → canvasSessionId 映射 ──
const canvasSessionIdMap = new Map<string, string>();

export function setCanvasSessionId(chatId: string, canvasSessionId: string): void {
  canvasSessionIdMap.set(chatId, canvasSessionId);
}

// ★ FIX 2026-07-12: 添加 fallback 警告日志, 方便排查 Session ID 不匹配问题
export function getCanvasSessionId(chatId: string): string {
  const id = canvasSessionIdMap.get(chatId);
  if (!id) {
    console.warn(
      `[IncrementalCanvasPusher] ⚠️ getCanvasSessionId("${chatId}") 返回回退值 — ` +
      `映射表中无此 chatId。这通常意味着 PreviewPanel 还未注册真实 canvas session ID。` +
      `\n  回退使用: canvas-${chatId}` +
      `\n  当前已注册的 keys: ${[...canvasSessionIdMap.keys()].join(', ') || '(空)'}`
    );
    return `canvas-${chatId}`;
  }
  return id;
}

export function clearCanvasSessionId(chatId: string): void {
  canvasSessionIdMap.delete(chatId);
}

// ── 画布 session 自动启动 + push 重试 ──
// 当 canvas.push 返回 "session not found" 时, 自动 start session 并重试一次
const _startedSessions = new Set<string>();

export async function ensureCanvasAndPush(
  sessionId: string,
  dsl: any,
  chatSessionId?: string,
): Promise<{ ok: boolean; error?: string }> {
  if (typeof window === 'undefined' || !window.soloforge?.canvas) {
    return { ok: false, error: 'no electron canvas' };
  }
  const canvas = window.soloforge.canvas;

  // 第一次尝试 push
  try {
    const r = await canvas.push(sessionId, dsl);
    if (r?.ok) return { ok: true };

    // 如果是 session not found, 尝试启动 session
    if (r?.error && String(r.error).includes('not found')) {
      console.warn(`[ensureCanvasAndPush] session "${sessionId}" not found, auto-starting...`);

      // 启动画布 (如果尚未启动过)
      if (!_startedSessions.has(sessionId)) {
        _startedSessions.add(sessionId);
        try {
          const startR = await canvas.start(sessionId, 0, 640);
          if (!startR?.ok) {
            console.warn(`[ensureCanvasAndPush] canvas.start failed:`, startR?.error);
            return { ok: false, error: `start failed: ${startR?.error || 'unknown'}` };
          }
          console.log(`[ensureCanvasAndPush] canvas.start ok, port=${startR.session?.port}, retrying push...`);
        } catch (startErr: any) {
          console.warn(`[ensureCanvasAndPush] canvas.start exception:`, startErr?.message || startErr);
          return { ok: false, error: `start exception: ${startErr?.message || 'unknown'}` };
        }
      }

      // 重试 push
      try {
        const r2 = await canvas.push(sessionId, dsl);
        if (r2?.ok) {
          console.log(`[ensureCanvasAndPush] retry push ok after auto-start`);
          return { ok: true };
        }
        console.warn(`[ensureCanvasAndPush] retry push still failed:`, r2?.error);
        return { ok: false, error: r2?.error || 'retry failed' };
      } catch (retryErr: any) {
        return { ok: false, error: `retry exception: ${retryErr?.message || 'unknown'}` };
      }
    }

    return { ok: false, error: r?.error || 'push failed' };
  } catch (err: any) {
    return { ok: false, error: err?.message || 'exception' };
  }
}

// ── 语言标识映射 ──
const BLOCK_LANG_TO_TRANSLATOR: Record<string, string> = {
  html: 'html', htm: 'html',
  jsx: 'react', tsx: 'react',
  javascript: 'react', js: 'react',
  typescript: 'react', ts: 'react',
  vue: 'vue',
  dart: 'flutter',
  swift: 'swiftui',
  kotlin: 'compose',
  xml: 'android',
  xaml: 'xaml',
  qml: 'qml',
  python: 'python', py: 'python',
  c: 'c', cpp: 'c', 'c++': 'c', h: 'c',
  // ★ 2026-07-11: json 代码块 — LLM 用 canvas_push_ui 画图时返回 DSL JSON
  //   不走翻译器, 直接解析 JSON → 推画布
  json: '__json_dsl__',
};

// ─────────────────────────────────────────────────────────────
// UniversalNode → Flutter DSL 格式转换
//
// 翻译器输出: { type: 'text', content: 'Hello', style: { color: '#fff' } }
// Flutter 期望: { type: 'text', props: { content: 'Hello', color: '#fff' } }
//
// 关键映射:
//   style.background  → props.backgroundColor
//   style.gap         → props.spacing
//   style.radius      → props.borderRadius
//   style.shadow      → props.boxShadow
//   node.content      → props.content
//   node.label        → props.label
//   node.variant      → props.variant
//   type 'container'  → props.layout = 'column' (默认)
//   type 'row'        → props.layout = 'row'
//   type 'column'     → props.layout = 'column'
// ─────────────────────────────────────────────────────────────

function styleToProps(style: UniversalStyle | undefined, nodeType: string): Record<string, any> {
  const props: Record<string, any> = {};
  if (!style) return props;

  if (style.background) props.backgroundColor = style.background;
  if (style.color) props.color = style.color;
  if (style.padding != null) props.padding = style.padding;
  if (style.margin != null) props.margin = style.margin;
  if (style.radius != null) props.borderRadius = style.radius;
  if (style.shadow) props.boxShadow = style.shadow;
  if (style.border) props.border = style.border;
  if (style.opacity != null) props.opacity = style.opacity;
  if (style.fontSize != null) props.fontSize = style.fontSize;
  if (style.fontWeight != null) props.fontWeight = style.fontWeight;
  if (style.textAlign) props.textAlign = style.textAlign;
  if (style.gap != null) props.spacing = style.gap;
  if (style.width != null) props.width = style.width;
  if (style.height != null) props.height = style.height;
  if (style.flex != null) props.flex = style.flex;
  if (style.lineHeight != null) props.lineHeight = style.lineHeight;
  if (style.letterSpacing != null) props.letterSpacing = style.letterSpacing;

  // layout 方向
  if (nodeType === 'row') props.layout = 'row';
  else if (nodeType === 'column') props.layout = 'column';
  else if (nodeType === 'container') props.layout = props.layout || 'column';

  // align / justify
  if (style.align) props.align = style.align;
  if (style.justify) props.justify = style.justify;

  return props;
}

function universalNodeToFlutterDSL(node: UniversalNode): any {
  const nodeAny = node as any;
  const props: Record<string, any> = styleToProps(nodeAny.style, nodeAny.type);

  // 把 node 级别的字段移到 props
  if (nodeAny.content != null) props.content = nodeAny.content;
  if (nodeAny.label != null) props.label = nodeAny.label;
  if (nodeAny.variant != null) props.variant = nodeAny.variant;
  if (nodeAny.placeholder != null) props.placeholder = nodeAny.placeholder;
  if (nodeAny.value != null) props.value = nodeAny.value;
  if (nodeAny.kind != null) props.kind = nodeAny.kind;
  if (nodeAny.src != null) props.src = nodeAny.src;
  if (nodeAny.alt != null) props.alt = nodeAny.alt;

  const result: any = { type: nodeAny.type, props };

  // 递归处理 children
  if (nodeAny.children && Array.isArray(nodeAny.children) && nodeAny.children.length > 0) {
    result.children = nodeAny.children.map((child: UniversalNode) => universalNodeToFlutterDSL(child));
  }

  return result;
}

// ── 代码块解析 ──
interface CodeBlockInfo {
  lang: string;
  translatorLang: string | null;
  code: string;
  complete: boolean;
  openFenceStart: number;
  openFenceEnd: number;
  closeFenceEnd: number;
}

function parseCodeBlocks(text: string): CodeBlockInfo[] {
  const blocks: CodeBlockInfo[] = [];
  const openRe = /```(\w*)\s*\n/g;
  let searchFrom = 0;

  while (searchFrom < text.length) {
    openRe.lastIndex = searchFrom;
    const openMatch = openRe.exec(text);
    if (!openMatch) break;

    const openFenceStart = openMatch.index;
    const openFenceEnd = openMatch.index + openMatch[0].length;
    const lang = (openMatch[1] || '').toLowerCase();
    const translatorLang = BLOCK_LANG_TO_TRANSLATOR[lang] || null;

    const closeIdx = text.indexOf('\n```', openFenceEnd);
    if (closeIdx === -1) {
      blocks.push({
        lang, translatorLang,
        code: text.slice(openFenceEnd),
        complete: false,
        openFenceStart, openFenceEnd,
        closeFenceEnd: -1,
      });
      break;
    }

    const closeFenceEnd = closeIdx + 4;
    blocks.push({
      lang, translatorLang,
      code: text.slice(openFenceEnd, closeIdx),
      complete: true,
      openFenceStart, openFenceEnd,
      closeFenceEnd,
    });
    searchFrom = closeFenceEnd;
  }

  return blocks;
}

function buildDisplayText(text: string, blocks: CodeBlockInfo[]): string {
  if (blocks.length === 0) return text;

  let result = '';
  let lastEnd = 0;

  for (const block of blocks) {
    result += text.slice(lastEnd, block.openFenceStart);
    const langLabel = block.lang || 'code';
    if (block.complete) {
      result += `已渲染到画布 (${langLabel})`;
      lastEnd = block.closeFenceEnd;
    } else {
      result += `正在渲染到画布...`;
      lastEnd = text.length;
    }
  }

  result += text.slice(lastEnd);
  return result;
}

// ── 逐行代码追踪器 ──
class LineTracker {
  private code: string = '';
  private lastTranslatedLen: number = 0;
  private translateLang: string;
  private chatSessionId: string;
  private lastPushTime: number = 0;
  private throttleMs: number = 50;
  private translating: boolean = false;
  private _pushed: boolean = false;

  constructor(lang: string, chatSessionId: string) {
    this.translateLang = lang;
    this.chatSessionId = chatSessionId;
  }

  /**
   * 喂入代码增量
   * 2026-07-11 v3: 用代码长度变化代替行数, 有新代码就尝试翻译
   */
  feedCode(delta: string): boolean {
    this.code += delta;

    // 代码长度没变 → 不翻译
    if (this.code.length <= this.lastTranslatedLen) return false;

    // 节流: 50ms 内只翻译一次
    const now = Date.now();
    if (now - this.lastPushTime < this.throttleMs) return false;

    // 至少有 10 个字符才翻译 (避免太短的碎片)
    if (this.code.length < 10) return false;

    return true;
  }

  /**
   * 执行异步翻译 + 推画布
   */
  async translateAndPush(isFinal: boolean): Promise<void> {
    if (this.translating && !isFinal) return;
    if (!this.code.trim()) return;

    this.translating = true;
    this.lastPushTime = Date.now();

    // 增量翻译用全部已收到的代码 (不再截断最后一行)
    const codeToTranslate = this.code;
    if (!isFinal) {
      this.lastTranslatedLen = this.code.length;
    }

    try {
      // ★ 2026-07-11: json DSL 直接解析推送, 不走翻译器
      if (this.translateLang === '__json_dsl__') {
        const parsed = JSON.parse(codeToTranslate);
        if (parsed && parsed.type) {
          this._pushed = true;
          this.pushRawDsl(parsed, codeToTranslate, isFinal);
        }
        return;
      }

      const result = await translateCodeAsync(codeToTranslate, this.translateLang);

      if (result.node) {
        this._pushed = true;
        this.pushToCanvas(result.node, codeToTranslate, isFinal);
      }
    } catch {
      // 翻译失败 (代码不完整 / JSON 解析失败) — 静默跳过
    } finally {
      this.translating = false;
    }
  }

  /**
   * ★ 2026-07-11: 直接推送 raw DSL (json 代码块场景)
   * LLM 返回的 JSON 已经是 Flutter DSL 格式 {type, props, children}
   * 不需要 universalNodeToFlutterDSL 转换
   */
  private pushRawDsl(dsl: any, code: string, isFinal: boolean): void {
    const canvasSessionId = getCanvasSessionId(this.chatSessionId);
    const flutterDsl = { ui: dsl, platform: 'material' };

    if (typeof window !== 'undefined' && window.soloforge?.canvas) {
      ensureCanvasAndPush(canvasSessionId, flutterDsl, this.chatSessionId).then((r) => {
        if (!r.ok) {
          console.warn('[LineTracker] ensureCanvasAndPush (raw) failed:', r.error, 'sessionId:', canvasSessionId);
          usePreviewStreamStore.getState().recordPushError(this.chatSessionId,
            `canvas.push: ${r.error || 'failed'}`);
        }
      }).catch((err: any) => {
        console.warn('[LineTracker] ensureCanvasAndPush (raw) exception:', err?.message || err, 'sessionId:', canvasSessionId);
        usePreviewStreamStore.getState().recordPushError(this.chatSessionId,
          `canvas.push: ${err?.message || 'exception'}`);
      });
    }

    const previewStore = usePreviewStreamStore.getState();
    previewStore.initEntry(this.chatSessionId, {
      language: 'json',
      sessionId: canvasSessionId,
    });
    previewStore.updateStream(this.chatSessionId, {
      raw: code,
      payload: {
        language: 'json',
        framework: 'json',
        source_code: code,
        preview: { root: dsl },
      } as any,
      errors: [],
      done: isFinal,
    });
    if (isFinal) {
      previewStore.confirmPayload(this.chatSessionId, {
        language: 'json',
        framework: 'json',
        source_code: code,
        preview: { root: dsl },
      } as any);
    }

    console.log(`[LineTracker] ${isFinal ? '最终' : '增量'}JSON DSL推送`, {
      type: dsl.type,
      codeLen: code.length,
      sessionId: canvasSessionId,
    });
  }

  /**
   * 推送到画布 + previewStreamStore
   */
  private pushToCanvas(ast: UniversalNode, code: string, isFinal: boolean): void {
    const canvasSessionId = getCanvasSessionId(this.chatSessionId);

    // ★ 格式转换: UniversalNode → Flutter DSL {type, props, children}
    const flutterRoot = universalNodeToFlutterDSL(ast);
    const dsl = { ui: flutterRoot, platform: 'material' };

    // ★ Electron IPC 推画布 — 使用 ensureCanvasAndPush 自动启动+重试
    if (typeof window !== 'undefined' && window.soloforge?.canvas) {
      ensureCanvasAndPush(canvasSessionId, dsl, this.chatSessionId).then((r) => {
        if (!r.ok) {
          console.warn('[LineTracker] ensureCanvasAndPush failed:', r.error, 'sessionId:', canvasSessionId);
          usePreviewStreamStore.getState().recordPushError(this.chatSessionId,
            `canvas.push: ${r.error || 'failed'}`);
        }
      }).catch((err: any) => {
        console.warn('[LineTracker] ensureCanvasAndPush exception:', err?.message || err, 'sessionId:', canvasSessionId);
        usePreviewStreamStore.getState().recordPushError(this.chatSessionId,
          `canvas.push: ${err?.message || 'exception'}`);
      });
    }

    // 同步 previewStreamStore
    const previewStore = usePreviewStreamStore.getState();
    previewStore.initEntry(this.chatSessionId, {
      language: this.translateLang,
      sessionId: canvasSessionId,
    });
    previewStore.updateStream(this.chatSessionId, {
      raw: code,
      payload: {
        language: this.translateLang,
        framework: this.translateLang,
        source_code: code,
        preview: { root: ast },
      } as any,
      errors: [],
      done: isFinal,
    });
    if (isFinal) {
      previewStore.confirmPayload(this.chatSessionId, {
        language: this.translateLang,
        framework: this.translateLang,
        source_code: code,
        preview: { root: ast },
      } as any);
    }

    console.log(`[LineTracker] ${isFinal ? '最终' : '增量'}翻译推送`, {
      lang: this.translateLang,
      codeLen: code.length,
      sessionId: canvasSessionId,
    });
  }

  get pushed(): boolean { return this._pushed; }
  get fullCode(): string { return this.code; }
}

// ── 增量画布推送器 ──

export class IncrementalCanvasPusher {
  private chatSessionId: string;
  private rawText: string = '';
  private _handled: boolean = false;
  private pushedBlockStarts: Set<number> = new Set();
  private trackers: Map<number, LineTracker> = new Map();
  private flushing: boolean = false;

  constructor(chatSessionId: string) {
    this.chatSessionId = chatSessionId;
  }

  feedChunk(text: string): { displayText: string; inCodeBlock: boolean } {
    this.rawText += text;
    this.tryIncrementalTranslate();
    const blocks = parseCodeBlocks(this.rawText);
    return {
      displayText: buildDisplayText(this.rawText, blocks),
      inCodeBlock: blocks.some(b => !b.complete),
    };
  }

  async flush(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;

    const blocks = parseCodeBlocks(this.rawText);

    const finalTasks: Array<{ tracker: LineTracker; block: CodeBlockInfo }> = [];
    for (const block of blocks) {
      if (!block.translatorLang) continue;
      // ★ json DSL 不需要 isLanguageSupported 检查
      if (block.translatorLang !== '__json_dsl__' && !isLanguageSupported(block.translatorLang)) continue;
      if (!block.code.trim()) continue;

      const tracker = this.trackers.get(block.openFenceStart);
      if (tracker) {
        finalTasks.push({ tracker, block });
      } else {
        const newTracker = new LineTracker(block.translatorLang, this.chatSessionId);
        newTracker['code'] = block.code;
        this.trackers.set(block.openFenceStart, newTracker);
        finalTasks.push({ tracker: newTracker, block });
      }
    }

    if (finalTasks.length > 0) {
      console.log(`[IncrementalCanvasPusher] 最终一致性检查: ${finalTasks.length} 个代码块`);
      const promises = finalTasks.map(({ tracker }) => tracker.translateAndPush(true));
      await Promise.all(promises);

      for (const { block } of finalTasks) {
        this.pushedBlockStarts.add(block.openFenceStart);
      }
      this._handled = finalTasks.some(t => t.tracker.pushed);
    }

    this.flushing = false;
  }

  wasHandled(): boolean {
    return this._handled;
  }

  getDisplayText(): string {
    const blocks = parseCodeBlocks(this.rawText);
    return buildDisplayText(this.rawText, blocks);
  }

  private tryIncrementalTranslate(): void {
    const blocks = parseCodeBlocks(this.rawText);
    if (blocks.length === 0) return;

    for (const block of blocks) {
      if (!block.translatorLang) continue;
      // ★ json DSL 不需要 isLanguageSupported 检查
      if (block.translatorLang !== '__json_dsl__' && !isLanguageSupported(block.translatorLang)) continue;
      if (block.complete && this.pushedBlockStarts.has(block.openFenceStart)) continue;

      let tracker = this.trackers.get(block.openFenceStart);
      if (!tracker) {
        tracker = new LineTracker(block.translatorLang, this.chatSessionId);
        this.trackers.set(block.openFenceStart, tracker);
      }

      const prevCodeLen = tracker.fullCode.length;
      const newDelta = block.code.slice(prevCodeLen);
      if (newDelta) {
        const shouldTranslate = tracker.feedCode(newDelta);
        if (shouldTranslate) {
          tracker.translateAndPush(false).catch(() => {});
          this._handled = true;
        }
      }

      if (block.complete) {
        this.pushedBlockStarts.add(block.openFenceStart);
      }
    }
  }
}
