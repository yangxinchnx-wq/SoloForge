// src/kernel/watchdog.ts
import { kernel } from './runtime-kernel';
import { ComponentRegistry } from './registry';
import { PressureLevel } from './backpressure';
import { RuntimeEvent } from '../core/events/runtime-events';
import { logger } from '../core/logger';

export interface WatchdogConfig {
  tickIntervalMs: number;
  maxTransactionTimeoutMs: number;
}

export class RuntimeWatchdog {
  private static instance: RuntimeWatchdog;
  private registry = ComponentRegistry.getInstance();
  private timer: NodeJS.Timeout | null = null;
  private isRunning = false;

  private lastCheckedVersion = 0;
  private lastVersionChangeTime = Date.now();

  private config: WatchdogConfig = {
    tickIntervalMs: 5000,
    maxTransactionTimeoutMs: 15000
  };

  public static getInstance(): RuntimeWatchdog {
    if (!RuntimeWatchdog.instance) {
      RuntimeWatchdog.instance = new RuntimeWatchdog();
    }
    return RuntimeWatchdog.instance;
  }

  public start(customConfig?: Partial<WatchdogConfig>): void {
    if (this.isRunning) return;
    this.config = { ...this.config, ...customConfig };
    this.isRunning = true;

    this.lastVersionChangeTime = Date.now();
    this.lastCheckedVersion = kernel?.version ?? 0;

    this.timer = setInterval(() => {
      this.executeSafetyCheckLoop().catch((err) => {
        logger.error('Watchdog', '💥 看门狗内部安全检查循环崩溃', { error: err.message });
      });
    }, this.config.tickIntervalMs);

    logger.info('Watchdog', '👁️ Supervisor 看门狗卫士已激活站岗，全面接管自愈树');
  }

  private async executeSafetyCheckLoop(): Promise<void> {
    const currentTimestamp = Date.now();
    const currentVersion = kernel?.version ?? 0;

    const bpManager = this.registry.getBackpressureManager();
    const currentPressure = bpManager.getMetrics().pressureLevel;

    // 1. 轻量级内核事务流卡死判定
    this.checkKernelStall(currentVersion, currentTimestamp);

    // 2. 🛡️ 极限负载防御：若系统过载，自动降级挂起组件遍历，把 CPU 拱手让给业务管道
    if (currentPressure === PressureLevel.CRITICAL) {
      logger.warn('Watchdog', '🚨 系统处于 CRITICAL 过载！看门狗开启自适应降级最小化干预状态');
      return;
    }

    // 3. 稳态下触发全量扫描并冲刷只读快照
    const healthReport = await this.registry.getGlobalHealth();

    // 4. 自愈级联控制树执行
    if (healthReport && healthReport.status !== 'healthy') {
      await this.executeSupervisorSelfHealing(healthReport);
    } else if (kernel?.eventBus) {
      kernel.eventBus.emit(RuntimeEvent.SnapshotCreated, {
        status: 'PERFECT_STABLE',
        activeChecked: healthReport?.activeHealthChecked ?? 0,
        timestamp: currentTimestamp
      });
    }
  }

  private checkKernelStall(currentVersion: number, currentTimestamp: number): void {
    if (currentVersion !== this.lastCheckedVersion) {
      this.lastCheckedVersion = currentVersion;
      this.lastVersionChangeTime = currentTimestamp;
    } else {
      const bpManager = this.registry.getBackpressureManager();
      if (bpManager.getMetrics().queueDepth > 0 && (currentTimestamp - this.lastVersionChangeTime) > this.config.maxTransactionTimeoutMs) {
        logger.error('Watchdog', `🚨 检测到内核写事务处理卡死！版本持续停留在 v${currentVersion}`);
        if (kernel?.eventBus) {
          kernel.eventBus.emit(RuntimeEvent.RuntimeRecovery, {
            type: 'KERNEL_STALL_WARNING',
            message: `Kernel core write pathway stalled at v${currentVersion} under high load.`,
            timestamp: currentTimestamp
          });
        }
      }
    }
  }

  private async executeSupervisorSelfHealing(healthReport: any): Promise<void> {
    logger.warn('Watchdog', '⚠️ 检测到局部领域板卡异常，拉起控制树级联热重启...');
    const topology = healthReport?.componentsTopology ?? {};

    for (const comp of this.registry.getAllComponents()) {
      const compStatus = topology[comp.id];
      if (compStatus && (compStatus.status === 'failed' || compStatus.status === 'degraded')) {
        try {
          if (typeof comp.initialize === 'function') {
            await comp.initialize();
            logger.info('Watchdog', `🎉 故障组件 [${comp.id}] 原厂挂载契约重置自愈成功`);
          } else if (typeof comp.mount === 'function') {
            comp.mount();
            logger.info('Watchdog', `🎉 故障组件 [${comp.id}] 重新插拔挂载完毕`);
          }
        } catch (recoveryError: any) {
          logger.error('Watchdog', `❌ 组件 [${comp.id}] 级联恢复控制链断裂`, { error: recoveryError.message });
        }
      }
    }
  }

  /**
   * 🛡️ 显式外开优雅停机释放钩子，彻底根除进程退出时的定时器残留与泄漏
   */
  public shutdown(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.isRunning = false;
    logger.warn('Watchdog', '🛑 Supervisor 看门狗守护进程已平稳解绑下线并清理内存定时器');
  }
}
