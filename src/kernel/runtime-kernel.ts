// ─────────────────────────────────────────────────────────────────
// SoloForge Kernel Layer: Sovereign Control Plane Core
// Path: src/kernel/runtime-kernel.ts
// Description: 微内核运行时核心 - 统一真相内核
// ─────────────────────────────────────────────────────────────────

import { RuntimeComponent } from './runtime-component';
import { LifecycleManager } from '../runtime/lifecycle';
import { ConfigCenter, globalConfigCenter, MetricsCollectorInterface, globalMetricsCollector } from './config-center';
import type Redis from 'ioredis';
import type { TransactionManager } from './transaction-manager';
import type { ITransactionManager } from '../types/bootstrap-deps';

export enum RuntimeState {
  BOOTING = 'BOOTING',
  INITIALIZING = 'INITIALIZING',
  READY = 'READY',
  DEGRADED = 'DEGRADED',
  SHUTTING_DOWN = 'SHUTTING_DOWN',
  STOPPED = 'STOPPED',
  PANIC = 'PANIC',
}

export enum RuntimeMode {
  NORMAL = 'NORMAL',
  RECOVERY = 'RECOVERY',
}

/**
 * 事件总线接口
 */
export interface EventBusInterface {
  emit(event: string, payload: any): void;
  on(event: string, handler: (payload: any) => void): void;
  off(event: string, handler: (payload: any) => void): void;
  getEventLog(): Array<{ event: string; payload: any; timestamp: number }>;
}

/**
 * 命令总线接口
 */
export interface CommandBusInterface {
  execute(command: any): Promise<any>;
  registerHandler(type: string, handler: (command: any) => Promise<any>): void;
}

/**
 * 内存事件总线实现
 */
class InMemoryEventBus implements EventBusInterface {
  private eventLog: Array<{ event: string; payload: any; timestamp: number }> = [];
  private handlers: Map<string, Array<(payload: any) => void>> = new Map();

  emit(event: string, payload: any): void {
    const entry = { event, payload, timestamp: Date.now() };
    this.eventLog.push(entry);

    const eventHandlers = this.handlers.get(event);
    if (eventHandlers) {
      for (const handler of eventHandlers) {
        handler(payload);
      }
    }
  }

  on(event: string, handler: (payload: any) => void): void {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, []);
    }
    this.handlers.get(event)!.push(handler);
  }

  off(event: string, handler: (payload: any) => void): void {
    const list = this.handlers.get(event);
    if (list) {
      const idx = list.indexOf(handler);
      if (idx !== -1) list.splice(idx, 1);
    }
  }

  getEventLog(): Array<{ event: string; payload: any; timestamp: number }> {
    return [...this.eventLog];
  }

  clearLog(): void {
    this.eventLog = [];
  }
}

/**
 * 状态所有权注册表
 */
export class StateOwnershipRegistry {
  private ownerships: Map<string, Set<string>> = new Map();
  private wildcardPatterns: Map<string, string> = new Map();

  /**
   * 注册域的所有权
   */
  register(domain: string, keyPattern: string): void {
    if (!this.ownerships.has(domain)) {
      this.ownerships.set(domain, new Set());
    }
    this.ownerships.get(domain)!.add(keyPattern);
  }

  /**
   * 检查域是否有所有权
   */
  hasOwnership(domain: string, key: string): boolean {
    const patterns = this.ownerships.get(domain);
    if (!patterns) return false;

    for (const pattern of patterns) {
      // 支持通配符匹配
      if (pattern.includes('*')) {
        const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
        if (regex.test(key)) return true;
      } else if (pattern === key) {
        return true;
      }
    }

    return false;
  }

  /**
   * 获取域的所有权模式
   */
  getOwnershipPatterns(domain: string): string[] {
    return Array.from(this.ownerships.get(domain) || []);
  }
}

export class RuntimeKernel {
  private static instance: RuntimeKernel | null = null;
  private state: RuntimeState = RuntimeState.BOOTING;
  private mode: RuntimeMode = RuntimeMode.NORMAL;

  /**
   * 全局组件注册表
   */
  private readonly components = new Map<string, RuntimeComponent>();

  /**
   * 状态所有权注册表
   */
  public readonly stateOwnership = new StateOwnershipRegistry();

  /**
   * 事件总线
   */
  public readonly eventBus: EventBusInterface = new InMemoryEventBus();

  public commandBus: CommandBusInterface | null = null;
  public transactionManager: TransactionManager | null = null;
  public projectionManager: any = null;
  public snapshotManager: any = null;
  public scheduler: any = null;
  public lifecycleManager: LifecycleManager | null = null;
  public readonly id = 'kernel_sovereign_core';
  public readonly startedAt = Date.now();
  public version = 0;
  public readonly bootTime = Date.now();

  // 存根：占位属性（领域模块在挂载前访问时不会崩溃）
  public featureFlagManager: any = null;
  public recoveryPlanManager: any = null;

  // Phase 4/5/7 运行时代理（由 bootstrap / system-assembler 挂载）
  public distributedBrokerProxy: any = null;
  public sandboxMigrationEngineProxy: any = null;
  public globalTelemetryExporterProxy: any = null;
  public raftConsensusEngineProxy: any = null;
  public schedulerClient: any = null;

  // 🔥 热数据层：Garnet 热缓存客户端（运行态，无持久化，进程结束即销毁）
  private _garnetClient: Redis | null = null;
  private _garnetConnected: boolean = false;

  // 🛰️ Phase 5 Observability Infrastructure
  public readonly configCenter: ConfigCenter = globalConfigCenter;
  public readonly metricsCollector: MetricsCollectorInterface = globalMetricsCollector;
  public currentTick: number = 0;

  public static getInstance(): RuntimeKernel {
    if (!RuntimeKernel.instance) {
      RuntimeKernel.instance = new RuntimeKernel();
    }
    return RuntimeKernel.instance;
  }

  /**
   * 构造函数 - 预注册域所有权
   */
  constructor() {
    this.initializeDomainOwnership();
  }

  /**
   * 初始化域所有权配置
   */
  private initializeDomainOwnership(): void {
    // 司法法庭域：可访问 court_case_registry_* 前缀的状态
    this.stateOwnership.register('JudicialCourt', 'court_case_registry*');

    // AI 运行时域：可访问 AIRuntime_* 前缀的状态
    this.stateOwnership.register('AIRuntime', 'AIRuntime*');
    this.stateOwnership.register('AIRuntime', 'core_scheduler*');

    // 资源总调度域：可访问 governor_* 前缀的状态
    this.stateOwnership.register('Governor', 'governor*');

    // Shadow Governor 域：可访问 governor_shadow_* 前缀的状态
    this.stateOwnership.register('ShadowGovernor', 'governor_shadow*');

    // 决策引擎域：可访问 decision_* 前缀的状态
    this.stateOwnership.register('DecisionEngine', 'decision*');
  }

  /**
   * 注册组件
   */
  public register(component: RuntimeComponent): void {
    if (this.components.has(component.name)) {
      throw new Error(
        `[RuntimeKernel] Component already registered: ${component.name}`
      );
    }

    this.components.set(component.name, component);

    console.log(
      `[RuntimeKernel] Registered component: ${component.name}`
    );
  }

  /**
   * 启动全部组件
   */
  public async start(): Promise<void> {
    this.transition(RuntimeState.INITIALIZING);

    try {
      for (const component of this.components.values()) {
        console.log(
          `[RuntimeKernel] Starting: ${component.name}`
        );

        await component.start();

        console.log(
          `[RuntimeKernel] Started: ${component.name}`
        );
      }

      this.transition(RuntimeState.READY);

      console.log(
        '[RuntimeKernel] Runtime READY'
      );
    } catch (error) {
      console.error(
        '[RuntimeKernel] Startup failure',
        error
      );

      this.transition(RuntimeState.PANIC);

      throw error;
    }
  }

  /**
   * 优雅关闭
   */
  public async shutdown(): Promise<void> {
    this.transition(RuntimeState.SHUTTING_DOWN);

    const reverseComponents = Array
      .from(this.components.values())
      .reverse();

    for (const component of reverseComponents) {
      try {
        console.log(
          `[RuntimeKernel] Stopping: ${component.name}`
        );

        await component.stop();

        console.log(
          `[RuntimeKernel] Stopped: ${component.name}`
        );
      } catch (error) {
        console.error(
          `[RuntimeKernel] Failed stopping ${component.name}`,
          error
        );
      }
    }

    this.transition(RuntimeState.STOPPED);

    console.log(
      '[RuntimeKernel] Runtime STOPPED'
    );
  }

  /**
   * 全局健康检查
   */
  public async healthCheck(): Promise<boolean> {
    if (this.state === RuntimeState.PANIC) {
      return false;
    }

    const results = await Promise.all(
      Array.from(this.components.values()).map(async component => {
        try {
          return await component.healthCheck();
        } catch {
          return false;
        }
      })
    );

    return results.every(Boolean);
  }

  /**
   * 获取状态
   */
  public getState(): RuntimeState {
    return this.state;
  }

  /**
   * 获取组件
   */
  public getComponent<T extends RuntimeComponent>(
    name: string
  ): T | undefined {
    return this.components.get(name) as T;
  }

  /**
   * 状态迁移
   */
  private transition(next: RuntimeState): void {
    console.log(
      `[RuntimeKernel] ${this.state} -> ${next}`
    );

    this.state = next;
  }

  // ────────────── 运行时模式控制 ──────────────
  public setMode(mode: RuntimeMode): void {
    this.mode = mode;
    console.log(`[RuntimeKernel] Mode: ${this.mode}`);
  }

  // ────────────── 事件总线访问器 ──────────────
  /**
   * 获取事件总线（兼容 RuntimeKernelInterface）
   */
  public getEventBus(): EventBusInterface {
    return this.eventBus;
  }

  /**
   * 获取生命周期管理器
   */
  public getLifecycleManager(): LifecycleManager | null {
    return this.lifecycleManager;
  }

  /**
   * 设置生命周期管理器
   */
  public setLifecycleManager(manager: LifecycleManager): void {
    this.lifecycleManager = manager;
    console.log('[RuntimeKernel] LifecycleManager 已设置');
  }

  // ────────────── 状态所有权验证 ──────────────
  /**
   * 验证域是否有状态的所有权
   */
  public verifyOwnership(domain: string, key: string): boolean {
    return this.stateOwnership.hasOwnership(domain, key);
  }

  /**
   * 注册域的状态所有权
   */
  public registerOwnership(domain: string, keyPattern: string): void {
    this.stateOwnership.register(domain, keyPattern);
    console.log(`[RuntimeKernel] Registered ownership: ${domain} -> ${keyPattern}`);
  }

  // ────────────── 命令总线 ──────────────
  public async executeCommand(cmd: {
    id?: string;
    type: string;
    domain: string;
    caller: string;
    payload: any;
  }): Promise<any> {
    console.log(`[RuntimeKernel] Execute command: ${cmd.type} from ${cmd.caller}`);
    if (this.commandBus?.execute) {
      try {
        return await this.commandBus.execute(cmd);
      } catch (err: any) {
        console.error(`[RuntimeKernel] Command ${cmd.type} failed:`, err.message);
        return { accepted: false, type: cmd.type, error: err.message };
      }
    }
    console.warn(`[RuntimeKernel] CommandBus not initialized, command ${cmd.type} dropped`);
    return { accepted: false, type: cmd.type, error: 'CommandBus not initialized' };
  }

  // ────────────── 兼容旧系统装配器的存根接口 ──────────────
  public bootstrapCoreLinkages(components: {
    commandBus: CommandBusInterface;
    transactionManager: ITransactionManager;
    projectionManager: any;
    snapshotManager: any;
    scheduler: any;
  }): void {
    this.commandBus = components.commandBus;
    this.transactionManager = components.transactionManager as TransactionManager;
    this.projectionManager = components.projectionManager;
    this.snapshotManager = components.snapshotManager;
    this.scheduler = components.scheduler;
  }

  public getMode(): RuntimeMode {
    return this.mode;
  }

  // ────── 🔥 Garnet 热数据层管理 ──────

  /**
   * 注入 Garnet 热数据层客户端（ioredis 实例）
   * 必须在冷启动阶段调用
   */
  public setGarnetClient(client: Redis): void {
    this._garnetClient = client;
    this._garnetConnected = true;
    console.log('[RuntimeKernel] 🔥 Garnet 热数据层客户端已注入');
  }

  /**
   * 获取 Garnet 热数据层客户端
   * 返回 null 表示热数据层未就绪（应降级到直写 SurrealDB 模式）
   */
  public getGarnetClient(): Redis | null {
    return this._garnetClient;
  }

  /**
   * Garnet 热数据层是否就绪
   */
  public isGarnetReady(): boolean {
    return this._garnetConnected && this._garnetClient !== null;
  }

  /**
   * 断开 Garnet 连接（优雅关闭时调用）
   */
  public async disconnectGarnet(): Promise<void> {
    if (this._garnetClient) {
      try {
        await this._garnetClient.quit();
        this._garnetClient = null;
        this._garnetConnected = false;
        console.log('[RuntimeKernel] 🔥 Garnet 热数据层连接已断开');
      } catch (err) {
        console.error('[RuntimeKernel] Garnet 断开失败:', (err as Error).message);
      }
    }
  }

  public registerDomain(): void {}
}

// ============================================================
// 向后兼容别名（供测试使用）
// ============================================================

/**
 * @deprecated 使用 RuntimeKernel 代替
 */
export const SovereignRuntimeKernel = RuntimeKernel;

// 刚性合流：直导出微内核事实引用，确保大盘 index.ts 零阻断
export const kernel = RuntimeKernel.getInstance();
export default kernel;
