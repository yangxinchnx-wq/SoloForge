/**
 * aiBackend — 统一 AI 流式后端接口
 *   dev (浏览器 / Vite dev server) → fetch('/api/java-agent/chat/send') (POST 触发)
 *                                  → Node.js(3001) 透传到 Java Spring AI Agent(8770)
 *   prod (Electron) → window.soloforge.ai.chatViaPort (MessagePortMain 零拷贝)
 *                     (注: 当前 preload.cjs 未暴露 dispatchAgent, IPC 路径为预留)
 *
 * ChatPanel 只见这一个接口, 不知道底层是 fetch 还是 IPC
 *
 * 接口规范:
 *   startChat(req, onEvent) → { abort(): void }
 *   onEvent 收到的事件: { kind: 'text' | 'phase' | 'error' | 'done', ... }
 *
 * 2026-07-08 Phase 3: 运行时从 Node.js /api/agents/dispatch 切换到
 *            Java Spring AI /api/java-agent/chat/send (Node.js 透传到 8770)
 *            Java 服务当前为非流式 (单 JSON 响应), 仅 emit text + done
 */

export type ChatStreamEvent =
  | { kind: 'text'; text: string; taskId?: string }
  | { kind: 'phase'; phase: string; taskId?: string; [k: string]: any }
  | { kind: 'error'; error: string; taskId?: string }
  | { kind: 'done'; taskId?: string };

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

/**
 * 将前端 ChatRequest 映射为 Java Spring AI ChatRequest DTO
 *   POST /api/java-agent/api/chat/send (Node.js 透传到 8770/api/chat/send)
 *   Response: { success: boolean, content?: string, error?: string, sessionId, agentId }
 */
function buildJavaRequestBody(req: ChatRequest): any {
  const settings = req.activeSettings || {};
  return {
    message: req.prompt,
    sessionId: req.chatId ?? null,
    provider: req.mainProvider
      ? {
          baseUrl: req.mainProvider.baseUrl,
          apiKey: req.mainProvider.apiKey,
          model: req.mainProvider.model,
        }
      : null,
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
    },
    stream: false, // Java 服务当前为非流式
  };
}

/**
 * dev (fetch 触发) 实现
 * 流程:
 *   1) fetch POST /api/java-agent/chat/send → Node.js(3001) 透传到 Java(8770)
 *   2) Java AgentOrchestrator 复杂度分流 (单 Agent / 多 Agent 协作)
 *   3) 终态 JSON 返回 → emit text + done
 */
async function startChatViaFetch(req: ChatRequest, onEvent: (e: ChatStreamEvent) => void): Promise<ChatHandle> {
  const taskId = `java-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const controller = new AbortController();
  const signal = controller.signal;

  // 超时保护: LLM 调用可能挂起 (如服务商不可达), 120s 后自动 abort
  const timeoutId = setTimeout(() => {
    controller.abort();
    onEvent({ kind: 'error', error: '请求超时 (120s)：Java Agent 服务响应时间过长，请检查 8770 端口与 LLM 服务商连通性。', taskId });
  }, 120_000);

  (async () => {
    try {
      const res = await fetch('/api/java-agent/api/chat/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildJavaRequestBody(req)),
        signal,
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        onEvent({ kind: 'error', error: `HTTP ${res.status} ${errText}`, taskId });
        return;
      }

      const result = await res.json().catch(() => null);
      if (!signal.aborted) {
        if (result?.success === false) {
          onEvent({ kind: 'error', error: result?.error || 'Java Agent 返回失败', taskId });
          return;
        }
        // Java 返回 { success, content, sessionId, agentId }
        if (result?.content) {
          onEvent({ kind: 'text', text: result.content, taskId });
        }
        onEvent({ kind: 'done', taskId });
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
 * 未来若启用 IPC, main 进程应转发到 /api/java-agent/chat/send。
 */
async function startChatViaIpc(req: ChatRequest, onEvent: (e: ChatStreamEvent) => void): Promise<ChatHandle> {
  const sf = (window as any).soloforge;
  if (!sf?.dispatchAgent || !sf?.onAgentEvent) {
    throw new Error('AI IPC backend unavailable (missing dispatchAgent / onAgentEvent)');
  }

  const taskId = `ipc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // 订阅 agent 事件 (预留, Java 服务当前不推送 phase 事件)
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
        // main 进程应识别此标记并转发到 /api/java-agent/chat/send
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
