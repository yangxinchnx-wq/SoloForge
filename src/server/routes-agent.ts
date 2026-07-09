// ────────────────────────────────────────────────────────────
// SoloForge API Server — Agent Routes
// Path: src/server/routes-agent.ts
//
// Endpoints:
//   GET  /api/agents/snapshot        — pool snapshot + live scores
//   POST /api/agents/dispatch        — RACER routing + execution
//   POST /api/agents/dispute         — raise dispute -> court -> credit
//   POST /api/agents/bindSubTask     — bind packetUuid:workerIdx -> subTaskId
//   POST /api/test/reputation-enqueue    — dev-only: emit ReputationIncrementRequested
//   GET  /api/test/reputation-bridge-status — dev-only: bridge stats
// ────────────────────────────────────────────────────────────

import type { IncomingMessage, ServerResponse } from 'http';
import type { RuntimeKernel } from '../kernel/runtime-kernel';
import type { AgentRegistry, AgentDispatchRequest } from '../core/agent/agent-registry';
import type { AgentDecisionOrchestrator } from '../core/agent/agent-decision-orchestrator';
import type { ApiResponse } from './types';
import { logger } from '../core/logger';

// ------------------------------------------------------------
// Dependency bag the agent routes need from the server.
// ------------------------------------------------------------

export interface AgentRouteDeps {
  kernel: RuntimeKernel;
  agentRegistry: AgentRegistry | null;
  agentOrchestrator: AgentDecisionOrchestrator | null;
  reputationOutboxBridge: any;
}

// ------------------------------------------------------------
// Handlers
// ------------------------------------------------------------

export async function handleAgentSnapshot(deps: AgentRouteDeps): Promise<ApiResponse> {
  if (!deps.agentRegistry) {
    return { status: 503, headers: { 'Content-Type': 'application/json' }, body: { error: 'AgentRegistry not initialized' } };
  }
  const snapshot = deps.agentRegistry.snapshot();
  return {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    body: { count: snapshot.length, cpuLoad: deps.agentRegistry.getCpuLoad(), agents: snapshot },
  };
}

export async function handleAgentDispatch(body: any, deps: AgentRouteDeps): Promise<ApiResponse> {
  if (!deps.agentOrchestrator) {
    return { status: 503, headers: { 'Content-Type': 'application/json' }, body: { error: 'AgentDecisionOrchestrator not initialized' } };
  }
  const payload = body?.payload ?? {};
  const mainProvider = body?.mainProvider ?? payload.mainProvider ?? null;
  const req: AgentDispatchRequest = {
    packetUuid: body?.packetUuid,
    packetSizeKb: body?.packetSizeKb,
    requiresDeepCognition: body?.requiresDeepCognition,
    globalConfidenceMetric: body?.globalConfidenceMetric,
    taskComplexityMetrics: body?.taskComplexityMetrics,
    chatId: body?.chatId,
    prompt: payload.prompt ?? body?.prompt,
    history: payload.history ?? body?.history,
    activeFile: payload.activeFile ?? body?.activeFile ?? null,
    mainProvider: mainProvider ? { baseUrl: mainProvider.baseUrl, apiKey: mainProvider.apiKey, model: mainProvider.model } : undefined,
    workspaceFolder: body?.workspaceFolder ?? payload.workspaceFolder,
    activeTools: body?.activeTools ?? undefined,
    activeSkills: body?.activeSkills ?? undefined,
    activeKnowledge: body?.activeKnowledge ?? undefined,
  };
  try {
    const result = await deps.agentOrchestrator.dispatchPacket(req);
    return { status: 200, headers: { 'Content-Type': 'application/json' }, body: result };
  } catch (e: any) {
    const errMsg = e?.message ?? String(e);
    let status = 500;
    if (errMsg.includes('LLM HTTP 429') || errMsg.includes('rate limit')) {
      status = 429;
    } else if (errMsg.includes('LLM HTTP 401') || errMsg.includes('Unauthorized')) {
      status = 401;
    } else if (errMsg.includes('LLM HTTP 404')) {
      status = 404;
    } else if (errMsg.includes('LLM HTTP')) {
      status = 502;
    }
    return { status, headers: { 'Content-Type': 'application/json' }, body: { error: errMsg } };
  }
}

/**
 * SSE variant of handleAgentDispatch — streams phase events in real-time.
 *
 * Protocol (same format as Java Agent SSE):
 *   event: phase
 *   data: {"phase":"phase0_subtask","packetUuid":"...","chatId":"...","subtasks":[...]}
 *
 *   event: phase
 *   data: {"phase":"phase1_worker_start","packetUuid":"...","chatId":"...","workerIdx":0,"modelName":"..."}
 *
 *   event: text
 *   data: {"content":"final LLM output"}
 *
 *   event: done
 *   data: {}
 *
 *   event: error
 *   data: {"error":"..."}
 */
export async function handleAgentDispatchSSE(
  req: IncomingMessage,
  res: ServerResponse,
  body: any,
  deps: AgentRouteDeps,
): Promise<void> {
  if (!deps.agentOrchestrator) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'AgentDecisionOrchestrator not initialized' }));
    return;
  }

  // SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const writeSSE = (event: string, data: any): void => {
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch { /* client disconnected */ }
  };

  // Build dispatch request (same logic as handleAgentDispatch)
  const payload = body?.payload ?? {};
  const mainProvider = body?.mainProvider ?? payload.mainProvider ?? null;
  const subProvidersRaw = body?.subProviders ?? payload.subProviders ?? null;
  const chatId: string = body?.chatId ?? payload.chatId ?? `chat-${Date.now()}`;
  const agentReq: AgentDispatchRequest = {
    packetUuid: body?.packetUuid,
    packetSizeKb: body?.packetSizeKb,
    requiresDeepCognition: body?.requiresDeepCognition,
    globalConfidenceMetric: body?.globalConfidenceMetric,
    taskComplexityMetrics: body?.taskComplexityMetrics,
    chatId,
    prompt: payload.prompt ?? body?.prompt,
    history: payload.history ?? body?.history,
    activeFile: payload.activeFile ?? body?.activeFile ?? null,
    mainProvider: mainProvider ? { baseUrl: mainProvider.baseUrl, apiKey: mainProvider.apiKey, model: mainProvider.model } : undefined,
    subProviders: Array.isArray(subProvidersRaw) ? subProvidersRaw.map((p: any) => ({ baseUrl: p.baseUrl, apiKey: p.apiKey, model: p.model })) : undefined,
    workspaceFolder: body?.workspaceFolder ?? payload.workspaceFolder,
    activeTools: body?.activeTools ?? undefined,
    activeSkills: body?.activeSkills ?? undefined,
    activeKnowledge: body?.activeKnowledge ?? undefined,
  };

  // Subscribe to orchestrator phase events on eventBus
  const phaseEventNames = [
    'phase0_subtask', 'phase0_skip',
    'phase1_worker_start', 'phase1_worker_done', 'phase1_worker_error',
    'phase2_judge', 'phase2_judge_error',
    'phase3_deliver_start', 'phase3_deliver_done',
  ];
  const listeners: Array<{ event: string; handler: (p: any) => void }> = [];
  for (const evtName of phaseEventNames) {
    const handler = (evtPayload: any) => {
      // Only forward events matching this chat
      if (evtPayload?.chatId === chatId) {
        writeSSE('phase', { phase: evtName, ...evtPayload });
      }
    };
    deps.kernel.eventBus.on(evtName, handler);
    listeners.push({ event: evtName, handler });
  }

  // Track client disconnect
  let aborted = false;
  req.on('close', () => { aborted = true; });

  try {
    const result = await deps.agentOrchestrator.dispatchPacket(agentReq);
    if (!aborted) {
      // Send final output as text event (single chunk)
      if (result.output) {
        writeSSE('text', { content: result.output });
      }
      // done 事件携带 token 用量,让前端/测试可见 (2026-07-09)
      writeSSE('done', {
        tokenUsage: result.tokenUsage,
        parallel: result.parallel,
        winnerAgentId: result.winnerAgentId,
        strategy: result.strategy,
        durationMs: result.durationMs,
        // 经验路径才有的指纹 (供前端 👍/👎 反馈定位经验)
        experienceFingerprint: result.experienceFingerprint,
      });
    }
  } catch (e: any) {
    if (!aborted) {
      writeSSE('error', { error: e?.message ?? String(e) });
    }
  } finally {
    // Unsubscribe from eventBus
    for (const { event, handler } of listeners) {
      deps.kernel.eventBus.off(event, handler);
    }
    try { if (!aborted) res.end(); } catch { /* ignore */ }
  }
}

export async function handleAgentDispute(body: any, deps: AgentRouteDeps): Promise<ApiResponse> {
  if (!deps.agentRegistry) {
    return { status: 503, headers: { 'Content-Type': 'application/json' }, body: { error: 'AgentRegistry not initialized' } };
  }
  const agentId = body?.agentId;
  const statement = body?.statement ?? 'Custody dispute over packet execution ordering';
  const attackMode = body?.attackMode ?? 'legitimate';
  if (!agentId) {
    return { status: 400, headers: { 'Content-Type': 'application/json' }, body: { error: 'agentId is required' } };
  }
  const agent = deps.agentRegistry.getAgent(agentId);
  if (!agent) {
    return { status: 404, headers: { 'Content-Type': 'application/json' }, body: { error: `agent not found: ${agentId}` } };
  }
  const traceId = body?.traceId ?? `trace_${Date.now()}`;
  const claim = agent.forgeDisputeClaim(statement, attackMode);
  try {
    const verdict = await deps.agentRegistry.raiseDispute(claim, traceId);
    return { status: 200, headers: { 'Content-Type': 'application/json' }, body: { claim, verdict, traceId } };
  } catch (e: any) {
    return { status: 500, headers: { 'Content-Type': 'application/json' }, body: { error: e.message } };
  }
}

export async function handleAgentBindSubTask(body: any, deps: AgentRouteDeps): Promise<ApiResponse> {
  if (!deps.agentRegistry) {
    return { status: 503, headers: { 'Content-Type': 'application/json' }, body: { error: 'AgentRegistry not initialized' } };
  }
  const { packetUuid, workerIdx, chatId, subTaskId, agentId } = body ?? {};
  if (!packetUuid || workerIdx === undefined || !chatId || !subTaskId || !agentId) {
    return { status: 400, headers: { 'Content-Type': 'application/json' }, body: { error: 'packetUuid, workerIdx, chatId, subTaskId, agentId are all required' } };
  }
  try {
    const result = deps.agentRegistry.bindSubTask({ packetUuid, workerIdx, chatId, subTaskId, agentId });
    return { status: 200, headers: { 'Content-Type': 'application/json' }, body: result };
  } catch (e: any) {
    return { status: 500, headers: { 'Content-Type': 'application/json' }, body: { error: e.message } };
  }
}

/**
 * 经验反馈 (2026-07-09) — 用户 👍/👎 更新经验 successRate
 *
 * 解决"LLM 回答错误仍保存记忆, 越做越错"弊端:
 *   👎 → successRate 下降, 连续 👎 低于 0.3 自动删除经验
 *   👍 → successRate 上升, 经验更稳定
 *
 * 请求体: { fingerprint?: string, prompt?: string, positive: boolean }
 *   - fingerprint 优先 (经验路径回复携带)
 *   - 无 fingerprint 时用 prompt 文本查找 (模糊匹配)
 */
export async function handleExperienceFeedback(body: any, deps: AgentRouteDeps): Promise<ApiResponse> {
  if (!deps.agentOrchestrator) {
    return { status: 503, headers: { 'Content-Type': 'application/json' }, body: { error: 'AgentDecisionOrchestrator not initialized' } };
  }
  const { fingerprint, prompt, positive } = body ?? {};
  if (typeof positive !== 'boolean') {
    return { status: 400, headers: { 'Content-Type': 'application/json' }, body: { error: 'positive (boolean) is required' } };
  }

  // 定位经验: 优先 fingerprint, 否则用 prompt 查找
  let fp = fingerprint;
  if (!fp && prompt) {
    fp = deps.agentOrchestrator.findExperienceFingerprint(prompt);
  }
  if (!fp) {
    return { status: 404, headers: { 'Content-Type': 'application/json' }, body: { error: 'experience not found', positive } };
  }

  try {
    const { alive, successRate } = deps.agentOrchestrator.rateExperience(fp, positive);
    logger.info('ExperienceFeedback', `fingerprint=${fp} positive=${positive} → alive=${alive} successRate=${successRate.toFixed(2)}`);
    return {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: {
        acknowledged: true,
        fingerprint: fp,
        positive,
        alive,           // false = 经验已失效删除 (连续 👎 淘汰)
        successRate,     // 当前成功率
        message: alive
          ? (positive ? '经验已强化, 将继续优先复用' : '经验已降权, 连续 👎 将自动失效')
          : '经验已因低分失效删除, 下次该问题将重新走 Agent Loop 解决',
      },
    };
  } catch (e: any) {
    return { status: 500, headers: { 'Content-Type': 'application/json' }, body: { error: e.message } };
  }
}

export function handleTestReputationBridgeStatus(deps: AgentRouteDeps): ApiResponse {
  if (!deps.reputationOutboxBridge) {
    return { status: 503, headers: { 'Content-Type': 'application/json' }, body: { error: 'ReputationOutboxBridge not started' } };
  }
  try {
    const status = deps.reputationOutboxBridge.getStatus();
    return { status: 200, headers: { 'Content-Type': 'application/json' }, body: status };
  } catch (e: any) {
    return { status: 500, headers: { 'Content-Type': 'application/json' }, body: { error: e.message } };
  }
}

export async function handleTestReputationEnqueue(body: any, deps: AgentRouteDeps): Promise<ApiResponse> {
  if (!deps.reputationOutboxBridge) {
    return { status: 503, headers: { 'Content-Type': 'application/json' }, body: { error: 'ReputationOutboxBridge not started' } };
  }
  if (!deps.kernel?.eventBus) {
    return { status: 503, headers: { 'Content-Type': 'application/json' }, body: { error: 'kernel/eventBus not ready' } };
  }
  const payload = {
    commandId: body?.commandId ?? `test_cmd_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    txId: body?.txId ?? `test_tx_${Date.now()}`,
    traceId: body?.traceId ?? `test_trace_${Date.now()}`,
    agentClusterId: body?.agentClusterId ?? 'test_cluster',
    reputationIncrement: typeof body?.reputationIncrement === 'number' ? body.reputationIncrement : 1.0,
    reasonCode: body?.reasonCode ?? 'TEST_HOOK_E2E',
    kernelVersionSeal: body?.kernelVersionSeal ?? 1,
    timestamp: Date.now(),
  };
  try {
    const { RuntimeEvent } = await import('../core/events/runtime-events');
    deps.kernel.eventBus.emit(RuntimeEvent.ReputationIncrementRequested, payload);
    return { status: 200, headers: { 'Content-Type': 'application/json' }, body: { ok: true, payload, note: 'emit done, outbox worker will push within 100ms' } };
  } catch (e: any) {
    return { status: 500, headers: { 'Content-Type': 'application/json' }, body: { error: e.message } };
  }
}
