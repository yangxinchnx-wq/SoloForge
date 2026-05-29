// ─────────────────────────────────────────────────────────────────
// SoloForge Kernel Layer: Adaptive Backpressure Manager
// Path: src/kernel/backpressure.ts
// ─────────────────────────────────────────────────────────────────

export enum PressureLevel {
  NORMAL = 'NORMAL',
  ELEVATED = 'ELEVATED',
  HIGH = 'HIGH',
  CRITICAL = 'CRITICAL'
}

export interface BackpressureMetrics {
  pressureLevel: PressureLevel;
  queueDepth: number;
  rejectionRate: number;
  memoryPressure: number;
}

export class BackpressureManager {
  private level: PressureLevel = PressureLevel.NORMAL;
  private queueDepth = 0;
  private rejectionCount = 0;
  private totalRequests = 0;

  public recordRequest(): void {
    this.totalRequests++;
    this.queueDepth++;
    this.recalculate();
  }

  public recordCompletion(): void {
    this.queueDepth = Math.max(0, this.queueDepth - 1);
    this.recalculate();
  }

  public recordRejection(): void {
    this.rejectionCount++;
    this.recalculate();
  }

  private recalculate(): void {
    const rejectionRate = this.totalRequests > 0
      ? this.rejectionCount / this.totalRequests
      : 0;

    if (this.queueDepth > 1000 || rejectionRate > 0.5 || this.getMemoryPressure() > 0.95) {
      this.level = PressureLevel.CRITICAL;
    } else if (this.queueDepth > 500 || rejectionRate > 0.2 || this.getMemoryPressure() > 0.85) {
      this.level = PressureLevel.HIGH;
    } else if (this.queueDepth > 200 || rejectionRate > 0.05 || this.getMemoryPressure() > 0.7) {
      this.level = PressureLevel.ELEVATED;
    } else {
      this.level = PressureLevel.NORMAL;
    }
  }

  private getMemoryPressure(): number {
    const used = process.memoryUsage();
    return used.heapUsed / used.heapTotal;
  }

  public getMetrics(): BackpressureMetrics {
    return {
      pressureLevel: this.level,
      queueDepth: this.queueDepth,
      rejectionRate: this.totalRequests > 0
        ? this.rejectionCount / this.totalRequests
        : 0,
      memoryPressure: this.getMemoryPressure()
    };
  }

  public shouldReject(): boolean {
    return this.level === PressureLevel.CRITICAL;
  }
}
