// scripts/smoke-llm-agent-bridge.ts
// 演示: LLM 如何调用 Agent 系统来"生成一个软件"

import { EventEmitter } from 'events';
import { AgentRegistry } from '../src/core/agent/agent-registry';
import { AgentDecisionOrchestrator } from '../src/core/agent/agent-decision-orchestrator';
import { TaskAgentBridge, LLMAgentTask } from '../src/core/agent/task-agent-bridge';
import { ConsensAgentCourtRoom } from '../src/core/court/consensagent';
import { SocialReputationEngine } from '../src/core/society/reputation';
import { globalConfigCenter } from '../src/kernel/config-center';

class StubKernel {
  public eventBus: any = new EventEmitter();
  public eventLog: any[] = [];
  public commandBus: any;
  public transactionManager: any;
  public configCenter = globalConfigCenter;
  public metricsCollector: any = { counter: () => {} };
  public version = 1;

  constructor() {
    const handlers = new Map();
    this.commandBus = {
      handlers,
      registerHandler(t: string, h: any) { handlers.set(t, h); },
      execute: async (cmd: any) => {
        const h = handlers.get(cmd?.type);
        return h ? await h(cmd) : { passthrough: true };
      }
    };
    this.transactionManager = {
      begin: async (id: string) => ({ id, commandId: id, payload: {} }),
      commit: async () => {},
      rollback: async () => {},
    };
    const orig = this.eventBus.emit.bind(this.eventBus);
    this.eventBus.emit = (e: string, p: any) => { this.eventLog.push({ e, p }); return orig(e, p); };
  }
  verifyOwnership(_: string, key: string) { return key.startsWith('AIRuntime_'); }
  getEventBus() { return this.eventBus; }
  async executeCommand() { return { accepted: true }; }
}

async function main() {
  console.log('='.repeat(70));
  console.log('  Demo: LLM 调用 Agent 系统生成一个 Todo 应用');
  console.log('='.repeat(70));

  const kernel = new StubKernel();

  // 1. 启动系统
  const court = new ConsensAgentCourtRoom(kernel as any);
  await court.bootCourtRoom();
  court.enforcePhase1LockState(true);
  const rep = new SocialReputationEngine(kernel as any);
  await rep.boot();

  const registry = new AgentRegistry(kernel as any);
  await registry.boot();
  const orchestrator = new AgentDecisionOrchestrator(kernel as any, registry);
  const bridge = new TaskAgentBridge(registry, orchestrator);

  // 2. 查看 Agent 池状态
  console.log('\n📊 当前 Agent 池状态:');
  const pool = bridge.getAgentPoolStatus();
  for (const a of pool) {
    console.log(`  ${a.available ? '✓' : '✗'} ${a.agentId.padEnd(35)} strategy=${a.strategy.padEnd(16)} rep=${a.reputation.toFixed(3)}`);
  }

  // 3. 模拟 LLM 分解任务: "生成一个 Todo 应用"
  console.log('\n🤖 LLM 任务分解: "帮我生成一个 Todo 应用"\n');

  const tasks: LLMAgentTask[] = [
    {
      taskId: 'task_001',
      taskType: 'architecture',
      description: '设计 Todo 应用的整体架构，包括前后端分离、数据库选型、API 设计',
      complexity: 0.8,
      requiresDeepCognition: true,
      context: { framework: 'react', backend: 'express', db: 'sqlite' }
    },
    {
      taskId: 'task_002',
      taskType: 'code_generation',
      description: '生成 React 前端组件: TodoList, TodoItem, AddTodo, 使用 TypeScript',
      complexity: 0.5,
      requiresDeepCognition: false,
      context: { framework: 'react', language: 'typescript' }
    },
    {
      taskId: 'task_003',
      taskType: 'code_generation',
      description: '生成 Express 后端 API: CRUD 操作, RESTful 设计',
      complexity: 0.5,
      requiresDeepCognition: false,
      context: { framework: 'express', language: 'typescript' }
    },
    {
      taskId: 'task_004',
      taskType: 'testing',
      description: '生成前端组件的单元测试用例, 使用 Vitest + Testing Library',
      complexity: 0.3,
      requiresDeepCognition: false,
      context: { testFramework: 'vitest' }
    },
    {
      taskId: 'task_005',
      taskType: 'documentation',
      description: '生成 README.md 和 API 文档',
      complexity: 0.2,
      requiresDeepCognition: false,
    },
  ];

  // 4. 逐个执行任务，观察 RACER 选路
  const results = [];
  for (const task of tasks) {
    console.log(`\n📋 任务 [${task.taskType}] ${task.description.slice(0, 50)}...`);
    console.log(`   复杂度: ${task.complexity} | 深度推理: ${task.requiresDeepCognition}`);

    const result = await bridge.executeTask(task);
    results.push(result);

    const agent = registry.getAgent(result.agentId);
    const rep = agent?.reputationScore ?? 0;
    console.log(`   → 选中 Agent: ${result.agentId} (${result.strategy})`);
    console.log(`   → 置信度: ${result.confidence.toFixed(3)} | 耗时: ${result.durationMs}ms`);
    console.log(`   → Agent 信誉: ${rep.toFixed(3)}`);
  }

  // 5. 最终 Agent 池状态
  console.log('\n' + '='.repeat(70));
  console.log('📊 任务执行后 Agent 池状态:');
  for (const a of registry.snapshot()) {
    console.log(
      `  ${a.agentId.padEnd(35)} ` +
      `strategy=${a.strategyType.padEnd(16)} ` +
      `rep=${a.reputationScore.toFixed(3)} ` +
      `executions=${a.totalExecutions} ` +
      `wins=${a.totalWins}`
    );
  }

  // 6. 展示 Gossip 效果
  console.log('\n🗣️  Gossip 闲谈传播后声誉变化:');
  const gossipEngine = registry.reputationEngine;
  for (const snap of gossipEngine.snapshot()) {
    const c = snap.components;
    console.log(
      `  ${snap.entityId.padEnd(35)} ` +
      `能力=${c.competence.toFixed(2)} ` +
      `可靠=${c.reliability.toFixed(2)} ` +
      `诚实=${c.integrity.toFixed(2)} ` +
      `协作=${c.collaboration.toFixed(2)} ` +
      `聚合=${snap.aggregateScore.toFixed(3)}`
    );
  }

  await registry.shutdown();
  console.log('\n✅ Demo 完成');
}

main().catch(e => { console.error('💥', e); process.exit(1); });
