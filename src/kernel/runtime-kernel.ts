// src/kernel/runtime-kernel.ts
import { ULID } from 'ulid';
import { logger } from '../core/logger';
import { EventBus } from '../core/events';
import { RuntimeEvent } from '../core/events/runtime-events';
import { Governor } from '../core/governor';
import { FeatureFlag } from '../core/feature-flag';
import { StateOwnerRegistry } from './state-ownership';

// ======================== 类型定义 ========================
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

// ======================== 主类 ========================
export class RuntimeKernel {
  private static instance: RuntimeKernel | null = null;

  public readonly id: string;
  public readonly startedAt: number;
  public version: number = 0;

  // 核心组件
  public readonly eventBus: EventBus;
  public readonly governor: Governor;
  public readonly ownershipRegistry: StateOwnerRegistry;

  // 管理器（这里简化实现，生产环境建议单独文件）
  private commandBus: any;
  private transactionManager: any;
  private projectionManager: any;
  private snapshotManager: any;
  private scheduler: any;

  private mode: RuntimeMode = RuntimeMode.NORMAL;
  private domains: Map<string, any> = new Map();
  private isHeadless: boolean = false;
  private replaying: boolean = false;

  private constructor(config: { headless?: boolean } = {}) {
    this.id = `kernel_${ULID()}`;
    this.startedAt = Date.now();
    this.isHeadless = config.headless ?? false;

    this.eventBus = new EventBus();
    this.governor = Governor.getInstance();
    this.ownershipRegistry = new StateOwnerRegistry();

    this.initManagers();
    this.registerCoreDomains();
    this.setupEventListeners();

    logger.info('RuntimeKernel', `🚀 SoloForge RuntimeKernel Final Version Ready`, {
      id: this.id,
      headless: this.isHeadless,
      mode: this.mode
    });
  }

  public static getInstance(config?: { headless?: boolean }): RuntimeKernel {
    if (!RuntimeKernel.instance) {
      RuntimeKernel.instance = new RuntimeKernel(config);
    }
    return RuntimeKernel.instance;
  }

  private initManagers() {
    // 实际项目中建议拆分成独立文件，这里提供结构
    this.commandBus = { execute: async (cmd: Command) => cmd.payload };
    this.transactionManager = {
      begin: async () => ({ id: ULID() }),
      commit: async () => {},
      rollback: async () => {}
    };
    this.projectionManager = { updateAll: () => {}, replayEvent: () => {} };
    this.snapshotManager = { 
      createFullSnapshot: async () => ULID(),
      recover: async () => {},
      replayEvent: () => {}
    };
    this.scheduler = { drain: async () => {} };
  }

  private registerCoreDomains() {
    const cores = ['WorkspaceRuntime', 'TaskRuntime', 'AIRuntime', 'PatchRuntime', 
                  'MemoryRuntime', 'ProjectionRuntime', 'GovernorRuntime'];
    
    cores.forEach(domain => {
      this.ownershipRegistry.registerDomain(domain);
      this.domains.set(domain, null);
    });
  }

  private setupEventListeners() {
    this.eventBus.on(RuntimeEvent.TransactionCommitted, (p) => {
      this.version++;
      this.projectionManager.updateAll(p);
      this.governor.onTransactionCommitted(p);
    });
  }

  /** ==================== 核心执行入口 ==================== */
  public async executeCommand<T = any>(command: Command): Promise<T> {
    if (this.replaying) throw new Error('Cannot execute commands during replay');

    const commandId = `cmd_${ULID()}`;

    try {
      // 1. 安全检查
      if (FeatureFlag.isEnabled('kernel_safety_mode') && command.riskLevel === 'high') {
        await this.governor.validateHighRiskCommand(command);
      }

      // 2. 所有权校验（宪法核心）
      this.ownershipRegistry.verifyCommandOwnership(command);

      // 3. Governor 资源检查
      await this.governor.beforeCommand(command);

      // 4. 事务执行
      const tx = await this.transactionManager.begin(commandId, command.domain);
      const result = await this.commandBus.execute(command);
      await this.transactionManager.commit(tx.id);

      this.eventBus.emit(RuntimeEvent.CommandAccepted, { commandId, ...command, result });
      return result;
    } catch (error: any) {
      await this.transactionManager.rollback(commandId, error);
      this.eventBus.emit(RuntimeEvent.CommandRejected, { commandId, error: error.message });
      throw error;
    }
  }

  /** ==================== Replay & Recovery ==================== */
  public async replay(events: any[]): Promise<void> {
    this.replaying = true;
    this.setMode(RuntimeMode.REPLAY);
    logger.info('RuntimeKernel', `Replaying ${events.length} events...`);

    try {
      for (const event of events.sort((a, b) => a.timestamp - b.timestamp)) {
        await this.projectionManager.replayEvent(event);
        await this.snapshotManager.replayEvent(event);
        this.version = Math.max(this.version, event.version || 0);
      }
      logger.info('RuntimeKernel', '✅ Replay completed successfully');
    } finally {
      this.replaying = false;
      this.setMode(RuntimeMode.NORMAL);
    }
  }

  public async createSnapshot(reason = 'manual'): Promise<string> {
    return this.snapshotManager.createFullSnapshot(reason);
  }

  public async recover(snapshotId: string): Promise<void> {
    this.setMode(RuntimeMode.RECOVERY);
    await this.snapshotManager.recover(snapshotId);
    this.setMode(RuntimeMode.NORMAL);
  }

  /** ==================== 其他方法 ==================== */
  public setMode(mode: RuntimeMode): void {
    const old = this.mode;
    this.mode = mode;
    this.eventBus.emit(RuntimeEvent.RuntimeModeChanged, { oldMode: old, mode });
  }

  public getMode(): RuntimeMode { return this.mode; }

  public registerDomain(name: string, instance: any): void {
    this.domains.set(name, instance);
    this.ownershipRegistry.registerDomain(name);
    logger.info('RuntimeKernel', `Domain mounted: ${name}`);
  }

  public async shutdown(): Promise<void> {
    logger.info('RuntimeKernel', 'Shutting down...');
    await this.scheduler.drain();
    await this.snapshotManager.createFullSnapshot('shutdown');
    this.setMode(RuntimeMode.SHUTDOWN);
    logger.info('RuntimeKernel', 'Shutdown completed');
  }
}

// ======================== 导出 ========================
export const kernel = RuntimeKernel.getInstance();
export default kernel;