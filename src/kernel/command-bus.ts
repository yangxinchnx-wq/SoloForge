// src/kernel/command-bus.ts
import { RuntimeKernel } from './runtime-kernel';
import { logger } from '../core/logger';
import { ULID } from 'ulid';

export type CommandHandler = (command: any) => Promise<any>;

export class CommandBus {
  private handlers = new Map<string, CommandHandler>();

  constructor(private kernel: RuntimeKernel) {
    this.registerDefaultHandlers();
  }

  private registerDefaultHandlers() {
    this.registerHandler('TASK_CREATE', async (cmd) => ({
      success: true,
      taskId: `task_${ULID()}`,
      createdAt: Date.now()
    }));
  }

  public registerHandler(commandType: string, handler: CommandHandler): void {
    this.handlers.set(commandType, handler);
    logger.info('CommandBus', `Handler registered: ${commandType}`);
  }

  public async execute(command: any): Promise<any> {
    const handler = this.handlers.get(command.type);

    if (!handler) {
      logger.warn('CommandBus', `No handler found for command type: ${command.type}, using passthrough`);
      return command.payload || { success: true, forwarded: true };
    }

    return handler(command);
  }
}