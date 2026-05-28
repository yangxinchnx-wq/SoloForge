// src/kernel/registry.ts
import { kernel } from './runtime-kernel'; // 统一风格：唯一事实源直调模式
import { logger } from '../core/logger';
import { BackpressureManager } from './backpressure';

export interface RuntimeComponent {
  id: string;
  domain: string;
  initialize?: () => Promise<void>;
  mount?: () => void;
  health?: () => Promise<{ status: 'healthy' | 'degraded' | 'failed'; [key: string]: any }>;
}

export class ComponentRegistry {
  private static instance: ComponentRegistry;
  private components: Map<string, RuntimeComponent> = new Map();
  private backpressure = new BackpressureManager();

  private lastHealthReportSnapshot: any = {
    status: 'healthy',
    totalComponents: 0,
    activeHealthChecked: 0,
    implicitHealthyComponents: 0,
    componentsTopology: {},
    timestamp: Date.now()
  };

  public static getInstance(): ComponentRegistry {
    if (!ComponentRegistry.instance) {
      ComponentRegistry.instance = new ComponentRegistry();
    }
    return ComponentRegistry.instance;
  }

  public register(component: RuntimeComponent): void {
    this.components.set(component.id, component);

    // 刚性风格校准：直接通过唯一内核实例划分所有权树，阻止 Split-Brain 风险
    kernel.registerDomain(component.domain, component);

    logger.info('ComponentRegistry', `✅ 运行时组件已安全挂载至内核域: [${component.id}] → Domain: ${component.domain}`);
    this.refreshSnapshotSync();
  }

  private refreshSnapshotSync(): void {
    let checked = 0;
    let implicit = 0;
    const topology: any = {};

    for (const [id, comp] of this.components) {
      if (comp.health) {
        checked++;
        topology[id] = { status: 'healthy', info: 'Ready for runtime active health telemetry' };
      } else {
        implicit++;
        topology[id] = { status: 'healthy', info: 'Implicit volatile dynamic module (Exempt)' };
      }
    }

    this.lastHealthReportSnapshot = {
      status: 'healthy',
      totalComponents: this.components.size,
      activeHealthChecked: checked,
      implicitHealthyComponents: implicit,
      componentsTopology: topology,
      backpressure: this.backpressure.getMetrics(),
      timestamp: Date.now()
    };
  }

  public getBackpressureManager(): BackpressureManager {
    return this.backpressure;
  }

  public async getGlobalHealth(): Promise<any> {
    const healths: any = {};
    let hasFailureOrDegraded = false;
    let checkedComponentsCount = 0;
    let implicitHealthyCount = 0;

    for (const [id, comp] of this.components) {
      try {
        if (comp.health) {
          checkedComponentsCount++;
          const report = await comp.health();
          healths[id] = report;
          if (report && report.status !== 'healthy') {
            hasFailureOrDegraded = true;
          }
        } else {
          implicitHealthyCount++;
          healths[id] = { status: 'healthy', info: 'Implicit volatile dynamic module' };
        }
      } catch (e: any) {
        hasFailureOrDegraded = true;
        healths[id] = { status: 'failed', error: e.message };
      }
    }

    this.lastHealthReportSnapshot = {
      status: hasFailureOrDegraded ? 'degraded' : 'healthy',
      totalComponents: this.components.size,
      activeHealthChecked: checkedComponentsCount,
      implicitHealthyComponents: implicitHealthyCount,
      componentsTopology: healths,
      backpressure: this.backpressure.getMetrics(),
      timestamp: Date.now()
    };

    return this.lastHealthReportSnapshot;
  }

  /**
   * 同步 O(1) 快照只读提取：免去模板字符串中的 Promise 泄漏，全面落实"观测链路背压豁免"原则
   */
  public getGlobalHealthSnapshotSync(): any {
    return this.lastHealthReportSnapshot;
  }

  public getAllComponents(): RuntimeComponent[] {
    return Array.from(this.components.values());
  }
}
