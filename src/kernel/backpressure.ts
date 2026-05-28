// src/kernel/backpressure.ts
import { logger } from '../core/logger';

export enum PressureLevel {
  NORMAL = 'NORMAL',
  ELEVATED = 'ELEVATED',
  HIGH = 'HIGH',
  CRITICAL = 'CRITICAL'
}

export interface BackpressureMetrics {
  pressureLevel: PressureLevel;
  queueDepth: number;
  eventRate: number;
  activeTransactions: number;
  latencyP95: number;
  rejectionRate: number; // 精确比率 (0.0 ~ 1.0)
}

export class BackpressureManager {
  private pressureLevel: PressureLevel = PressureLevel.NORMAL;
  private queueDepth = 0;
  private eventRate = 0;
  private activeTx = 0;
  private lastCheck = Date.now();

  private totalRequests = 0;
  private rejectionCount = 0;

  private readonly THRESHOLDS = {
    queue: { elevated: 50, high: 120, critical: 250 },
    rate: { elevated: 30, high: 80, critical: 150 },   // QPS 基准
    latency: { elevated: 80, high: 200, critical: 500 } // 毫秒
  };

  public updateMetrics(queueDepth: number, eventRate: number, latency: number, activeTx: number): void {
    this.totalRequests++;
    this.queueDepth = queueDepth;
    this.eventRate = eventRate;
    this.activeTx = activeTx;

    let newLevel = PressureLevel.NORMAL;

    if (queueDepth > this.THRESHOLDS.queue.critical ||
        eventRate > this.THRESHOLDS.rate.critical ||
        latency > this.THRESHOLDS.latency.critical) {
      newLevel = PressureLevel.CRITICAL;
    } else if (queueDepth > this.THRESHOLDS.queue.high ||
               eventRate > this.THRESHOLDS.rate.high ||
               latency > this.THRESHOLDS.latency.high) {
      newLevel = PressureLevel.HIGH;
    } else if (queueDepth > this.THRESHOLDS.queue.elevated ||
               eventRate > this.THRESHOLDS.rate.elevated ||
               latency > this.THRESHOLDS.latency.elevated) {
      newLevel = PressureLevel.ELEVATED;
    }

    if (newLevel !== this.pressureLevel) {
      this.pressureLevel = newLevel;
      logger.warn('Backpressure', `系统压力等级演进 → ${newLevel}`, {
        queueDepth,
        eventRate,
        latency,
        activeTx,
        rejectionRate: this.getRejectionRate().toFixed(4)
      });
    }

    if (newLevel === PressureLevel.CRITICAL) {
      this.rejectionCount++;
    }
  }

  public shouldAcceptTask(): boolean {
    return this.pressureLevel !== PressureLevel.CRITICAL;
  }

  private getRejectionRate(): number {
    return this.totalRequests > 0 ? this.rejectionCount / this.totalRequests : 0;
  }

  public getMetrics(): BackpressureMetrics {
    return {
      pressureLevel: this.pressureLevel,
      queueDepth: this.queueDepth,
      eventRate: this.eventRate,
      activeTransactions: this.activeTx,
      latencyP95: 0,
      rejectionRate: this.getRejectionRate()
    };
  }

  public async applyBackpressure(): Promise<void> {
    if (this.pressureLevel === PressureLevel.CRITICAL) {
      await new Promise(resolve => setTimeout(resolve, 50));
    } else if (this.pressureLevel === PressureLevel.HIGH) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
}
