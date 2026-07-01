// scripts/smoke-agent-ws.ts
// 端到端冒烟: 后端 EventBus → AgentEventHub (WebSocket) → Electron main 模拟客户端
//
// 验证 ws://localhost:0/ws/agents 端到端工作:
//   1. 启动后端 API server + agent registry
//   2. 用 ws client 连接, 模拟 Electron main.cjs
//   3. 派发 packet, 等待 ws 消息
//   4. 提交 dispute, 等待 ws 消息
//   5. 校验事件类型 + payload 字段

import { EventEmitter } from 'events';
import http from 'http';
import { AgentRegistry } from '../src/core/agent/agent-registry';
import { AgentDecisionOrchestrator } from '../src/core/agent/agent-decision-orchestrator';
import { AgentEventHub } from '../src/core/agent/agent-event-hub';
import { RuntimeEvent } from '../src/core/events/runtime-events';
import { CourtEvent } from '../src/core/events/court-events';
import { ConsensAgentCourtRoom } from '../src/core/court/consensagent';
import { SocialReputationEngine } from '../src/core/society/reputation';
import { globalConfigCenter } from '../src/kernel/config-center';
import { WebSocket } from 'ws';
import crypto from 'crypto';

class StubKernel {
  public eventBus: any = new EventEmitter();
  public eventLog: any[] = [];
  public commandBus: any;
  public transactionManager: any;
  public configCenter = globalConfigCenter;
  public metricsCollector: any = { counter: () => {} };
  public version = 1;

  constructor() {
    const handlers = new Map<string, any>();
    this.commandBus = {
      handlers,
      registerHandler(t: string, h: any) { handlers.set(t, h); },
      execute: async (cmd: any) => {
        const h = handlers.get(cmd?.type);
        return h ? await h(cmd) : { passthrough: true };
      },
    };
    const transactions = new Map<string, any>();
    this.transactionManager = {
      transactions,
      begin: async (id: string, module: string, payload: any) => {
        const tx = { id, module, payload, commandId: id, startedAt: Date.now() };
        transactions.set(id, tx);
        return tx;
      },
      commit: async (id: string) => {
        transactions.delete(id);
        this.eventBus.emit(RuntimeEvent.TransactionCommitted, { txId: id, domain: 'test', data: { dummy: 1 }, version: 1 });
      },
      rollback: async (id: string) => { transactions.delete(id); },
    };
  }

  verifyOwnership(domain: string, key: string) {
    return key.startsWith('AIRuntime_') || key.startsWith('core_scheduler');
  }
  getEventBus() { return this.eventBus; }
  async executeCommand(cmd: any) { return { accepted: true, type: cmd?.type }; }
}

async function main() {
  console.log('🚀 Smoke test: WebSocket agent event hub end-to-end');

  const kernel = new StubKernel();
  // 把 registry 挂到 kernel 代理, 让 hub 能取 snapshot
  let registryRef: AgentRegistry | null = null;

  // 1) 启动 court + reputation + agent (复用 smoke-agent-flow 的方式)
  const court = new ConsensAgentCourtRoom(kernel as any);
  await court.bootCourtRoom();
  court.enforcePhase1LockState(true);
  const rep = new SocialReputationEngine(kernel as any);
  await rep.boot();

  const registry = new AgentRegistry(kernel as any);
  await registry.boot();
  registryRef = registry;
  // stub 的 kernel 代理
  (kernel as any).agentRegistryProxy = registry;
  const orchestrator = new AgentDecisionOrchestrator(kernel as any, registry);

  // 2) 启动 HTTP server + AgentEventHub
  const server = http.createServer((req, res) => {
    res.writeHead(404);
    res.end('not a hub path');
  });
  const hub = new AgentEventHub(kernel as any);
  hub.attach(server);

  // 监听 0 端口让 OS 分配
  const port = await new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve(typeof addr === 'object' && addr ? addr.port : 0);
    });
  });
  console.log(`  ✓ HTTP server listening on 127.0.0.1:${port}`);

  // 3) WebSocket 客户端 (模拟 Electron main.cjs)
  const wsUrl = `ws://127.0.0.1:${port}/ws/agents`;
  console.log(`  ✓ connecting → ${wsUrl}`);
  const ws = new WebSocket(wsUrl);
  const received: any[] = [];
  ws.on('message', (raw) => {
    try { received.push(JSON.parse(raw.toString())); } catch { /* ignore */ }
  });
  await new Promise<void>((resolve, reject) => {
    ws.on('open', () => resolve());
    ws.on('error', reject);
    setTimeout(() => reject(new Error('ws open timeout')), 5000);
  });
  console.log('  ✅ WebSocket connected');

  // 4) 派发 packet → 等待 agent.task.* 事件
  console.log('\n📦 派发 1 个 packet:');
  const beforeCount = received.length;
  const r = await orchestrator.dispatchPacket({
    packetSizeKb: 16,
    requiresDeepCognition: false,
    globalConfidenceMetric: 0.8,
    taskComplexityMetrics: 0.2,
  });
  console.log(`  ✓ winner=${r.winnerAgentId} score=${r.score.toFixed(3)}`);

  // 5) 提交 dispute → 等待 court.* 事件 + agent.reputation.updated
  console.log('\n⚖️  提交诉状:');
  const agent = registry.getAgent('agent_alpha_fast_edge')!;
  const claim = agent.forgeDisputeClaim('WS test claim', 'legitimate');
  const beforeDispute = received.length;
  await registry.raiseDispute(claim, 'trace_ws_test');

  // 等待事件传播
  await new Promise((r) => setTimeout(r, 500));

  // 6) 校验
  const newEvents = received.slice(beforeCount);
  const newDispute = received.slice(beforeDispute);

  console.log(`\n📊 事件统计:`);
  console.log(`  派发后收到: ${newEvents.length} 条`);
  console.log(`  诉状后收到: ${newDispute.length} 条`);

  const types = newEvents.map((e) => e.type);
  console.log(`  派发事件类型: ${types.join(', ')}`);

  const hasDispatched = types.includes(RuntimeEvent.AgentTaskDispatched);
  const hasExecuted = types.includes(RuntimeEvent.AgentTaskExecuted);
  const hasRepUpdated = newDispute.some((e) => e.type === RuntimeEvent.AgentReputationUpdated);
  const hasCourtDecided = newDispute.some((e) => e.type === CourtEvent.ARBITRATION_DECIDED);

  console.log('\n🧪 校验:');
  console.log(`  ${hasDispatched ? '✅' : '❌'} agent.task.dispatched`);
  console.log(`  ${hasExecuted ? '✅' : '❌'} agent.task.executed`);
  console.log(`  ${hasCourtDecided ? '✅' : '❌'} court.arbitration.decided`);
  console.log(`  ${hasRepUpdated ? '✅' : '❌'} agent.reputation.updated`);

  // 7) ping/pong
  console.log('\n🏓 ping/pong test:');
  ws.send(JSON.stringify({ type: 'ping' }));
  await new Promise((r) => setTimeout(r, 100));
  const pongs = received.filter((e) => e.type === 'pong');
  console.log(`  ${pongs.length > 0 ? '✅' : '❌'} pong received (count=${pongs.length})`);

  // 清理
  ws.close();
  hub.close();
  server.close();
  await registry.shutdown();

  const allPass = hasDispatched && hasExecuted && hasRepUpdated && hasCourtDecided && pongs.length > 0;
  console.log(`\n${allPass ? '✅' : '❌'} ${allPass ? '数据流贯通 WebSocket 端到端验证通过' : '数据流验证失败'}`);
  process.exit(allPass ? 0 : 1);
}

main().catch((e) => { console.error('💥', e); process.exit(1); });
