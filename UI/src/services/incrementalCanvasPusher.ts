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
import { getCanvasSize, useCanvasDeviceStore } from '../state/canvasDeviceStore';

// ── chatId → canvasSessionId 映射 ──
const canvasSessionIdMap = new Map<string, string>();

export function setCanvasSessionId(chatId: string, canvasSessionId: string): void {
  canvasSessionIdMap.set(chatId, canvasSessionId);
}

/**
 * 静默检查: 已注册的真实 sessionId (不含 fallback)
 * 用于预注册逻辑, 避免 getCanvasSessionId 的 fallback 警告
 */
export function peekCanvasSessionId(chatId: string): string | undefined {
  return canvasSessionIdMap.get(chatId);
}

// ★ FIX 2026-07-12: 添加 fallback 警告日志, 方便排查 Session ID 不匹配问题
export function getCanvasSessionId(chatId: string): string {
  const id = canvasSessionIdMap.get(chatId);
  if (!id) {
    // ★ 2026-07-13: 降级为 console.debug, 避免正常预注册流程中触发噪音
    console.debug(
      `[IncrementalCanvasPusher] getCanvasSessionId("${chatId}") 返回回退值 canvas-${chatId}`
    );
    return `canvas-${chatId}`;
  }
  return id;
}

export function clearCanvasSessionId(chatId: string): void {
  canvasSessionIdMap.delete(chatId);
}

/**
 * ★ 2026-07-14: 懒创建画布 — 只在真正需要推 UI 时才创建
 *
 * 检查 chatId 是否已有关联的真实画布 ID (非 fallback)。
 * 如果没有, 调用 POST /api/canvas/sessions 创建一个, 并更新映射。
 * 创建成功后派发 'soloforge-canvas-created' 事件, 让 useChatClickCanvasBridge 刷新。
 *
 * 用于: handleSend / resumeChat / handleAcceptEnable — 发送消息时确保画布存在
 * 不用于: 选中对话时 (选中不应自动建画布)
 */
export async function ensureCanvasForChat(chatId: string): Promise<string | null> {
  if (!chatId) return null;

  // 已有真实画布 ID (非 fallback), 直接返回
  const existing = canvasSessionIdMap.get(chatId);
  if (existing && !existing.startsWith('canvas-')) {
    return existing;
  }

  // 调用后端创建画布
  try {
    const resp = await fetch('/api/canvas/sessions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Requester-Chat-Session-Id': chatId,
      },
      body: JSON.stringify({ description: '默认画布' }),
    });
    if (!resp.ok) {
      console.warn(`[ensureCanvasForChat] POST /api/canvas/sessions → ${resp.status}`);
      // 降级: 注册 fallback ID, 让 ensureCanvasAndPush 尝试自动启动
      const fallback = `canvas-${chatId}`;
      canvasSessionIdMap.set(chatId, fallback);
      return fallback;
    }
    const data = await resp.json();
    if (data.success && data.payload && data.payload.sessionId) {
      const realId = data.payload.sessionId as string;
      canvasSessionIdMap.set(chatId, realId);
      console.log(`[ensureCanvasForChat] ✅ created canvas ${realId} for chat ${chatId}`);

      // ★ FIX 2026-07-14: 把 fallback key 的帧尺寸复制到真实 key
      //   PreviewPanel 在 bridge 未就绪时用 fallback key 写入 frameSizes,
      //   现在映射已更新为真实 ID, 需要确保 frameSizes 也有真实 key 的数据,
      //   否则 aiBackend/incrementalCanvasPusher 用真实 ID 查不到尺寸。
      const fallbackKey = `canvas-${chatId}`;
      const devState = useCanvasDeviceStore.getState();
      const fallbackFrame = devState.getFrameSize(fallbackKey);
      if (fallbackFrame && fallbackFrame.width > 0) {
        devState.setFrameSize(realId, fallbackFrame);
        console.log(`[ensureCanvasForChat] 📐 copied frame size ${fallbackFrame.width}×${fallbackFrame.height} from ${fallbackKey} → ${realId}`);
      }

      // 通知 bridge 刷新, 让 PreviewPanel 拿到真实画布 ID
      window.dispatchEvent(new CustomEvent('soloforge-canvas-created'));
      return realId;
    }
    // 创建失败 (可能达上限), 降级到 fallback
    console.warn('[ensureCanvasForChat] canvas creation returned no sessionId, using fallback');
    const fallback = `canvas-${chatId}`;
    canvasSessionIdMap.set(chatId, fallback);
    return fallback;
  } catch (e) {
    console.warn('[ensureCanvasForChat] failed:', (e as Error).message);
    const fallback = `canvas-${chatId}`;
    canvasSessionIdMap.set(chatId, fallback);
    return fallback;
  }
}

// ── 画布 session 自动启动 + push 重试 ──
// 当 canvas.push 返回 "session not found" 时, 自动 start session 并重试一次
const _startedSessions = new Set<string>();

/**
 * ★ 2026-07-14: 按 canvasSessionId 清理所有相关状态
 * 用于画布删除场景 — 彻底清除该画布的所有前端缓存
 *   1. canvasSessionIdMap 中所有映射到该 canvasSessionId 的 chatId
 *   2. _startedSessions 中的启动记录 (允许后续同 ID 画布重新启动)
 */
export function clearByCanvasSessionId(canvasSessionId: string): void {
  // 反向查找所有映射到该 canvasSessionId 的 chatId 并清除
  for (const [chatId, cid] of canvasSessionIdMap.entries()) {
    if (cid === canvasSessionId) {
      canvasSessionIdMap.delete(chatId);
    }
  }
  // 清理已启动记录, 允许同 ID 画布 (如 canvas_3 被删除后新建) 重新启动
  _startedSessions.delete(canvasSessionId);
}

// ── 画布 session 自动启动 + push 重试 (辅助) ──

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
          // ★ FIX 2026-07-14: 使用 store 中的实际画布尺寸, 不再硬编码 width=0
          const size = getCanvasSize(sessionId);
          const startR = await canvas.start(sessionId, size.width, size.height);
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

/**
 * ★ 2026-07-14: 导出 normalizeDsl — 将 LLM 的 JSON DSL 格式归一化为 Flutter UiParser 期望格式
 *
 * LLM 被指示输出 (简洁格式):
 *   { "type": "column", "children": [{ "type": "text", "text": "Hello", "style": { "fontSize": 24 } }] }
 *
 * Flutter UiParser.parse 期望 (props 格式):
 *   { "type": "container", "props": { "layout": "column" }, "children": [{ "type": "text", "props": { "content": "Hello", "fontSize": 24 } }] }
 *
 * 归一化规则:
 *   1. column/row → container + props.layout
 *   2. style.* → props.* (带字段名映射)
 *   3. text → props.content
 *   4. container 的 color → props.backgroundColor
 *   5. 递归处理 children
 */
const STYLE_KEY_MAP: Record<string, string> = {
  background: 'backgroundColor',
  bgColor: 'backgroundColor',
  gap: 'spacing',
  radius: 'borderRadius',
  shadow: 'boxShadow',
};

/**
 * ★ 2026-07-14: 深度搜索 JSON 中的 DSL 节点
 * 递归查找第一个包含 type 字段的对象, 作为 DSL root
 * 用于处理 LLM 返回的各种未知 JSON 包装格式
 */
function deepFindDsl(obj: any, depth: number = 0): any | null {
  if (!obj || typeof obj !== 'object' || depth > 5) return null;

  // 直接有 type 字段 → 就是 DSL
  if (typeof obj.type === 'string' && obj.type.length > 0) {
    return obj;
  }

  // 常见包装 key
  const wrapperKeys = ['ui', 'dsl', 'widget', 'root', 'page', 'view', 'component', 'element', 'node', 'tree', 'body', 'content', 'child', 'data'];
  for (const key of wrapperKeys) {
    if (obj[key] && typeof obj[key] === 'object') {
    	const found = deepFindDsl(obj[key], depth + 1);
    	if (found) return found;
    }
  }

  // 遍历所有值
  for (const val of Object.values(obj)) {
    if (val && typeof val === 'object' && !Array.isArray(val)) {
    	const found = deepFindDsl(val, depth + 1);
    	if (found) return found;
    }
  }
  // 遍历数组
  for (const val of Object.values(obj)) {
    if (Array.isArray(val)) {
    	for (const item of val) {
        const found = deepFindDsl(item, depth + 1);
        if (found) return found;
      }
    }
  }

  return null;
}

export function normalizeDsl(node: any): any {
  if (!node || typeof node !== 'object') return node;

  const rawType = (node.type as string) || 'container';
  const props: Record<string, any> = { ...(node.props || {}) };

  // 1. column/row → container + layout
  let normalizedType = rawType;
  if (rawType === 'column' || rawType === 'row') {
    normalizedType = 'container';
    if (!props.layout) props.layout = rawType;
  }

  // 2. style.* → props.*
  if (node.style && typeof node.style === 'object') {
    for (const [key, val] of Object.entries(node.style)) {
      const propKey = STYLE_KEY_MAP[key] || key;
      if (props[propKey] === undefined) props[propKey] = val;
    }
  }

  // 3. 内容字段 → props
  if (node.text !== undefined && props.content === undefined) props.content = node.text;
  if (node.content !== undefined && props.content === undefined) props.content = node.content;
  if (node.label !== undefined && props.label === undefined) props.label = node.label;
  if (node.src !== undefined && props.src === undefined) props.src = node.src;
  if (node.url !== undefined && props.url === undefined) props.url = node.url;
  if (node.placeholder !== undefined && props.placeholder === undefined) props.placeholder = node.placeholder;
  if (node.value !== undefined && props.value === undefined) props.value = node.value;
  if (node.variant !== undefined && props.variant === undefined) props.variant = node.variant;
  if (node.icon !== undefined && props.icon === undefined) props.icon = node.icon;

  // 4. container 的 color → backgroundColor
  if (normalizedType === 'container' && props.color && !props.backgroundColor) {
    props.backgroundColor = props.color;
    delete props.color;
  }

  // 5. 递归 children
  let children = node.children;
  if (Array.isArray(children)) {
    children = children.map(normalizeDsl);
  }

  return { type: normalizedType, props, children: children || [] };
}

/**
 * ★ 2026-07-14: 导出供 useChatStore.tryLocalTranslateAndPush 使用
 * 将 UniversalNode 转换为 Flutter DSL 格式 {type, props, children}
 */
export function universalNodeToFlutterDSL(node: UniversalNode): any {
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
export interface CodeBlockInfo {
  lang: string;
  translatorLang: string | null;
  code: string;
  complete: boolean;
  openFenceStart: number;
  openFenceEnd: number;
  closeFenceEnd: number;
}

export function parseCodeBlocks(text: string): CodeBlockInfo[] {
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
  // ★ FIX: 多个已完成代码块只显示一次「已渲染到画布」, 不重复
  let renderedLabelShown = false;

  for (const block of blocks) {
    result += text.slice(lastEnd, block.openFenceStart);
    const langLabel = block.lang || 'code';
    if (block.complete) {
      if (!renderedLabelShown) {
        result += `已渲染到画布 (${langLabel})`;
        renderedLabelShown = true;
      }
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
  // ★ 2026-07-14: 跟踪当前正在进行的翻译 Promise, 防止增量与最终翻译竞态
  private currentPromise: Promise<void> | null = null;

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
   * ★ 2026-07-14: 等待当前正在进行的翻译完成
   * 用于 flush() 时确保增量翻译不会覆盖最终翻译结果
   */
  async waitForCurrentTranslation(): Promise<void> {
    if (this.currentPromise) {
      await this.currentPromise;
    }
  }

  /**
   * 执行异步翻译 + 推画布
   */
  async translateAndPush(isFinal: boolean): Promise<void> {
    // ★ 2026-07-14: 如果有正在进行的翻译, 等待它完成再启动新的
    //   防止增量翻译 (done=false) 覆盖最终翻译 (done=true) 的结果
    if (this.currentPromise) {
      await this.currentPromise;
    }
    if (this.translating && !isFinal) return;
    if (!this.code.trim()) return;

    this.translating = true;
    this.lastPushTime = Date.now();

    // 增量翻译用全部已收到的代码 (不再截断最后一行)
    const codeToTranslate = this.code;
    if (!isFinal) {
      this.lastTranslatedLen = this.code.length;
    }

    // ★ 2026-07-14: 用 currentPromise 包裹整个翻译过程
    //   flush() 会先 waitForCurrentTranslation() 再调 translateAndPush(true)
    //   确保增量翻译不会在最终翻译之后完成并覆盖 done=true
    const doTranslate = async () => {
    try {
      // ★ 2026-07-11: json DSL 直接解析推送, 不走翻译器
      // ★ FIX 2026-07-12: 同时处理两种 JSON 格式:
      //   1. 直接 DSL: {"type":"svg","props":{...}}
      //   2. 工具调用: {"tool":"canvas_push_ui","args":{"dslJson":"{...}"}}
      if (this.translateLang === '__json_dsl__') {
        // ★ 2026-07-14: JSON DSL 不做增量翻译 — 部分 JSON 永远无法 JSON.parse
        //   增量阶段 (isFinal=false) 静默跳过, 等 flush() 时 isFinal=true 再解析
        let parsed: any;
        try {
          parsed = JSON.parse(codeToTranslate);
        } catch (jsonErr) {
          if (isFinal) {
            // 最终翻译也失败 — JSON 语法错误, 打印警告
            console.warn(`[LineTracker] JSON.parse 失败 (final): ${(jsonErr as Error).message}, codeLen=${codeToTranslate.length}`);
            console.warn(`[LineTracker] code preview: ${codeToTranslate.slice(0, 300)}...`);
          }
          // 增量阶段: JSON 不完整是正常的, 静默返回
          return;
        }
        // ★ 2026-07-14: 非 canvas_push_ui 的工具调用 (read_file/list_files/write_file 等)
        //   不是 DSL, 静默跳过, 不打警告
        if (parsed && parsed.tool && parsed.tool !== 'canvas_push_ui' && parsed.args) {
          console.log(`[LineTracker] 跳过非画布工具调用: tool=${parsed.tool}`);
          return;
        }

        console.log('[LineTracker] __json_dsl__ parsed, keys=', Object.keys(parsed || {}), 'isFinal=', isFinal);

        // Case 1: 直接 DSL (有 type 字段)
        if (parsed && parsed.type) {
          this._pushed = true;
          this.pushRawDsl(parsed, codeToTranslate, isFinal);
          return;
        }

        // Case 1b: 已包装的 DSL 格式 {ui: {...}, platform: "material"}
        //   LLM 可能直接返回这种格式, 不需要再包装
        if (parsed && parsed.ui) {
          this._pushed = true;
          this.pushWrappedDsl(parsed, codeToTranslate, isFinal);
          return;
        }

        // Case 2: 工具调用 JSON (有 tool + args 字段)
        // LLM 用 canvas_push_ui 工具时返回的格式, 从 args.dslJson 提取真正的 DSL
        if (parsed && parsed.tool === 'canvas_push_ui' && parsed.args) {
          const dslJsonStr = parsed.args.dslJson || parsed.args.dsl;
          if (dslJsonStr && typeof dslJsonStr === 'string') {
            try {
              const innerDsl = JSON.parse(dslJsonStr);
              if (innerDsl && innerDsl.type) {
                this._pushed = true;
                this.pushRawDsl(innerDsl, dslJsonStr, isFinal);
                return;
              }
              // innerDsl 也可能是已包装格式
              if (innerDsl && innerDsl.ui) {
                this._pushed = true;
                this.pushWrappedDsl(innerDsl, dslJsonStr, isFinal);
                return;
              }
            } catch {
              // dslJson 解析失败, 静默跳过
            }
          }
          // args 本身可能就是 DSL 对象 (非字符串)
          if (parsed.args.type) {
            this._pushed = true;
            this.pushRawDsl(parsed.args, codeToTranslate, isFinal);
            return;
          }
          // args 本身也可能是已包装格式
          if (parsed.args.ui) {
            this._pushed = true;
            this.pushWrappedDsl(parsed.args, codeToTranslate, isFinal);
            return;
          }
        }

        // ★ 2026-07-14: 深度搜索 fallback — 从任意 JSON 中提取 DSL
        const found = deepFindDsl(parsed);
        if (found) {
          console.log('[LineTracker] deepFindDsl found DSL, type=', found.type, 'keys=', Object.keys(found));
          this._pushed = true;
          this.pushRawDsl(found, codeToTranslate, isFinal);
          return;
        }

        // 真的不是已知的 JSON 格式
        console.warn('[LineTracker] JSON DSL 格式未识别, keys=', Object.keys(parsed || {}), 'code=', codeToTranslate.slice(0, 200));
        return;
      }

      const result = await translateCodeAsync(codeToTranslate, this.translateLang);

      if (result.node) {
        this._pushed = true;
        this.pushToCanvas(result.node, codeToTranslate, isFinal);
      } else {
        // ★ 2026-07-14: 翻译返回 null node — 打印详细错误帮助诊断
        console.warn(`[LineTracker] translateCodeAsync 返回 null node: lang=${this.translateLang}, codeLen=${codeToTranslate.length}, error=${result.error || 'unknown'}, isFinal=${isFinal}`);
        // 打印前 200 字符代码片段, 帮助定位翻译器问题
        console.warn(`[LineTracker] code preview: ${codeToTranslate.slice(0, 200)}...`);
      }
    } catch (err: any) {
      // ★ 2026-07-14: 不再静默吞错, 打印详细错误帮助诊断
      console.warn(`[LineTracker] translateAndPush 翻译失败: lang=${this.translateLang}, codeLen=${codeToTranslate.length}, error=${err?.message || err}`);
    } finally {
      this.translating = false;
    }
    }; // end doTranslate

    this.currentPromise = doTranslate();
    try {
      await this.currentPromise;
    } finally {
      this.currentPromise = null;
    }
  }

  /**
   * ★ 2026-07-14: 推送已包装的 DSL 格式 {ui: {...}, platform: "material"}
   * LLM 直接返回了完整的包装格式, 不需要再包一层
   */
  private pushWrappedDsl(wrappedDsl: any, code: string, isFinal: boolean): void {
    const canvasSessionId = getCanvasSessionId(this.chatSessionId);
    // 确保 platform 字段存在
    if (!wrappedDsl.platform) wrappedDsl.platform = 'material';
    // ★ FIX 2026-07-14: 归一化 ui 子树
    if (wrappedDsl.ui) {
      wrappedDsl.ui = normalizeDsl(wrappedDsl.ui);
    }
    const dsl = wrappedDsl;

    if (typeof window !== 'undefined' && window.soloforge?.canvas) {
      ensureCanvasAndPush(canvasSessionId, dsl, this.chatSessionId).then((r) => {
        if (!r.ok) {
          console.warn('[LineTracker] ensureCanvasAndPush (wrapped) failed:', r.error, 'sessionId:', canvasSessionId);
          usePreviewStreamStore.getState().recordPushError(this.chatSessionId,
            `canvas.push: ${r.error || 'failed'}`);
        }
      }).catch((err: any) => {
        console.warn('[LineTracker] ensureCanvasAndPush (wrapped) exception:', err?.message || err, 'sessionId:', canvasSessionId);
        usePreviewStreamStore.getState().recordPushError(this.chatSessionId,
          `canvas.push: ${err?.message || 'exception'}`);
      });
    }

    const previewStore = usePreviewStreamStore.getState();
    if (!previewStore.getEntry(this.chatSessionId)) {
      previewStore.initEntry(this.chatSessionId, { language: 'json', sessionId: canvasSessionId });
    }
    const root = dsl.ui;
    previewStore.updateStream(this.chatSessionId, {
      raw: code,
      payload: { language: 'json', framework: 'json', source_code: code, preview: { root } } as any,
      errors: [], done: isFinal,
    });
    if (isFinal) {
      previewStore.confirmPayload(this.chatSessionId, {
        language: 'json', framework: 'json', source_code: code, preview: { root } } as any,
      );
    }
    console.log(`[LineTracker] pushWrappedDsl done: isFinal=${isFinal}, root.type=${root?.type}`);
  }

  /**
   * ★ 2026-07-11: 直接推送 raw DSL (json 代码块场景)
   * LLM 返回的 JSON 已经是 Flutter DSL 格式 {type, props, children}
   * 不需要 universalNodeToFlutterDSL 转换
   */
  private pushRawDsl(dsl: any, code: string, isFinal: boolean): void {
    const canvasSessionId = getCanvasSessionId(this.chatSessionId);
    // ★ FIX 2026-07-14: 归一化 LLM 的 JSON DSL → Flutter UiParser 期望的 {type, props, children} 格式
    const normalized = normalizeDsl(dsl);
    const flutterDsl = { ui: normalized, platform: 'material' };

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
    // ★ 2026-07-14: 仅在 entry 不存在时 initEntry, 避免重置已有数据
    if (!previewStore.getEntry(this.chatSessionId)) {
      previewStore.initEntry(this.chatSessionId, {
        language: 'json',
        sessionId: canvasSessionId,
      });
    }
    previewStore.updateStream(this.chatSessionId, {
      raw: code,
      payload: {
        language: 'json',
        framework: 'json',
        source_code: code,
        preview: { root: normalized },
      } as any,
      errors: [],
      done: isFinal,
    });
    if (isFinal) {
      previewStore.confirmPayload(this.chatSessionId, {
        language: 'json',
        framework: 'json',
        source_code: code,
        preview: { root: normalized },
      } as any);
    }

    console.log(`[LineTracker] ${isFinal ? '最终' : '增量'}JSON DSL推送`, {
      type: normalized.type,
      layout: normalized.props?.layout,
      childCount: normalized.children?.length,
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

    // 同步 previewStreamStore — ★ 2026-07-14: 仅在 entry 不存在时 initEntry, 避免重置已有数据
    const previewStore = usePreviewStreamStore.getState();
    if (!previewStore.getEntry(this.chatSessionId)) {
      previewStore.initEntry(this.chatSessionId, {
        language: this.translateLang,
        sessionId: canvasSessionId,
      });
    }
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
    console.log(`[IncrementalCanvasPusher] flush: rawText.length=${this.rawText.length}, blocks=${blocks.length}, handled=${this._handled}`);
    // ★ 2026-07-14: 打印 rawText 前 200 字符, 帮助诊断 LLM 返回了什么
    if (this.rawText.length > 0) {
      console.log(`[IncrementalCanvasPusher] flush rawText preview:`, this.rawText.slice(0, 200));
    }
    // ★ 2026-07-14: 打印每个 block 的信息
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      console.log(`[IncrementalCanvasPusher] block[${i}]: lang=${b.lang}, translatorLang=${b.translatorLang}, complete=${b.complete}, codeLen=${b.code.length}, code preview=${b.code.slice(0, 100)}`);
    }

    const finalTasks: Array<{ tracker: LineTracker; block: CodeBlockInfo }> = [];
    for (const block of blocks) {
      if (!block.translatorLang) {
        console.log(`[IncrementalCanvasPusher] flush skip: lang=${block.lang}, translatorLang=null`);
        continue;
      }
      // ★ json DSL 不需要 isLanguageSupported 检查
      if (block.translatorLang !== '__json_dsl__' && !isLanguageSupported(block.translatorLang)) {
        console.log(`[IncrementalCanvasPusher] flush skip: translatorLang=${block.translatorLang} not supported`);
        continue;
      }
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
      // ★ 2026-07-14: 先等待所有增量翻译完成, 防止竞态覆盖
      await Promise.all(finalTasks.map(({ tracker }) => tracker.waitForCurrentTranslation()));
      const promises = finalTasks.map(({ tracker }) => tracker.translateAndPush(true));
      await Promise.all(promises);

      for (const { block } of finalTasks) {
        this.pushedBlockStarts.add(block.openFenceStart);
      }
      // ★ 2026-07-14: 不要覆盖已成功的 _handled — 增量阶段可能已成功推送
      //   flush 遇到非 DSL 工具调用 (read_file 等) 时 pushed=false,
      //   但不应丢失增量阶段已推送的状态
      const anyPushed = finalTasks.some(t => t.tracker.pushed);
      this._handled = this._handled || anyPushed;
      console.log(`[IncrementalCanvasPusher] flush 完成: _handled=${this._handled}`);
    } else {
      console.log(`[IncrementalCanvasPusher] flush: 无可翻译的代码块`);
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
