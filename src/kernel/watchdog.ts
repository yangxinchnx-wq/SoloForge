// ─────────────────────────────────────────────────────────────────
// SoloForge Kernel Layer: Runtime Watchdog
// Path: src/kernel/watchdog.ts
// ─────────────────────────────────────────────────────────────────

import { ComponentRegistry } from './registry';
import { logger } from '../core/logger';

interface WatchdogConfig {
  tickIntervalMs: number;
  healthCheckTimeoutMs?: number;
}

export class RuntimeWatchdog {
  private static instance: RuntimeWatchdog | null = null;
  private config: WatchdogConfig = { tickIntervalMs: 5000, healthCheckTimeoutMs: 3000 };
  private timer: NodeJS.Timeout | null = null;
  private readonly registry = ComponentRegistry.getInstance();

  private constructor() {}

  public static getInstance(): RuntimeWatchdog {
    if (!RuntimeWatchdog.instance) {
      RuntimeWatchdog.instance = new RuntimeWatchdog();
    }
    return RuntimeWatchdog.instance;
  }

  public start(config: WatchdogConfig): void {
    this.config = { ...this.config, ...config };
    logger.info('Watchdog', `🛡️ 看门狗启动，间隔 ${this.config.tickIntervalMs}ms`);

    this.timer = setInterval(() => this.tick(), this.config.tickIntervalMs);
  }

  public shutdown(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      logger.info('Watchdog', '🛡️ 看门狗已关闭');
    }
  }

  private async tick(): Promise<void> {
    try {
      const components = this.registry.getAllComponents();
      const results = await Promise.allSettled(
        components.map(async (comp) => {
          const timeout = this.config.healthCheckTimeoutMs ?? 3000;
          return Promise.race([
            comp.healthCheck(),
            new Promise<boolean>((_, reject) =>
              setTimeout(() => reject(new Error('HEALTH_CHECK_TIMEOUT')), timeout)
            )
          ]);
        })
      );

      const failed = results.filter(r => r.status === 'rejected' || r.status === 'fulfilled' && !r.value);
      if (failed.length > 0) {
        logger.warn('Watchdog', `⚠️ ${failed.length}/${components.length} 组件健康检查异常`);
      }
    } catch (err: any) {
      logger.error('Watchdog', '💥 看门狗tick异常', { error: err.message });
    }
  }
}
