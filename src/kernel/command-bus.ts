// ─────────────────────────────────────────────────────────────────
// SoloForge Kernel Layer: Command Bus - Pure Routing Board
// Path: src/kernel/command-bus.ts
// ─────────────────────────────────────────────────────────────────

import { RuntimeKernel } from './runtime-kernel';
import { logger } from '../core/logger';

type CommandHandler = (command: any) => Promise<any>;

export class CommandBus {
  private handlers = new Map<string, CommandHandler>();
  private kernel: RuntimeKernel;

  constructor(kernel: RuntimeKernel) {
    this.kernel = kernel;
    logger.info('CommandBus', '🚦 Command Bus 初始化完成（纯路由模式）');
  }

  /**
   * 注册命令处理器
   */
  public registerHandler(type: string, handler: CommandHandler): void {
    this.handlers.set(type, handler);
    logger.info('CommandBus', `Handler registered: ${type}`);
  }

  /**
   * 执行命令 - 纯路由 + 执行
   * 【重要宪法遵守】：不发射任何全局事件！
   * 事件发射权唯一属于 RuntimeKernel（事务提交后）
   */
  public async execute(command: any): Promise<any> {
    const { type, domain, caller = 'ANONYMOUS' } = command;

    logger.debug('CommandBus', `Routing command: ${type} → [${domain}]`, { caller });

    const handler = this.handlers.get(type);

    if (handler) {
      try {
        // 纯执行，不发射事件
        const result = await handler(command);
        logger.debug('CommandBus', `Command ${type} executed successfully`);
        return result;
      } catch (err: any) {
        logger.error('CommandBus', `Handler execution failed for ${type}`, { error: err.message });
        throw err;   // 让上层内核决定是否发射 Rejected 事件
      }
    } else {
      // Passthrough（当前过渡阶段）
      logger.warn('CommandBus', `No handler found for command type: ${type}, using passthrough`);
      return { 
        success: true, 
        mode: 'passthrough', 
        command 
      };
    }
  }
}

export default CommandBus;