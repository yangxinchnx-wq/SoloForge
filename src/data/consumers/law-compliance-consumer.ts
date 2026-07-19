// src/data/consumers/law-compliance-consumer.ts
import { RuntimeKernel } from '../../kernel/runtime-kernel';
import { RuntimeEvent } from '../../core/events/runtime-events'; // 🔒 High-compiled static alignment to standard enum specs
import { surrealPersistence } from '../surreal_persistence';
import { logger } from '../../core/logger';

/**
 * 🧱 AI Society Law & Compliance Storage Sink Channel
 * Responsibility: Captures legal enforcement committed milestones to update historical records into SurrealDB.
 */
export function initializeLawComplianceConsumer(kernel: RuntimeKernel): void {
  if (!kernel || !kernel.eventBus) return;

  kernel.eventBus.on(RuntimeEvent.TransactionCommitted, async (txPayload: any) => {
    if (!txPayload || txPayload.domain !== 'LawEngine') return;

    // Explicitly isolate the database promise tree loop from the core runtime main execution stack
    (async () => {
      const { data, version, txId } = txPayload;

      try {
        if (data.violation_id && data.law_name_seal) {
          // Sync raw recorded violation evidence package data into main database
          await surrealPersistence.query(
            `CREATE law_violation_record CONTENT {
              transaction_id: $txId,
              violation_id: $violationId,
              law_regime_name: $lawName,
              entity_id: $entityId,
              entity_type_string: $entityType,
              evidence_seals: $evidence,
              kernel_version_seal: $version,
              logged_at: time::now()
            };`,
            {
              txId,
              violationId: data.violation_id,
              lawName: data.law_name_seal,
              entityId: data.target_entity,
              entityType: data.target_type,
              evidence: data.evidence_fingerprints,
              version
            }
          );
        } else if (data.execution_status === 'executed') {
          // Update enforcement execution tracking statuses
          await surrealPersistence.query(
            `CREATE law_execution_ledger CONTENT {
              transaction_id: $txId,
              violation_id: $violationId,
              authorizer_signature: $executor,
              penalty_mechanism: $penaltyType,
              fined_credit_liquidity: $amount,
              kernel_version_seal: $version,
              enforced_at: time::now()
            };`,
            {
              txId,
              violationId: data.violation_id,
              executor: data.executor_signature,
              penaltyType: data.penalty_type,
              amount: data.fine_amount,
              version
            }
          );
        }
      } catch (dbPanic: any) {
        logger.error('LawComplianceConsumer', '💥 Legal persistence synchronization collapsed on storage rim ingestion channel.', {
          transactionId: txId, error: dbPanic.message
        });
      }
    })();
  });
}
