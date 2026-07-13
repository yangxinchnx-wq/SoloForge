// ─────────────────────────────────────────────────────────────────
// SoloForge Entry Layer: Production Launch Pad
// Path: src/index.ts
// Description: 全系统统一点火发射台 - 冷启动微内核并激活中央编排时钟
// ─────────────────────────────────────────────────────────────────

import { RuntimeKernel } from './kernel/runtime-kernel';
import { RoleEvolutionEngine } from './core/society/role-evolution';
import { CoalitionEngine } from './core/society/coalition';
import { ClusterRuntimeOrchestrator } from './kernel/orchestration/cluster-runtime-orchestrator';
import { SurrealPersistence } from './data/surreal_persistence';
import { bootstrapSystemNetwork } from './bootstrap';

// 🔥 热数据层：Garnet 连接管理
import { connect as garnetConnect, disconnect as garnetDisconnect } from './data/garnet/index';

// 消费者：SocietyEvolutionConsumer 仅在 index.ts 初始化（bootstrap.ts 未覆盖）
import { initializeSocietyEvolutionConsumer } from './data/consumers/society-evolution-consumer';

import { logger } from './core/logger';
import { initOpenTelemetry } from './observability/otel-init';
import { SoloForgeApiServer } from './api-server';
import { AgentRegistry } from './core/agent/agent-registry';
import { AgentDecisionOrchestrator } from './core/agent/agent-decision-orchestrator';

/**
 * 🪐 SoloForge Distributed MARL Agent Governance OS - Production Entry Point
 * Responsibility: Executes cold-boot container injection and launches the monotonic clock ticker.
 */
async function mainSystemIgnitionEngine(): Promise<void> {
  // 🛰️ 初始化 OpenTelemetry 可观测性 SDK（必须在内核启动之前）
  try {
    await initOpenTelemetry();
    logger.info('SYSTEM_MAIN', '🛰️ [OpenTelemetry] Observability SDK initialized (Traces/Logs active, Metrics reusing existing Prometheus endpoint)');
  } catch (otelErr: unknown) {
    const msg = otelErr instanceof Error ? otelErr.message : String(otelErr);
    logger.warn('SYSTEM_MAIN', '⚠️ [OpenTelemetry] Failed to initialize SDK, continuing without OTel', { error: msg });
  }

  logger.warn('SYSTEM_MAIN', '🏁 [Inception Mode Activated] Bootstrapping hardened SoloForge Micro-Kernel context...');

  try {
    // Step 1: Instantiate bare metal stateless micro-kernel core node
    const kernel = new RuntimeKernel();
    await kernel.start(); // 推 state: BOOTING → INITIALIZING → READY

    // Step 2: 执行纯净总装工厂（Garnet + SurrealDB + 所有领域引擎 + 消费者 + 网络层）
    // bootstrapSystemNetwork 完成全部模块初始化，index.ts 不再重复内联 any 桩代码
    await bootstrapSystemNetwork(kernel, null);

    // Phase 3: bootstrap 完成后，将 TelemetryMetricExporter 注入 Metric Bridge
    try {
      const { initMetricBridge } = await import('./observability/otel-metric-bridge');
      await initMetricBridge(kernel.globalTelemetryExporterProxy);
      logger.info('SYSTEM_MAIN', '🛰️ [OTel Metric Bridge] TelemetryMetricExporter linked to Prometheus /metrics');
    } catch (e) {
      logger.warn('SYSTEM_MAIN', '⚠️ Metric Bridge late-init failed (non-fatal)');
    }

    // Step 3: 初始化 bootstrap.ts 未覆盖的消费者与引擎
    initializeSocietyEvolutionConsumer(kernel);

    const roleEvolution = new RoleEvolutionEngine(kernel);
    await roleEvolution.boot();
    logger.info('SYSTEM_MAIN', '🧬 RoleEvolutionEngine booted');

    const coalitionEngine = new CoalitionEngine(kernel);
    await coalitionEngine.boot();
    logger.info('SYSTEM_MAIN', '🤝 CoalitionEngine booted');

    // Step 4: 创建 SurrealPersistence（供 API Server 使用）
    const surrealPersistence = new SurrealPersistence();
    await surrealPersistence.start();

    // Step 5: 从 kernel 获取引擎引用，组装 ClusterRuntimeOrchestrator
    const lawEngine = kernel.lawEngineProxy;
    const reputationEngine = kernel.reputationEngineProxy;
    const telemetryExporter = kernel.globalTelemetryExporterProxy;
    const sandboxEngine = kernel.sandboxMigrationEngineProxy ?? {
      updateHostLoadFactorTelemetry: () => { /* no-op fallback */ }
    };

    const masterOrchestrator = new ClusterRuntimeOrchestrator(
      kernel,
      lawEngine,
      reputationEngine,
      sandboxEngine,
      telemetryExporter
    );

    // Step 6: 信号拦截 — 优雅关闭
    process.on('SIGTERM', async () => {
      logger.error('SYSTEM_MAIN', '🔌 SIGTERM intercept captured. Initiating un-defiled emergency fallback teardown...');
      await masterOrchestrator.shutdownOrchestrationUniverse();
      if (kernel.distributedBrokerProxy) {
        kernel.distributedBrokerProxy.shutdownBroker();
      }
      await kernel.disconnectGarnet(); // 🔥 关闭 Garnet 连接，释放所有 TTL 缓存
      process.exit(0);
    });

    process.on('SIGINT', async () => {
      logger.error('SYSTEM_MAIN', '🔌 SIGINT intercept captured. Initiating graceful shutdown...');
      await masterOrchestrator.shutdownOrchestrationUniverse();
      if (kernel.distributedBrokerProxy) {
        kernel.distributedBrokerProxy.shutdownBroker();
      }
      await kernel.disconnectGarnet();
      process.exit(0);
    });

    // 🪐 MONOTONIC CORE FIRED LIVE!
    await masterOrchestrator.igniteSystemOrchestrationUniverse();

    // Step 7: Start API Server for frontend connectivity
    const apiServer = new SoloForgeApiServer(kernel, telemetryExporter, surrealPersistence);

    // Step 7.1: 实例化 Agent 基础设施并注入 API Server
    const agentRegistry = new AgentRegistry(kernel);
    await agentRegistry.boot();
    logger.warn('SYSTEM_MAIN', `🤖 AgentRegistry booted: ${agentRegistry.listAgents().length} agents online`);

    const agentOrchestrator = new AgentDecisionOrchestrator(kernel, agentRegistry);
    apiServer.setAgentRegistry(agentRegistry);
    apiServer.setAgentOrchestrator(agentOrchestrator);
    logger.warn('SYSTEM_MAIN', '🤖 AgentDecisionOrchestrator injected into API Server');

    try {
      await apiServer.start();
      logger.warn('SYSTEM_MAIN', `🌐 API Server live at http://localhost:${apiServer.getPort()}`);

      // Hook event bus to broadcast via SSE
      const originalEmit = kernel.eventBus.emit.bind(kernel.eventBus);
      kernel.eventBus.emit = function(event: string, payload: unknown): void {
        originalEmit(event, payload);
        apiServer.broadcastEvent(event, payload);
      };

      // Register API server for graceful shutdown
      process.on('SIGTERM', async () => {
        await apiServer.stop();
      });
      process.on('SIGINT', async () => {
        await apiServer.stop();
      });
    } catch (apiErr: unknown) {
      const msg = apiErr instanceof Error ? apiErr.message : String(apiErr);
      logger.warn('SYSTEM_MAIN', `⚠️ API Server failed to start: ${msg}`);
    }

    logger.warn('SYSTEM_MAIN', '🏆 🏆 🏆 SoloForge Full-Universe Operating System is officially launched production live!');

  } catch (fatalLinkageBreakdown: unknown) {
    const msg = fatalLinkageBreakdown instanceof Error ? fatalLinkageBreakdown.message : String(fatalLinkageBreakdown);
    console.error(`CRITICAL_OS_PANIC: Core bootstrapper collapsed! ${msg}`);
    process.exit(1);
  }
}

// Fire launch parameters trigger
mainSystemIgnitionEngine();
