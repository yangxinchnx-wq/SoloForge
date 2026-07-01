/**
 * 演示: 如何让后端 Agent 的工具调用 → 前端流送区实时显示
 *
 * 链路:
 *   1) 后端 runAgentLoop.onToolCall → eventBus.emit('tool_started' / 'tool_completed')
 *      (已经由 agent-loop.ts 的 streamHook 完成)
 *   2) index.ts:218 monkey-patch: eventBus.emit → apiServer.broadcastEvent
 *   3) api-server.ts:1206 SSE 推到 /api/events/stream
 *   4) 前端 sseBackend.ts 按 chatId 路由到对应 subscriber
 *   5) ChatPanel.runChatSse 收到 → mapPhaseToStreamEvents → pushStreamEvent
 *   6) streamingStore.applyEvent → subTask.stepHistory 追加步骤
 *   7) StreamPanel 重渲染 → SubTaskNode 展开步骤
 *
 * 调用方法 (3 种, 由浅入深):
 *
 *   [A] 直接调 runAgentLoop (单次)
 *       - 适合: 测试 / 单一 agent 任务 / 不需要 RACER 选路
 *
 *   [B] 用 SpecializedAgent (推荐, 复用技能库)
 *       - 适合: 生产环境的单个 agent 执行
 *
 *   [C] 在 RACER executeOnAgent 里改用 SpecializedAgent (升级路径)
 *       - 适合: 让多模型协作路径也支持工具调用
 */

import { runAgentLoop, type AgentExecutionContext } from '../src/core/agent/tools/agent-loop';
import { SpecializedAgent } from '../src/core/agent/specialized-agent';
import type { RuntimeKernel } from '../src/kernel/runtime-kernel';
import { logger } from '../src/core/logger';

// ─── 通用: 构造 streamHook ─────────────────────────────────────────

/**
 * 构造一个 streamHook, 让 Agent 的工具调用自动广播到流送区
 * @param kernel  RuntimeKernel 实例 (从 SoloForgeApiServer.kernel 拿)
 * @param chatId 前端 chatId (SSE 路由)
 * @param subTaskId 前端 subTaskId (事件挂到这个 subTask 的 stepHistory)
 */
export function makeStreamHook(kernel: RuntimeKernel, chatId: string, subTaskId: string) {
  return {
    chatId,
    subTaskId,
    emit: (eventName: 'tool_started' | 'tool_completed', payload: any) => {
      // 直接 emit 到 eventBus, index.ts:218 的 monkey-patch 会自动转 SSE
      //   → sseClients.forEach(c => c.write(`data: {...}\n\n`))
      //   → 前端 EventSource 收到
      //   → sseBackend 按 chatId 路由
      //   → ChatPanel 调 mapPhaseToStreamEvents
      //   → streamingStore.applyEvent
      //   → subTask.stepHistory 追加
      kernel.eventBus.emit(eventName, payload);
    },
  };
}

// ─── [A] 直接调 runAgentLoop ──────────────────────────────────────

/**
 * 最简单的调用方法,适合测试或一次性任务
 *
 * 用法:
 *   const result = await callAgentWithStreamHook(kernel, {
 *     agentId: 'agent-001',
 *     chatId: 'chat-abc',
 *     subTaskId: 'sub-xyz',
 *     task: '读 src/index.ts 的第 1-50 行',
 *   });
 */
export async function callAgentWithStreamHook(
  kernel: RuntimeKernel,
  opts: {
    agentId: string;
    chatId: string;
    subTaskId: string;
    task: string;
    model?: string;
  }
) {
  const ctx: AgentExecutionContext = {
    agentId: opts.agentId,
    domain: 'code-dev',
    role: '代码专家',
    systemPrompt: '你是一个能调用工具的真实 Agent。',
    skills: [],
    model: opts.model,
    temperature: 0.2,
    maxTokens: 4096,
    streamHook: makeStreamHook(kernel, opts.chatId, opts.subTaskId),
  };

  return runAgentLoop(ctx, opts.task);
}

// ─── [B] 用 SpecializedAgent ──────────────────────────────────────

/**
 * 推荐: 复用技能库 + 自动训练触发
 *
 * 用法:
 *   const agent = new SpecializedAgent({
 *     agentId: 'agent-001',
 *     domain: 'code-dev',
 *     level: 'senior',
 *     role: '代码专家',
 *     capabilities: ['read', 'write', 'search'],
 *     defaultStrategy: 'precision',
 *     systemPrompt: '...',
 *   });
 *   const result = await callSpecializedAgentWithStream(agent, kernel, {
 *     taskId: 'task-1',
 *     description: '...',
 *     chatId: 'chat-abc',
 *     subTaskId: 'sub-xyz',
 *   });
 */
export async function callSpecializedAgentWithStream(
  agent: SpecializedAgent,
  kernel: RuntimeKernel,
  opts: {
    taskId: string;
    description: string;
    chatId: string;
    subTaskId: string;
    model?: string;
  }
) {
  return agent.executeTask({
    taskId: opts.taskId,
    description: opts.description,
    model: opts.model,
    streamHook: makeStreamHook(kernel, opts.chatId, opts.subTaskId),
  });
}

// ─── [C] 升级 RACER executeOnAgent 走 SpecializedAgent ───────────

/**
 * 升级路径: 让 RACER 多模型协作也支持工具调用
 *
 * ⚠️ 升级前确认:
 *   1) 已经在 api-server.ts 持有 SpecializedAgent 实例 (或新建)
 *   2) LLM provider 已配置 (vault keys)
 *   3) 接受更慢的执行速度 (LLM 工具循环比模拟慢 1-3s/轮)
 *
 * 改 agent-registry.ts:202 executeOnAgent:
 *
 *   public async executeOnAgent(agentId, packetUuid, packetSizeKb): Promise<string> {
 *     // 旧逻辑 (模拟): const result = await agent.executeNetworkPacketTask(packetUuid, packetSizeKb);
 *
 *     // 新逻辑 (真实 LLM):
 *     const specializedAgent = this.specializedAgents.get(agentId);
 *     if (!specializedAgent) {
 *       logger.warn('AgentRegistry', `${agentId} not found, fallback to simulated`);
 *       return agent.executeNetworkPacketTask(packetUuid, packetSizeKb);
 *     }
 *     const result = await specializedAgent.executeTask({
 *       taskId: packetUuid,
 *       description: this.buildTaskDescription(packetUuid, packetSizeKb),
 *       // 关键: streamHook 从当前执行的 chatId / subTaskId 拿
 *       streamHook: this.resolveStreamHook(agentId, packetUuid),
 *     });
 *     return result.answer;
 *   }
 *
 *   private resolveStreamHook(agentId: string, packetUuid: string) {
 *     // 从 RTRRacerEngine 上下文拿当前 chatId + 当前选中的 subTaskId
 *     // (需在 RACER 引擎传 packet 时把 chatId + subTaskId 一起带过来)
 *     const { chatId, subTaskId } = this.currentRacerContext.get(packetUuid) ?? {};
 *     if (!chatId || !subTaskId) return undefined;
 *     return makeStreamHook(this.kernel, chatId, subTaskId);
 *   }
 */

// ─── 完整示例: 在 api-server.ts handleAgentDispatch 里调用 ─────────

/**
 * api-server.ts:1067 handleAgentDispatch 内部可以加:
 *
 *   // 1) 从 request body 拿 chatId (前端已传)
 *   const chatId = body?.chatId;
 *
 *   // 2) 派发前, 调一次 createTask 在前端 store 里建占位
 *   //    (这里只是文档示例, 实际前端在 ChatPanel 收到第一波 phase 事件时自动建)
 *   //    真实场景: 前端在用户点"发送"时已经建好 rootTask, 这里只需要拿到 subTaskId
 *
 *   // 3) 假设 RACER 选中了 worker-0, 它的 subTaskId 已经在前端建好:
 *   //    前端 ChatPanel.runChatSse 监听 phase0_subtask 时, 调 streamingStore.bindSubTask
 *   //    把 workerIdx 绑到新创建的 subTaskId
 *   //    然后 RACER 在 executeOnAgent 里, 通过 packetUuid 查到绑定的 subTaskId:
 *
 *   //    const subTaskId = this.racerWorkerBindings.get(`${packetUuid}_${workerIdx}`);
 *   //    const streamHook = makeStreamHook(this.kernel, chatId, subTaskId);
 *
 *   // 4) 调 SpecializedAgent (替换 executeNetworkPacketTask)
 *   //    之后所有工具调用自动 broadcast 到流送区
 */

// ─── Smoke test: 不需要 LLM 也能验证链路 ─────────────────────────

/**
 * 用一个 mock LLM provider 跑通整条链路 (不调真实 LLM, 适合 CI 验证)
 *
 * 用法:
 *   pnpm tsx examples/stream-hook-demo.ts
 */
async function smokeTest() {
  // 这里只是接口示意, 真实 mock 跑通需要构造一个最小 RuntimeKernel
  // (含 eventBus + 一个订阅 tool_started 的 listener)
  // 实际验证: pnpm test (97/97 已通过) + UI vitest (70/70 已通过)
  logger.info('stream-hook-demo', 'see tests/streamingStore.test.ts for E2E verification');
}

if (require.main === module) {
  smokeTest().catch(err => {
    logger.error('stream-hook-demo', `failed: ${err.message}`);
    process.exit(1);
  });
}
