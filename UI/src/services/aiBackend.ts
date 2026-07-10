/**
 * aiBackend — 统一 AI 流式后端接口
 *   dev (浏览器 / Vite dev server) → USE_RACER ? /api/agents/dispatch (RACER) : /api/java-agent/api/chat/stream (Java SSE)
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
 */

export type ChatStreamEvent =
  | { kind: 'text'; text: string; taskId?: string }
  | { kind: 'phase'; phase: string; taskId?: string; [k: string]: any }
  | { kind: 'error'; error: string; taskId?: string }
  | { kind: 'done'; taskId?: string; experienceFingerprint?: string; strategy?: string };

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
  /** 前端配置的 LLM provider (apiKey + baseUrl + model), 传递给后端 */
  mainProvider?: { baseUrl: string; apiKey: string; model: string };
  /** 工作区文件夹路径 (用于 AI 作用域限制) */
  workspaceFolder?: string;
  /** 前端资源管理器选中的工具 ID 列表 (如 browser_devtools, bu_run_task, win_powershell) */
  activeTools?: string[];
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

const FORCE_CANVAS_INSTRUCTION = `[FORCE_CANVAS] 用户明确要求在画布上作画/展示。你必须:

## 优先策略 — 返回代码块 (零 token, 推荐)
SoloForge 前端内置 11 款本地翻译器, 会自动把你的代码块翻译成画布 AST 并推送渲染。
你只需在回复中用 markdown 代码块返回 UI 代码, 前端自动处理, 无需调用任何工具:
  - 网页:    \`\`\`html  / \`\`\`tsx  / \`\`\`vue
  - 移动端:  \`\`\`dart  / \`\`\`swift  / \`\`\`kotlin
  - 桌面端:  \`\`\`xml  / \`\`\`xaml  / \`\`\`qml
  - 脚本UI:  \`\`\`python  / \`\`\`c

## 仅以下场景才调用 canvas_push_ui 工具
- 图形/插画/图标/流程图 (用 svg 节点, 代码块无法表达)
- 用户明确要求"用 AST 推送"或"实时推送"

## 要求
1. 不要只回复文字, 必须有代码块或工具调用
2. 代码块要完整可渲染 (含布局结构 + 样式)
3. 末尾不要加 <<<PREVIEW_NEEDED>>> 标记 (前端会自动检测代码块)`;

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

/** 构建最终 prompt — 在原始 prompt 前注入强制画布指令 (若检测到关键词) */
function buildPromptWithCanvasForce(prompt: string): string {
  const instruction = detectForceCanvas(prompt);
  if (instruction) {
    return `${instruction}\n\n用户原始请求: ${prompt}`;
  }
  return prompt;
}

/**
 * 将前端 ChatRequest 映射为 Java Spring AI ChatRequest DTO
 *   POST /api/java-agent/api/chat/stream (Node.js 直连到 8770/api/chat/stream)
 *   Response: SSE stream — event:text/done/error, data:{...}
 */
// ── RACER 模式开关: true=Node.js RACER Agent, false=Java Agent ──
// 可通过 _setUseRacer(false) 在测试中关闭, 强制走 Java 路径
let _useRacer = true;
/** @internal 测试用: 切换 RACER / Java 路径 */
export function _setUseRacer(v: boolean): void { _useRacer = v; }
/** @internal 测试用: 获取当前模式 */
export function _getUseRacer(): boolean { return _useRacer; }

function buildRacerRequestBody(req: ChatRequest): any {
  return {
    prompt: buildPromptWithCanvasForce(req.prompt),
    chatId: req.chatId ?? `chat-${Date.now()}`,
    packetUuid: `pkt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    history: req.history || [],
    activeFile: req.activeFile || null,
    mainProvider: req.mainProvider || null,
    // 副模型列表: 并行 worker agent 使用 (winner 用 mainProvider, 其他用 subProviders)
    subProviders: req.subProviders || [],
    workspaceFolder: req.workspaceFolder || null,
    activeTools: req.activeTools || [],
    activeSkills: req.activeSkills || [],
    activeKnowledge: req.activeKnowledge || [],
  };
}

function buildJavaRequestBody(req: ChatRequest): any {
  const settings = req.activeSettings || {};
  return {
    message: buildPromptWithCanvasForce(req.prompt),
    sessionId: req.chatId ?? null,
    provider: req.mainProvider
      ? {
          baseUrl: req.mainProvider.baseUrl,
          apiKey: req.mainProvider.apiKey,
          model: req.mainProvider.model,
        }
      : null,
    history: req.history || [],
    fileContext: req.fileContext || undefined,
    settings: {
      agentId: req.agentId || settings.agentId || 'code_agent',
      personality: settings.personality || 'professional',
      tone: settings.tone || 'detailed',
      emojiMode: settings.emojiMode || (settings.emojiEnabled ? settings.emojiType || 'standard' : 'off'),
      emojiEnabled: settings.emojiEnabled ?? false,
      emojiType: settings.emojiType || 'standard',
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
 * 执行 Java Agent 路径 (SSE 流式)
 * 用于 USE_RACER=false 时的主路径，以及 RACER 失败时的 fallback
 */
async function executeJavaPath(req: ChatRequest, signal: AbortSignal, taskId: string, onEvent: (e: ChatStreamEvent) => void): Promise<void> {
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
    onEvent({ kind: 'error', error: `HTTP ${res.status} ${errText}`, taskId });
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

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
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
            } else if (currentEvent === 'error') {
              onEvent({ kind: 'error', error: data.error || 'Unknown error', taskId });
            } else if (currentEvent === 'done') {
              onEvent({ kind: 'done', taskId });
            }
          } catch {}
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
      } else if (currentEvent === 'done') {
        onEvent({ kind: 'done', taskId });
      }
    } catch {}
  }
}

/**
 * Parse RACER SSE stream — handles phase, text, done, error events.
 * Same wire format as Java Agent SSE, with additional phase events.
 */
async function parseRacerSSE(
  res: Response,
  signal: AbortSignal,
  taskId: string,
  onEvent: (e: ChatStreamEvent) => void,
): Promise<void> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let currentEvent = '';
  let currentData = '';

  const processEvent = (): void => {
    if (!currentEvent || !currentData || signal.aborted) return;
    try {
      const data = JSON.parse(currentData);
      switch (currentEvent) {
        case 'text':
          if (data.content) {
            onEvent({ kind: 'text', text: data.content, taskId });
          }
          break;
        case 'phase':
          onEvent({ kind: 'phase', phase: data.phase, taskId, ...data });
          break;
        case 'error':
          onEvent({ kind: 'error', error: data.error || 'Unknown error', taskId });
          break;
        case 'done':
          onEvent({ kind: 'done', taskId, experienceFingerprint: data.experienceFingerprint, strategy: data.strategy });
          break;
      }
    } catch { /* ignore malformed JSON */ }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (line.startsWith('event:')) {
        currentEvent = line.substring(6).trim();
      } else if (line.startsWith('data:')) {
        currentData = line.substring(5).trim();
      } else if (line === '' || line === '\r') {
        processEvent();
        currentEvent = '';
        currentData = '';
      }
    }
  }

  // Process any remaining event in buffer
  processEvent();
}

/**
 * dev (fetch SSE 流式) 实现
 * 流程:
 *   1) USE_RACER=true 时优先走 Node.js RACER Agent (/api/agents/dispatch)
 *   2) RACER 非超时失败时自动 fallback 到 Java Agent (/api/java-agent/api/chat/stream)
 *   3) RACER 超时 (AbortError) 不 fallback — 说明后端整体不可用
 *   4) USE_RACER=false 时直接走 Java Agent
 */
async function startChatViaFetch(req: ChatRequest, onEvent: (e: ChatStreamEvent) => void): Promise<ChatHandle> {
  const backend = _useRacer ? 'racer' : 'java';
  const taskId = `${backend}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const controller = new AbortController();
  const signal = controller.signal;

  const timeoutMs = 120_000;
  const timeoutId = setTimeout(() => {
    controller.abort();
    onEvent({ kind: 'error', error: `${backend === 'racer' ? 'RACER Agent' : 'Java Agent'} request timeout (${timeoutMs / 1000}s)`, taskId });
  }, timeoutMs);

  (async () => {
    try {
      if (_useRacer) {
        // ── RACER path: Node.js AgentDecisionOrchestrator (SSE streaming) ──
        //   Sends Accept: text/event-stream to get real-time phase events
        //   Falls back to JSON if server doesn't support SSE
        //   Non-timeout errors auto-fallback to Java Agent
        try {
          const res = await fetch('/api/agents/dispatch', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Accept': 'text/event-stream',
            },
            body: JSON.stringify(buildRacerRequestBody(req)),
            signal,
          });

          if (!res.ok) {
            const errText = await res.text().catch(() => '');
            let errMsg = `HTTP ${res.status}`;
            try { errMsg = JSON.parse(errText).error || errMsg; } catch { errMsg = errText || errMsg; }
            throw new Error(errMsg);
          }

          const contentType = res.headers.get('content-type') || '';
          if (contentType.includes('text/event-stream') && res.body) {
            // ── SSE streaming path ──
            await parseRacerSSE(res, signal, taskId, onEvent);
          } else {
            // ── Fallback: JSON response (server didn't return SSE) ──
            const result = await res.json();
            if (result.output) {
              onEvent({ kind: 'text', text: result.output, taskId });
            }
            onEvent({ kind: 'done', taskId });
          }
        } catch (racerErr: any) {
          if (racerErr?.name === 'AbortError') {
            return;
          }
          // RACER 非超时错误 → fallback 到 Java Agent
          const reason = racerErr?.message || String(racerErr);
          onEvent({ kind: 'phase', phase: 'fallback_to_java', taskId, reason });
          try {
            await executeJavaPath(req, signal, taskId, onEvent);
          } catch (javaErr: any) {
            if (javaErr?.name === 'AbortError') return;
            onEvent({ kind: 'error', error: `RACER failed (${reason}), Java fallback also failed: ${javaErr?.message || javaErr}`, taskId });
          }
        }

      } else {
        // ── Java path: legacy Spring AI Agent ──
        await executeJavaPath(req, signal, taskId, onEvent);
      }
    } catch (err: any) {
      if (err?.name === 'AbortError') return;
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
export function startChat(req: ChatRequest, onEvent: (e: ChatStreamEvent) => void): Promise<ChatHandle> {
  if (isElectronIpcAvailable()) {
    return startChatViaIpc(req, onEvent);
  }
  return startChatViaFetch(req, onEvent);
}
