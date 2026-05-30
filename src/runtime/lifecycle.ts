// src/runtime/lifecycle.ts
export enum RuntimePhase {
  INIT = 'INIT',
  BOOTSTRAP = 'BOOTSTRAP',
  STARTING = 'STARTING',
  RUNNING = 'RUNNING',
  DEGRADED = 'DEGRADED',
  BACKPRESSURE = 'BACKPRESSURE',
  RECOVERING = 'RECOVERING',
  STOPPING = 'STOPPING',
  STOPPED = 'STOPPED',
  FAILED = 'FAILED'
}

export interface HealthReport {
  status: 'healthy' | 'degraded' | 'failed';
  latency: number;
  details: Record<string, any>;
  timestamp: number;
}

export interface RuntimeComponent {
  readonly id?: string;
  readonly name: string;
  phase?: RuntimePhase;

  start(): Promise<void>;
  stop(): Promise<void>;
  healthCheck(): Promise<boolean>;
  shutdown?(signal?: string): Promise<void>;
}

export class LifecycleManager {
  private components: Map<string, RuntimeComponent> = new Map();

  register(component: RuntimeComponent): void {
    const id = component.id || component.name;
    this.components.set(id, component);
    console.log(`[Lifecycle] 注册组件: ${id}`);
  }

  async startAll(): Promise<void> {
    console.log('[Lifecycle] 开始启动所有组件...');
    for (const [id, comp] of this.components) {
      try {
        if (comp.phase !== undefined) comp.phase = RuntimePhase.STARTING;
        await comp.start();
        if (comp.phase !== undefined) comp.phase = RuntimePhase.RUNNING;
        console.log(`[Lifecycle] ✓ ${id} 启动成功`);
      } catch (error) {
        if (comp.phase !== undefined) comp.phase = RuntimePhase.FAILED;
        console.error(`[Lifecycle] ✗ ${id} 启动失败`, error);
        throw error;
      }
    }
  }

  async stopAll(): Promise<void> {
    console.log('[Lifecycle] 开始优雅关闭...');
    // 逆序关闭
    const ids = Array.from(this.components.keys()).reverse();
    for (const id of ids) {
      const comp = this.components.get(id)!;
      try {
        if (comp.phase !== undefined) comp.phase = RuntimePhase.STOPPING;
        await comp.stop();
        if (comp.phase !== undefined) comp.phase = RuntimePhase.STOPPED;
      } catch (error) {
        console.warn(`[Lifecycle] ${id} 关闭异常`, error);
      }
    }
  }

  getComponent(id: string): RuntimeComponent | undefined {
    return this.components.get(id);
  }

  getAllComponents(): RuntimeComponent[] {
    return Array.from(this.components.values());
  }
}
