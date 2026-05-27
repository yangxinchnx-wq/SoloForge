// ─────────────────────────────────────────────────────────────────
// SoloForge Kernel Layer: State Ownership Constitution Enforcer
// Path: src/kernel/state-ownership.ts
// ─────────────────────────────────────────────────────────────────

export class StateOwnerRegistry {
  private domains = new Set<string>();
  private systemCallers = new Set(['SYSTEM_MASTER_DAEMON', 'SYSTEM', 'BOOTSTRAP', 'SUPERVISOR']);

  registerDomain(domain: string): void {
    this.domains.add(domain);
    console.info(`[INFO] [StateOwnerRegistry] Sovereign domain registered: [${domain}]`);
  }

  /** 核心宪法校验 */
  verifyCommandOwnership(command: any): void {
    const { domain, caller = 'ANONYMOUS' } = command;

    if (!domain || !this.domains.has(domain)) {
      throw new Error(`ERR_SF_OWNERSHIP: Domain [${domain}] not registered`);
    }

    // 允许系统级调用（心跳、Bootstrap 等）
    if (this.systemCallers.has(caller)) {
      return; // 放行
    }

    // 普通调用必须有合法调用者
    if (caller === 'ANONYMOUS' || !caller) {
      throw new Error(`ERR_SF_OWNERSHIP: Anonymous caller rejected on domain [${domain}]`);
    }
  }
}

export const stateOwnerRegistry = new StateOwnerRegistry();