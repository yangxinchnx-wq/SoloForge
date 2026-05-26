// ─────────────────────────────────────────────────────────────────
// SoloForge Runtime Core: Sovereign Runtime Kernel
// Path: src/kernel/runtime-kernel.ts
// ─────────────────────────────────────────────────────────────────

export interface EventEnvelope {
  event: string;
  payload: any;
  timestamp: number;
}

export class SimpleEventBus {
  private eventLog: EventEnvelope[] = [];

  public emit(event: string, payload: any): void {
    this.eventLog.push({
      event,
      payload,
      timestamp: Date.now()
    });
  }

  public getEventLog(): EventEnvelope[] {
    return this.eventLog;
  }
}

export class SovereignRuntimeKernel {
  private eventBus = new SimpleEventBus();
  private ownershipMap: Map<string, string> = new Map();

  constructor() {
    // 显式在底座内核中锁定权限边界，禁止任何智能体跨域越权篡改数据
    this.registerDomainPattern('AIRuntime', 'core_scheduler_memory');
    this.registerDomainPattern('AIRuntime', 'racer_calibration_node');
    this.registerDomainPattern('JudicialCourt', 'court_case_registry*');
  }

  public registerDomainPattern(domain: string, pattern: string): void {
    this.ownershipMap.set(pattern, domain);
  }

  /**
   * 宪法级防御拦截：校验当前调用域（Domain）是否拥有该状态键的物理修改权
   */
  public verifyOwnership(domain: string, key: string): boolean {
    if (this.ownershipMap.has(key)) {
      return this.ownershipMap.get(key) === domain;
    }
    // 兼容通配符前缀路由检验
    for (const [pattern, authorizedOwner] of this.ownershipMap.entries()) {
      if (pattern.endsWith('*') && key.startsWith(pattern.slice(0, -1))) {
        return authorizedOwner === domain;
      }
    }
    return true;
  }

  public getEventBus(): SimpleEventBus {
    return this.eventBus;
  }
}