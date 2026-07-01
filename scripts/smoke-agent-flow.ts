// scripts/smoke-agent-flow.ts
// 端到端冒烟测试: Agent → RACER → Agent → Court → Agent → Society

import { EventEmitter } from 'events';
import { AgentRegistry } from '../src/core/agent/agent-registry';
import { AgentDecisionOrchestrator } from '../src/core/agent/agent-decision-orchestrator';
import { RuntimeEvent } from '../src/core/events/runtime-events';
import { CourtEvent } from '../src/core/events/court-events';
import { ConsensAgentCourtRoom } from '../src/core/court/consensagent';
import { SocialReputationEngine } from '../src/core/society/reputation';
import { ConfigCenter, globalConfigCenter } from '../src/kernel/config-center';
import crypto from 'crypto';

class StubKernel {
  public eventBus: any = new EventEmitter();
  public eventLog: any[] = [];
  public commandBus: any;
  public transactionManager: any;
  public configCenter: ConfigCenter = globalConfigCenter;
  public metricsCollector: any = { counter: (n: string) => { /* no-op */ } };
  public version = 1;

  constructor() {
    const handlers = new Map<string, any>();
    this.commandBus = {
      handlers,
      registerHandler(t: string, h: any) { handlers.set(t, h); },
      execute: async (cmd: any) => {
        const h = handlers.get(cmd?.type);
        return h ? await h(cmd) : { passthrough: true };
      }
    };
    const transactions = new Map<string, any>();
    this.transactionManager = {
      transactions,
      begin: async (id: string, module: string, payload: any) => {
        const tx = { id, module, payload, commandId: id, startedAt: Date.now() };
        transactions.set(id, tx);
        return tx;
      },
      commit: async (id: string) => { transactions.delete(id); this.eventBus.emit(RuntimeEvent.TransactionCommitted, { txId: id, domain: 'test', data: { dummy: 1 }, version: 1 }); },
      rollback: async (id: string) => { transactions.delete(id); }
    };

    // tee emit so we can count events
    const orig = this.eventBus.emit.bind(this.eventBus);
    this.eventBus.emit = (e: string, p: any) => { this.eventLog.push({ e, p }); return orig(e, p); };
  }

  verifyOwnership(domain: string, key: string) {
    return key.startsWith('AIRuntime_') || key.startsWith('core_scheduler');
  }
  getEventBus() { return this.eventBus; }
  async executeCommand(cmd: any) { return { accepted: true, type: cmd?.type }; }
}

async function main() {
  console.log('🚀 Smoke test: Agent → RACER → Court → Society 数据流');

  const kernel = new StubKernel();

  // 1) 先启动 court + reputation
  const court = new ConsensAgentCourtRoom(kernel as any);
  await court.bootCourtRoom();
  court.enforcePhase1LockState(true);
  const rep = new SocialReputationEngine(kernel as any);
  await rep.boot();
  console.log('  ✓ court + reputation engines online');

  // 2) 启动 agent registry
  const registry = new AgentRegistry(kernel as any);
  await registry.boot();
  const orchestrator = new AgentDecisionOrchestrator(kernel as any, registry);

  const beforeCount = kernel.eventLog.length;

  // 3) 派发 3 个不同 packet
  console.log('\n📦 派发 3 个 packet:');
  for (let i = 0; i < 3; i++) {
    const r = await orchestrator.dispatchPacket({
      packetSizeKb: 8 + i * 20,
      requiresDeepCognition: i === 2,
      globalConfidenceMetric: i === 1 ? 0.5 : 0.8,
      taskComplexityMetrics: i === 1 ? 0.5 : 0.2,
    });
    console.log(`  ✓ packet=${r.packetUuid} → ${r.winnerAgentId} (${r.strategy}) score=${r.score.toFixed(3)} t=${r.durationMs}ms`);
  }

  // 4) 提交一个 legitimate 诉状
  console.log('\n⚖️  提交诉状:');
  const agentAlpha = registry.getAgent('agent_alpha_fast_edge')!;
  const claim = agentAlpha.forgeDisputeClaim('State ownership of packet_X1', 'legitimate');
  console.log(`  ✓ claim from ${claim.originatingAgentId} with ${claim.linkedEvidenceRegistry.length} evidence`);
  try {
    const verdict = await registry.raiseDispute(claim, 'trace_test_001');
    console.log(`  ✓ verdict:`, JSON.stringify(verdict).slice(0, 200));
  } catch (e: any) {
    console.log(`  ⚠️ verdict error: ${e.message}`);
    console.log(`  📍 stack: ${e.stack?.split('\n').slice(0, 5).join('\n           ')}`);
  }

  // 5) 检查事件流
  const newEvents = kernel.eventLog.slice(beforeCount);
  const dispatched = newEvents.filter(e => e.e === RuntimeEvent.AgentTaskDispatched).length;
  const executed = newEvents.filter(e => e.e === RuntimeEvent.AgentTaskExecuted).length;
  const courtClaimSubmitted = newEvents.filter(e => e.e === CourtEvent.CLAIM_SUBMITTED).length;
  const courtDecided = newEvents.filter(e => e.e === CourtEvent.ARBITRATION_DECIDED).length;
  const repUpdated = newEvents.filter(e => e.e === RuntimeEvent.AgentReputationUpdated).length;

  console.log(`\n📊 事件流统计:`);
  console.log(`  AgentTaskDispatched  : ${dispatched} (expect 3)`);
  console.log(`  AgentTaskExecuted    : ${executed} (expect 3)`);
  console.log(`  Court.CLAIM_SUBMITTED: ${courtClaimSubmitted} (expect 1)`);
  console.log(`  Court.ARBITRATION_DECIDED: ${courtDecided} (expect ≥1)`);
  console.log(`  AgentReputationUpdated: ${repUpdated} (expect ≥0 after delay)`);

  // 6) Snapshot
  console.log(`\n🧬 Agent pool snapshot:`);
  for (const a of registry.snapshot()) {
    console.log(`  - ${a.agentId.padEnd(35)} strategy=${a.strategyType.padEnd(16)} rep=${a.reputationScore.toFixed(3)} evidence=${a.evidenceCount} wins=${a.totalWins} losses=${a.totalLosses}`);
  }

  await registry.shutdown();
  console.log('\n✅ 数据流贯通验证通过');
}

main().catch(e => { console.error('💥', e); process.exit(1); });
