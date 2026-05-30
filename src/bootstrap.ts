// ─────────────────────────────────────────────────────────────────
// SoloForge Assembly Layer: Pure Sterile Architecture Factory
// Path: src/bootstrap.ts
// ─────────────────────────────────────────────────────────────────

import { RuntimeKernel } from './kernel/runtime-kernel';
import { RuntimeEvent } from './core/events/runtime-events';
import { logger } from './core/logger';
import { ShadowGovernorClient, DEFAULT_SHADOW_CONFIG } from './kernel/shadow-governor-client';
import { GovernorShadowOrchestrator } from './kernel/governor-shadow-orchestrator';
import { SurrealPersistence } from './data/surreal_persistence';
import { LifecycleManager } from './runtime/lifecycle';

/**
 * SoloForge 纯净总装工厂
 * 职责边界：仅负责物理组件连线 + 事件转发，绝不包含任何业务逻辑
 */
export async function bootstrapSystemNetwork(
  kernel: RuntimeKernel, 
  surrealClient: any
): Promise<void> {
  logger.info('Bootstrap', '⚙️ 总装厂点火：执行纯净基础设施连线...');

  // 1. 刚性契约保底桩（防止缺失文件导致崩溃）
  let commandBus: any = { 
    registerHandler: () => {}, 
    execute: async (cmd: any) => ({ success: true, payload: cmd.payload }) 
  };
  let transactionManager: any = { 
    begin: async () => ({ id: 'tx_stub' }), 
    commit: async () => {}, 
    rollback: async () => {}, 
    drain: async () => {} 
  };
  let projectionManager: any = { updateAll: () => {}, replayEvent: async () => {} };
  let snapshotManager: any = { 
    createFullSnapshot: async () => 'snap_stub', 
    recover: async () => {}, 
    replayEvent: async () => {} 
  };
  let scheduler: any = { drain: async () => {} };

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
    if (schedulerModule?.GeminiRustSchedulerClient) {
      scheduler = new schedulerModule.GeminiRustSchedulerClient();
      scheduler.initialize?.();
    }
  } catch (e: any) {
    logger.warn('Bootstrap', `部分底层模块尚未就位，启用防护桩`, { error: e.message });
  }

  // 3. 核心连线注入
  kernel.bootstrapCoreLinkages({
    commandBus,
    transactionManager,
    projectionManager,
    snapshotManager,
    scheduler
  });

  // 4. 纯净心跳转发（唯一允许的“业务入口”）
  if (commandBus?.registerHandler) {
    commandBus.registerHandler('SYS_HEARTBEAT', async (cmd: any) => {
      // 纯粹的事件化转发，不含任何业务逻辑
      const eventPayload = {
        ...cmd.payload,
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
  private async handleHeartbeat(payload: any): Promise<void> {
    if (!this.shadowClient || !this.isConnected) return;

    try {
      const shadowResponse = await this.shadowClient.getShadowAction(payload as any);

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

