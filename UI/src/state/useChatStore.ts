/**
 * ChatPanel 核心 store
 *
 * 2026-07-03 阶段3.1.E 从 ChatPanel.tsx 抽出。
 * 原 12 个 useState + 9 个 handler 收敛到单一 zustand store,ChatPanel 只订阅渲染。
 *
 * 设计原则:
 *  - store 只持有 state + actions,不持有派生值 (派生值由组件 useMemo 计算)
 *  - props 依赖 (permissionMode/mainModel/secModels/selectedFile/editorContent/modelProviderMap/selectedChatId)
 *    通过 syncRuntimeOptions 同步到 store.options,action 内部用 get().options 读取
 *  - 持久化用模块级 useChatStore.subscribe,不依赖组件 useEffect
 *  - DOM 引用 (scrollRef/inputRef) 保留在组件,因为是 transient imperative state
 */

import { create } from 'zustand';
import { Code, Key, Brain, Database, CreditCard, HelpCircle } from '../utils/icons';
import { AndroidIcon, WindowsIcon, HarmonyOSIcon, DefaultChatIcon } from '../components/HistoryAndEditorPanel';
import { sanitizeConversations } from '../utils/chatMessageSanitizer';
import { startChat, ChatStreamEvent } from '../services/aiBackend';
import { useChatsStore } from './chatsStore';
import { useResourceManagerStore } from './useResourceManagerStore';
import type { ChatMessage, ChatSettingsItem } from '../types/chat';
import type { ToolCall, HashlineReadCall, HashlineEditCall, HashlineBatchCall } from '../types';
import { useStreamingStore } from './streamingStore';
import { mapPhaseToStreamEvents, type PhaseMapperContext } from '../services/phaseMappers';
import type { StreamEventKind, StreamEvent, PermissionMode } from '../types/streaming';
// P3 集成: Actor 系统 + Data Parts 模式
import { createTaskWithActor, dispatchStreamEvent, clearChatAll } from '../services/actorIntegration';
import { uiMessageStore } from '../services/uiMessageStore';
// 2026-07-09: HTML 翻译器 — 本地解析 HTML 代码块为 Universal AST, 直接推画布, 省一次 LLM 调用
import { translateCode, isLanguageSupported, detectLanguage } from '../translate';
// 2026-07-11: 本地翻译成功后同步写入 previewStreamStore, 让 PreviewPanel 也能显示 WebAstPreview
import { usePreviewStreamStore } from './previewStreamStore';
// P2-7: handleSend 拆分出的纯逻辑 (错误分类 / 越界检测 / 预览触发判定)
import { classifyStreamError, mentionsOutsideWorkspace, detectPreviewTrigger } from './useChatStore.helpers';
// 2026-07-11: 实时增量代码翻译 — LLM 每输出一行代码, 立即翻译推送到画布
import { IncrementalCanvasPusher, getCanvasSessionId, ensureCanvasAndPush, ensureCanvasForChat, universalNodeToFlutterDSL, normalizeDsl } from '../services/incrementalCanvasPusher';

// ★ 2026-07-14: 深度搜索 JSON 中的 DSL 节点 (与 incrementalCanvasPusher 中的一致)
function deepFindDslInJson(obj: any, depth: number = 0): any | null {
  if (!obj || typeof obj !== 'object' || depth > 5) return null;
  if (typeof obj.type === 'string' && obj.type.length > 0) return obj;
  const wrapperKeys = ['ui', 'dsl', 'widget', 'root', 'page', 'view', 'component', 'element', 'node', 'tree', 'body', 'content', 'child', 'data'];
  for (const key of wrapperKeys) {
    if (obj[key] && typeof obj[key] === 'object') {
      const found = deepFindDslInJson(obj[key], depth + 1);
      if (found) return found;
    }
  }
  for (const val of Object.values(obj)) {
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      const found = deepFindDslInJson(val, depth + 1);
      if (found) return found;
    }
  }
  for (const val of Object.values(obj)) {
    if (Array.isArray(val)) {
      for (const item of val) {
        const found = deepFindDslInJson(item, depth + 1);
        if (found) return found;
      }
    }
  }
  return null;
}

// ════════════════════════════════════════════════════════════
// [CANVAS PROBE — 临时诊断探针, 验证后删除]
// 在 done 事件时注入一个带标记的 HTML 代码块, 追踪它经过:
//   1. extractCodeBlock (代码块提取)
//   2. translateCode (翻译器)
//   3. previewStreamStore (状态存储)
//   4. WebAstPreview / canvas.push (渲染)
// 每一步打 [CANVAS_PROBE] 日志, 如果画布看不到东西就能定位断点
// ════════════════════════════════════════════════════════════
const CANVAS_PROBE_MARKER = '__CANVAS_PROBE_7F3A__';
const CANVAS_PROBE_HTML = `<div style="padding:24px;background:#6366f1;border-radius:12px">
<h1 style="color:white;font-size:24px">${CANVAS_PROBE_MARKER}</h1>
<p style="color:white;opacity:0.8">如果你在画布上看到这个紫色卡片, 说明管线畅通</p>
</div>`;

async function runCanvasProbe(chatSessionId: string): Promise<void> {
  const tag = '[CANVAS_PROBE]';
  console.log(`${tag} ═══════ 开始管线探针 ═══════`);
  console.log(`${tag} chatSessionId=${chatSessionId}`);

  // ── Stage 1: 代码块提取 ──
  const fakeText = '```html\n' + CANVAS_PROBE_HTML + '\n```';
  const block = extractCodeBlock(fakeText);
  if (!block) {
    console.error(`${tag} ❌ Stage 1 FAIL: extractCodeBlock 未提取到代码块`);
    return;
  }
  console.log(`${tag} ✅ Stage 1 PASS: extractCodeBlock → lang=${block.lang}, codeLen=${block.code.length}`);

  // ── Stage 2: 翻译 ──
  let ast;
  try {
    ast = translateCode(block.code, block.lang);
    if (!ast) {
      console.error(`${tag} ❌ Stage 2 FAIL: translateCode 返回 null`);
      return;
    }
    console.log(`${tag} ✅ Stage 2 PASS: translateCode → type=${(ast as any).type}, children=${(ast as any).children?.length || 0}`);
  } catch (err) {
    console.error(`${tag} ❌ Stage 2 FAIL: translateCode 抛异常:`, err);
    return;
  }

  // ── Stage 3: previewStreamStore 写入 ──
  const canvasSessionId = getCanvasSessionId(chatSessionId);
  const previewStore = usePreviewStreamStore.getState();
  previewStore.initEntry(chatSessionId, { language: 'html', sessionId: canvasSessionId });
  previewStore.updateStream(chatSessionId, {
    raw: block.code,
    payload: { language: 'html', framework: 'html', source_code: block.code, preview: { root: ast } } as any,
    errors: [],
    done: true,
  });
  previewStore.confirmPayload(chatSessionId, { language: 'html', framework: 'html', source_code: block.code, preview: { root: ast } } as any);
  const entry = previewStore.getEntry(chatSessionId);
  if (!entry?.payload) {
    console.error(`${tag} ❌ Stage 3 FAIL: previewStreamStore 写入后 getEntry 返回空 payload`);
    return;
  }
  console.log(`${tag} ✅ Stage 3 PASS: previewStreamStore payload confirmed, ast.type=${(entry.payload.preview?.root as any)?.type}`);

  // ── Stage 4: Electron IPC / fetch relay ──
  const dsl = { ...ast, platform: 'material' };
  if (typeof window !== 'undefined' && (window as any).soloforge?.canvas) {
    try {
      const result = await ensureCanvasAndPush(canvasSessionId, dsl, chatSessionId);
      if (result.ok) {
        console.log(`${tag} ✅ Stage 4 PASS: ensureCanvasAndPush ok, sessionId=${canvasSessionId}`);
      } else {
        console.warn(`${tag} ⚠️ Stage 4 WARN: ensureCanvasAndPush failed:`, result.error, 'sessionId:', canvasSessionId);
      }
    } catch (err) {
      console.warn(`${tag} ⚠️ Stage 4 WARN: ensureCanvasAndPush exception:`, err);
    }
  } else {
    console.log(`${tag} ℹ️ Stage 4 SKIP: 非 Electron 环境, 跳过 IPC (WebAstPreview 降级渲染)`);
    // 尝试 fetch relay
    try {
      const resp = await fetch('/api/canvas/relay/push-ui', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: chatSessionId, dsl: ast, language: 'html' }),
      });
      if (resp.ok) {
        const data = await resp.json();
        console.log(`${tag} ✅ Stage 4 PASS: fetch relay push-ui ok, success=${data.success}`);
      } else {
        console.warn(`${tag} ⚠️ Stage 4 WARN: fetch relay push-ui HTTP ${resp.status}`);
      }
    } catch (err) {
      console.warn(`${tag} ⚠️ Stage 4 WARN: fetch relay push-ui 异常:`, err);
    }
  }

  // ── Stage 5: 验证 PreviewPanel 能读到数据 ──
  const finalEntry = usePreviewStreamStore.getState().getEntry(chatSessionId);
  const finalAst = finalEntry?.payload?.preview?.root || finalEntry?.ast;
  if (finalAst) {
    console.log(`${tag} ✅ Stage 5 PASS: previewStreamStore 最终状态有 AST, type=${(finalAst as any).type}`);
    console.log(`${tag} ═══════ 探针完成: 管线畅通, PreviewPanel 应显示紫色卡片 ═══════`);
  } else {
    console.error(`${tag} ❌ Stage 5 FAIL: previewStreamStore 最终状态无 AST — PreviewPanel 读不到数据`);
  }
}
// ════════════════════════════════════════════════════════════

// ==========================================
// StreamPanel 桥接 — 把 aiBackend 事件喂给 streamingStore
// ==========================================
interface StreamBridge {
  onText: (text: string) => void;
  onPhase: (evt: any) => void;
  onAgent: (agentId: string, name: string, avatar: string | undefined, mainModel?: string, subModels?: string[], role?: string, domain?: string, subModel?: string) => void;
  onDone: (agentId?: string) => void;
  onError: (error: string) => void;
  /** ★ Token 使用统计 (一轮对话结束时由 usage 事件触发) */
  onUsage: (usage: { promptTokens: number; completionTokens: number; totalTokens: number; cachedTokens?: number }) => void;
}

function createStreamBridge(chatId: string, mainModel: string, userInput: string, mode: PermissionMode): StreamBridge {
  createTaskWithActor(chatId, userInput, mode);

  let isFirstText = true;
  let hasPhaseEvents = false;
  let textAccumulated = '';
  let javaAgentId: string | null = null;
  let javaAgentName: string | null = null;
  let javaAgentAvatar: string | undefined = undefined;
  let javaSubModel: string | null = null;

  const ctx: PhaseMapperContext = {
    activeChatId: chatId,
    pushStreamEvent: (kind: StreamEventKind, extra: Partial<StreamEvent> = {}) => {
      const meta = useStreamingStore.getState().getStreamTaskMeta(chatId);
      if (!meta) return;
      dispatchStreamEvent({
        id: `evt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        chatId,
        rootTaskId: meta.rootTaskId,
        kind,
        ts: Date.now(),
        status: 'running',
        content: '',
        ...extra,
      } as StreamEvent);
    },
    getSubTaskId: (cid: string, wIdx: number) => useStreamingStore.getState().getSubTaskId(cid, wIdx),
    bindSubTask: (cid: string, wIdx: number, subId: string) => useStreamingStore.getState().bindSubTask(cid, wIdx, subId),
    newSubTaskId: () => `sub-${crypto.randomUUID()}`,
  };

  let singleModelSubId: string | null = null;
  let hasError = false;

  return {
    onText(text: string) {
      if (!text) return;
      textAccumulated += text;
      if (isFirstText && !hasPhaseEvents) {
        isFirstText = false;
        singleModelSubId = ctx.newSubTaskId();
        const phaseLabel = javaAgentId ? 'AGENT_EXEC' : 'SINGLE_MODEL';
        const phaseDetail = javaAgentName ? `${javaAgentName} 执行` : '单模型直接生成';
        ctx.pushStreamEvent('phase_change', { content: phaseLabel, detail: phaseDetail, status: 'running' });
        const effectiveSubModel = javaSubModel ?? mainModel;
        const taskDesc = userInput.length > 60 ? userInput.slice(0, 60) + '...' : userInput;
        ctx.pushStreamEvent('subtask_created', {
          agentId: javaAgentId ?? 'main-model', avatar: javaAgentAvatar,
          content: effectiveSubModel, detail: taskDesc, status: 'pending', subTaskId: singleModelSubId,
        });
        ctx.pushStreamEvent('subtask_step', { subTaskId: singleModelSubId, content: 'EXECUTE', status: 'running' });
      }
      if (!hasPhaseEvents && singleModelSubId) {
        ctx.pushStreamEvent('text_chunk', { subTaskId: singleModelSubId, content: text, status: 'running' });
      }
    },
    onPhase(evt: any) { hasPhaseEvents = true; mapPhaseToStreamEvents(evt, ctx); },
    onAgent(agentId: string, name: string, avatar: string | undefined, _mainM?: string, _subMs?: string[], _role?: string, _domain?: string, subM?: string) {
      javaAgentId = agentId; javaAgentName = name; javaAgentAvatar = avatar; javaSubModel = subM ?? null;
    },
    onDone(_agentId?: string) {
      // ★ FIX: 如果已经发生了 error, 不要用 DONE 覆盖 ERROR 相位
      if (hasError) return;
      if (!hasPhaseEvents && !isFirstText && singleModelSubId) {
        ctx.pushStreamEvent('subtask_done', { subTaskId: singleModelSubId, content: textAccumulated, progress: 100, status: 'success' });
      }
      if (textAccumulated) ctx.pushStreamEvent('delivery', { content: textAccumulated });
      ctx.pushStreamEvent('phase_change', { content: 'DONE', detail: '生成完成', status: 'success' });
    },
    onError(error: string) { hasError = true; ctx.pushStreamEvent('phase_change', { content: 'ERROR', detail: error, status: 'error' }); },
    onUsage(usage) {
      // ★ 把 token 统计作为 usage part 追加到最后一条 assistant 消息
      const lastMsg = uiMessageStore.getLastAssistantMessage(chatId);
      if (!lastMsg) return;
      // 实际生效模型: 优先用 java 副模型, 否则回退到主模型
      const effectiveModel = javaSubModel ?? mainModel;
      uiMessageStore.appendPart(chatId, lastMsg.id, {
        type: 'usage',
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        totalTokens: usage.totalTokens,
        cachedTokens: usage.cachedTokens,
        model: effectiveModel,
        timestamp: Date.now(),
      });
    },
  };
}

function detectPreviewFromResponse(text: string): string | null {
  if (!text || text.length < 10) return null;

  const codeBlockRe = /```(\w+)/g;
  const langMap: Record<string, string> = {
    html: 'html', htm: 'html', jsx: 'typescript', tsx: 'typescript',
    javascript: 'typescript', js: 'typescript', typescript: 'typescript', ts: 'typescript',
    vue: 'typescript', svelte: 'typescript', dart: 'dart',
    python: 'python', py: 'python', go: 'go', rust: 'rust', rs: 'rust',
    java: 'java', c: 'c', cpp: 'c', 'c++': 'c', kotlin: 'java', swift: 'dart',
    css: 'html', scss: 'html',
  };
  let match: RegExpExecArray | null;
  while ((match = codeBlockRe.exec(text)) !== null) {
    const lang = match[1].toLowerCase();
    if (langMap[lang]) return langMap[lang];
  }

  const uiKeywords = [
    '界面','页面','组件','按钮','表单','布局','导航','菜单',
    '卡片','对话框','弹窗','侧边栏','工具栏','标签页','轮播',
    'dashboard','login','signup','register','form','button',
    'navbar','sidebar','modal','dialog','card','table','chart',
    '仪表盘','登录页','注册页','设置页','列表页','详情页',
  ];
  const lowerText = text.toLowerCase();
  for (const kw of uiKeywords) {
    if (lowerText.includes(kw.toLowerCase())) {
      if (/\bflutter\b|\bwidget\b|MaterialApp|Scaffold|StatelessWidget/i.test(text)) return 'dart';
      if (/\bstreamlit\b|\bdash\b|\bgradio\b|import pandas/i.test(text)) return 'python';
      if (/\bgo\b.*\bhtml\b|html\/template|gin\.Default/i.test(text)) return 'go';
      return 'typescript';
    }
  }
  if (/<(?:div|button|input|form|nav|header|footer|section|article|span|ul|li|table|img)\b/i.test(text)) return 'html';
  if (/(?:StatelessWidget|StatefulWidget|MaterialApp|Scaffold|AppBar|Container\(|Column\(|Row\(|Padding\()/i.test(text)) return 'dart';
  return null;
}

const BLOCK_LANG_TO_TRANSLATOR: Record<string, string> = {
  html: 'html', htm: 'html', jsx: 'react', tsx: 'react',
  javascript: 'react', js: 'react', typescript: 'react', ts: 'react',
  vue: 'vue', dart: 'flutter', swift: 'swiftui', kotlin: 'compose',
  xml: 'android', xaml: 'xaml', qml: 'qml', python: 'python', py: 'python',
  c: 'c', cpp: 'c', 'c++': 'c', h: 'c',
  // ★ 2026-07-14: 补充 json DSL 支持 — 与 incrementalCanvasPusher 保持一致
  json: '__json_dsl__',
};

/**
 * ★ 2026-07-14: 检查 JSON 字符串是否是画布 DSL (而非工具调用)
 * 工具调用格式: {"tool":"read_file","args":{...}}
 * 画布 DSL 格式: {"type":"container",...} 或 {"ui":{...}} 或 {"tool":"canvas_push_ui",...}
 */
function isCanvasDslJson(code: string): boolean {
  try {
    const parsed = JSON.parse(code);
    if (!parsed || typeof parsed !== 'object') return false;
    // 画布 DSL: 有 type 字段
    if (typeof parsed.type === 'string') return true;
    // 画布 DSL: 有 ui 字段
    if (parsed.ui && typeof parsed.ui === 'object') return true;
    // 画布 DSL: canvas_push_ui 工具调用
    if (parsed.tool === 'canvas_push_ui') return true;
    // 非画布: 其他工具调用 (read_file, write_file, etc.)
    if (typeof parsed.tool === 'string' && parsed.tool !== 'canvas_push_ui') return false;
    // 有 children 但无 type — 可能是不完整的画布 DSL
    if (Array.isArray(parsed.children)) return true;
    return false;
  } catch {
    return false;
  }
}

function extractCodeBlock(text: string): { code: string; lang: string } | null {
  if (!text) return null;
  const fencedRe = /```(\w+)\s*\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = fencedRe.exec(text)) !== null) {
    const blockLang = match[1].toLowerCase();
    const code = match[2].trim();
    if (!code) continue;
    const translatorLang = BLOCK_LANG_TO_TRANSLATOR[blockLang];
    // ★ 2026-07-14: __json_dsl__ 需要过滤非画布工具调用 JSON (如 read_file)
    if (translatorLang === '__json_dsl__') {
      if (!isCanvasDslJson(code)) {
        console.log('[extractCodeBlock] 跳过非画布 JSON 代码块, 前50字:', code.slice(0, 50));
        continue;
      }
      return { code, lang: '__json_dsl__' };
    }
    if (translatorLang && isLanguageSupported(translatorLang)) return { code, lang: translatorLang };
    const detected = detectLanguage(code);
    if (detected) return { code, lang: detected.language };
  }
  const trimmed = text.trim();
  if (/^<(?:!doctype\s+html|html|div|section|article|body|p|span|button|input|form|ul|ol|li|h[1-6]|nav|header|footer|main)\b/i.test(trimmed)) return { code: trimmed, lang: 'html' };
  return null;
}

async function tryLocalTranslateAndPush(text: string, chatSessionId: string): Promise<boolean> {
  console.log('[tryLocalTranslateAndPush] 开始检查, text长度=', text.length, 'chatId=', chatSessionId);
  const block = extractCodeBlock(text);
  if (!block) { console.log('[tryLocalTranslateAndPush] 未检测到 UI 代码块, 跳过'); return false; }
  const { code, lang } = block;
  console.log('[tryLocalTranslateAndPush] 检测到代码块, lang=', lang, 'code长度=', code.length);

  // ★ 2026-07-14: JSON DSL 直接解析推送, 不走翻译器
  if (lang === '__json_dsl__') {
    try {
      const dsl = JSON.parse(code);
      // ★ 2026-07-14: 安全检查 — 非 canvas_push_ui 的工具调用不是 DSL, 跳过
      if (dsl && dsl.tool && dsl.tool !== 'canvas_push_ui' && dsl.args) {
        console.log('[tryLocalTranslateAndPush] 跳过非画布工具调用:', dsl.tool);
        return false;
      }
      console.log('[tryLocalTranslateAndPush] JSON parsed, keys=', Object.keys(dsl || {}));

      // Case 1: 直接 DSL 格式 {type, props, children}
      if (dsl && dsl.type) {
        const canvasSessionId = getCanvasSessionId(chatSessionId);
        // ★ FIX 2026-07-14: 归一化 LLM JSON DSL → Flutter UiParser 期望格式
        const normalized = normalizeDsl(dsl);
        const flutterDsl = { ui: normalized, platform: 'material' };

        if (typeof window !== 'undefined' && window.soloforge?.canvas) {
          const result = await ensureCanvasAndPush(canvasSessionId, flutterDsl, chatSessionId);
          if (!result.ok) console.warn('[tryLocalTranslateAndPush] JSON DSL IPC push failed:', result.error);
        }

        const previewStore = usePreviewStreamStore.getState();
        if (!previewStore.getEntry(chatSessionId)) {
          previewStore.initEntry(chatSessionId, { language: 'json', sessionId: canvasSessionId });
        }
        previewStore.updateStream(chatSessionId, {
          raw: code,
          payload: { language: 'json', framework: 'json', source_code: code, preview: { root: normalized } } as any,
          errors: [], done: true,
        });
        const payloadArg = { language: 'json', framework: 'json', source_code: code, preview: { root: normalized } } as any;
        previewStore.confirmPayload(chatSessionId, payloadArg);
        console.log('[tryLocalTranslateAndPush] ✓ JSON DSL (type) 推送成功, normalized.type=', normalized.type, 'layout=', normalized.props?.layout);
        return true;
      }

      // Case 1b: 已包装的 DSL 格式 {ui: {...}, platform: "material"}
      if (dsl && dsl.ui) {
        const canvasSessionId = getCanvasSessionId(chatSessionId);
        if (!dsl.platform) dsl.platform = 'material';
        // ★ FIX 2026-07-14: 归一化 ui 子树
        dsl.ui = normalizeDsl(dsl.ui);

        if (typeof window !== 'undefined' && window.soloforge?.canvas) {
          const result = await ensureCanvasAndPush(canvasSessionId, dsl, chatSessionId);
          if (!result.ok) console.warn('[tryLocalTranslateAndPush] JSON DSL (wrapped) IPC push failed:', result.error);
        }

        const previewStore = usePreviewStreamStore.getState();
        if (!previewStore.getEntry(chatSessionId)) {
          previewStore.initEntry(chatSessionId, { language: 'json', sessionId: canvasSessionId });
        }
        const root = dsl.ui;
        previewStore.updateStream(chatSessionId, {
          raw: code,
          payload: { language: 'json', framework: 'json', source_code: code, preview: { root } } as any,
          errors: [], done: true,
        });
        const wrappedPayload = { language: 'json', framework: 'json', source_code: code, preview: { root } } as any;
        previewStore.confirmPayload(chatSessionId, wrappedPayload);
        console.log('[tryLocalTranslateAndPush] ✓ JSON DSL (wrapped ui) 推送成功, normalized.type=', root?.type);
        return true;
      }

      // Case 2: 工具调用 JSON {tool: "canvas_push_ui", args: {...}}
      if (dsl && dsl.tool === 'canvas_push_ui' && dsl.args) {
        const dslJsonStr = dsl.args.dslJson || dsl.args.dsl;
        let innerDsl: any = null;
        if (dslJsonStr && typeof dslJsonStr === 'string') {
          try { innerDsl = JSON.parse(dslJsonStr); } catch { /* ignore */ }
        }
        if (!innerDsl && dsl.args.type) innerDsl = dsl.args;
        if (!innerDsl && dsl.args.ui) innerDsl = dsl.args.ui;

        if (innerDsl) {
          const canvasSessionId = getCanvasSessionId(chatSessionId);
          const flutterDsl = innerDsl.ui ? innerDsl : { ui: innerDsl, platform: 'material' };
          if (!flutterDsl.platform) flutterDsl.platform = 'material';

          if (typeof window !== 'undefined' && window.soloforge?.canvas) {
            const result = await ensureCanvasAndPush(canvasSessionId, flutterDsl, chatSessionId);
            if (!result.ok) console.warn('[tryLocalTranslateAndPush] JSON DSL (tool) IPC push failed:', result.error);
          }

          const previewStore = usePreviewStreamStore.getState();
          if (!previewStore.getEntry(chatSessionId)) {
            previewStore.initEntry(chatSessionId, { language: 'json', sessionId: canvasSessionId });
          }
          const root = flutterDsl.ui;
          previewStore.updateStream(chatSessionId, {
            raw: code,
            payload: { language: 'json', framework: 'json', source_code: code, preview: { root } } as any,
            errors: [], done: true,
          });
          const toolPayload = { language: 'json', framework: 'json', source_code: code, preview: { root } } as any;
          previewStore.confirmPayload(chatSessionId, toolPayload);
          console.log('[tryLocalTranslateAndPush] ✓ JSON DSL (tool call) 推送成功');
          return true;
        }
      }

      console.warn('[tryLocalTranslateAndPush] JSON DSL 格式未识别, keys=', Object.keys(dsl || {}), 'code=', code.slice(0, 200));

      // ★ 2026-07-14: 深度搜索 fallback — 从任意 JSON 中提取 DSL
      const found = deepFindDslInJson(dsl);
      if (found) {
        console.log('[tryLocalTranslateAndPush] deepFindDsl found, type=', found.type);
        const canvasSessionId = getCanvasSessionId(chatSessionId);
        const flutterDsl = { ui: found, platform: 'material' };
        if (typeof window !== 'undefined' && window.soloforge?.canvas) {
          const result = await ensureCanvasAndPush(canvasSessionId, flutterDsl, chatSessionId);
          if (!result.ok) console.warn('[tryLocalTranslateAndPush] deepFindDsl IPC push failed:', result.error);
        }
        const previewStore = usePreviewStreamStore.getState();
        if (!previewStore.getEntry(chatSessionId)) {
          previewStore.initEntry(chatSessionId, { language: 'json', sessionId: canvasSessionId });
        }
        const root = found;
        previewStore.updateStream(chatSessionId, {
          raw: code,
          payload: { language: 'json', framework: 'json', source_code: code, preview: { root } } as any,
          errors: [], done: true,
        });
        previewStore.confirmPayload(chatSessionId, {
          language: 'json', framework: 'json', source_code: code, preview: { root } } as any,
        );
        console.log('[tryLocalTranslateAndPush] ✓ JSON DSL (deepFind) 推送成功');
        return true;
      }

      return false;
    } catch (err) {
      console.warn('[tryLocalTranslateAndPush] JSON DSL 解析失败:', err);
      return false;
    }
  }

  if (!isLanguageSupported(lang)) { console.log('[tryLocalTranslateAndPush] 语言不支持:', lang); return false; }

  try {
    const ast = translateCode(code, lang);
    const canvasSessionId = getCanvasSessionId(chatSessionId);

    // ★ FIX 2026-07-14: 使用正确的 DSL 格式 { ui: flutterDSL, platform: 'material' }
    //   原代码 { ...ast, platform } 是 UniversalNode 格式, Flutter 画布无法渲染
    const flutterRoot = universalNodeToFlutterDSL(ast);
    const dsl = { ui: flutterRoot, platform: 'material' };

    if (typeof window !== 'undefined' && window.soloforge?.canvas) {
      const result = await ensureCanvasAndPush(canvasSessionId, dsl, chatSessionId);
      if (result.ok) {
        console.log('[tryLocalTranslateAndPush] ✓ Electron IPC 推送成功', { canvasSessionId, language: lang });
      } else {
        console.warn('[tryLocalTranslateAndPush] Electron IPC 推送失败:', result.error);
      }
    }

    // ★ FIX 2026-07-14: 始终更新 previewStreamStore, 即使 IPC 失败或非 Electron 环境
    //   原代码只在 IPC 成功时才更新 previewStreamStore, 导致 WebAstPreview 无数据
    const previewStore = usePreviewStreamStore.getState();
    previewStore.initEntry(chatSessionId, { language: lang, sessionId: canvasSessionId });
    previewStore.updateStream(chatSessionId, {
      raw: code,
      payload: { language: lang, framework: lang, source_code: code, preview: { root: ast } } as any,
      errors: [], done: true,
    });
    const translatedPayload = { language: lang, framework: lang, source_code: code, preview: { root: ast } } as any;
    previewStore.confirmPayload(chatSessionId, translatedPayload);
    console.log('[tryLocalTranslateAndPush] ✓ previewStreamStore 已更新', { language: lang, canvasSessionId });

    // fetch relay (非 Electron 环境的画布推送)
    if (typeof window === 'undefined' || !window.soloforge?.canvas) {
      try {
        const resp = await fetch('/api/canvas/relay/push-ui', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId: chatSessionId, dsl: flutterRoot, language: lang }),
        });
        if (!resp.ok) { console.warn('[tryLocalTranslateAndPush] relay push-ui HTTP', resp.status); }
      } catch (relayErr) {
        console.warn('[tryLocalTranslateAndPush] relay push-ui 异常:', relayErr);
      }
    }

    return true;
  } catch (err) {
    console.warn('[tryLocalTranslateAndPush] 翻译或推送失败:', err);
    return false;
  }
}

const defaultChatDetails: Record<string, { title: string; icon: any }> = {};
const defaultConversations: Record<string, ChatMessage[]> = {};
const defaultConfigs: Record<string, ChatSettingsItem> = {};
const fallbackActiveSettings: ChatSettingsItem = { enabledSkills: ['code_review'], contextSize: 32000, personality: 'professional', tone: 'detailed', emojiEnabled: true, emojiType: 'mixed', agentId: 'code_agent' };
export const emptyStreamState: StreamState = { workerOutputs: [], reply: '', scores: [], judgeChosen: [], judgeReasoning: '', auditFindings: [], deliver: '', suggestEnables: [], toolCalls: [] };

export interface StreamState {
  workerOutputs: Array<{ workerIdx: number; modelName: string; content: string; status: 'pending' | 'streaming' | 'done' | 'error' }>;
  reply: string; scores: Array<{ workerIdx: number; score: number; reason: string; modelName?: string }>;
  judgeChosen: number[]; judgeReasoning: string;
  auditFindings: Array<{ severity: string; target: string; suggestion: string }>;
  deliver: string;
  suggestEnables: Array<{ candidateName: string; expectedGain: number; reason: string }>;
  toolCalls: ToolCall[];
}

export interface ChatRuntimeOptions {
  permissionMode?: 'normal' | 'performance' | 'ultimate' | 'expert';
  selectedChatId?: string; mainModel?: string; secModels?: any[];
  selectedFile?: string; editorContent?: string;
  modelProviderMap?: Record<string, { baseUrl: string; apiKey: string; model: string; providerName: string; enabledInSettings: boolean }>;
}

interface ChatStoreState {
  conversations: Record<string, ChatMessage[]>; configs: Record<string, ChatSettingsItem>;
  showSettingsPopup: boolean; chatsList: any[];
  pendingAttachment: { fileName: string; text: string } | null; isPendingAttachmentExpanded: boolean;
  isGenerating: boolean; isPaused: boolean; activeChatHandle: { taskId: string; abort: () => void } | null; lastReqBody: any; hashlineAgentEnabled: boolean;
  streamState: StreamState; inputValue: string; showModeDropdown: boolean;
  workspaceApproval: { chatId: string; message: string } | null;
  options: ChatRuntimeOptions;
  setConversations: (updater: Record<string, ChatMessage[]> | ((prev: Record<string, ChatMessage[]>) => Record<string, ChatMessage[]>)) => void;
  setConfigs: (updater: Record<string, ChatSettingsItem> | ((prev: Record<string, ChatSettingsItem>) => Record<string, ChatSettingsItem>)) => void;
  setShowSettingsPopup: (v: boolean) => void; setChatsList: (v: any[]) => void;
  setPendingAttachment: (v: { fileName: string; text: string } | null) => void;
  setIsPendingAttachmentExpanded: (v: boolean) => void; setIsGenerating: (v: boolean) => void;
  setLastReqBody: (v: any) => void; setHashlineAgentEnabled: (v: boolean) => void;
  setStreamState: (updater: StreamState | ((prev: StreamState) => StreamState)) => void;
  setInputValue: (updater: string | ((prev: string) => string)) => void; setShowModeDropdown: (v: boolean) => void;
  setWorkspaceApproval: (v: { chatId: string; message: string } | null) => void;
  resolveWorkspaceApproval: (chatId: string, decision: 'allow' | 'deny' | 'always') => void;
  syncRuntimeOptions: (opts: Partial<ChatRuntimeOptions>) => void;
  loadChatsList: () => void; loadChatConfigs: () => void; loadConversationsFromBackend: () => Promise<void>;
  handleUpdateActiveSettings: (updates: Partial<ChatSettingsItem>) => void;
  getActiveChatIcon: (localChatInfo: any, activeChatId: string) => any;
  getFallbackMessages: (localChatInfo: any) => ChatMessage[];
  handleSend: (inputRef?: React.RefObject<HTMLTextAreaElement | null>) => void;
  pauseChat: () => void;
  resumeChat: (additionalInstruction?: string) => void;
  discardPausedGeneration: () => void;
  handleAcceptEnable: (candidateName: string) => void;
  handlePhase: (evt: any, currentChatMsgs: ChatMessage[]) => void;
}

let persistIdleHandle: any = null;
let lastPersistedConversations: Record<string, ChatMessage[]> | null = null;
let lastPersistedConfigs: Record<string, ChatSettingsItem> | null = null;

// ★ 暂停/恢复: 保存流式上下文,让 pauseChat 保存已生成文本, resumeChat 据此发"继续"请求
let activeStreamContext: {
  activeChatId: string; accumulatedText: string; mainEntry: any; mainModel: string;
  finalContent: string; permissionMode: PermissionMode; currentChatMsgs: ChatMessage[];
  reqBody: any; hashlineAgentEnabled: boolean; selectedFile?: string; editorContent?: string;
  activeTools?: string[]; activeSkills?: string[]; activeKnowledge?: string[];
  activeSettings: ChatSettingsItem;
} | null = null;

function schedulePersistToBackend(conversations: Record<string, ChatMessage[]>, configs: Record<string, ChatSettingsItem>) {
  if (typeof window === 'undefined') return;
  if (persistIdleHandle) {
    if (typeof persistIdleHandle === 'object' && typeof (persistIdleHandle as any).cancel === 'function') (persistIdleHandle as any).cancel();
    else if (typeof persistIdleHandle === 'number') clearTimeout(persistIdleHandle);
    persistIdleHandle = null;
  }
  const w = window as any;
  const doFlush = () => { try { fetch('/api/conversations', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ conversations, configs }) }).catch(() => {}); } catch {} };
  if (w.requestIdleCallback && w.cancelIdleCallback) { const handle = w.requestIdleCallback(doFlush, { timeout: 2000 }); persistIdleHandle = { cancel: () => w.cancelIdleCallback(handle) }; }
  else { persistIdleHandle = setTimeout(doFlush, 800); }
}

const initialConversations: Record<string, ChatMessage[]> = {};
const initialConfigs: Record<string, ChatSettingsItem> = {};

export const useChatStore = create<ChatStoreState>((set, get) => ({
  conversations: initialConversations, configs: initialConfigs,
  showSettingsPopup: false, chatsList: [], pendingAttachment: null, isPendingAttachmentExpanded: false,
  isGenerating: false, isPaused: false, activeChatHandle: null, lastReqBody: null, hashlineAgentEnabled: false, streamState: emptyStreamState,
  inputValue: '', showModeDropdown: false, workspaceApproval: null, options: {},
  setConversations: (updater) => set((state) => ({ conversations: typeof updater === 'function' ? (updater as any)(state.conversations) : updater })),
  setConfigs: (updater) => set((state) => ({ configs: typeof updater === 'function' ? (updater as any)(state.configs) : updater })),
  setShowSettingsPopup: (v) => set({ showSettingsPopup: v }), setChatsList: (v) => set({ chatsList: v }),
  setPendingAttachment: (v) => set({ pendingAttachment: v }), setIsPendingAttachmentExpanded: (v) => set({ isPendingAttachmentExpanded: v }),
  setIsGenerating: (v) => set({ isGenerating: v }),
  // ★ 暂停: 中止 fetch, 但保留 activeStreamContext (含已生成文本) 供恢复使用
  pauseChat: () => { const h = get().activeChatHandle; if (h) h.abort(); set({ isGenerating: false, isPaused: true, activeChatHandle: null }); },
  // ★ 恢复: 无参数=纯继续; 有参数=把"已生成内容+新指令"合并发给 LLM 一起算
  resumeChat: async (additionalInstruction?: string) => {
    const ctx = activeStreamContext;
    if (!ctx) { set({ isPaused: false }); return; }
    const hasInstruction = !!(additionalInstruction && additionalInstruction.trim());
    set({ isPaused: false, isGenerating: true, activeChatHandle: null, streamState: { ...emptyStreamState } });

    let continuePrompt: string;
    if (hasInstruction) {
      // 用户追加了新指令: 让 LLM 基于已生成内容 + 新指令综合处理
      continuePrompt = ctx.accumulatedText.trim()
        ? `以下是之前已生成的内容：\n\n${ctx.accumulatedText}\n\n---\n用户追加指令：${additionalInstruction}\n\n请基于已有内容并根据追加指令继续生成，直接输出，不要重复已有内容。`
        : additionalInstruction!;
    } else {
      // 纯恢复: 让 LLM 接续已有内容
      continuePrompt = ctx.accumulatedText.trim()
        ? `请继续以下内容的生成，直接接续，不要重复已有内容：\n\n${ctx.accumulatedText}`
        : ctx.finalContent;
    }
    // 历史包含原始消息 + 已有部分回复, 让 LLM 知道上下文
    const resumeHistory = [...ctx.currentChatMsgs, { sender: 'assistant' as const, content: ctx.accumulatedText }];

    const streamBridge = createStreamBridge(ctx.activeChatId, ctx.mainModel, continuePrompt, ctx.permissionMode);
    let streamFinalized = false;
    let canvasPusher: IncrementalCanvasPusher | null = null;
    // 从已生成文本开始累积, 新 chunk 追加到后面
    let resumeAccumulated = ctx.accumulatedText;
    // 预创建 canvasPusher 并喂入已有文本, 让 displayText 包含完整内容
    if (ctx.accumulatedText) { canvasPusher = new IncrementalCanvasPusher(ctx.activeChatId); canvasPusher.feedChunk(ctx.accumulatedText); }

    // ★ 2026-07-14: 懒创建画布 — 恢复时也确保画布存在
    await ensureCanvasForChat(ctx.activeChatId);

    const chatHandle = await startChat({ chatId: ctx.activeChatId, prompt: continuePrompt, mode: ctx.permissionMode, history: resumeHistory.map(m => ({ sender: m.sender, content: m.rawContent || m.content })), fileContext: ctx.selectedFile ? { name: ctx.selectedFile, content: ctx.editorContent } : undefined, mainProvider: { baseUrl: ctx.mainEntry.baseUrl, apiKey: ctx.mainEntry.apiKey, model: ctx.mainEntry.model }, subProviders: ctx.reqBody.subProviders, candidateProviders: ctx.reqBody.candidateProviders, ...(ctx.hashlineAgentEnabled ? { toolCallMode: 'hashline' } : {}), workspaceFolder: useChatsStore.getState().getChat(ctx.activeChatId)?.workspaceFolder, activeTools: ctx.activeTools, activeSkills: ctx.activeSkills, activeKnowledge: ctx.activeKnowledge, activeSettings: ctx.activeSettings, canvasId: getCanvasSessionId(ctx.activeChatId) } as any, async (evt: ChatStreamEvent) => {
      switch (evt.kind) {
        case 'text': {
          resumeAccumulated += evt.text;
          if (!canvasPusher) canvasPusher = new IncrementalCanvasPusher(ctx.activeChatId);
          const { displayText } = canvasPusher.feedChunk(evt.text);
          streamBridge.onText(evt.text);
          if (activeStreamContext) activeStreamContext.accumulatedText = resumeAccumulated;
          set((s) => { const cl = s.conversations[ctx.activeChatId] || []; if (cl.length === 0) return {}; const nl = [...cl]; const lm = { ...nl[nl.length - 1] }; if (lm.sender === 'assistant') { lm.content = displayText; lm.rawContent = resumeAccumulated; nl[nl.length - 1] = lm; } return { conversations: { ...s.conversations, [ctx.activeChatId]: nl } }; });
          break;
        }
        case 'phase': { streamBridge.onPhase(evt); get().handlePhase(evt, ctx.currentChatMsgs); break; }
        case 'agent': { streamBridge.onAgent(evt.agentId, evt.name, evt.avatar, evt.mainModel, evt.subModels, evt.role, evt.domain, evt.subModel); break; }
        case 'usage': { streamBridge.onUsage(evt.usage); break; }
        case 'error': { if (!streamFinalized) { streamFinalized = true; streamBridge.onError(evt.error); } activeStreamContext = null; const fm = classifyStreamError(evt.error || ''); set((s) => { const cl = s.conversations[ctx.activeChatId] || []; if (cl.length === 0) return { isGenerating: false, isPaused: false, activeChatHandle: null, streamState: { ...emptyStreamState } }; const nl = [...cl]; const lm = { ...nl[nl.length - 1] }; if (lm.sender === 'assistant') lm.content = `${lm.content}\n\n\u274C **生成中断**：${fm}`; nl[nl.length - 1] = lm; return { conversations: { ...s.conversations, [ctx.activeChatId]: nl }, isGenerating: false, isPaused: false, activeChatHandle: null, streamState: { ...emptyStreamState } }; }); break; }
        case 'done': {
          if (!streamFinalized) { streamFinalized = true; streamBridge.onDone(evt.agentId); } activeStreamContext = null;
          set({ isGenerating: false, isPaused: false, activeChatHandle: null, streamState: { ...emptyStreamState } });
          if (canvasPusher) await canvasPusher.flush();
          break;
        }
      }
    });
    set({ activeChatHandle: { taskId: chatHandle.taskId, abort: () => { chatHandle.abort(); if (!streamFinalized) { streamFinalized = true; streamBridge.onDone(); } } } });
  },
  // ★ 丢弃暂停的生成: 清除上下文 + 移除残留的部分 assistant 消息, 回到空闲态
  discardPausedGeneration: () => {
    activeStreamContext = null;
    set((s) => {
      const chatId = s.options.selectedChatId || '1';
      const cl = s.conversations[chatId] || [];
      // 移除最后一条 assistant 消息 (被放弃的部分生成内容)
      if (cl.length > 0 && cl[cl.length - 1].sender === 'assistant') {
        return { conversations: { ...s.conversations, [chatId]: cl.slice(0, -1) }, isPaused: false, isGenerating: false, activeChatHandle: null, streamState: { ...emptyStreamState } };
      }
      return { isPaused: false, isGenerating: false, activeChatHandle: null, streamState: { ...emptyStreamState } };
    });
  },
  setLastReqBody: (v) => set({ lastReqBody: v }),
  setHashlineAgentEnabled: (v) => set({ hashlineAgentEnabled: v }),
  setStreamState: (updater) => set((state) => ({ streamState: typeof updater === 'function' ? (updater as any)(state.streamState) : updater })),
  setInputValue: (updater) => set((state) => ({ inputValue: typeof updater === 'function' ? (updater as any)(state.inputValue) : updater })),
  setShowModeDropdown: (v) => set({ showModeDropdown: v }),
  setWorkspaceApproval: (v) => set({ workspaceApproval: v }),
  resolveWorkspaceApproval: (chatId, decision) => {
    if (decision === 'always') localStorage.setItem(`soloforge_workspace_always_allow_${chatId}`, '1');
    set({ workspaceApproval: null });
    window.dispatchEvent(new CustomEvent('soloforge-workspace-approval-resolved', { detail: { chatId, decision } }));
  },
  syncRuntimeOptions: (opts) => set((state) => ({ options: { ...state.options, ...opts } })),

  loadChatsList: () => {
    if (typeof window === 'undefined') return;
    try { const chats = useChatsStore.getState().chats; const mapped = chats.map((c: any) => ({ id: c.id, title: c.title, time: c.time || '', tag: c.tag, tagBg: c.tagBg, tagText: c.tagText, icon: undefined, permission: c.permission })); set({ chatsList: mapped }); } catch {}
  },

  loadChatConfigs: () => {},

  loadConversationsFromBackend: async () => {
    if (typeof window === 'undefined') return;
    try {
      const resp = await fetch('/api/conversations');
      if (!resp.ok) return;
      const data = await resp.json();
      if (data.success) {
        const convos = data.conversations && typeof data.conversations === 'object' ? data.conversations : {};
        const cfgs = data.configs && typeof data.configs === 'object' ? data.configs : {};
        const sanitized = sanitizeConversations(convos);
        lastPersistedConversations = sanitized; lastPersistedConfigs = cfgs;
        set({ conversations: sanitized, configs: cfgs });
        if (JSON.stringify(sanitized) !== JSON.stringify(convos)) { schedulePersistToBackend(sanitized, cfgs); }
      }
    } catch (e) { console.warn('[useChatStore] 从后端加载对话消息失败:', (e as Error).message); }
  },

  handleUpdateActiveSettings: (updates) => {
    const { options, configs } = get(); const activeChatId = options.selectedChatId || '1';
    const activeSettings = configs[activeChatId] || fallbackActiveSettings;
    set({ configs: { ...configs, [activeChatId]: { ...activeSettings, ...updates } } });
  },

  getActiveChatIcon: (localChatInfo, _activeChatId) => {
    if (localChatInfo?.tag === 'ANDROID') return AndroidIcon; if (localChatInfo?.tag === 'WINDOWS') return WindowsIcon;
    if (localChatInfo?.tag === 'HARMONY') return HarmonyOSIcon; if (localChatInfo?.tag === 'NEW') return DefaultChatIcon;
    if (localChatInfo?.tag === 'VUE') return Code; if (localChatInfo?.tag === 'AUTH') return Key;
    if (localChatInfo?.tag === 'AI') return Brain; if (localChatInfo?.tag === 'DB') return Database;
    if (localChatInfo?.tag === 'PAY') return CreditCard; if (localChatInfo?.tag === 'HELP') return HelpCircle;
    return DefaultChatIcon;
  },

  getFallbackMessages: (localChatInfo) => {
    if (localChatInfo?.tag === 'ANDROID') return [{ sender: 'assistant', content: '\u{1F44B} 你好！已为您开启 **Android 应用开发** 专属智能架构与调试辅助面板。\n\n后端系统与真实工具编译调试接口已接入就绪。您可以就以下领域发起提问：\n\n1. \u{1F4F1} **Jetpack Compose 视图流**：高效的声明式 UI 最佳组件化划分姿态。\n2. 协程 & Flow 异步并发管理，避免主线程卡死现象。\n3. Gradle 构建重构、三方 SDK 统一依赖配置与 Android SDK 高版本适配规约。\n4. 真机/模拟器 ADB 调试报错堆栈智能定位。\n\n请在输入框键入您想要探讨的代码问题！', time: '刚才', avatar: '' }];
    if (localChatInfo?.tag === 'WINDOWS') return [{ sender: 'assistant', content: '\u{1F44B} 你好！已为您开启 **Windows 软件开发/桌面系统** 专属智能架构辅助面板。\n\n后端编译及运行接口环境整备完成。支持提问的技术体系：\n\n1. \u{1F5A5} **WPF / WinForms / WinUI 3**：MVVM 架构重构及自定义精美现代皮肤制作。\n2. Win32 底层 API 调用、高性能 C++ DLL 混合调用与多线程资源释放预防内存积压。\n3. MSIX / Advanced Installer 标准静默打包、Windows 平台软件防病毒篡改签名工作流。\n4. 针对不同版本的 Windows OS 精细化桌面通知及注册表检索。\n\n欢迎直接向我提供您的需求！', time: '刚才', avatar: '' }];
    if (localChatInfo?.tag === 'HARMONY') return [{ sender: 'assistant', content: '\u{1F44B} 你好！已为您开启 **鸿蒙 (HarmonyOS / OpenHarmony)** 生态开发专属高级顾问。\n\n后端调试器与 DevEco Studio 热重载模块交互链路随时待命。核心探讨板块示范：\n\n1. \u{1F534} **ArkTS 极速业务逻辑编写**：理解 @State, @Prop, @Link, @Provide 极佳响应式流状态装饰器搭配运作。\n2. ArkUI 自定义精致声明式组件构建，精细控制渲染性能指标。\n3. Stage 分层架构模型规范、多个 Feature Ability (FA级) 交互安全防护与切片加载处理机制。\n4. 鸿蒙原生多设备适配分布式流转，在平板、折叠屏及智能穿戴间无缝同步。\n\n有什么问题尽管问！', time: '刚才', avatar: '' }];
    return [];
  },

  handleSend: async (_inputRef) => {
    const state = get();
    const { inputValue, pendingAttachment, conversations, options, hashlineAgentEnabled, configs } = state;
    const { permissionMode = 'normal', mainModel = 'GPT-4o', secModels = [], selectedFile, editorContent, modelProviderMap = {} } = options;
    if (!inputValue.trim() && !pendingAttachment) return;
    const finalContent = inputValue.trim() || `请帮我分析如下来自于 "${pendingAttachment?.fileName}" 的代码。`;

    // ── 确保存在有效对话: 没有对话历史时自动创建一个新对话 ──
    //   原代码 selectedChatId || '1' 会把首条消息写进虚假 ID '1',
    //   历史列表里看不到、重启后丢失。首次发送时改成自动建真实对话。
    let selectedChatId = options.selectedChatId || '';
    if (!selectedChatId || !useChatsStore.getState().getChat(selectedChatId)) {
      const newChat = await useChatsStore.getState().createChat();
      if (!newChat) {
        set({ inputValue: '' });
        return;
      }
      selectedChatId = newChat.id;
    }

    // ── 工作区越界检查 ──
    const chatInfo = useChatsStore.getState().getChat(selectedChatId);
    const workspaceFolder = chatInfo?.workspaceFolder;
    if (workspaceFolder) {
      const alwaysAllow = localStorage.getItem(`soloforge_workspace_always_allow_${selectedChatId}`) === '1';
      if (!alwaysAllow && mentionsOutsideWorkspace(finalContent)) {
        set({ workspaceApproval: { chatId: selectedChatId, message: `检测到您可能需要在工作区文件夹 "${workspaceFolder}" 外进行操作。是否允许？` } });
        const decision = await new Promise<'allow' | 'deny' | 'always'>((resolve) => {
          const handler = (e: Event) => { const detail = (e as CustomEvent).detail; if (detail?.chatId === selectedChatId) { window.removeEventListener('soloforge-workspace-approval-resolved', handler); resolve(detail.decision as 'allow' | 'deny' | 'always'); } };
          window.addEventListener('soloforge-workspace-approval-resolved', handler);
        });
        if (decision === 'deny') { set({ inputValue: '' }); return; }
      }
    }

    const userMsg: ChatMessage = { sender: 'user', content: finalContent, time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }), avatar: '' };
    if (pendingAttachment) userMsg.attachment = { fileName: pendingAttachment.fileName, text: pendingAttachment.text };
    const activeChatId = selectedChatId; const activeMessages = conversations[activeChatId] || []; const currentChatMsgs = [...activeMessages, userMsg];
    set({ conversations: { ...conversations, [activeChatId]: currentChatMsgs }, inputValue: '', pendingAttachment: null, isGenerating: true, isPaused: false, activeChatHandle: null, streamState: { ...emptyStreamState } });

    const mainEntry = modelProviderMap[mainModel];
    if (!mainEntry || !mainEntry.apiKey) {
      set((s) => ({ conversations: { ...s.conversations, [activeChatId]: [...currentChatMsgs, { sender: 'assistant', content: `\u274C **主模型未配置**：请在「设置 → 模型」中测试通过主模型「${mainModel}」后再试。`, time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }), avatar: '' }] }, isGenerating: false, activeChatHandle: null }));
      return;
    }

    const subModelIds = (secModels || []).map((s: any) => s.id || s.name);
    const subEntries = subModelIds.map((name: string) => modelProviderMap[name]).filter((e: any): e is NonNullable<typeof e> => !!e && e.enabledInSettings && !!e.apiKey);
    const candidateEntries = Object.values(modelProviderMap).filter((e: any) => e.enabledInSettings && !!e.apiKey && !subModelIds.includes(e.model));
    const rmState = useResourceManagerStore.getState();
    const activeTools = Array.from(rmState.activeTools); const activeSkills = Array.from(rmState.activeSkills); const activeKnowledge = Array.from(rmState.activeKnowledge);

    const reqBody = { mode: permissionMode, query: finalContent, history: activeMessages.map(m => ({ sender: m.sender, content: m.rawContent || m.content })), fileContext: selectedFile ? { name: selectedFile, content: editorContent } : undefined, toolCallMode: hashlineAgentEnabled ? 'hashline' : undefined, mainProvider: { baseUrl: mainEntry.baseUrl, apiKey: mainEntry.apiKey, model: mainEntry.model }, subProviders: subEntries.map(e => ({ baseUrl: e.baseUrl, apiKey: e.apiKey, model: e.model })), candidateProviders: candidateEntries.map((e: any) => ({ displayName: e.model, providerName: e.providerName, modelName: e.model, baseUrl: e.baseUrl })), activeTools: activeTools.length > 0 ? activeTools : undefined, activeSkills: activeSkills.length > 0 ? activeSkills : undefined, activeKnowledge: activeKnowledge.length > 0 ? activeKnowledge : undefined };
    set({ lastReqBody: reqBody });

    const assistantMsg: ChatMessage = { sender: 'assistant', content: '', time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }), avatar: '' };
    set((s) => ({ conversations: { ...s.conversations, [activeChatId]: [...currentChatMsgs, assistantMsg] } }));

    let accumulatedText = '';
    let canvasPusher: IncrementalCanvasPusher | null = null;

    // ★ FIX 2026-07-14: 发新消息时清理旧的 previewStreamStore entry
    //   避免上一轮的残留数据导致 usePreviewBridge 跳过新推送
    usePreviewStreamStore.getState().clearEntry(activeChatId);

    // ★ 2026-07-14: 懒创建画布 — 发消息时才创建, 不再注册 fallback ID
    //   ensureCanvasForChat 会调用 POST /api/canvas/sessions 创建真实画布
    //   并派发 'soloforge-canvas-created' 事件让 bridge 刷新
    await ensureCanvasForChat(activeChatId);

    const streamBridge = createStreamBridge(activeChatId, mainModel, finalContent, permissionMode);
    let streamFinalized = false;

    // ★ 保存流式上下文, 供 pauseChat/resumeChat 使用
    activeStreamContext = { activeChatId, accumulatedText: '', mainEntry, mainModel, finalContent, permissionMode, currentChatMsgs, reqBody, hashlineAgentEnabled, selectedFile, editorContent, activeTools: activeTools.length > 0 ? activeTools : undefined, activeSkills: activeSkills.length > 0 ? activeSkills : undefined, activeKnowledge: activeKnowledge.length > 0 ? activeKnowledge : undefined, activeSettings: configs[activeChatId] || fallbackActiveSettings };

    const chatHandle = await startChat({ chatId: activeChatId, prompt: finalContent, mode: permissionMode, history: activeMessages.map(m => ({ sender: m.sender, content: m.rawContent || m.content })), fileContext: selectedFile ? { name: selectedFile, content: editorContent } : undefined, mainProvider: { baseUrl: mainEntry.baseUrl, apiKey: mainEntry.apiKey, model: mainEntry.model }, subProviders: subEntries.map(e => ({ baseUrl: e.baseUrl, apiKey: e.apiKey, model: e.model })), candidateProviders: candidateEntries.map((e: any) => ({ displayName: e.model, providerName: e.providerName, modelName: e.model, baseUrl: e.baseUrl })), ...(hashlineAgentEnabled ? { toolCallMode: 'hashline' } : {}), workspaceFolder: useChatsStore.getState().getChat(activeChatId)?.workspaceFolder, activeTools: activeTools.length > 0 ? activeTools : undefined, activeSkills: activeSkills.length > 0 ? activeSkills : undefined, activeKnowledge: activeKnowledge.length > 0 ? activeKnowledge : undefined, activeSettings: configs[activeChatId] || fallbackActiveSettings, canvasId: getCanvasSessionId(activeChatId) } as any, async (evt: ChatStreamEvent) => {
      switch (evt.kind) {
        case 'text': {
          accumulatedText += evt.text;
          if (activeStreamContext) activeStreamContext.accumulatedText = accumulatedText;
          if (!canvasPusher) canvasPusher = new IncrementalCanvasPusher(activeChatId);
          const { displayText, inCodeBlock } = canvasPusher.feedChunk(evt.text);
          // ★ FIX 2026-07-12: 始终调用 streamBridge.onText, 即使在代码块内
          //   原代码 if (!inCodeBlock) 导致 LLM 回复全是代码时流送区空白:
          //   onText 从未被调用 → uiMessageStore 无 parts → StreamPanel 返回 null
          //   代码块文本也会推入流送区,让用户看到 LLM 的完整输出进度
          streamBridge.onText(evt.text);
          set((s) => { const cl = s.conversations[activeChatId] || []; if (cl.length === 0) return {}; const nl = [...cl]; const lm = { ...nl[nl.length - 1] }; if (lm.sender === 'assistant') { lm.content = displayText; lm.rawContent = accumulatedText; nl[nl.length - 1] = lm; } return { conversations: { ...s.conversations, [activeChatId]: nl } }; });
          break;
        }
        case 'phase': { streamBridge.onPhase(evt); get().handlePhase(evt, currentChatMsgs); break; }
        case 'agent': { streamBridge.onAgent(evt.agentId, evt.name, evt.avatar, evt.mainModel, evt.subModels, evt.role, evt.domain, evt.subModel); break; }
        case 'usage': { streamBridge.onUsage(evt.usage); break; }
        case 'error': { if (!streamFinalized) { streamFinalized = true; streamBridge.onError(evt.error); } activeStreamContext = null; const fm = classifyStreamError(evt.error || ''); set((s) => { const cl = s.conversations[activeChatId] || []; if (cl.length === 0) return { isGenerating: false, isPaused: false, activeChatHandle: null, streamState: { ...emptyStreamState } }; const nl = [...cl]; const lm = { ...nl[nl.length - 1] }; if (lm.sender === 'assistant') lm.content = `\u274C **AI 调用失败**：${fm}`; nl[nl.length - 1] = lm; return { conversations: { ...s.conversations, [activeChatId]: nl }, isGenerating: false, isPaused: false, activeChatHandle: null, streamState: { ...emptyStreamState } }; }); break; }
        case 'done': {
          if (!streamFinalized) { streamFinalized = true; streamBridge.onDone(evt.agentId); } activeStreamContext = null; set({ isGenerating: false, isPaused: false, activeChatHandle: null, streamState: { ...emptyStreamState } });
          const expFp = (evt as any).experienceFingerprint as string | undefined;
          if (expFp) set((s) => { const cl = s.conversations[activeChatId] || []; if (cl.length === 0) return {}; const nl = [...cl]; const lm = { ...nl[nl.length - 1] }; if (lm.sender === 'assistant') lm.experienceFingerprint = expFp; nl[nl.length - 1] = lm; return { conversations: { ...s.conversations, [activeChatId]: nl } }; });
if (canvasPusher) await canvasPusher.flush();
const pusherHandled = canvasPusher?.wasHandled() ?? false;
let localPushed = pusherHandled;
if (!pusherHandled) localPushed = await tryLocalTranslateAndPush(accumulatedText, activeChatId);
// ★ FIX 2026-07-14: 如果推送和本地翻译都没成功, 清理残留 entry
//   避免旧数据导致 usePreviewBridge 跳过预览触发
if (!pusherHandled && !localPushed) {
  usePreviewStreamStore.getState().clearEntry(activeChatId);
}
// ★ 2026-07-14: 诊断日志 — 跟踪画布推送结果
console.log('[useChatStore] done event: pusherHandled=', pusherHandled, 'localPushed=', localPushed, 'accumulatedText.length=', accumulatedText.length);
const _finalEntry = usePreviewStreamStore.getState().getEntry(activeChatId);
console.log('[useChatStore] previewStreamStore entry:', _finalEntry ? { hasAst: !!_finalEntry.ast, hasPayload: !!_finalEntry.payload, isStreaming: _finalEntry.isStreaming, language: _finalEntry.language } : 'null');
          const pr = detectPreviewTrigger(accumulatedText, localPushed, detectPreviewFromResponse);
          const fdt = canvasPusher?.getDisplayText() ?? pr.cleanText;
          const cd = fdt.replace(/\s*<<<PREVIEW_NEEDED:\w+>>>\s*$/, '');
          set((s) => { const cl = s.conversations[activeChatId] || []; if (cl.length === 0) return {}; const nl = [...cl]; const lm = { ...nl[nl.length - 1] }; if (lm.sender === 'assistant') lm.content = cd; nl[nl.length - 1] = lm; return { conversations: { ...s.conversations, [activeChatId]: nl } }; });
          if (pr.shouldPreview && typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('soloforge-preview-trigger', { detail: { chatId: activeChatId, message: finalContent, language: pr.previewLang, provider: mainEntry ? { baseUrl: mainEntry.baseUrl, apiKey: mainEntry.apiKey, model: mainEntry.model } : undefined } }));
          break;
        }
      }
    });
    set({ activeChatHandle: { taskId: chatHandle.taskId, abort: () => { chatHandle.abort(); if (!streamFinalized) { streamFinalized = true; streamBridge.onDone(); } } } });
  },

  handleAcceptEnable: async (candidateName) => {
    const state = get(); const { lastReqBody, options, configs } = state; if (!lastReqBody) return;
    const entry = (options.modelProviderMap || {})[candidateName]; if (!entry || !entry.apiKey) return;
    const activeChatId = options.selectedChatId || '1';
    const newSub = { baseUrl: entry.baseUrl, apiKey: entry.apiKey, model: entry.model };
    const newReqBody = { ...lastReqBody, subProviders: [...(lastReqBody.subProviders as any[]), newSub], candidateProviders: (lastReqBody.candidateProviders as any[]).filter((c: any) => c.modelName !== candidateName), enableDecision: { candidateName, accept: true } };
    set({ streamState: { ...emptyStreamState }, isGenerating: true });
    const streamBridge = createStreamBridge(activeChatId, options.mainModel || '', '', lastReqBody.mode);
    let canvasPusher2: IncrementalCanvasPusher | null = null;
    let accText2 = '';
    // ★ 2026-07-14: 懒创建画布 — handleAcceptEnable 也需要确保画布存在
    await ensureCanvasForChat(activeChatId);
    startChat({ chatId: activeChatId, prompt: '', mode: lastReqBody.mode, history: [], mainProvider: (lastReqBody.mainProvider as any), subProviders: newSub ? [...(lastReqBody.subProviders as any[]), newSub] : (lastReqBody.subProviders as any[]), candidateProviders: (lastReqBody.candidateProviders as any[]).filter((c: any) => c.modelName !== candidateName), activeTools: lastReqBody.activeTools, activeSkills: lastReqBody.activeSkills, activeKnowledge: lastReqBody.activeKnowledge, activeSettings: configs[activeChatId] || fallbackActiveSettings } as any, (evt: ChatStreamEvent) => {
      switch (evt.kind) {
        case 'phase': { streamBridge.onPhase(evt); get().handlePhase(evt, get().conversations[activeChatId] || []); break; }
        case 'error': streamBridge.onError(evt.error); break;
        case 'done': streamBridge.onDone(); if (canvasPusher2) canvasPusher2.flush().catch(() => {}); set({ isGenerating: false }); break;
        case 'text': { accText2 += evt.text; if (!canvasPusher2) canvasPusher2 = new IncrementalCanvasPusher(activeChatId); const { displayText, inCodeBlock } = canvasPusher2.feedChunk(evt.text); streamBridge.onText(evt.text); set((s) => { const cl = s.conversations[activeChatId] || []; if (cl.length === 0) return {}; const nl = [...cl]; const lm = { ...nl[nl.length - 1] }; if (lm.sender === 'assistant') { lm.content = displayText; lm.rawContent = accText2; } nl[nl.length - 1] = lm; return { conversations: { ...s.conversations, [activeChatId]: nl } }; }); break; }
      }
    });
  },

  handlePhase: (evt, _currentChatMsgs) => {
    if (evt.kind !== 'phase') return;
    const { options } = get(); const activeChatId = options.selectedChatId || '1';
    set((s) => { const prev = s.streamState; const next: StreamState = { ...prev };
      switch (evt.phase) {
        case 'phase0_subtask': { const st = (evt as any).subtasks; if (Array.isArray(st)) next.workerOutputs = st.map((st2: any, i: number) => ({ workerIdx: st2.workerIdx ?? i, modelName: st2.modelName ?? `Worker ${i}`, content: '', status: 'pending' as const })); break; }
        case 'phase0_skip': break;
        case 'suggest_enable': next.suggestEnables = [...prev.suggestEnables, { candidateName: (evt as any).candidateName, expectedGain: (evt as any).expectedGain, reason: (evt as any).reason ?? '' }]; break;
        case 'phase1_worker_start': next.workerOutputs = prev.workerOutputs.map(w => w.workerIdx === (evt as any).workerIdx ? { ...w, status: 'streaming' as const } : w); break;
        case 'phase1_worker_done': next.workerOutputs = prev.workerOutputs.map(w => w.workerIdx === (evt as any).workerIdx ? { ...w, status: ((evt as any).content?.startsWith('\u26A0\uFE0F') ? 'error' : 'done') as 'error' | 'done', content: (evt as any).content ?? '' } as any : w); break;
        case 'phase1_worker_error': next.workerOutputs = prev.workerOutputs.map(w => w.workerIdx === (evt as any).workerIdx ? { ...w, status: 'error' as const, content: (evt as any).content ?? (evt as any).error ?? '' } as any : w); break;
        case 'phase2_judge': next.judgeChosen = (evt as any).chosen ?? []; next.judgeReasoning = ''; next.scores = (evt as any).score !== undefined ? [{ workerIdx: 0, score: (evt as any).score, reason: '', modelName: (evt as any).chosen?.[0] }] : prev.scores; break;
        case 'phase2_judge_error': console.error('[orchestrator judge error]', (evt as any).error); break;
        case 'phase3_deliver_start': break;
        case 'phase3_deliver_done': if ((evt as any).reply) next.deliver = (evt as any).reply; break;
        case 'tool_started': { const callId = (evt as any).toolCallId ?? `tc-${Date.now()}`; const bl = [...prev.toolCalls]; bl.push({ id: callId, kind: 'hashline.batch' as any, status: 'running' as any, total: 1, succeeded: 0, failedAt: undefined, errorCode: undefined, results: [{ tool: (evt as any).tool ?? 'unknown', args: (evt as any).args, started: true }], timestamp: (evt as any).ts ?? Date.now() } as any); next.toolCalls = bl; break; }
        case 'tool_completed': { const callId = (evt as any).toolCallId; const bl = [...prev.toolCalls]; const idx = bl.findIndex(t => t.id === callId); if (idx >= 0) bl[idx] = { ...bl[idx], status: (evt as any).success ? 'success' : 'error' } as any; next.toolCalls = bl; break; }
        case 'dispatch': if (Array.isArray((evt as any).subtasks)) next.workerOutputs = (evt as any).subtasks.map((m: any, i: number) => ({ workerIdx: i, modelName: m, content: '', status: 'pending' as const })); break;
        case 'worker_start': next.workerOutputs = prev.workerOutputs.map(w => w.workerIdx === (evt as any).workerIdx ? { ...w, status: 'streaming' as const } : w); break;
        case 'worker_done': next.workerOutputs = prev.workerOutputs.map(w => w.workerIdx === (evt as any).workerIdx ? { ...w, status: ((evt as any).content?.startsWith('\u26A0\uFE0F') ? 'error' : 'done') as 'error' | 'done', content: (evt as any).content ?? '' } as any : w); break;
        case 'score': next.scores = (evt as any).scores ?? []; break;
        case 'judge': next.judgeChosen = (evt as any).chosen ?? []; next.judgeReasoning = (evt as any).reasoning ?? ''; break;
        case 'audit': next.auditFindings = (evt as any).findings ?? []; break;
        case 'warn': console.warn('[orchestrator warn]', (evt as any).msg); break;
        case 'error': console.error('[orchestrator error]', (evt as any).msg); break; default: break;
      } return { streamState: next };
    });
  },
}));

useChatStore.subscribe((state, prevState) => {
  const convChanged = state.conversations !== prevState.conversations && state.conversations !== lastPersistedConversations;
  const cfgChanged = state.configs !== prevState.configs && state.configs !== lastPersistedConfigs;
  if (convChanged) lastPersistedConversations = state.conversations;
  if (cfgChanged) lastPersistedConfigs = state.configs;
  if (convChanged || cfgChanged) schedulePersistToBackend(state.conversations, state.configs);
});

// ★ 2026-07-13: 挂到 window 上, 供 PreviewPanel 等模块无循环依赖地读取 conversations
if (typeof window !== 'undefined') {
  (window as any).__chatStoreGetState = () => useChatStore.getState();
}

export { defaultChatDetails, defaultConversations, defaultConfigs, fallbackActiveSettings };
