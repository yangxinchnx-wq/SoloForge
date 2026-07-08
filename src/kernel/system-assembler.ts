// ─────────────────────────────────────────────────────────────────
// SoloForge Assembly Layer: Shared Cold-Boot Factory
// Path: src/kernel/system-assembler.ts
// Description: 共享冷启动工厂 — index.ts 和 bootstrap.ts 的去重产物
//
// 职责边界：
//   - 创建所有核心总线桩 (commandBus, transactionManager, etc.)
//   - 初始化 Garnet 热数据层
//   - 渐进式加载真实物理组件（弹性防御）
//   - 注入 kernel.bootstrapCoreLinkages
//   - 初始化所有领域引擎和消费者
//   - 返回 AssemblyContext 供调用方做入口特定逻辑
//
// TODO: 后续可进一步将领域引擎初始化拆为可插拔的 Phase 注册表
// ─────────────────────────────────────────────────────────────────

import { RuntimeKernel } from './runtime-kernel';
import { logger } from '../core/logger';

// 🔥 热数据层
import { connect as garnetConnect } from '../data/garnet/index';
import { getClient as getGarnetClient } from '../data/garnet/client';

// 领域引擎
import { RoleEvolutionEngine } from '../core/society/role-evolution';
import { CoalitionEngine } from '../core/society/coalition';
import { SocialMemoryEngine } from '../core/society/social-memory';
import { LawEngine } from '../core/law/law-engine';
import { SocialReputationEngine } from '../core/society/reputation';
import { InstitutionEngine } from '../core/society/institution';
import { GovernancePolicyEngine } from '../core/society/governance';
import { ConsensAgentCourtRoom } from '../core/court/consensagent';
import { LlmEscalationRoom } from '../core/court/llm_escalation';
import { DistributedProtocolBroker } from './orchestration/distributed-broker';
import { TelemetryMetricExporter } from './observability/telemetry-exporter';
import { RaftConsensusNode } from './consensus/raft-consensus-node';
import { SurrealPersistence } from '../data/surreal_persistence';

// 消费者
import { initializeSocietyEvolutionConsumer } from '../data/consumers/society-evolution-consumer';
import { initializeSocialMemoryConsumer } from '../data/consumers/social-memory-consumer';
import { initializeLawComplianceConsumer } from '../data/consumers/law-compliance-consumer';
import { initializeReputationAnalyticsConsumer } from '../data/consumers/reputation-analytics-consumer';
import { initializeCourtAdjudicationConsumer } from '../data/consumers/court-adjudication-consumer';
import { initializeTelemetryAggregationConsumer } from '../data/consumers/telemetry-aggregation-consumer';
import { initializeConsensusAuditConsumer } from '../data/consumers/consensus-audit-consumer';

// ============================================================
// 类型定义
// ============================================================

export interface AssemblyContext {
  kernel: RuntimeKernel;
  commandBus: any;
  transactionManager: any;
  projectionManager: any;
  snapshotManager: any;
  scheduler: any;

  // 领域引擎
  roleEvolution: RoleEvolutionEngine;
  coalitionEngine: CoalitionEngine;
  socialMemory: SocialMemoryEngine;
  lawEngine: LawEngine;
  reputationEngine: SocialReputationEngine;
  institutionEngine: InstitutionEngine;
  governancePolicyEngine: GovernancePolicyEngine;
  primaryCourt: ConsensAgentCourtRoom;
  supremeCourt: LlmEscalationRoom;
  surrealPersistence: SurrealPersistence;

  // 基础设施
  distributedBroker: DistributedProtocolBroker;
  telemetryExporter: TelemetryMetricExporter;
  raftConsensusNode: RaftConsensusNode;
}

// ============================================================
// 工厂函数
// ============================================================

/**
 * 共享冷启动工厂
 * 同时被 index.ts (生产入口) 和 bootstrap.ts (测试/组装入口) 调用
 */
export async function assembleSystem(kernel: RuntimeKernel): Promise<AssemblyContext> {
  logger.info('SystemAssembler', '⚙️ 共享总装厂点火：执行纯净基础设施连线...');

  // ── 1. 刚性契约保底桩 ──
  let commandBus: any = {
    handlers: new Map<string, any>(),
    registerHandler: function (type: string, handler: any) {
      this.handlers.set(type, handler);
    },
    execute: async function (cmd: any) {
      const handler = this.handlers.get(cmd.type);
      if (handler) return await handler(cmd);
      return { success: true };
    },
  };
  let transactionManager: any = {
    transactions: new Map<string, any>(),
    begin: async function (id: string, module: string, payload: any) {
      const tx = { id, module, payload, startedAt: Date.now() };
      this.transactions.set(id, tx);
      return tx;
    },
    commit: async function (id: string) { this.transactions.delete(id); },
    rollback: async function (id: string, error: any) { this.transactions.delete(id); },
  };
  let projectionManager: any = { updateAll: () => {}, replayEvent: async () => {} };
  let snapshotManager: any = {
    createFullSnapshot: async () => 'snap_stub',
    recover: async () => {},
    replayEvent: async () => {},
  };
  let scheduler: any = {
    drain: async () => {},
    pushTask: async () => true,
    popTask: async () => null,
    getStats: async () => ({ queueSize: 0, totalPush: 0, totalPop: 0 }),
  };

  // ── 2. Garnet 热数据层 ──
  try {
    logger.info('SystemAssembler', '🔥 [Garnet Hot Layer] Initializing TTL-backed in-memory caches...');
    await garnetConnect();
    kernel.setGarnetClient(getGarnetClient());
    logger.info('SystemAssembler', '🔥 [Garnet Hot Layer] ✓ Session/Task/Counter/EventStream caches online.');
  } catch (garnetErr: any) {
    logger.warn('SystemAssembler', '⚠️ [Garnet Hot Layer] Connection failed - proceeding with direct SurrealDB writes', {
      error: garnetErr.message,
    });
  }

  // ── 3. 渐进式加载物理组件 ──
  try {
    const commandBusModule = await import('./command-bus').catch(() => null);
    const transactionManagerModule = await import('./transaction-manager').catch(() => null);
    const schedulerModule = await import('./scheduler-client').catch(() => null);

    if (commandBusModule?.CommandBus) {
      commandBus = new commandBusModule.CommandBus(kernel);
    }
    if (transactionManagerModule?.TransactionManager) {
      transactionManager = new transactionManagerModule.TransactionManager(kernel);
    }
    if (schedulerModule?.SoloForgeRustSchedulerClient) {
      scheduler = new schedulerModule.SoloForgeRustSchedulerClient();
      scheduler.initialize?.();
      kernel.schedulerClient = scheduler;
      logger.info('SystemAssembler', '🦀 [Rust Scheduler] spawn 完成,降级/直连已就位');
    }
  } catch (e: any) {
    logger.warn('SystemAssembler', `部分底层模块尚未就位，启用防护桩`, { error: e.message });
  }

  // ── 4. 核心连线注入 ──
  kernel.bootstrapCoreLinkages({
    commandBus,
    transactionManager,
    projectionManager,
    snapshotManager,
    scheduler,
  });

  // ── 5. 消费者初始化 ──
  initializeSocietyEvolutionConsumer(kernel);
  initializeSocialMemoryConsumer(kernel);
  initializeLawComplianceConsumer(kernel);
  initializeReputationAnalyticsConsumer(kernel);
  initializeCourtAdjudicationConsumer(kernel);
  logger.info('SystemAssembler', '🔌 Layer 1 Ingestion: Hardened infrastructure persistence sync channels pinned.');

  // ── 6. 领域引擎实例化 ──
  const roleEvolution = new RoleEvolutionEngine(kernel);
  const coalitionEngine = new CoalitionEngine(kernel);
  const socialMemory = new SocialMemoryEngine(kernel);
  const lawEngine = new LawEngine(kernel);
  const reputationEngine = new SocialReputationEngine(kernel);
  const institutionEngine = new InstitutionEngine(kernel);
  const governancePolicyEngine = new GovernancePolicyEngine(kernel);
  const primaryCourt = new ConsensAgentCourtRoom(kernel);

  const surrealPersistence = new SurrealPersistence();
  await surrealPersistence.start();
  const supremeCourt = new LlmEscalationRoom(kernel, surrealPersistence);

  const distributedBroker = new DistributedProtocolBroker(kernel);
  const telemetryExporter = new TelemetryMetricExporter(kernel);

  initializeTelemetryAggregationConsumer(kernel, telemetryExporter);
  initializeConsensusAuditConsumer(kernel);

  // ── 7. 同步冷启动激活 ──
  await roleEvolution.boot();
  await coalitionEngine.boot();
  await socialMemory.boot();
  await lawEngine.boot();
  await reputationEngine.boot();
  await institutionEngine.boot();
  await governancePolicyEngine.bootGovernanceEngine();
  await primaryCourt.bootCourtRoom();
  await supremeCourt.initializeSupremeTribunal();
  await telemetryExporter.initializeExporterNode();

  // ── 8. 分布式代理 ──
  try {
    await distributedBroker.connectMarlServiceGateway();
  } catch (e) {
    logger.warn('SystemAssembler', 'Distributed broker connection failed, using no-op fallback');
  }
  kernel.distributedBrokerProxy = distributedBroker;

  // ── 9. Raft 共识 ──
  const localClusterNodeId = kernel.configCenter.get('governor.cluster.local_node_id', 'node_alpha_master');
  const raftConsensusNode = new RaftConsensusNode(kernel, localClusterNodeId);
  await raftConsensusNode.bootConsensusRegistry();
  kernel.raftConsensusEngineProxy = raftConsensusNode;

  logger.info('SystemAssembler', '🏆 共享总装厂纯净交付完成');

  return {
    kernel,
    commandBus,
    transactionManager,
    projectionManager,
    snapshotManager,
    scheduler,
    roleEvolution,
    coalitionEngine,
    socialMemory,
    lawEngine,
    reputationEngine,
    institutionEngine,
    governancePolicyEngine,
    primaryCourt,
    supremeCourt,
    surrealPersistence,
    distributedBroker,
    telemetryExporter,
    raftConsensusNode,
  };
}
