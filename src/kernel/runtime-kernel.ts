// ─────────────────────────────────────────────────────────────────
// SoloForge Kernel Layer: Sovereign Control Plane Plane Core
// Path: src/kernel/runtime-kernel.ts
// ─────────────────────────────────────────────────────────────────

import { RuntimeComponent } from './runtime-component';

export enum RuntimeState {
  BOOTING = 'BOOTING',
  INITIALIZING = 'INITIALIZING',
  READY = 'READY',
  DEGRADED = 'DEGRADED',
  SHUTTING_DOWN = 'SHUTTING_DOWN',
  STOPPED = 'STOPPED',
  PANIC = 'PANIC',
}

export class RuntimeKernel {
  private static instance: RuntimeKernel | null = null;
  private state: RuntimeState = RuntimeState.BOOTING;

  /**
   * 全局组件注册表
   */
  private readonly components = new Map<string, RuntimeComponent>();

  public commandBus: any = null;
  public transactionManager: any = null;
  public projectionManager: any = null;
  public snapshotManager: any = null;
  public scheduler: any = null;
  public readonly id = 'kernel_sovereign_core';
  public readonly startedAt = Date.now();
  public version = 0;
  public readonly eventBus: any = { emit: () => {}, on: () => {} };

  public static getInstance(): RuntimeKernel {
    if (!RuntimeKernel.instance) {
      RuntimeKernel.instance = new RuntimeKernel();
    }
    return RuntimeKernel.instance;
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

  // ────────────── 兼容旧系统装配器的存根接口 ──────────────
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
  }
  public getMode(): string { return 'normal'; }
  public registerDomain(): void {}
}

// 刚性合流：直导出微内核事实引用，确保大盘 index.ts 零阻断
export const kernel = RuntimeKernel.getInstance();
export default kernel;
