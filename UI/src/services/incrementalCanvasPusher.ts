/**
 * incrementalCanvasPusher — 逐行实时翻译 + 多线程加速 + 最终一致性检查
 *
 * 核心设计 (2026-07-11 v2):
 *
 *  1. 逐行增量翻译
 *     - LLM 每吐出一行完整代码 → 立即送 Worker 翻译 → 推画布
 *     - 不等代码块闭合, 逐行累积, 实时预览
 *
 *  2. 多线程加速
 *     - 用 translateCodeAsync (内部自动选 Worker / in-thread)
 *     - 多个代码块并行翻译 (translateBatchParallel)
 *     - 主线程不卡顿, 翻译在 Worker 池执行
 *
 *  3. 最终一致性检查
 *     - 增量翻译可能"前面一个意思后面一个意思" (部分代码结构不完整)
 *     - done 事件时用完整代码做最终翻译 → 覆盖增量结果
 *     - 保证最终画布呈现的是完整一致的 UI
 *
 *  4. 聊天区/流送区过滤
 *     - 代码块替换为占位符 "正在渲染到画布..." → "已渲染到画布 (lang)"
 *     - 代码块内的 text delta 不推送给 streamBridge
 */

import { translateCode, isLanguageSupported } from '../translate';
import { translateCodeAsync } from '../translate/translatorWorker';
import { usePreviewStreamStore } from '../state/previewStreamStore';
import type { UniversalNode } from './canvas/UniversalAST';

// ── chatId → canvasSessionId 映射 ──
// PreviewPanel 启动画布时注册, IncrementalCanvasPusher 推送时读取
// 解决 canvas_1 (bridge) vs canvas-1 (fallback) 的 sessionId 不匹配问题
const canvasSessionIdMap = new Map<string, string>();

export function setCanvasSessionId(chatId: string, canvasSessionId: string): void {
  canvasSessionIdMap.set(chatId, canvasSessionId);
}

export function getCanvasSessionId(chatId: string): string {
  return canvasSessionIdMap.get(chatId) || `canvas-${chatId}`;
}

export function clearCanvasSessionId(chatId: string): void {
  canvasSessionIdMap.delete(chatId);
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
};

// ── 代码块解析 (不变) ──
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
    // 代码块之前的文字保留
    result += text.slice(lastEnd, block.openFenceStart);
    // 代码块替换为纯文字占位符 (无 emoji)
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
/**
 * 跟踪单个代码块的增量翻译状态
 *
 * 工作原理:
 *   - 记录上次翻译时的代码行数
 *   - 每次 feedChunk 检查是否新增了完整行 (以 \n 结尾)
 *   - 新行到达 → 异步送 Worker 翻译 → 完成后推画布
 *   - 翻译失败 (代码不完整) 静默跳过
 */
class LineTracker {
  private code: string = '';
  private lastTranslatedLines: number = 0;
  private translateLang: string;
  private chatSessionId: string;
  private lastPushTime: number = 0;
  private throttleMs: number = 50; // 逐行节流: 50ms (原 150ms 太慢, 用户看不到逐笔渲染)
  private translating: boolean = false;
  private _pushed: boolean = false;

  constructor(lang: string, chatSessionId: string) {
    this.translateLang = lang;
    this.chatSessionId = chatSessionId;
  }

  /**
   * 喂入代码增量, 返回是否有新行需要翻译
   */
  feedCode(delta: string): boolean {
    this.code += delta;

    // 统计完整行数 (以 \n 结尾的行)
    const completeLines = this.code.split('\n').length - 1; // 最后一行可能不完整
    if (completeLines <= this.lastTranslatedLines) return false;

    // 节流: 避免每行都翻译 (150ms 内只翻译一次)
    const now = Date.now();
    if (now - this.lastPushTime < this.throttleMs) return false;

    return true;
  }

  /**
   * 执行异步翻译 (送 Worker 池) + 推画布
   */
  async translateAndPush(isFinal: boolean): Promise<void> {
    if (this.translating && !isFinal) return; // 上一次还没翻译完, 跳过 (最终翻译强制执行)
    if (!this.code.trim()) return;

    this.translating = true;
    this.lastPushTime = Date.now();

    // 完整行数 (最终翻译时用全部代码)
    const codeToTranslate = isFinal ? this.code : this.getCompleteLines();

    if (!isFinal) {
      const completeLines = codeToTranslate.split('\n').length - 1;
      this.lastTranslatedLines = completeLines;
    }

    try {
      // ★ 用 Worker 多线程翻译 (translateCodeAsync 内部自动选择 Worker / in-thread)
      const result = await translateCodeAsync(codeToTranslate, this.translateLang);

      if (result.node) {
        this._pushed = true;
        this.pushToCanvas(result.node, codeToTranslate, isFinal);
      }
    } catch {
      // 翻译失败 (代码不完整) — 静默跳过, 等下次重试
    } finally {
      this.translating = false;
    }
  }

  /**
   * 获取当前已完整的代码行
   * 2026-07-11 修复: 如果没有换行符, 返回全部 code (单行代码也要翻译)
   *   之前: lastNewline === -1 → return '' → 第一行永远不被翻译
   *   现在: lastNewline === -1 → return this.code (至少翻译一次)
   */
  private getCompleteLines(): string {
    const lastNewline = this.code.lastIndexOf('\n');
    if (lastNewline === -1) return this.code; // 单行代码也要翻译
    return this.code.slice(0, lastNewline + 1);
  }

  /**
   * 推送到画布 + previewStreamStore
   * 2026-07-11: previewStreamStore 只更新状态 (language/bytes/streaming),
   *   不再触发 PreviewPanel 的 useEffect 二次推送 — 避免双推冲突
   */
  private pushToCanvas(ast: UniversalNode, code: string, isFinal: boolean): void {
    const canvasSessionId = getCanvasSessionId(this.chatSessionId);
    const dsl = { ...ast, platform: 'material' };

    // ★ Electron IPC 推画布 — 这是唯一的推画布通道
    if (typeof window !== 'undefined' && window.soloforge?.canvas?.push) {
      window.soloforge.canvas.push(canvasSessionId, dsl).catch((err: any) => {
        console.warn('[LineTracker] canvas.push failed:', err?.message || err);
      });
    } else {
      console.warn('[LineTracker] window.soloforge.canvas.push 不可用, 跳过画布推送');
    }

    // 同步 previewStreamStore (仅状态, 不触发二次推送)
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

    if (isFinal) {
      console.log('[LineTracker] 最终一致性翻译完成', {
        lang: this.translateLang,
        lines: code.split('\n').length,
        codeLen: code.length,
      });
    } else {
      console.log('[LineTracker] 增量翻译推送', {
        lang: this.translateLang,
        lines: code.split('\n').length,
        codeLen: code.length,
      });
    }
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
  /** 每个代码块的逐行追踪器 (key = openFenceStart) */
  private trackers: Map<number, LineTracker> = new Map();
  /** 是否正在进行最终一致性检查 */
  private flushing: boolean = false;

  constructor(chatSessionId: string) {
    this.chatSessionId = chatSessionId;
  }

  /**
   * 喂入一个流式 delta 文本片段
   * @returns { displayText: 过滤后的显示文本, inCodeBlock: 当前是否在代码块内 }
   */
  feedChunk(text: string): { displayText: string; inCodeBlock: boolean } {
    this.rawText += text;
    this.tryIncrementalTranslate();
    const blocks = parseCodeBlocks(this.rawText);
    return {
      displayText: buildDisplayText(this.rawText, blocks),
      inCodeBlock: blocks.some(b => !b.complete),
    };
  }

  /**
   * 最终刷新: 对所有代码块做完整翻译 (一致性检查)
   *
   * 用完整代码重新翻译一次, 覆盖增量翻译的结果
   * 保证最终画布呈现的是完整一致的 UI
   */
  async flush(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;

    const blocks = parseCodeBlocks(this.rawText);

    // 收集所有需要最终翻译的代码块
    const finalTasks: Array<{ tracker: LineTracker; block: CodeBlockInfo }> = [];
    for (const block of blocks) {
      if (!block.translatorLang || !isLanguageSupported(block.translatorLang)) continue;
      if (!block.code.trim()) continue;

      const tracker = this.trackers.get(block.openFenceStart);
      if (tracker) {
        finalTasks.push({ tracker, block });
      } else {
        // 没有追踪器的代码块 (如刚闭合的) → 新建
        const newTracker = new LineTracker(block.translatorLang, this.chatSessionId);
        // 把完整代码喂进去
        newTracker['code'] = block.code;
        this.trackers.set(block.openFenceStart, newTracker);
        finalTasks.push({ tracker: newTracker, block });
      }
    }

    // ★ 并行最终翻译 (多 Worker 线程)
    // 多个代码块同时翻译, 充分利用多核 CPU
    if (finalTasks.length > 0) {
      console.log(`[IncrementalCanvasPusher] 最终一致性检查: ${finalTasks.length} 个代码块, 并行翻译`);

      const promises = finalTasks.map(({ tracker }) => tracker.translateAndPush(true));
      await Promise.all(promises);

      // 标记所有已处理
      for (const { block } of finalTasks) {
        this.pushedBlockStarts.add(block.openFenceStart);
      }
      this._handled = finalTasks.some(t => t.tracker.pushed);
    }

    this.flushing = false;
  }

  /**
   * 是否已成功翻译并推送过代码块
   */
  wasHandled(): boolean {
    return this._handled;
  }

  /**
   * 获取过滤后的显示文本 (代码块→占位符)
   */
  getDisplayText(): string {
    const blocks = parseCodeBlocks(this.rawText);
    return buildDisplayText(this.rawText, blocks);
  }

  // ── 内部方法 ──

  /**
   * 增量翻译: 检测新行 → 异步送 Worker 翻译 → 推画布
   */
  private tryIncrementalTranslate(): void {
    const blocks = parseCodeBlocks(this.rawText);
    if (blocks.length === 0) return;

    for (const block of blocks) {
      // 只处理有翻译器支持的代码块
      if (!block.translatorLang || !isLanguageSupported(block.translatorLang)) continue;

      // 已闭合且已推送 → 跳过
      if (block.complete && this.pushedBlockStarts.has(block.openFenceStart)) continue;

      // 获取或创建追踪器
      let tracker = this.trackers.get(block.openFenceStart);
      if (!tracker) {
        tracker = new LineTracker(block.translatorLang, this.chatSessionId);
        this.trackers.set(block.openFenceStart, tracker);
      }

      // 计算自上次 feed 以来的代码增量
      // tracker 内部记录了已处理的 code 长度, 我们需要把新增部分喂给它
      const prevCodeLen = tracker.fullCode.length;
      const newDelta = block.code.slice(prevCodeLen);
      if (newDelta) {
        const shouldTranslate = tracker.feedCode(newDelta);
        if (shouldTranslate) {
          // 异步翻译 (不阻塞主线程, 送 Worker 池)
          // 用 .catch 捕获异常, 不影响后续 delta 处理
          tracker.translateAndPush(false).catch(() => {});
          this._handled = true;
        }
      }

      // 代码块刚闭合 → 标记 (最终翻译在 flush 中做)
      if (block.complete) {
        this.pushedBlockStarts.add(block.openFenceStart);
      }
    }
  }
}
