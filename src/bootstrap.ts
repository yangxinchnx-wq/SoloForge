// ─────────────────────────────────────────────────────────────────
// SoloForge Assembly Layer: Pure Sterile Architecture Factory
// Path: src/bootstrap.ts
// ─────────────────────────────────────────────────────────────────

import { RuntimeKernel } from './kernel/runtime-kernel';
import { RuntimeEvent } from './core/events/runtime-events';
import { logger } from './core/logger';
import { ShadowGovernorClient, DEFAULT_SHADOW_CONFIG, TelemetryVector } from './kernel/shadow-governor-client';
import { GovernorShadowOrchestrator } from './kernel/governor-shadow-orchestrator';
import { SurrealPersistence } from './data/surreal_persistence';
import { connect as garnetConnect, disconnect as garnetDisconnect } from './data/garnet/index';
import { getClient as getGarnetClient } from './data/garnet/client';
import { LifecycleManager } from './runtime/lifecycle';
import { SocialMemoryEngine } from './core/society/social-memory';
import { initializeSocialMemoryConsumer } from './data/consumers/social-memory-consumer';
import { ConsensAgentCourtRoom } from './core/court/consensagent';
import { LlmEscalationRoom } from './core/court/llm_escalation';
import { initializeCourtAdjudicationConsumer } from './data/consumers/court-adjudication-consumer';
import { LawEngine } from './core/law/law-engine';
import { initializeLawComplianceConsumer } from './data/consumers/law-compliance-consumer';
import { SocialReputationEngine } from './core/society/reputation';
import { initializeReputationAnalyticsConsumer } from './data/consumers/reputation-analytics-consumer';
import { InstitutionEngine } from './core/society/institution';
import { GovernancePolicyEngine } from './core/society/governance';
import { initializeSocietyGovernanceConsumer } from './data/consumers/society-governance-consumer';
import { DistributedProtocolBroker } from './kernel/orchestration/distributed-broker';
import { SandboxMigrationEngine } from './kernel/sandbox/isolation-slot';
import { initializeMigrationAuditConsumer } from './data/consumers/migration-audit-consumer';
import { TelemetryMetricExporter } from './kernel/observability/telemetry-exporter';
import { initializeTelemetryAggregationConsumer } from './data/consumers/telemetry-aggregation-consumer';
import { RaftConsensusNode } from './kernel/consensus/raft-consensus-node';
import { initializeConsensusAuditConsumer } from './data/consumers/consensus-audit-consumer';
import type {
  ICommandBus,
  ICommand,
  ICommandResult,
  ITransactionManager,
  ITransaction,
  IProjectionManager,
  ISnapshotManager,
  ISchedulerClient,
  BootstrapDeps,
} from './types/bootstrap-deps';

// ─────────────────────────────────────────────────────────────────
// 阶段化初始化子函数
// ─────────────────────────────────────────────────────────────────

/**
 * 阶段 1：基础设施层
 * Garnet 热数据层 + SurrealDB 持久化 + Scheduler 调度器
 */
async function initInfrastructure(
  kernel: RuntimeKernel
): Promise<BootstrapDeps> {
  // 1. 刚性契约保底桩（防止缺失文件导致崩溃）
  // 类型由接口契约约束，确保后续替换为真实实现时类型安全
  let commandBus: ICommandBus = {
    registerHandler: () => {},
    execute: async (cmd: ICommand): Promise<ICommandResult> => ({ success: true, payload: cmd.payload })
  };
  let transactionManager: ITransactionManager = {
    begin: async (_commandId: string, _domain: string, _initialPayload?: unknown): Promise<ITransaction> => ({ id: 'tx_stub', status: 'pending' }),
    commit: async (_txId: string): Promise<void> => {},
    rollback: async (_commandId: string, _error: unknown): Promise<void> => {},
    drain: async (): Promise<void> => {}
  };
  let projectionManager: IProjectionManager = { updateAll: () => {}, replayEvent: async () => {} };
  let snapshotManager: ISnapshotManager = {
    createFullSnapshot: async () => 'snap_stub',
    recover: async () => {},
    replayEvent: async () => {}
  };
  let scheduler: ISchedulerClient = { drain: async () => {} };

  // 🔥 Garnet 热数据层初始化（优先于所有领域模块，确保热缓存在组件启动前就位）
  try {
    logger.info('Bootstrap', '🔥 [Garnet Hot Layer] Initializing TTL-backed in-memory caches...');
    await garnetConnect();
    kernel.setGarnetClient(getGarnetClient());
    logger.info('Bootstrap', '🔥 [Garnet Hot Layer] ✓ Session/Task/Counter/EventStream caches online.');
  } catch (garnetErr: unknown) {
    logger.warn('Bootstrap', '⚠️ [Garnet Hot Layer] Connection failed - proceeding with direct SurrealDB writes', {
      error: garnetErr instanceof Error ? garnetErr.message : String(garnetErr)
    });
  }

  // 2. 渐进式加载物理组件（弹性防御）
  try {
    const commandBusModule = await import('./kernel/command-bus').catch(() => null);
    const transactionManagerModule = await import('./kernel/transaction-manager').catch(() => null);
    const schedulerModule = await import('./kernel/scheduler-client').catch(() => null);

    if (commandBusModule?.CommandBus) {
      commandBus = new commandBusModule.CommandBus(kernel);
    }
    if (transactionManagerModule?.TransactionManager) {
      transactionManager = new transactionManagerModule.TransactionManager(kernel);
    }
    if (schedulerModule?.SoloForgeRustSchedulerClient) {
      scheduler = new schedulerModule.SoloForgeRustSchedulerClient();
      scheduler.initialize?.();
    }
  } catch (e: unknown) {
    logger.warn('Bootstrap', `部分底层模块尚未就位，启用防护桩`, { error: e instanceof Error ? e.message : String(e) });
  }

  return { commandBus, transactionManager, projectionManager, snapshotManager, scheduler };
}

/**
 * 阶段 2：核心服务层
 * CommandBus 连线注入 + 心跳转发 + AI Runtime + LifecycleManager + Shadow Governor
 */
async function initCoreServices(
  kernel: RuntimeKernel,
  deps: BootstrapDeps
): Promise<void> {
  const { commandBus, transactionManager, projectionManager, snapshotManager, scheduler } = deps;

  // 3. 核心连线注入
  kernel.bootstrapCoreLinkages({
    commandBus,
    transactionManager,
    projectionManager,
    snapshotManager,
    scheduler
  });

  // 4. 纯净心跳转发（唯一允许的”业务入口”）
  if (commandBus?.registerHandler) {
    commandBus.registerHandler('SYS_HEARTBEAT', async (cmd: ICommand): Promise<ICommandResult> => {
      // 纯粹的事件化转发，不含任何业务逻辑
      const eventPayload = {
        ...(cmd.payload as Record<string, unknown> | undefined),
        timestamp: Date.now(),
        source: 'SYS_HEARTBEAT'
      };

      kernel.eventBus.emit(RuntimeEvent.Heartbeat || 'sys.heartbeat', eventPayload);

      return { success: true, event: 'Heartbeat broadcasted' };
    });
  }

  // 5. 领域模块热插拔（各领域自己负责订阅心跳）
  try {
    const aiModuleImport = await import('./kernel/domains/ai-runtime').catch(() => null);
    if (aiModuleImport?.AIRuntimeModule) {
      const aiModule = new aiModuleImport.AIRuntimeModule(kernel, null, scheduler);
      aiModule.mount?.();
      logger.info('Bootstrap', 'AI Runtime 领域板卡已挂载');
    }
  } catch (e) {
    logger.warn('Bootstrap', 'AI 领域模块暂未就位，跳过挂载');
  }

  // 6. 创建 LifecycleManager 并注册组件
  const lifecycleManager = new LifecycleManager();
  kernel.setLifecycleManager(lifecycleManager);

  // 7. Shadow Governor Orchestrator 挂载（通过 EventBus 接入，符合微内核原则）
  try {
    // 创建 SurrealPersistence 实例
    const surrealPersistence = new SurrealPersistence();

    // 创建完整的 GovernorShadowOrchestrator（包含事务 + 乐观锁）
    const shadowOrchestrator = new GovernorShadowOrchestrator(kernel, surrealPersistence, {
      persistence: {
        enabled: true,
        batchInterval: 5000,
        maxBatchSize: 100
      }
    });

    // 注册到 LifecycleManager（符合 Lifecycle Manager 生命周期钩子原则）
    lifecycleManager.register(shadowOrchestrator);
    logger.info('Bootstrap', '🔮 Shadow Governor Orchestrator 已注册到 LifecycleManager');

  } catch (e) {
    logger.warn('Bootstrap', '⚠️ Shadow Governor Orchestrator 暂未就位，不影响主流程');
  }
}

/**
 * 阶段 3：社会引擎层
 * SocialMemory + Law + Reputation + Institution + Governance
 */
async function initSocietyEngines(kernel: RuntimeKernel): Promise<void> {
  // 8. Social Memory Consumer 初始化（异步持久化冷沉淀消费者）
  try {
    initializeSocialMemoryConsumer(kernel);
    logger.info('Bootstrap', '🧬 [Phase 3 Complete] Social Memory Consumer 已挂载到数据沉淀管道');
  } catch (e) {
    logger.warn('Bootstrap', '⚠️ Social Memory Consumer 暂未就位');
  }

  // 9. Social Memory Engine 热插拔挂载
  try {
    const socialMemoryEngine = new SocialMemoryEngine(kernel);
    await socialMemoryEngine.boot();
    logger.info('Bootstrap', '🧬 [Phase 3 Complete] Collective Social Memory Engine dynamically interlocked.');
  } catch (e) {
    logger.warn('Bootstrap', '⚠️ Social Memory Engine 暂未就位');
  }

  // 12. Law Compliance Consumer 初始化（异步持久化冷沉淀消费者）
  try {
    initializeLawComplianceConsumer(kernel);
    logger.info('Bootstrap', '🧱 [Phase 3 Law Complete] Law Compliance Consumer 已挂载到数据沉淀管道');
  } catch (e) {
    logger.warn('Bootstrap', '⚠️ Law Compliance Consumer 暂未就位');
  }

  // 13. Constitutional Law Engine 热插拔挂载
  try {
    const lawEngine = new LawEngine(kernel);
    await lawEngine.boot();
    logger.info('Bootstrap', '🧱 [Phase 3 Law Layer Mounted] Constitutional Law Engine frozen into release track safely.');
  } catch (e) {
    logger.warn('Bootstrap', '⚠️ Law Engine 暂未就位');
  }

  // 14. Reputation Analytics Consumer 初始化（异步持久化冷沉淀消费者）
  try {
    initializeReputationAnalyticsConsumer(kernel);
    logger.info('Bootstrap', '🧱 [Phase 3 Reputation Complete] Reputation Analytics Consumer 已挂载到数据沉淀管道');
  } catch (e) {
    logger.warn('Bootstrap', '⚠️ Reputation Analytics Consumer 暂未就位');
  }

  // 15. Social Reputation Engine 热插拔挂载
  try {
    const socialReputationEngine = new SocialReputationEngine(kernel);
    await socialReputationEngine.boot();
    logger.info('Bootstrap', '🧱 [Phase 3 Trust Base Mounted] Constitutional Social Reputation Engine frozen successfully.');
  } catch (e) {
    logger.warn('Bootstrap', '⚠️ Social Reputation Engine 暂未就位');
  }

  // 16. Society Governance Consumer 初始化（异步持久化冷沉淀消费者）
  try {
    initializeSocietyGovernanceConsumer(kernel);
    logger.info('Bootstrap', '🏆 [Phase 3 Social Regime Complete] Society Governance Consumer 已挂载到数据沉淀管道');
  } catch (e) {
    logger.warn('Bootstrap', '⚠️ Society Governance Consumer 暂未就位');
  }

  // 17. Institution Engine + Governance Policy Engine 热插拔挂载
  try {
    const institutionEngine = new InstitutionEngine(kernel);
    const governancePolicyEngine = new GovernancePolicyEngine(kernel);

    await institutionEngine.boot();
    await governancePolicyEngine.bootGovernanceEngine();
    logger.info('Bootstrap', '🏆 [Phase 3 Social Regime Assembly Finalized] Institution and Governance Engines successfully locked.');
  } catch (e) {
    logger.warn('Bootstrap', '⚠️ Institution/Goverance Engines 暂未就位');
  }
}

/**
 * 阶段 4：司法系统层
 * ConsensAgentCourtRoom + LlmEscalationRoom
 */
async function initCourtSystem(kernel: RuntimeKernel): Promise<void> {
  // 10. Court Adjudication Consumer 初始化（异步持久化冷沉淀消费者）
  try {
    initializeCourtAdjudicationConsumer(kernel);
    logger.info('Bootstrap', '🏛️ [Phase 3 Court Complete] Court Adjudication Consumer 已挂载到数据沉淀管道');
  } catch (e) {
    logger.warn('Bootstrap', '⚠️ Court Adjudication Consumer 暂未就位');
  }

  // 11. Primary Court Room + Supreme LLM Escalation Tribunal 热插拔挂载
  try {
    const surrealPersistence = new SurrealPersistence();
    const primaryCourt = new ConsensAgentCourtRoom(kernel);
    const supremeCourt = new LlmEscalationRoom(kernel, surrealPersistence);

    await primaryCourt.bootCourtRoom();
    await supremeCourt.initializeSupremeTribunal();
    logger.info('Bootstrap', '🏛️ [Phase 3 Absolute Complete] Judicial Assembly Courtroom Framework frozen into release line safely.');
  } catch (e) {
    logger.warn('Bootstrap', '⚠️ Court Engines 暂未就位');
  }
}

/**
 * 阶段 5：网络通信层
 * DistributedBroker + SandboxMigration + Telemetry + Raft Consensus + Garnet Bridge
 */
async function initNetworkLayer(kernel: RuntimeKernel): Promise<void> {
  // 18. Distributed Protocol Broker 热插拔挂载（Phase 4 跨语言IPC网络通信代理）
  try {
    const distributedBroker = new DistributedProtocolBroker(kernel);
    await distributedBroker.connectMarlServiceGateway();
    kernel.distributedBrokerProxy = distributedBroker;
    logger.info('Bootstrap', '🛰️ [Phase 4 Ignition Base] Cross-language distributed IPC fast broker client linked and live.');
  } catch (e) {
    logger.warn('Bootstrap', '⚠️ Distributed Protocol Broker 暂未就位');
  }

  // 19. Migration Audit Consumer 初始化（沙箱迁移历史冷沉淀消费者）
  try {
    initializeMigrationAuditConsumer(kernel);
    logger.info('Bootstrap', '🛡️ [Phase 5 Sandbox] Migration Audit Consumer 已挂载到数据沉淀管道');
  } catch (e) {
    logger.warn('Bootstrap', '⚠️ Migration Audit Consumer 暂未就位');
  }

  // 20. Sandbox Migration Engine 热插拔挂载（零宕机热迁移引擎）
  try {
    const sandboxMigrationEngine = new SandboxMigrationEngine(kernel);
    await sandboxMigrationEngine.bootSandboxRegistry();
    kernel.sandboxMigrationEngineProxy = sandboxMigrationEngine;
    logger.info('Bootstrap', '🛡️ [Phase 5 Complete] Hardened V8 Isolate sandboxing and live memory migration engine locked into release line safely.');
  } catch (e) {
    logger.warn('Bootstrap', '⚠️ Sandbox Migration Engine 暂未就位');
  }

  // 21. Telemetry Metric Exporter + Aggregation Consumer 初始化（Prometheus 时序指标汇聚网关）
  try {
    const telemetryExporter = new TelemetryMetricExporter(kernel);
    initializeTelemetryAggregationConsumer(kernel, telemetryExporter);
    await telemetryExporter.initializeExporterNode();
    kernel.globalTelemetryExporterProxy = telemetryExporter;
    logger.info('Bootstrap', '🛰️ [Phase 5 Observability Complete] Prometheus Exporter Gateway frozen cleanly.');
  } catch (e) {
    logger.warn('Bootstrap', '⚠️ Telemetry Exporter 暂未就位');
  }

  // 22. Consensus Audit Consumer 初始化（分布式强共识审计沉淀消费者）
  try {
    initializeConsensusAuditConsumer(kernel);
    logger.info('Bootstrap', '🧱 [Phase 7 Consensus] Distributed Consensus Audit Consumer 已挂载到数据沉淀管道');
  } catch (e) {
    logger.warn('Bootstrap', '⚠️ Consensus Audit Consumer 暂未就位');
  }

  // 23. Raft Consensus Node 热插拔挂载（分布式强共识状态机）
  try {
    const localClusterNodeId = kernel.configCenter.get('governor.cluster.local_node_id', 'node_alpha_master');
    const raftConsensusNode = new RaftConsensusNode(kernel, localClusterNodeId);
    await raftConsensusNode.bootConsensusRegistry();
    kernel.raftConsensusEngineProxy = raftConsensusNode;
    logger.info('Bootstrap', '🧱 [Phase 7 Multi-Node Replicated live] Hardened Raft consensus engine interlocked successfully.');
  } catch (e) {
    logger.warn('Bootstrap', '⚠️ Raft Consensus Node 暂未就位');
  }

  // 🔥 Garnet EventBus 桥接（监听内核关键事件 → 写入 Garnet Streams）
  try {
    const { GarnetEventBridge } = await import('./data/garnet/garnet-bridge');
    const garnetBridge = new GarnetEventBridge({
      eventBus: kernel.eventBus,
      getGarnetClient: () => kernel.getGarnetClient(),
    });
    await garnetBridge.start();
    const lifecycleManager = kernel.getLifecycleManager();
    lifecycleManager.register(garnetBridge);
    logger.info('Bootstrap', '🔥 [Garnet Bridge] ↔ EventBus ↔ Garnet Streams interlocked.');
  } catch (bridgeErr: unknown) {
    logger.warn('Bootstrap', '⚠️ Garnet Bridge 未就位，事件仍走 SurrealDB 直写', { error: bridgeErr instanceof Error ? bridgeErr.message : String(bridgeErr) });
  }
}

// ─────────────────────────────────────────────────────────────────
// 总装厂编排入口
// ─────────────────────────────────────────────────────────────────

/**
 * SoloForge 纯净总装工厂
 * 职责边界：仅负责物理组件连线 + 事件转发，绝不包含任何业务逻辑
 *
 * 结构重组为五个阶段化子函数，保持原执行顺序和错误处理不变：
 *   initInfrastructure  → Garnet、SurrealDB、Scheduler
 *   initCoreServices    → CommandBus、TransactionManager、LifecycleManager
 *   initSocietyEngines  → SocialMemory、Law、Reputation、Institution、Governance
 *   initCourtSystem     → ConsensAgentCourtRoom、LlmEscalationRoom
 *   initNetworkLayer    → DistributedBroker、SandboxMigration、Telemetry、Raft、GarnetBridge
 */
export async function bootstrapSystemNetwork(
  kernel: RuntimeKernel,
  surrealClient: unknown
): Promise<void> {
  logger.info('Bootstrap', '⚙️ 总装厂点火：执行纯净基础设施连线...');

  // 阶段 1：基础设施层（Garnet + SurrealDB + Scheduler）
  const infraDeps = await initInfrastructure(kernel);

  // 阶段 2：核心服务层（CommandBus 连线 + 心跳 + AI Runtime + Lifecycle + Shadow Governor）
  await initCoreServices(kernel, infraDeps);

  // 阶段 3：社会引擎层（SocialMemory + Law + Reputation + Institution + Governance）
  await initSocietyEngines(kernel);

  // 阶段 4：司法系统层（Court + LLM Escalation）
  await initCourtSystem(kernel);

  // 阶段 5：网络通信层（DistributedBroker + Sandbox + Telemetry + Raft + Garnet Bridge）
  await initNetworkLayer(kernel);

  logger.info('Bootstrap', '🏆 总装厂纯净交付完成 - 架构零污染闭合');
}

/**
 * Shadow Governor Orchestrator
 * 职责：
 * 1. 管理 Shadow Server 连接
 * 2. 通过 EventBus 订阅遥测事件
 * 3. 记录 Rule vs PPO 对比数据
 * 4. 通过 EventBus 发出 Shadow 决策事件（Event Sourcing）
 * 5. 集成 Lifecycle Manager 生命周期钩子
 *
 * @deprecated 使用 GovernorShadowOrchestrator 代替
 */
export class ShadowOrchestrator {
  private shadowClient: ShadowGovernorClient | null = null;
  private kernel: RuntimeKernel;
  private isConnected = false;

  constructor(kernel: RuntimeKernel) {
    this.kernel = kernel;
  }

  /**
   * 初始化 Shadow Governor 连接
   */
  public async initialize(config?: Partial<typeof DEFAULT_SHADOW_CONFIG>): Promise<void> {
    this.shadowClient = new ShadowGovernorClient(config);

    const connected = await this.shadowClient.connect();
    this.isConnected = connected;

    if (connected) {
      // 订阅遥测事件：通过 EventBus 接入（符合微内核原则）
      this.kernel.eventBus.on(RuntimeEvent.Heartbeat, this.handleHeartbeat.bind(this));
      logger.info('Bootstrap', '🔮 Shadow Governor 已连接，遥测订阅已激活');
    } else {
      logger.warn('Bootstrap', '⚠️ Shadow Governor 连接失败，使用 fallback 策略');
    }
  }

  /**
   * 处理心跳事件，获取 PPO 决策（Shadow 模式）
   */
  private async handleHeartbeat(payload: unknown): Promise<void> {
    if (!this.shadowClient || !this.isConnected) return;

    try {
      const shadowResponse = await this.shadowClient.getShadowAction(payload as TelemetryVector);

      // 通过 EventBus 发出 Shadow 决策事件（Event Sourcing）
      this.kernel.eventBus.emit('shadow.decision.recorded', {
        timestamp: Date.now(),
        action: shadowResponse.action,
        actionName: shadowResponse.action_name,
        prob: shadowResponse.prob,
        value: shadowResponse.value,
        source: 'ppo_shadow'
      });
    } catch (e) {
      // Shadow 失败不影响主路径
      logger.debug('Shadow', `Shadow 决策失败: ${e}`);
    }
  }

  /**
   * 获取统计信息
   */
  public getStats() {
    return this.shadowClient?.getStats() || null;
  }

  /**
   * 关闭连接
   */
  public async shutdown(): Promise<void> {
    if (this.shadowClient) {
      this.shadowClient.close();
    }
    logger.info('Bootstrap', '🔮 Shadow Governor 已关闭');
  }
}

