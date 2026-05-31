// src/runtime/kernel.ts
import { RuntimeComponent, RuntimePhase, LifecycleManager, HealthReport } from './lifecycle';
import { Supervisor } from './supervisor';

export class RuntimeKernel implements RuntimeComponent {
  public readonly id = 'RuntimeKernel';
  public readonly name = 'RuntimeKernel';
  public phase: RuntimePhase = RuntimePhase.INIT;

  private lifecycle = new LifecycleManager();
  private supervisor = new Supervisor();
  private components: Map<string, RuntimeComponent> = new Map();

  private static instance: RuntimeKernel;

  static getInstance(): RuntimeKernel {
    if (!RuntimeKernel.instance) {
      RuntimeKernel.instance = new RuntimeKernel();
    }
    return RuntimeKernel.instance;
  }

  registerComponent(component: RuntimeComponent): void {
    this.components.set(component.id, component);
    this.lifecycle.register(component);
    this.supervisor.watch(component);
  }

  async start(): Promise<void> {
    this.phase = RuntimePhase.BOOTSTRAP;
    console.log('🚀 SoloForge RuntimeKernel 启动...');

    await this.lifecycle.startAll();

    this.phase = RuntimePhase.RUNNING;
    console.log('✅ SoloForge RuntimeKernel 已完全启动并运行');
  }

  async stop(): Promise<void> {
    this.phase = RuntimePhase.STOPPING;
    await this.lifecycle.stopAll();
    this.phase = RuntimePhase.STOPPED;
  }

  async health(): Promise<HealthReport> {
    const reports: Record<string, HealthReport> = {};
    let overallStatus: 'healthy' | 'degraded' | 'failed' = 'healthy';

    for (const [id, comp] of this.components) {
      try {
        const report = await comp.health();
        reports[id] = report;
        if (report.status === 'failed') overallStatus = 'failed';
        else if (report.status === 'degraded' && overallStatus !== 'failed') {
          overallStatus = 'degraded';
        }
      } catch (e) {
        overallStatus = 'failed';
      }
    }

    return {
      status: overallStatus,
      latency: Date.now(),
      details: { components: reports, phase: this.phase },
      timestamp: Date.now()
    };
  }

  async healthCheck(): Promise<boolean> {
    const report = await this.health();
    return report.status !== 'failed';
  }

  async shutdown(signal = 'SIGTERM'): Promise<void> {
    console.log(`⚠️ 收到关闭信号: ${signal}`);
    await this.stop();
    process.exit(0);   // 这里需要 @types/node 支持
  }
}
