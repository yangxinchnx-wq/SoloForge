// src/kernel/transaction-manager.ts
import { ULID } from 'ulid';
import { logger } from '../core/logger';
import { RuntimeKernel } from './runtime-kernel';
import { RuntimeEvent } from '../core/events/runtime-events';

export class TransactionManager {
  private activeTransactions = new Map<string, {
    id: string;
    commandId: string;
    domain: string;
    startedAt: number;
    payload?: any;
  }>();

  constructor(private kernel: RuntimeKernel) {}

  async begin(commandId: string, domain: string, initialPayload?: any) {
    const tx = {
      id: `tx_${ULID()}`,
      commandId,
      domain,
      startedAt: Date.now(),
      payload: initialPayload
    };
    this.activeTransactions.set(tx.id, tx);
    logger.debug('TransactionManager', `Transaction opened`, { txId: tx.id, commandId });
    return tx;
  }

  async commit(txId: string): Promise<void> {
    const tx = this.activeTransactions.get(txId);
    if (!tx) {
      throw new Error(`ERR_SF_TX: Transaction ${txId} not found or already committed`);
    }

    this.activeTransactions.delete(txId);

    // 关键修复：必须在这里发射事件，激活内核版本钟和投影系统
    this.kernel.eventBus.emit(RuntimeEvent.TransactionCommitted, {
      txId: tx.id,
      commandId: tx.commandId,
      domain: tx.domain,
      timestamp: Date.now(),
      version: this.kernel.version + 1,
      data: tx.payload || {}
    });

    logger.debug('TransactionManager', `Transaction committed successfully`, { txId });
  }

  async rollback(commandId: string, error: any): Promise<void> {
    logger.warn('TransactionManager', `Rollback triggered`, { commandId, cause: error?.message });

    for (const [txId, tx] of this.activeTransactions.entries()) {
      if (tx.commandId === commandId) {
        this.activeTransactions.delete(txId);
        this.kernel.eventBus.emit(RuntimeEvent.TransactionRolledBack, {
          txId,
          commandId,
          error: error?.message
        });
      }
    }
  }

  async drain(): Promise<void> {
    this.activeTransactions.clear();
  }
}