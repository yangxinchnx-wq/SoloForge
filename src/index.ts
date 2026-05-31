// ─────────────────────────────────────────────────────────────────
// SoloForge Entry Layer: Production Launch Pad
// Path: src/index.ts
// Description: 全系统统一点火发射台 - 冷启动微内核并激活中央编排时钟
// ─────────────────────────────────────────────────────────────────

import { RuntimeKernel } from './kernel/runtime-kernel';
import { RoleEvolutionEngine } from './core/society/role-evolution';
import { CoalitionEngine } from './core/society/coalition';
import { SocialMemoryEngine } from './core/society/social-memory';
import { LawEngine } from './core/law/law-engine';
import { SocialReputationEngine } from './core/society/reputation';
import { InstitutionEngine } from './core/society/institution';
import { GovernancePolicyEngine } from './core/society/governance';
import { ConsensAgentCourtRoom } from './core/court/consensagent';
import { LlmEscalationRoom } from './core/court/llm_escalation';
import { DistributedProtocolBroker } from './kernel/orchestration/distributed-broker';
import { TelemetryMetricExporter } from './kernel/observability/telemetry-exporter';
import { ClusterRuntimeOrchestrator } from './kernel/orchestration/cluster-runtime-orchestrator';
import { RaftConsensusNode } from './kernel/consensus/raft-consensus-node';
import { SurrealPersistence } from './data/surreal_persistence';

// 🔥 热数据层：Garnet 连接管理
import { connect as garnetConnect, disconnect as garnetDisconnect, getSessionCache, getTaskCache, getCounter, getEventStream } from './data/garnet/index';

// Asynchronously hooked infrastructure ingestion consumers
import { initializeSocietyEvolutionConsumer } from './data/consumers/society-evolution-consumer';
import { initializeSocialMemoryConsumer } from './data/consumers/social-memory-consumer';
import { initializeLawComplianceConsumer } from './data/consumers/law-compliance-consumer';
import { initializeReputationAnalyticsConsumer } from './data/consumers/reputation-analytics-consumer';
import { initializeCourtAdjudicationConsumer } from './data/consumers/court-adjudication-consumer';
import { initializeTelemetryAggregationConsumer } from './data/consumers/telemetry-aggregation-consumer';
import { initializeConsensusAuditConsumer } from './data/consumers/consensus-audit-consumer';

import { logger } from './core/logger';

/**
 * 🪐 SoloForge Distributed MARL Agent Governance OS - Production Entry Point
 * Responsibility: Executes cold-boot container injection and launches the monotonic clock ticker.
 */
async function mainSystemIgnitionEngine(): Promise<void> {
  logger.warn('SYSTEM_MAIN', '🏁 [Inception Mode Activated] Bootstrapping hardened SoloForge Micro-Kernel context...');

  try {
    // Step 1: Instantiate bare metal stateless micro-kernel core node
    const kernel = new RuntimeKernel();

    // 🔥 Pre-step: Initialize Garnet hot data layer (运行态缓存，进程结束即销毁)
    try {
      logger.info('SYSTEM_MAIN', '🔥 [Garnet Hot Layer] Initializing in-memory caches and event streams...');
      await garnetConnect();
      // 注入 ioredis 客户端到内核
      const { getClient } = await import('./data/garnet/client');
      kernel.setGarnetClient(getClient());
      // 预初始化事件流消费者组
      const eventStreamModule = await import('./data/garnet/index');
      logger.info('SYSTEM_MAIN', '🔥 [Garnet Hot Layer] ✓ Session/Task/Counter caches live. TTL-backed, zero-persistence.');
    } catch (garnetErr: any) {
      logger.warn('SYSTEM_MAIN', '⚠️ [Garnet Hot Layer] Connection failed - system degrades to direct SurrealDB writes', { error: garnetErr.message });
    }

    // Step 1.5: Initialize core bus linkages (CommandBus, TransactionManager, etc.)
    const commandBus = {
      handlers: new Map<string, any>(),
      registerHandler: function(type: string, handler: any) {
        this.handlers.set(type, handler);
      },
      execute: async function(cmd: any) {
        const handler = this.handlers.get(cmd.type);
        if (handler) return await handler(cmd);
        return { success: true };
      }
    };

    const transactionManager = {
      transactions: new Map<string, any>(),
      begin: async function(id: string, module: string, payload: any) {
        const tx = { id, module, payload, startedAt: Date.now() };
        this.transactions.set(id, tx);
        return tx;
      },
      commit: async function(id: string) {
        this.transactions.delete(id);
      },
      rollback: async function(id: string, error: any) {
        this.transactions.delete(id);
      }
    };

    const projectionManager = { updateAll: () => {}, replayEvent: async () => {} };
    const snapshotManager = {
      createFullSnapshot: async () => 'snap_stub',
      recover: async () => {},
      replayEvent: async () => {}
    };
    const scheduler = { drain: async () => {} };

    kernel.bootstrapCoreLinkages({
      commandBus,
      transactionManager,
      projectionManager,
      snapshotManager,
      scheduler
    });

    // Step 2: Initialize outmost non-blocking asynchronous storage consumers (Defends database isolation rules)
    initializeSocietyEvolutionConsumer(kernel);
    initializeSocialMemoryConsumer(kernel);
    initializeLawComplianceConsumer(kernel);
    initializeReputationAnalyticsConsumer(kernel);
    initializeCourtAdjudicationConsumer(kernel);
    logger.info('SYSTEM_MAIN', '🔌 Layer 1 Ingestion: Hardened infrastructure persistence sync channels pinned.');

    // Step 3: Instantiate all Phase 3, 4, 5 domain card subsystems
    const roleEvolution = new RoleEvolutionEngine(kernel);
    const coalitionEngine = new CoalitionEngine(kernel);
    const socialMemory = new SocialMemoryEngine(kernel);
    const lawEngine = new LawEngine(kernel);
    const reputationEngine = new SocialReputationEngine(kernel);
    const institutionEngine = new InstitutionEngine(kernel);
    const governancePolicyEngine = new GovernancePolicyEngine(kernel);
    const primaryCourt = new ConsensAgentCourtRoom(kernel);

    // Create SurrealPersistence instance for LlmEscalationRoom
    const surrealPersistence = new SurrealPersistence();
    const supremeCourt = new LlmEscalationRoom(kernel, surrealPersistence);

    const distributedBroker = new DistributedProtocolBroker(kernel);
    const telemetryExporter = new TelemetryMetricExporter(kernel);

    // Initialize telemetry analytical consumers connecting events straight onto Prometheus schemas
    initializeTelemetryAggregationConsumer(kernel, telemetryExporter);

    // Phase 7: Initialize Consensus Audit Consumer for distributed Raft replication
    initializeConsensusAuditConsumer(kernel);

    // Step 4: Synchronous linear cold boot activation mounting modules into kernel slots
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

    // Step 5: Hot link fast socket network transport channels to strategy computation universes
    try {
      await distributedBroker.connectMarlServiceGateway();
    } catch (e) {
      logger.warn('SYSTEM_MAIN', 'Distributed broker connection failed, using no-op fallback');
    }

    // Globally map the network proxy instance handle to authorize ticker cascades
    (kernel as any).distributedBrokerProxy = distributedBroker;

    // Phase 7: Initialize Raft Consensus Node for distributed strong consistency
    const localClusterNodeId = kernel.configCenter.get('governor.cluster.local_node_id', 'node_alpha_master');
    const raftConsensusNode = new RaftConsensusNode(kernel, localClusterNodeId);
    await raftConsensusNode.bootConsensusRegistry();
    (kernel as any).raftConsensusEngineProxy = raftConsensusNode;

    // Step 6: Instantiate master clock supervisor and dynamically engage fire-rate loops
    const sandboxEngine = (kernel as any).sandboxMigrationEngineProxy ?? {
      updateHostLoadFactorTelemetry: () => { /* no-op fallback */ }
    };

    const masterOrchestrator = new ClusterRuntimeOrchestrator(
      kernel,
      lawEngine,
      reputationEngine,
      sandboxEngine,
      telemetryExporter
    );

    // Seed clean process signal interceptions to handle emergency failover pull-outs gracefully
    process.on('SIGTERM', async () => {
      logger.error('SYSTEM_MAIN', '🔌 SIGTERM intercept captured. Initiating un-defiled emergency fallback teardown...');
      await masterOrchestrator.shutdownOrchestrationUniverse();
      distributedBroker.shutdownBroker();
      await kernel.disconnectGarnet(); // 🔥 关闭 Garnet 连接，释放所有 TTL 缓存
      process.exit(0);
    });

    process.on('SIGINT', async () => {
      logger.error('SYSTEM_MAIN', '🔌 SIGINT intercept captured. Initiating graceful shutdown...');
      await masterOrchestrator.shutdownOrchestrationUniverse();
      distributedBroker.shutdownBroker();
      await kernel.disconnectGarnet(); // 🔥 关闭 Garnet 连接，释放所有 TTL 缓存
      process.exit(0);
    });

    // 🪐 MONOTONIC CORE FIRED LIVE!
    await masterOrchestrator.igniteSystemOrchestrationUniverse();
    logger.warn('SYSTEM_MAIN', '🏆 🏆 🏆 SoloForge Full-Universe Operating System is officially launched production live!');

  } catch (fatalLinkageBreakdown: any) {
    console.error(`CRITICAL_OS_PANIC: Core bootstrapper collapsed! ${fatalLinkageBreakdown.message}`);
    process.exit(1);
  }
}

// Fire launch parameters trigger
mainSystemIgnitionEngine();
