/**
 * aiBackend — 统一 AI 流式后端接口
 *   dev (浏览器 / Vite dev server) → fetch('/api/agents/dispatch') (POST 触发)
 *                                  + sseBackend 订阅 '/api/events/stream' (phase 流送)
 *   prod (Electron) → window.soloforge.ai.chatViaPort (MessagePortMain 零拷贝)
 *
 * ChatPanel 只见这一个接口, 不知道底层是 fetch 还是 IPC
 *
 * 接口规范:
 *   startChat(req, onEvent) → { abort(): void }
 *   onEvent 收到的事件: { kind: 'text' | 'phase' | 'error' | 'done', ... }
 */

import { sseBackend } from './sseBackend';

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
 * dev (fetch 触发 + sseBackend 订阅 phase) 实现
 * 流程:
 *   1) 启动 sseBackend 订阅, phase 事件经 onEvent 推送
 *   2) fetch POST /api/agents/dispatch 触发后端 Orchestrator
 *   3) Orchestrator emit phase0/1/2/3 事件 → eventBus → SSE 广播 → 前端收到
 *   4) 终态 JSON 返回 → emit done
 */
async function startChatViaFetch(req: ChatRequest, onEvent: (e: ChatStreamEvent) => void): Promise<ChatHandle> {
  const taskId = `dispatch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const chatId = req.chatId;
  const controller = new AbortController();
  const signal = controller.signal;

  // 1) 订阅本 chatId 的 phase 事件 (多 chat 并发隔离)
  sseBackend.subscribe(chatId ?? '__no_chat__', onEvent);

  (async () => {
    try {
      // 2) 触发后端 Orchestrator
      const res = await fetch('/api/agents/dispatch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agentId: 'agent-001',
          taskType: 'execute',
          payload: { prompt: req.prompt, history: req.history, activeFile: req.activeFile },
          chatId,
        }),
        signal,
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        onEvent({ kind: 'error', error: `HTTP ${res.status} ${errText}`, taskId });
        return;
      }

      // 3) Orchestrator 终态返回, emit done
      //    (中间 phase 由 sseBackend 通过 EventSource 推过来)
      const result = await res.json().catch(() => null);
      if (!signal.aborted) {
        onEvent({ kind: 'done', taskId });
      }
    } catch (err: any) {
      if (err?.name === 'AbortError') return;
      onEvent({ kind: 'error', error: err?.message || String(err), taskId });
    } finally {
      // 4) 取消本 chatId 订阅 (其他 chat 不受影响)
      if (chatId) sseBackend.unsubscribe(chatId);
    }
  })();

  return {
    taskId,
    abort: () => {
      controller.abort();
      if (chatId) sseBackend.unsubscribe(chatId);
    },
  };
}

/**
 * prod (Electron IPC) 实现
 * 流程:
 *   1) 订阅 onAgentEvent IPC, 收到 phase 事件 (含 chatId) 路由后转 onEvent
 *   2) dispatchAgent IPC 调 /api/agents/dispatch 触发后端 Orchestrator
 *   3) 终态返回 → emit done
 *   4) abort 时取消 IPC 订阅 + 不再处理结果
 */
async function startChatViaIpc(req: ChatRequest, onEvent: (e: ChatStreamEvent) => void): Promise<ChatHandle> {
  const sf = (window as any).soloforge;
  if (!sf?.dispatchAgent || !sf?.onAgentEvent) {
    throw new Error('AI IPC backend unavailable (missing dispatchAgent / onAgentEvent)');
  }

  const taskId = `ipc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const chatId = req.chatId;

  // 1) 订阅 agent 事件, 只把本 chatId 的 phase 路由到 onEvent
  const unsubscribeAgent = sf.onAgentEvent((msg: any) => {
    if (!msg || typeof msg.type !== 'string') return;
    // 只关心 phase 事件 (其他 agent.* / court.* 忽略)
    if (!msg.type.startsWith('phase')) return;
    // chatId 路由
    if (chatId && msg.payload?.chatId && msg.payload.chatId !== chatId) return;
    onEvent({
      kind: 'phase',
      phase: msg.type,
      taskId,
      ...(msg.payload ?? {}),
    });
  });

  // 2) 触发 dispatch (忽略响应, phase 走 IPC 推过来, 终态由 done 标识)
  (async () => {
    try {
      const resp = await sf.dispatchAgent({
        agentId: 'agent-001',
        taskType: 'execute',
        payload: { prompt: req.prompt, history: req.history, activeFile: req.activeFile },
        chatId,
      });
      if (!resp?.ok) {
        onEvent({ kind: 'error', error: `IPC dispatch failed: HTTP ${resp?.status} ${resp?.error ?? ''}`, taskId });
        return;
      }
      onEvent({ kind: 'done', taskId });
    } catch (err: any) {
      onEvent({ kind: 'error', error: err?.message || String(err), taskId });
    }
  })();

  return {
    taskId,
    abort: () => {
      // IPC dispatch 是 fire-and-forget, 没法中断后端在跑的 Orchestrator
      // 仅取消前端 phase 事件订阅
      try { unsubscribeAgent(); } catch {}
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