// src/data/consumers/migration-audit-consumer.ts
import { RuntimeKernel } from '../../kernel/runtime-kernel';
import { RuntimeEvent } from '../../core/events/runtime-events'; // 🔒 High-compiled static alignment to standard enum keys
import { surrealPersistence } from '../surreal_persistence';
import { logger } from '../../core/logger';

/**
 * 🧱 Sandbox Migration Audit Storage Sink Consumer
 * Responsibility: Intercepts transactional milestone facts to write live migration history logs into SurrealDB safely.
 */
export function initializeMigrationAuditConsumer(kernel: RuntimeKernel): void {
  if (!kernel || !kernel.eventBus) return;

  kernel.eventBus.on(RuntimeEvent.TransactionCommitted, async (txPayload: any) => {
    if (!txPayload || txPayload.domain !== 'SandboxMigration') return;

    // Explicitly detach database promise allocation threads from core micro-kernel ticker execution streams
    (async () => {
      const { data, version, txId } = txPayload;

      try {
        await surrealPersistence.query(
          `CREATE sandbox_migration_history CONTENT {
            transaction_id: $txId,
            migration_manifest_id: $manifestId,
            eviction_reason_code: $reason,
            memory_checksum_seal: $checksum,
            relocated_isolate_bytes: $bytes,
            executed_at_clock_tick: $tick,
            kernel_version_seal: $version,
            persisted_at: time::now()
          };`,
          {
            txId,
            manifestId: data.manifest_id,
            reason: data.eviction_code,
            checksum: data.serialized_state_checksum,
            bytes: data.relocated_bytes,
            tick: data.clock_tick_marker,
            version
          }
        );
      } catch (dbPanic: any) {
        logger.error('MigrationAuditConsumer', '💥 Sandbox context audit flush collapsed on persistence rim ingestion pipeline.', {
          transactionId: txId, error: dbPanic.message
        });
      }
    })();
  });
}
