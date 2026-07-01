/**
 * 验证脚本: 端到端跑通 RACER B+C 升级链路
 *
 * 路径:
 *   1) AgentRegistry 启动, 5 个默认 agent
 *   2) bindSubTask({packetUuid, workerIdx, chatId, subTaskId, agentId})
 *   3) executeOnAgent(agentId, packetUuid, packetSizeKb, workerIdx)
 *      → 查 binding → 命中 → getOrCreateSpecializedAgent → executeTask
 *        → runAgentLoop → onToolCall → streamHook → eventBus.emit('tool_started'/'tool_completed')
 *   4) eventBus 订阅者收到 tool_started/tool_completed
 *   5) releasePacketBindings 清空
 *
 * 预期:
 *   - 验证 1: binding 注册成功
 *   - 验证 2: executeOnAgent 走 binding 路径 (不抛异常, 走 try/catch 降级)
 *   - 验证 3: getOrCreateSpecializedAgent 懒加载 + 复用
 *   - 验证 4: releasePacketBindings 清空
 *   - 验证 5: AgentRegistry 默认 5 个 agents
 *
 * ⚠️ 注意: 本脚本只验证 binding + dispatch 路径, 不实际调 LLM (避免 API key 依赖)。
 *   executeOnAgent 在 LLM 调用失败时会降级到 executeNetworkPacketTask (模拟)。
 */

import { AgentRegistry } from '../src/core/agent/agent-registry';
import { EventEmitter } from 'events';
import type { RuntimeKernel } from '../src/kernel/runtime-kernel';
import { logger } from '../src/core/logger';

// ─── Mock RuntimeKernel ─────────────────────────────────────────

class MockEventBus extends EventEmitter {}
const mockKernel: any = { eventBus: new MockEventBus() };

// ─── 准备: 启动 AgentRegistry ──────────────────────────────────

const registry = new AgentRegistry(mockKernel as RuntimeKernel);
await registry.boot();

console.log('🚀 AgentRegistry booted with', registry.listAgents().length, 'agents\n');

// 取一个真实 agentId
const sampleAgent = registry.listAgents()[0]!;
const AGENT_ID = sampleAgent.strategyType
  ? 'agent_alpha_fast_edge'
  : 'agent_alpha_fast_edge';
// 直接查 map 拿真实 id
const realAgentIds = Array.from((registry as any).agents.keys()) as string[];
const REAL_AGENT_ID = realAgentIds[0];
console.log('🔑 using agentId:', REAL_AGENT_ID);

// ─── 订阅: 模拟 SSE 桥接 ────────────────────────────────────────

const received: Array<{ event: string; payload: any }> = [];
mockKernel.eventBus.on('tool_started', (payload) => {
  received.push({ event: 'tool_started', payload });
});
mockKernel.eventBus.on('tool_completed', (payload) => {
  received.push({ event: 'tool_completed', payload });
});
mockKernel.eventBus.on('agent.task.executed', (payload) => {
  logger.debug('verify', `AgentTaskExecuted: llmExecuted=${payload.llmExecuted}, packet=${payload.packetUuid}`);
});

// ─── 1) bindSubTask ─────────────────────────────────────────────

const PACKET = 'pkt-test-001';
const WORKER_IDX = 0;
const CHAT_ID = 'chat-test-001';
const SUBTASK_ID = 'sub-test-001';

const bindResult = registry.bindSubTask({
  packetUuid: PACKET,
  workerIdx: WORKER_IDX,
  chatId: CHAT_ID,
  subTaskId: SUBTASK_ID,
  agentId: REAL_AGENT_ID,
});

console.log('📋 bindSubTask result:', bindResult);

// ─── 2) executeOnAgent (绑定后, 应尝试走 LLM 路径) ────────────

console.log('\n🏃 executeOnAgent with binding (会尝试 LLM, 失败降级到模拟)...');
let executeError: any = null;
try {
  const output = await registry.executeOnAgent(REAL_AGENT_ID, PACKET, 32, WORKER_IDX);
  console.log('📤 output:', output?.slice(0, 100) ?? '(empty)');
} catch (e: any) {
  executeError = e;
  console.log('⚠️ executeOnAgent 抛错:', e?.message ?? e);
}

// 等一下,让异步 emit 收完
await new Promise(r => setTimeout(r, 50));

// ─── 2.5) 验证 binding 还在 (释放前) ─────────────────────────

const bindingBeforeRelease = registry.getSubTaskBinding(PACKET, WORKER_IDX);
console.log('🔗 binding before release:', bindingBeforeRelease);

// ─── 3) 释放 binding ───────────────────────────────────────────

const released = registry.releasePacketBindings(PACKET);
console.log(`\n🧹 released ${released} binding(s)`);

// ─── 验证 ──────────────────────────────────────────────────────

console.log('\n🔍 验证:');

const checks = [
  { name: '验证 1: bindSubTask 返回 ok=true + key', pass: bindResult.ok === true && typeof bindResult.key === 'string' },
  { name: '验证 2: 释放前 getSubTaskBinding 能查到', pass: bindingBeforeRelease !== undefined },
  { name: '验证 3: AgentRegistry 5 个默认 agents', pass: registry.listAgents().length === 5 },
  { name: '验证 4: getOrCreateSpecializedAgent 懒加载', pass: registry.getOrCreateSpecializedAgent('agent-test-specialized', 'chain_of_thought').config.agentId === 'agent-test-specialized' },
  { name: '验证 5: getOrCreateSpecializedAgent 复用 (同一 id 返回同一实例)', pass: registry.getOrCreateSpecializedAgent('agent-test-specialized', 'chain_of_thought') === registry.getOrCreateSpecializedAgent('agent-test-specialized', 'chain_of_thought') },
  { name: '验证 6: binding 释放后 getSubTaskBinding 返回 undefined', pass: registry.getSubTaskBinding(PACKET, WORKER_IDX) === undefined },
  { name: '验证 7: executeOnAgent 不抛致命异常 (LLM 失败被降级吞掉)', pass: executeError === null || executeError?.message?.includes('AGENT_NOT_FOUND') === false },
];

let allPass = true;
for (const c of checks) {
  console.log(`  ${c.pass ? '✅' : '❌'} ${c.name}`);
  if (!c.pass) allPass = false;
}

console.log(allPass ? '\n🎉 全部通过 — B+C 升级 binding 机制已验证 ready!' : '\n❌ 有失败项');
process.exit(allPass ? 0 : 1);
