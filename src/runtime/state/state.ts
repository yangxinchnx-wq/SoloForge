// src/runtime/state/state.ts
export enum IsolationLevel {
  READ_ONLY = 'READ_ONLY',
  TRANSACTIONAL = 'TRANSACTIONAL',
  EPHEMERAL = 'EPHEMERAL',      // 临时推理状态
  CONSENSUS = 'CONSENSUS'       // 需要 Court 通过才能写入
}

export interface StateSnapshot {
  key: string;
  value: any;
  version: number;
  isolation: IsolationLevel;
  lastModified: number;
}

export class StateManager {
  private stateStore: Map<string, StateSnapshot> = new Map();
  private transactionStore: Map<string, Map<string, any>> = new Map();

  set(key: string, value: any, isolation: IsolationLevel = IsolationLevel.TRANSACTIONAL): void {
    const snapshot: StateSnapshot = {
      key,
      value,
      version: Date.now(),
      isolation,
      lastModified: Date.now()
    };
    this.stateStore.set(key, snapshot);
  }

  get(key: string): any {
    return this.stateStore.get(key)?.value;
  }

  beginTransaction(txId: string): void {
    this.transactionStore.set(txId, new Map());
  }

  commitTransaction(txId: string): boolean {
    const tx = this.transactionStore.get(txId);
    if (!tx) return false;

    for (const [key, value] of tx) {
      this.set(key, value, IsolationLevel.TRANSACTIONAL);
    }
    this.transactionStore.delete(txId);
    return true;
  }

  rollbackTransaction(txId: string): void {
    this.transactionStore.delete(txId);
  }

  getSnapshot(): Record<string, StateSnapshot> {
    const snapshot: Record<string, StateSnapshot> = {};
    for (const [k, v] of this.stateStore) {
      snapshot[k] = v;
    }
    return snapshot;
  }
}