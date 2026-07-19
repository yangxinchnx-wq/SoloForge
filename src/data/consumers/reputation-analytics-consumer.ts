// src/data/consumers/reputation-analytics-consumer.ts
import { RuntimeKernel } from '../../kernel/runtime-kernel';
import { RuntimeEvent } from '../../core/events/runtime-events'; // 🔒 High-compiled static alignment to Appendix B enums
import { surrealPersistence } from '../surreal_persistence';
import { logger } from '../../core/logger';

/**
 * 🧱 AI Society Trust Ledger Analytical Ingestion Channel
 * Responsibility: Captures reputation transaction commit streams to sync historical balances into SurrealDB asynchronously.
 */
export function initializeReputationAnalyticsConsumer(kernel: RuntimeKernel): void {
  if (!kernel || !kernel.eventBus) return;

  kernel.eventBus.on(RuntimeEvent.TransactionCommitted, async (txPayload: any) => {
    if (!txPayload || txPayload.domain !== 'SocialReputation') return;

    // Fully cut the execution tree promise context loop away from the core task ticking engine
    (async () => {
      const { data, version, txId } = txPayload;

      try {
        if (data.recalibrated_score !== undefined) {
          // Sink reputation score calibration log metrics packages
          await surrealPersistence.query(
            `CREATE agent_reputation_history CONTENT {
              transaction_id: $txId,
              reputation_id: $repId,
              target_entity_id: $entityId,
              consolidated_score: $score,
              components_matrix: $components,
              badges_held_count: $badges,
              kernel_version_seal: $version,
              calculated_at: time::now()
            };`,
            {
              txId,
              repId: data.reputation_block_id,
              entityId: data.target_entity,
              score: data.recalibrated_score,
              components: data.components_snapshot,
              badges: data.badges_earned_count,
              version
            }
          );
        } else if (data.points_deducted) {
          // Sink penalty fine enforcement historical footprints
          await surrealPersistence.query(
            `CREATE law_penalty_levy CONTENT {
              transaction_id: $txId,
              reputation_id: $repId,
              target_entity_id: $entityId,
              sanction_type_tag: $sanction,
              deducted_points_value: $fine,
              kernel_version_seal: $version,
              levied_at: time::now()
            };`,
            {
              txId,
              repId: data.reputation_block_id,
              entityId: data.target_entity,
              sanction: data.sanction_type,
              fine: data.points_deducted,
              version
            }
          );
        }
      } catch (dbPanic: any) {
        logger.error('ReputationAnalyticsConsumer', '💥 Credit delta logging synchronization collapsed on storage rim channel.', {
          transactionId: txId, error: dbPanic.message
        });
      }
    })();
  });
}
