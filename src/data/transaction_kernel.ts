// ─────────────────────────────────────────────────────────────────
// SoloForge Data Layer: Atomic Transaction Kernel
// Path: src/data/transaction_kernel.ts
//
// 设计意图:
//   为 Layer 6 全链路总装测试 (system-backbone.test.ts) 提供原子事务内核。
//   实现乐观锁版本控制的状态递增提交，确保并发冲突检测。
// ─────────────────────────────────────────────────────────────────

export interface StatePatch {
  targetKey: string;
  value: any;
}

export class TransactionKernel {
  private registry: Record<string, any>;
  private _version: number;

  constructor(initialRegistry: Record<string, any> = {}) {
    this.registry = this.deepClone(initialRegistry);
    this._version = 1;
  }

  get version(): number {
    return this._version;
  }

  /**
   * 提交原子事务
   * - 乐观锁: expectedVersion !== current version → 拒绝, return false
   * - 成功: 按顺序应用 patches, version++, return true
   * - 运行时异常: 回滚所有已应用变更, 抛出 ERR_TX_PATCH_APPLY_FAILED
   */
  commitTransaction(patches: StatePatch[], expectedVersion: number): boolean {
    if (expectedVersion !== this._version) {
      return false;
    }

    // 保存快照用于回滚
    const snapshotRegistry = this.deepClone(this.registry);
    const snapshotVersion = this._version;

    try {
      for (const patch of patches) {
        this.registry[patch.targetKey] = this.deepClone(patch.value);
      }
      this._version++;
      return true;
    } catch (err) {
      // 回滚到快照
      this.registry = snapshotRegistry;
      this._version = snapshotVersion;
      throw new Error(`ERR_TX_PATCH_APPLY_FAILED: ${(err as Error).message}`);
    }
  }

  getSnapshot(): { version: number; data: Record<string, any> } {
    return {
      version: this._version,
      data: this.deepClone(this.registry),
    };
  }

  get(key: string): any {
    return this.registry[key];
  }

  private deepClone<T>(value: T): T {
    if (typeof structuredClone === 'function') {
      try {
        return structuredClone(value);
      } catch {
        // fallback
      }
    }
    return JSON.parse(JSON.stringify(value)) as T;
  }
}
