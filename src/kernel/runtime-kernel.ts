// ─────────────────────────────────────────────────────────────────
// SoloForge Kernel Layer: Unified Truth Microkernel Core
// Path: src/kernel/runtime-kernel.ts
// ─────────────────────────────────────────────────────────────────

import { ulid } from 'ulid'; 
import { logger } from '../core/logger';
import { EventBus } from '../core/events';
import { RuntimeEvent } from '../core/events/runtime-events';
import { StateOwnerRegistry } from './state-ownership';

export enum RuntimeMode {
  NORMAL = 'normal',
  REPLAY = 'replay',
  FORK = 'fork',
  SANDBOX = 'sandbox',
  RECOVERY = 'recovery',
  SHUTDOWN = 'shutdown'
}

export interface Command {
  type: string;
  domain: string;
  payload?: any;
  riskLevel?: 'low' | 'medium' | 'high' | 'critical';
  [key: string]: any;
}

export class RuntimeKernel {
  private static instance: RuntimeKernel | null = null;
  public readonly id: string;
  public readonly startedAt: number;
  public version: number = 0;

  public readonly eventBus: EventBus;
  public readonly ownershipRegistry: StateOwnerRegistry;

  public commandBus: { execute: (cmd: Command) => Promise<any> } | null = null;
  public transactionManager: any = null;
  public projectionManager: any = null;
  public snapshotManager: any = null;
  public scheduler: any = null;

  private mode: RuntimeMode = RuntimeMode.NORMAL;
  private domains: Map<string, any> = new Map();
  private replaying: boolean = false;

  private constructor() {
    this.id = `kernel_${ulid()}`; 
    this.startedAt = Date.now();
    this.eventBus = new EventBus();
    this.ownershipRegistry = new StateOwnerRegistry();

    this.registerCoreDomains();
    this.setupEventListeners();

    logger.info('RuntimeKernel', `🚀 Microkernel initialized`, { 
      id: this.id, 
      version: this.version 
    });
  }

  public static getInstance(): RuntimeKernel {
    if (!RuntimeKernel.instance) {
      RuntimeKernel.instance = new RuntimeKernel();
    }
    return RuntimeKernel.instance;
  }

  public bootstrapCoreLinkages(components: {
    commandBus: any;
    transactionManager: any;
    projectionManager: any;
    snapshotManager: any;
    scheduler: any;
  }): void {
    this.commandBus = components.commandBus;
    this.transactionManager = components.transactionManager;
    this.projectionManager = components.projectionManager;
    this.snapshotManager = components.snapshotManager;
    this.scheduler = components.scheduler;
    logger.info('RuntimeKernel', '✅ Core linkages bootstrapped successfully');
  }

  private registerCoreDomains() {
    const domains = [
      'WorkspaceRuntime', 'TaskRuntime', 'AIRuntime', 
      'PatchRuntime', 'MemoryRuntime', 'ProjectionRuntime', 'GovernorRuntime'
    ];
        
    domains.forEach(domain => {
      this.ownershipRegistry.registerDomain(domain);
      this.domains.set(domain, null);
    });
  }

  private setupEventListeners() {
    this.eventBus.on(RuntimeEvent.TransactionCommitted, () => {
      this.version++;
    });
  }

  public async executeCommand<T = any>(command: Command): Promise<T> {
    if (this.replaying) {
      throw new Error('ERR_KERNEL_REPLAY: Write operations blocked during replay');
    }
    if (!this.commandBus || !this.transactionManager) {
      throw new Error('ERR_KERNEL_UNBOOTED: Call bootstrapCoreLinkages first');
    }

    const commandId = `cmd_${ulid()}`; 
    let txId: string | null = null;

    try {
      this.ownershipRegistry.verifyCommandOwnership(command);
      const tx = await this.transactionManager.begin(commandId, command.domain);
      txId = tx.id;

      const result = await this.commandBus.execute(command);
      await this.transactionManager.commit(txId);
      txId = null;

      this.eventBus.emit(RuntimeEvent.CommandAccepted, { 
        commandId, 
        ...command, 
        result, 
        version: this.version 
      });
      return result;
    } catch (error: any) {
      if (txId && this.transactionManager) {
        await this.transactionManager.rollback(commandId, error).catch(() => {});
      }
      this.eventBus.emit(RuntimeEvent.CommandRejected, { 
        commandId, 
        type: command.type, 
        error: error.message 
      });
      throw error;
    }
  }

  public async replay(events: any[]): Promise<void> {
    if (!this.projectionManager || !this.snapshotManager) {
      throw new Error('ERR_KERNEL_MISSING_PROJECTION');
    }
    this.replaying = true;
    this.setMode(RuntimeMode.REPLAY);
    try {
      const sorted = [...events].sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
      for (const event of sorted) {
        this.version = Math.max(this.version, event.version || 0);
        await this.projectionManager.replayEvent(event);
        await this.snapshotManager.replayEvent(event);
      }
      logger.info('RuntimeKernel', `✅ Replay completed, version locked at v${this.version}`);
    } finally {
      this.replaying = false;
      this.setMode(RuntimeMode.NORMAL);
    }
  }

  public setMode(mode: RuntimeMode): void {
    const oldMode = this.mode;
    this.mode = mode;
    this.eventBus.emit(RuntimeEvent.RuntimeModeChanged, { oldMode, mode });
  }

  public getMode(): RuntimeMode { return this.mode; }

  public registerDomain(name: string, instance: any): void {
    this.domains.set(name, instance);
    this.ownershipRegistry.registerDomain(name);
  }

  public async shutdown(): Promise<void> {
    logger.warn('RuntimeKernel', '🛑 Shutting down microkernel...');
    
    // 🛡️ 【修复断层二】：使用极其刚性的内聚 try-catch 块，消灭对同步函数执行异步 .catch() 引发的运行时崩溃
    if (this.scheduler) {
      try {
        if (typeof this.scheduler.drain === 'function') {
          await this.scheduler.drain();
        } else if (typeof this.scheduler.shutdown === 'function') {
          // 同步执行释放，即使返回 void/undefined 也能被 try 块安全护航
          await this.scheduler.shutdown();
        }
      } catch (e) {}
    }

    if (this.transactionManager && typeof this.transactionManager.drain === 'function') {
      try { await this.transactionManager.drain(); } catch (e) {}
    }
    if (this.snapshotManager && typeof this.snapshotManager.createFullSnapshot === 'function') {
      try { await this.snapshotManager.createFullSnapshot('shutdown'); } catch (e) {}
    }

    this.setMode(RuntimeMode.SHUTDOWN);
    logger.info('RuntimeKernel', '✅ Kernel shutdown completed');
  }
}

export const kernel = RuntimeKernel.getInstance();
export default kernel;