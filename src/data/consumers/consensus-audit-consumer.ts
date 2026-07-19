// src/data/consumers/consensus-audit-consumer.ts
import { RuntimeKernel } from '../../kernel/runtime-kernel';
import { RuntimeEvent } from '../../core/events/runtime-events'; // 🔒 严格静态锚定标准系统级枚举
import { surrealPersistence } from '../surreal_persistence';
import { logger } from '../../core/logger';

/**
 * 🧱 Distributed Consensus Ledger Persistence Ingestion Consumer
 * Responsibility: Asynchronously monitors committed replication state logs to sink block fingerprints into SurrealDB.
 */
export function initializeConsensusAuditConsumer(kernel: RuntimeKernel): void {
  if (!kernel || !kernel.eventBus) return;

  kernel.eventBus.on(RuntimeEvent.TransactionCommitted, async (txPayload: any) => {
    if (!txPayload || txPayload.domain !== 'ConsensusEngine') return;

    // Immediately-Invoked Function Expression (IIFE) detaches promise chains to shield unblocked I/O runtime
    (async () => {
      const { data, version, txId } = txPayload;

      try {
        await surrealPersistence.query(
          `CREATE distributed_consensus_ledger CONTENT {
            transaction_id: $txId,
            replicated_log_index: $logIndex,
            kernel_version_seal: $version,
            payload_snapshot_data: $payload,
            synchronized_at: time::now()
          };`,
          {
            txId,
            logIndex: version,
            version,
            payload: data
          }
        );
      } catch (dbPanic: any) {
        logger.error('ConsensusAuditConsumer', '💥 Replicated state block sink collapsed on infrastructure ingestion layer.', {
          transactionId: txId, error: dbPanic.message
        });
      }
    })();
  });
}
