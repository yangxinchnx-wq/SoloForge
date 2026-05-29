// src/runtime/health.ts
import { RuntimeComponent, RuntimePhase, HealthReport } from './lifecycle';

export interface SystemHealthMetrics {
  uptime: number;
  totalComponents: number;
  healthyComponents: number;
  degradedComponents: number;
  failedComponents: number;
  activeTransactions: number;
  schedulerQueueDepth: number;
  eventCount: number;
  memoryUsage: number;
  cpuUsage: number;
}

export class HealthManager {
  private startTime: number = Date.now();
  private metrics: SystemHealthMetrics = {
    uptime: 0,
    totalComponents: 0,
    healthyComponents: 0,
    degradedComponents: 0,
    failedComponents: 0,
    activeTransactions: 0,
    schedulerQueueDepth: 0,
    eventCount: 0,
    memoryUsage: 0,
    cpuUsage: 0,
  };

  updateMetrics(newMetrics: Partial<SystemHealthMetrics>): void {
    this.metrics = { ...this.metrics, ...newMetrics };
  }

  async getSystemHealth(components: Map<string, RuntimeComponent>): Promise<HealthReport> {
    this.metrics.uptime = Math.floor((Date.now() - this.startTime) / 1000);

    let healthy = 0;
    let degraded = 0;
    let failed = 0;
    const details: Record<string, any> = {};

    for (const [id, comp] of components) {
      try {
        const report = await comp.health();
        details[id] = report;

        if (report.status === 'healthy') healthy++;
        else if (report.status === 'degraded') degraded++;
        else failed++;
      } catch (error) {
        failed++;
        details[id] = { status: 'failed', error: (error as Error).message };
      }
    }

    this.metrics.totalComponents = components.size;
    this.metrics.healthyComponents = healthy;
    this.metrics.degradedComponents = degraded;
    this.metrics.failedComponents = failed;

    let overallStatus: 'healthy' | 'degraded' | 'failed' = 'healthy';

    if (failed > 0) overallStatus = 'failed';
    else if (degraded > 0 || failed + degraded > components.size * 0.3) {
      overallStatus = 'degraded';
    }

    return {
      status: overallStatus,
      latency: Date.now(),
      details: {
        summary: this.metrics,
        components: details,
        phase: 'GLOBAL'
      },
      timestamp: Date.now()
    };
  }

  getBasicMetrics(): SystemHealthMetrics {
    return { ...this.metrics };
  }
}
