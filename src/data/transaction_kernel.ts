export interface StateSnapshot {
  version: number;
  timestamp: number;
  data: Record<string, any>;
}

export interface StatePatch {
  targetKey: string;
  value: any;
}

export class TransactionKernel {
  private currentSnapshot: StateSnapshot;
  private rollbackStack: StateSnapshot[] = [];
  private readonly maxStackDepth = 50;

  constructor(initialData: Record<string, any> = {}) {
    this.currentSnapshot = {
      version: 1,
      timestamp: Date.now(),
      data: JSON.parse(JSON.stringify(initialData))
    };
  }

  public getSnapshot(): StateSnapshot {
    return this.currentSnapshot;
  }

  public commitTransaction(patches: StatePatch[], expectedVersion: number): boolean {
    if (this.currentSnapshot.version !== expectedVersion) {
      console.error("[SYS_TRANSACTION] 版本冲突! 预期: " + expectedVersion + ", 当前: " + this.currentSnapshot.version);
      return false;
    }

    if (this.rollbackStack.length >= this.maxStackDepth) {
      this.rollbackStack.shift();
    }
    this.rollbackStack.push(JSON.parse(JSON.stringify(this.currentSnapshot)));

    try {
      const newData = JSON.parse(JSON.stringify(this.currentSnapshot.data));
      for (const patch of patches) {
        newData[patch.targetKey] = patch.value;
      }

      this.currentSnapshot = {
        version: this.currentSnapshot.version + 1,
        timestamp: Date.now(),
        data: newData
      };

      console.log("[SYS_TRANSACTION] 事务提交成功. 新版本: " + this.currentSnapshot.version);
      return true;
    } catch (err) {
      console.error("[SYS_TRANSACTION] 事务应用失败，触发自动紧急回滚!", err);
      return this.rollback();
    }
  }

  public rollback(): boolean {
    const previousSnapshot = this.rollbackStack.pop();
    if (!previousSnapshot) {
      console.error("[CRITICAL_SYS] 回滚失败: 历史备份栈已空!");
      throw new Error("SYS001: Rollback stack underflow");
    }

    this.currentSnapshot = previousSnapshot;
    console.warn("[SYS_TRANSACTION] 💥 触发安全机制，系统已原子化回滚至版本: " + this.currentSnapshot.version);
    return true;
  }
}