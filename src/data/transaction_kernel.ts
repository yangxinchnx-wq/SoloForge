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
      console.error("[SYS_TRANSACTION] Ã§ÂÂÃ¦ÂÂ¬Ã¥ÂÂ²Ã§ÂªÂ! Ã©Â¢ÂÃ¦ÂÂ: " + expectedVersion + ", Ã¥Â½ÂÃ¥ÂÂ: " + this.currentSnapshot.version);
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

      console.log("[SYS_TRANSACTION] Ã¤ÂºÂÃ¥ÂÂ¡Ã¦ÂÂÃ¤ÂºÂ¤Ã¦ÂÂÃ¥ÂÂ. Ã¦ÂÂ°Ã§ÂÂÃ¦ÂÂ¬: " + this.currentSnapshot.version);
      return true;
    } catch (err) {
      const rolled = this.rollback();
      // Patch list malformed (e.g. undefined entry, missing targetKey). Do NOT silently
      // roll back and report success. Roll back state, then surface the error to the caller.
      const reason = err instanceof Error ? err.message : String(err);
      console.error("[SYS_TRANSACTION] patch apply failed, rolled=" + rolled + ", reason=" + reason);
      throw new Error("ERR_TX_PATCH_APPLY_FAILED: " + reason);
    }
  }

  public rollback(): boolean {
    const previousSnapshot = this.rollbackStack.pop();
    if (!previousSnapshot) {
      console.error("[CRITICAL_SYS] Ã¥ÂÂÃ¦Â»ÂÃ¥Â¤Â±Ã¨Â´Â¥: Ã¥ÂÂÃ¥ÂÂ²Ã¥Â¤ÂÃ¤Â»Â½Ã¦Â ÂÃ¥Â·Â²Ã§Â©Âº!");
      throw new Error("SYS001: Rollback stack underflow");
    }

    this.currentSnapshot = previousSnapshot;
    console.warn("[SYS_TRANSACTION] Ã°ÂÂÂ¥ Ã¨Â§Â¦Ã¥ÂÂÃ¥Â®ÂÃ¥ÂÂ¨Ã¦ÂÂºÃ¥ÂÂ¶Ã¯Â¼ÂÃ§Â³Â»Ã§Â»ÂÃ¥Â·Â²Ã¥ÂÂÃ¥Â­ÂÃ¥ÂÂÃ¥ÂÂÃ¦Â»ÂÃ¨ÂÂ³Ã§ÂÂÃ¦ÂÂ¬: " + this.currentSnapshot.version);
    return true;
  }
}