﻿﻿﻿/**
 * aiBackend — 统一 AI 流式后端接口
 *   dev (浏览器 / Vite dev server) → /api/java-agent/api/chat/stream (Java SSE)
 *                                  → Node.js(3000) 直连透传到 Java Spring AI Agent(8770)
 *   prod (Electron) → window.soloforge.ai.chatViaPort (MessagePortMain 零拷贝)
 *                     (注: 当前 preload.cjs 未暴露 dispatchAgent, IPC 路径为预留)
 *
 * ChatPanel 只见这一个接口, 不知道底层是 fetch 还是 IPC
 *
 * 接口规范:
 *   startChat(req, onEvent) → { abort(): void }
 *   onEvent 收到的事件: { kind: 'text' | 'phase' | 'error' | 'done', ... }
 *
 * 2026-07-08 Phase 4: 真实 SSE 流式 — 从 /api/chat/stream 读取 Server-Sent Events
 *            每个 text 事件携带 LLM delta 文本片段, 前端逐字追加渲染
 *
 * 2026-07-14: 移除所有 fallback 降级逻辑 (RACER / LLM Proxy)。
 *            请求失败直接抛出具体错误信息, 不允许降级。
 */

import { StreamingLatencyTracker } from './perfMonitor';
import { getDeviceConstraint, type CanvasDeviceInfo } from '../state/canvasDeviceStore';

export type ChatStreamEvent =
  | { kind: 'text'; text: string; taskId?: string }
  | { kind: 'phase'; phase: string; taskId?: string; [k: string]: any }
  | { kind: 'agent'; agentId: string; name: string; avatar?: string; role?: string; domain?: string; modelBinding?: string; mainModel?: string; subModels?: string[]; subModel?: string; taskId?: string }
  | { kind: 'error'; error: string; taskId?: string }
  | { kind: 'done'; taskId?: string; agentId?: string; experienceFingerprint?: string; strategy?: string }
  | { kind: 'usage'; usage: { promptTokens: number; completionTokens: number; totalTokens: number; cachedTokens?: number }; taskId?: string };

export interface ChatRequest {
  prompt: string;
  /** 前端 chatId, 用于 phase 事件路由回流送区 */
  chatId?: string;
  history?: Array<{ sender: 'user' | 'assistant' | string; content: string }>;
  activeFile?: { name: string; content: string } | null;
  mainModel?: string;
  secModels?: any[];
  mixedTasks?: boolean;
  activeSettings?: any;
  /**
   * 前端配置的 LLM provider (baseUrl + model), 传递给后端。
   *
   * ⚠️ 安全注意: apiKey 字段在此接口中以明文形式存在。
   *   JavaScript 运行时可通过 DevTools 提取。
   *   后续改进方向:
   *     1. 前端只传 provider ID，后端从安全配置服务获取密钥
   *     2. 或使用短期 session token 替代持久 apiKey
   */
  mainProvider?: { baseUrl: string; apiKey: string; model: string; rateLimitProfile?: { maxConcurrent?: number; maxRpm?: number; maxTpm?: number; contextWindow?: number; maxOutputTokens?: number } | null };
  /** 工作区文件夹路径 (用于 AI 作用域限制) */
  workspaceFolder?: string;
  /** 前端资源管理器选中的工具 ID 列表 (如 browser_devtools, bu_run_task, win_powershell) */
  activeTools?: string[];
  /** 前端从 toolsManifest 提取的完整工具 schema (OpenAI Function Calling 格式), 供 Java 端直接使用 */
  toolSchemas?: any[];
  /** 前端资源管理器选中的技能 ID 列表 */
  activeSkills?: string[];
  /** 前端资源管理器选中的知识库 ID 列表 */
  activeKnowledge?: string[];
  /** Agent ID (手动选择, 默认 code_agent, 由 Java 服务 AgentOrchestrator 路由) */
  agentId?: string;
  /** 画布 ID (从 PreviewPanel 传入, 让 Agent 知道推送到哪个画布) */
  canvasId?: string;
  // 多模型场景下透传到 phaseMappers
  [k: string]: any;
}

export interface ChatHandle {
  taskId: string;
  abort: () => void;
}

/** 检测当前是否在 Electron 环境 + IPC 可用 (dispatchAgent / onAgentEvent) */
export function isElectronIpcAvailable(): boolean {
  return typeof window !== 'undefined'
    && typeof (window as any).soloforge?.dispatchAgent === 'function'
    && typeof (window as any).soloforge?.onAgentEvent === 'function';
}

// ────────────────────────────────────────────────────────────
// 强制画布关键词检测 (2026-07-09 新增)
//
// 当用户明确要求"在画布上画/展示/渲染"时, 在 prompt 前注入强制画布指令,
// 让 LLM 必须调用 canvas_push_ui 工具, 而不是只回复文字。
//
// 检测关键词:
//   - "画布上画" / "在画布画" / "画到画布" / "用画布画"
//   - "canvas画" / "canvas 上画"
//   - "画一个 X" / "画一只 X" / "画个 X" (图形类)
//   - "在画布上显示" / "在画布展示"
// ────────────────────────────────────────────────────────────
const FORCE_CANVAS_PATTERNS: RegExp[] = [
  /画布上画/i,
  /在画布画/i,
  /画到画布/i,
  /用画布画/i,
  /画布上显示/i,
  /画布上展示/i,
  /在画布上渲染/i,
  /canvas\s*上?画/i,
  /canvas\s*上?显示/i,
  // "画一个/画一只/画个" — 图形任务强信号
  /画[一]?[个只]|画个|画只/i,
];

const FORCE_CANVAS_INSTRUCTION = `[FORCE_CANVAS] 用户要求在画布上作画/展示。你必须返回可渲染的 UI 内容。

## 默认策略 — 输出 JSON DSL (零翻译, 最快路径)
SoloForge 画布的原生渲染格式是 JSON DSL (UiNode 树)。
默认情况下, 你直接输出 \`\`\`json 代码块, 前端零翻译直送 Flutter 渲染, 速度最快。

### JSON DSL 格式规范 (严格遵守)

每个节点结构: { "type": "节点类型", "props": { 属性键值对 }, "children": [子节点...] }

**节点类型**:
- container — 通用容器 (用 props.layout 指定方向: "row" 或 "column", 默认 "column")
- text — 文本 (props.content = 文本内容)
- button — 按钮 (props.label = 按钮文字, props.variant = "filled"|"outlined"|"text")
- input — 输入框 (props.placeholder = 占位文字)
- image — 图片 (props.url = 图片地址)
- icon — 图标 (props.icon = 图标名, 如 "star", "home", "search")
- svg — SVG 矢量图 (props.content = SVG 字符串)
- chart — 图表 (props.chartType = "bar"|"line"|"pie", props.data = [{label, value, color?}])
- spacer — 弹性空白 (props.flex = 整数)
- progress — 进度条 (props.value = 0~1)
- divider — 分割线

**常用 props 字段**:
- layout: "row" | "column" (仅 container)
- content: 文本内容 (text/svg)
- color: 文字颜色 (text)
- backgroundColor: 背景颜色 (container)
- fontSize: 字号 (text, 数字)
- fontWeight: 字重 (text, 如 "bold", "w400"~"w900")
- padding: 内边距 (数字或 "上,右,下,左")
- margin: 外边距
- borderRadius: 圆角
- width / height: 尺寸
- spacing: 子元素间距 (container)
- mainAxisAlignment: "start"|"center"|"end"|"spaceBetween"|"spaceEvenly"
- crossAxisAlignment: "start"|"center"|"end"|"stretch"
- alignment: "center"|"topLeft"|"bottomRight" 等

**颜色格式**: #RRGGBB (如 #2196F3) 或 #AARRGGBB

### 完整示例

\`\`\`json
{
  "type": "container",
  "props": { "layout": "column", "padding": 16, "backgroundColor": "#1a1a2e", "spacing": 12 },
  "children": [
    { "type": "text", "props": { "content": "Hello World", "fontSize": 24, "fontWeight": "bold", "color": "#ffffff" }, "children": [] },
    { "type": "container", "props": { "layout": "row", "spacing": 8 }, "children": [
      { "type": "button", "props": { "label": "OK", "variant": "filled", "color": "#4CAF50" }, "children": [] },
      { "type": "button", "props": { "label": "Cancel", "variant": "outlined", "color": "#F44336" }, "children": [] }
    ] }
  ]
}
\`\`\`

## 语言检测 — 用户明确指定语言时走翻译层
当用户在请求中明确提到以下关键字时, 输出对应语言的代码块, 前端翻译器会自动转译为画布 AST:
  - "dart" / "flutter"       → \`\`\`dart
  - "html" / "网页" / "css"  → \`\`\`html
  - "tsx" / "react"          → \`\`\`tsx
  - "vue"                    → \`\`\`vue
  - "swift" / "ios"          → \`\`\`swift
  - "kotlin" / "android"     → \`\`\`kotlin
  - "xml"                    → \`\`\`xml
  - "python" / "tkinter"     → \`\`\`python
  - "svg" / "矢量图"          → \`\`\`svg  (或用 JSON DSL 的 svg 节点)

## 仅以下场景才调用 canvas_push_ui 工具
- 用户明确要求"用 AST 推送"或"实时推送"
- 极其复杂的动态交互 (代码块无法表达)

## 要求
1. 不要只回复文字, 必须有代码块
2. 代码块要完整可渲染 (含布局结构 + 样式)
3. 每个节点必须有 type 和 props 字段 (不要用 style, 用 props)
4. 文本内容放在 props.content 里 (不要放在 text 字段)
5. 末尾不要加 <<<PREVIEW_NEEDED>>> 标记 (前端会自动检测代码块)`;

/** 检测用户输入是否包含强制画布关键词, 若包含则返回注入指令, 否则返回 null */
export function detectForceCanvas(prompt: string): string | null {
  if (!prompt || typeof prompt !== 'string') return null;
  for (const pattern of FORCE_CANVAS_PATTERNS) {
    if (pattern.test(prompt)) {
      return FORCE_CANVAS_INSTRUCTION;
    }
  }
  return null;
}

/**
 * ★ 检查设备是否有灵动岛 (Dynamic Island)
 *
 * 灵动岛出现在 iPhone 14 Pro 及以后的机型上。
 * 返回灵动岛尺寸信息 (基于屏幕尺寸按比例计算), 或 null。
 *
 * 尺寸比例基于 iPhone 15 Pro Max 真机 (430×932):
 *   - 宽: 125px / 430 ≈ 29%
 *   - 高: 37px / 932 ≈ 4%
 *   - 距顶部: 11px / 932 ≈ 1.2%
 */
function getDynamicIslandInfo(device: CanvasDeviceInfo): { width: number; height: number; topMargin: number; leftMargin: number; radius: number } | null {
  const label = (device.label || '').toLowerCase();
  const sizeKey = (device.sizeKey || '').toLowerCase();
  const glbFile = (device.glbFile || '').toLowerCase();

  // iPhone 14 Pro / 14 Pro Max / iPhone 15 全系列 / iPhone 16 全系列
  const hasDynamicIsland =
    glbFile.includes('iphone_15') ||
    glbFile.includes('iphone_16') ||
    label.includes('iphone 14 pro') ||
    label.includes('iphone 15') ||
    label.includes('iphone 16') ||
    sizeKey.includes('iphone14pro') ||
    sizeKey.includes('iphone15') ||
    sizeKey.includes('iphone16');

  if (!hasDynamicIsland) return null;

  const NOTCH_W_RATIO = 125 / 430;
  const NOTCH_H_RATIO = 37 / 932;
  const NOTCH_TOP_MARGIN_RATIO = 11 / 932;

  const notchW = Math.round(NOTCH_W_RATIO * device.width);
  const notchH = Math.round(NOTCH_H_RATIO * device.height);
  const topMargin = Math.round(NOTCH_TOP_MARGIN_RATIO * device.height);
  const leftMargin = Math.round((device.width - notchW) / 2);

  return {
    width: notchW,
    height: notchH,
    topMargin,
    leftMargin,
    radius: Math.round(notchH / 2),
  };
}

/**
 * ★ 2026-07-14: 构建画布尺寸约束提示词
 *
 * 无论是否触发强制画布关键词, 都会注入画布尺寸信息。
 * 这样 LLM 在生成任何 UI 代码时都能知道画布的实际尺寸。
 *
 * 优先级:
 *   1. 有设备约束 → 返回设备尺寸 + 设备类型布局建议
 *   2. 无设备约束 → 返回画布实际帧尺寸 (PreviewPanel 计算的)
 *   3. 都没有 → 返回默认尺寸 430×932 (iPhone 15 Pro Max)
 */
function buildCanvasSizeHint(canvasId?: string): string | null {
  const device = getDeviceConstraint(canvasId);
  if (device) {
    const groupHint =
      device.group === 'mobile' ? '使用移动端布局: 单列、大触摸区、底部导航' :
      device.group === 'watch'  ? '使用极简布局: 单元素、大字体、最少层级' :
      device.group === 'tablet' ? '可用双列或网格布局, 支持横竖屏' :
                                  '可用多列、侧边栏、密集信息布局';
    const screenHint =
      device.group === 'mobile' ? '竖屏窄宽度' :
      device.group === 'tablet' ? '中等宽度' :
      device.group === 'watch'  ? '极小圆形/方形屏幕' :
                                  '宽屏桌面';
    let hint = `## 画布尺寸约束
当前画布目标设备: ${device.label}
屏幕尺寸: ${device.width}×${device.height}px
设备类型: ${device.group}${device.renderMode === '3D' ? ' (3D 模式)' : ''}

**重要**: 你生成的 UI 必须严格适配此设备尺寸。
- 宽度必须不超过 ${device.width}px, 高度必须不超过 ${device.height}px
- 所有坐标和尺寸都基于 ${device.width}×${device.height} 的画布
- 布局要考虑 ${screenHint}
- ${groupHint}`;

    // ★ 灵动岛约束: 如果设备有灵动岛, 告诉 LLM 避开该区域
    const island = getDynamicIslandInfo(device);
    if (island) {
      const safeTop = island.topMargin + island.height + 8;
      hint += `

## 灵动岛约束 (Dynamic Island)
此设备屏幕顶部有灵动岛, 你生成的 UI 必须避开该区域:
- 灵动岛位置: 水平居中, 距顶部 ${island.topMargin}px
- 灵动岛尺寸: ${island.width}×${island.height}px (药丸形, 圆角半径 ${island.radius}px)
- 灵动岛左边距: ${island.leftMargin}px
- 灵动岛覆盖区域: x=${island.leftMargin}, y=${island.topMargin}, w=${island.width}, h=${island.height}

**关键**: 顶部内容的 padding-top 至少为 ${safeTop}px (灵动岛底部 ${island.topMargin + island.height}px + 8px 安全间距), 避免被灵动岛遮挡。
- 状态栏区域 (顶部 ${safeTop}px) 不要放置按钮、文字或图片
- 导航栏标题从 ${safeTop}px 开始向下排列`;
    }

    return hint;
  }

  // ★ 无设备约束时返回 null, 不注入尺寸提示
  //   之前返回默认 430×932 的提示, 导致普通对话被画布指令污染
  return null;
}

/**
 * 构建最终 prompt — 有设备时注入尺寸约束，有画布关键词时注入完整画布指令
 *
 * ★ FIX 2026-07-20: 之前对每条消息都注入画布尺寸约束 (即使没有画布关键词),
 *   导致普通对话被画布指令污染, LLM 返回一堆不相干的画布/UI 内容。
 *   现在只在 detectForceCanvas 返回非 null (用户明确要求画布操作) 时才注入。
 *
 * ★ FIX 2026-07-21: 进一步优化 — 当用户选了设备时, 即使没有画布关键词,
 *   也注入尺寸约束 (但不注入 DSL 格式指令), 让 LLM 始终知道目标设备尺寸。
 *   这样用户说"做个登录页面"时 LLM 也能生成适配设备尺寸的 UI。
 */
function buildPromptWithCanvasForce(prompt: string, canvasId?: string): string {
  const instruction = detectForceCanvas(prompt);
  const sizeHint = buildCanvasSizeHint(canvasId);

  if (instruction) {
    // 强制画布模式: 注入完整指令 + 尺寸约束
    return `${instruction}\n${sizeHint ?? ''}\n\n用户原始请求: ${prompt}`;
  }

  // ★ 有设备选中但无画布关键词: 只注入尺寸约束 (不注入 DSL 格式指令)
  //   这样 LLM 知道目标设备尺寸, 但不会被 DSL 格式规范污染
  if (sizeHint) {
    return `${sizeHint}\n\n用户原始请求: ${prompt}`;
  }

  // 普通对话: 不注入任何画布相关指令, 直接返回原始 prompt
  return prompt;
}

/**
 * 将前端 ChatRequest 映射为 Java Spring AI ChatRequest DTO
 *   POST /api/java-agent/api/chat/stream (Node.js 直连到 8770/api/chat/stream)
 *   Response: SSE stream — event:text/done/error, data:{...}
 */
function buildJavaRequestBody(req: ChatRequest): any {
  const settings = req.activeSettings || {};

  if (process.env.NODE_ENV === 'development') {
    console.log('[aiBackend] buildJavaRequestBody: mainProvider=' +
      (req.mainProvider?.model || 'none') +
      ', subProviders=' + (req.subProviders?.length || 0));
  }

  return {
    message: buildPromptWithCanvasForce(req.prompt, req.canvasId),
    sessionId: req.chatId ?? null,
    permissionMode: (req as any).mode || 'normal',
    provider: req.mainProvider
      ? {
          baseUrl: req.mainProvider.baseUrl,
          apiKey: req.mainProvider.apiKey,
          model: req.mainProvider.model,
          rateLimitProfile: req.mainProvider.rateLimitProfile || null,
        }
      : null,
    // 副模型列表: Java agent 事件带回前端流送区显示 (主模型 → agent (副模型))
    subProviders: (req.subProviders || []).map(sp => ({
      baseUrl: sp.baseUrl,
      apiKey: sp.apiKey,
      model: sp.model,
      rateLimitProfile: sp.rateLimitProfile || null,
    })),
    history: req.history || [],
    fileContext: req.fileContext || undefined,
    settings: {
      agentId: req.agentId || settings.agentId || 'code_agent',
      personality: settings.personality || 'professional',
      tone: settings.tone || 'detailed',
      emojiMode: settings.emojiMode || (settings.emojiEnabled ? settings.emojiType || 'standard' : 'off'),
      emojiEnabled: settings.emojiEnabled ?? false,
      emojiType: settings.emojiType || 'standard',
      enabledTools: req.activeTools || [],
      toolSchemas: req.toolSchemas || [],
      enabledSkills: req.activeSkills || settings.enabledSkills || [],
      enabledKnowledge: req.activeKnowledge || [],
      workspaceFolder: req.workspaceFolder || null,
      chatSessionId: req.chatId ?? null,
      canvasId: req.canvasId ?? null,
    },
    stream: true, // 2026-07-08: 启用真实流式
  };
}

/**
 * 执行 Java Agent 路径 (SSE 流式) — 唯一请求路径
 *
 * 请求失败直接抛出具体错误信息, 不允许降级。
 */
async function executeJavaPath(req: ChatRequest, signal: AbortSignal, taskId: string, onEvent: (e: ChatStreamEvent) => void | Promise<void>): Promise<void> {
  const res = await fetch('/api/java-agent/api/chat/stream', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'text/event-stream',
    },
    body: JSON.stringify(buildJavaRequestBody(req)),
    signal,
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    // ★ 不再降级, 直接抛出具体错误
    const errorMsg = errText
      ? `Java Agent 请求失败: HTTP ${res.status} — ${errText}`
      : `Java Agent 请求失败: HTTP ${res.status}`;
    onEvent({ kind: 'error', error: errorMsg, taskId });
    return;
  }

  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('text/event-stream')) {
    const result = await res.json().catch(() => null);
    // 处理 Java Agent JSON 响应: { success: false, error } → error 事件
    if (result && result.success === false) {
      onEvent({ kind: 'error', error: result.error || 'Unknown error', taskId });
      return;
    }
    if (result?.content) {
      onEvent({ kind: 'text', text: result.content, taskId });
    }
    onEvent({ kind: 'done', taskId });
    return;
  }

  // SSE stream parsing
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let currentEvent = '';
  let currentData = '';
  let doneSent = false;
  let sseDebugLineCount = 0;
  // ★ 启动 LLM 流式延迟追踪 (TTFT / 总时延 / 字节数)
  const latencyTracker = new StreamingLatencyTracker();
  latencyTracker.start(`llm-stream:${req.mainModel || 'java-agent'}`);

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) latencyTracker.recordChunk(value.byteLength);
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      // [DEBUG SSE] 打印前 30 行原始数据, 看 Java 后端实际返回了什么
      if (sseDebugLineCount < 30 && line.trim()) {
        console.log(`[SSE DEBUG] line#${sseDebugLineCount}: ${line.slice(0, 200)}`);
        sseDebugLineCount++;
      }
      if (line.startsWith('event:')) {
        currentEvent = line.substring(6).trim();
      } else if (line.startsWith('data:')) {
        currentData = line.substring(5).trim();
      } else if (line === '' || line === '\r') {
        if (currentEvent && currentData && !signal.aborted) {
          try {
            const data = JSON.parse(currentData);
            if (currentEvent === 'text' && data.content) {
              onEvent({ kind: 'text', text: data.content, taskId });
            } else if (currentEvent === 'phase') {
              onEvent({ kind: 'phase', phase: data.phase, taskId, ...data });
            } else if (currentEvent === 'agent') {
              onEvent({ kind: 'agent', agentId: data.agentId, name: data.name, avatar: data.avatar, role: data.role, domain: data.domain, modelBinding: data.modelBinding, mainModel: data.mainModel, subModels: data.subModels, subModel: data.subModel, taskId });
            } else if (currentEvent === 'usage') {
              // ★ Java Agent 发送的 token 统计事件
              onEvent({ kind: 'usage', usage: { promptTokens: data.promptTokens ?? 0, completionTokens: data.completionTokens ?? 0, totalTokens: data.totalTokens ?? 0, cachedTokens: data.cachedTokens }, taskId });
            } else if (currentEvent === 'error') {
              onEvent({ kind: 'error', error: data.error || 'Unknown error', taskId });
            } else if (currentEvent === 'done') {
              doneSent = true;
              // ★ 2026-07-14: await onEvent for done — 确保 flush()/tryLocalTranslateAndPush() 完成
              await onEvent({ kind: 'done', taskId, agentId: data.agentId });
            }
          } catch (e) {
            // [DEBUG SSE] 不再静默吞错, 打印解析失败的信息
            console.warn(`[SSE DEBUG] JSON.parse failed: event=${currentEvent}, data=${currentData.slice(0, 200)}, error=${e}`);
          }
        }
        currentEvent = '';
        currentData = '';
      }
    }
  }

  if (currentEvent && currentData && !signal.aborted) {
    try {
      const data = JSON.parse(currentData);
      if (currentEvent === 'text' && data.content) {
        onEvent({ kind: 'text', text: data.content, taskId });
      } else if (currentEvent === 'phase') {
        onEvent({ kind: 'phase', phase: data.phase, taskId, ...data });
      } else if (currentEvent === 'agent') {
        onEvent({ kind: 'agent', agentId: data.agentId, name: data.name, avatar: data.avatar, role: data.role, domain: data.domain, modelBinding: data.modelBinding, mainModel: data.mainModel, subModels: data.subModels, subModel: data.subModel, taskId });
      } else if (currentEvent === 'usage') {
        onEvent({ kind: 'usage', usage: { promptTokens: data.promptTokens ?? 0, completionTokens: data.completionTokens ?? 0, totalTokens: data.totalTokens ?? 0, cachedTokens: data.cachedTokens }, taskId });
      } else if (currentEvent === 'done') {
        doneSent = true;
        await onEvent({ kind: 'done', taskId, agentId: data.agentId });
      }
    } catch {}
  }

  // ★ 2026-07-11: 合成 done 事件
  if (!doneSent && !signal.aborted) {
    console.log('[aiBackend] Java SSE 流结束, 后端未发 done 事件 → 合成 done');
    await onEvent({ kind: 'done', taskId });
  }
  // ★ 结束延迟追踪, emit LatencySample
  latencyTracker.finish();
}

/**
 * dev (fetch SSE 流式) 实现
 * ★ 2026-07-14: 移除所有 fallback 降级逻辑, 只走 Java Agent 路径。
 *   请求失败直接抛出具体错误信息, 不允许降级。
 */
async function startChatViaFetch(req: ChatRequest, onEvent: (e: ChatStreamEvent) => void | Promise<void>): Promise<ChatHandle> {
  const taskId = `java-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const controller = new AbortController();
  const signal = controller.signal;

  const timeoutMs = 120_000;
  const timeoutId = setTimeout(() => {
    controller.abort();
    onEvent({ kind: 'error', error: `Java Agent 请求超时 (${timeoutMs / 1000}s)`, taskId });
  }, timeoutMs);

  (async () => {
    try {
      await executeJavaPath(req, signal, taskId, onEvent);
    } catch (err: any) {
      if (err?.name === 'AbortError') return;
      // ★ 不降级, 直接抛出具体错误
      onEvent({ kind: 'error', error: err?.message || String(err), taskId });
    } finally {
      clearTimeout(timeoutId);
    }
  })();

  return {
    taskId,
    abort: () => {
      clearTimeout(timeoutId);
      controller.abort();
    },
  };
}

/**
 * prod (Electron IPC) 实现 — 预留路径
 * 当前 preload.cjs 未暴露 dispatchAgent/onAgentEvent, 此函数不会被调用。
 * 未来若启用 IPC, main 进程应转发到 /api/java-agent/api/chat/stream。
 */
async function startChatViaIpc(req: ChatRequest, onEvent: (e: ChatStreamEvent) => void): Promise<ChatHandle> {
  const sf = (window as any).soloforge;
  if (!sf?.dispatchAgent || !sf?.onAgentEvent) {
    throw new Error('AI IPC backend unavailable (missing dispatchAgent / onAgentEvent)');
  }

  const taskId = `ipc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const unsubscribeAgent = sf.onAgentEvent?.((msg: any) => {
    if (!msg || typeof msg.type !== 'string') return;
    if (!msg.type.startsWith('phase')) return;
    onEvent({
      kind: 'phase',
      phase: msg.type,
      taskId,
      ...(msg.payload ?? {}),
    });
  });

  (async () => {
    try {
      const resp = await sf.dispatchAgent({
        _target: 'java-agent',
        ...buildJavaRequestBody(req),
      });
      if (!resp?.ok) {
        onEvent({ kind: 'error', error: `IPC dispatch failed: HTTP ${resp?.status} ${resp?.error ?? ''}`, taskId });
        return;
      }
      if (resp?.body?.content) {
        onEvent({ kind: 'text', text: resp.body.content, taskId });
      }
      onEvent({ kind: 'done', taskId });
    } catch (err: any) {
      onEvent({ kind: 'error', error: err?.message || String(err), taskId });
    }
  })();

  return {
    taskId,
    abort: () => {
      try { unsubscribeAgent?.(); } catch {}
    },
  };
}

/**
 * 统一入口: dev/prod 自动适配
 */
export function startChat(req: ChatRequest, onEvent: (e: ChatStreamEvent) => void | Promise<void>): Promise<ChatHandle> {
  if (isElectronIpcAvailable()) {
    return startChatViaIpc(req, onEvent);
  }
  return startChatViaFetch(req, onEvent);
}

export function maskApiKey(key: string | null | undefined): string {
  if (!key) return key === '' ? '(empty)' : '(none)';
  if (key.length <= 10) return '****';
  return key.slice(0, 5) + '****' + key.slice(-4);
}
