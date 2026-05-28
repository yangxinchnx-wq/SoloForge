// src/kernel/orchestration.ts
import { RuntimeKernel } from './runtime-kernel';
import { bootstrapSystemNetwork } from '../bootstrap';
import { logger } from '../core/logger';

export class OrchestrationManager {
  private kernel = RuntimeKernel.getInstance();

  public async orchestrateStartup(surrealClient: any = null): Promise<void> {
    logger.info('Orchestration', '🎼 开始高级编排总装流水线...');
    
    try {
      await bootstrapSystemNetwork(this.kernel, surrealClient);
      logger.info('Orchestration', '✅ 基础设施物理连线完成，内核进入稳态');
    } catch (error: any) {
      logger.error('Orchestration', '❌ 编排启动失败', { error: error.message });
      throw error;
    }
  }
}