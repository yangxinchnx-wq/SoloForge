// ─────────────────────────────────────────────────────────────────
// SoloForge Kernel Layer: Unified Truth Microkernel Core
// Path: src/kernel/runtime-kernel.ts
// ─────────────────────────────────────────────────────────────────

import { ULID } from 'ulid';
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

/**
 * 🚀 RuntimeKernel - SoloForge 唯一真相微内核
 * 严格遵循 V3.0 融合文档 + 系统规格说明
 */
export class RuntimeKernel {
  private static instance: RuntimeKernel | null = null;

  public readonly id: string;
  public readonly startedAt: number;
  public version: number = 0;

  // 核心总线
  public readonly eventBus: EventBus;
  public readonly ownershipRegistry: StateOwnerRegistry;

  // 依赖注入契约（由 index.ts 负责装配）
  public commandBus: { execute: (cmd: Command) => Promise<any> } | null = null;
  public transactionManager: any = null;
  public projectionManager: any = null;
  public snapshotManager: any = null;
  public scheduler: any = null;

  private mode: RuntimeMode = RuntimeMode.NORMAL;
  private domains: Map<string, any> = new Map();
  private replaying: boolean = false;

  private constructor() {
    this.id = `kernel_${ULID()}`;
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

  /** 所有状态变更的唯一入口 */
  public async executeCommand<T = any>(command: Command): Promise<T> {
    if (this.replaying) {
      throw new Error('ERR_KERNEL_REPLAY: Write operations blocked during replay');
    }
    if (!this.commandBus || !this.transactionManager) {
      throw new Error('ERR_KERNEL_UNBOOTED: Call bootstrapCoreLinkages first');
    }

    const commandId = `cmd_${ULID()}`;
    let txId: string | null = null;

    try {
      // 所有权校验
      this.ownershipRegistry.verifyCommandOwnership(command);

      // 事务开启
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

  public getMode(): RuntimeMode {
    return this.mode;
  }

  public registerDomain(name: string, instance: any): void {
    this.domains.set(name, instance);
    this.ownershipRegistry.registerDomain(name);
  }

  public async shutdown(): Promise<void> {
    logger.warn('RuntimeKernel', '🛑 Shutting down microkernel...');

    if (this.scheduler) await this.scheduler.drain().catch(() => {});
    if (this.transactionManager) await this.transactionManager.drain?.().catch(() => {});
    if (this.snapshotManager) await this.snapshotManager.createFullSnapshot?.('shutdown').catch(() => {});

    this.setMode(RuntimeMode.SHUTDOWN);
    logger.info('RuntimeKernel', '✅ Kernel shutdown completed');
  }
}

// 单例导出（供 index.ts 使用）
export const kernel = RuntimeKernel.getInstance();
export default kernel;