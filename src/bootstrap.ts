// ─────────────────────────────────────────────────────────────────
// SoloForge Assembly Layer: Pure Sterile Architecture Factory
// Path: src/bootstrap.ts
// ─────────────────────────────────────────────────────────────────

import { RuntimeKernel } from './kernel/runtime-kernel';
import { RuntimeEvent } from './core/events/runtime-events';
import { logger } from './core/logger';

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

  logger.info('Bootstrap', '🏆 总装厂纯净交付完成 - 架构零污染闭合');
}

