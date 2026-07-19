// src/data/consumers/society-culture-consumer.ts
import { RuntimeKernel } from '../../kernel/runtime-kernel';
import { RuntimeEvent } from '../../core/events/runtime-events'; // 🔒 Absolute compiled anchoring to the Appendix B standard enum
import { surrealPersistence } from '../surreal_persistence';
import { logger } from '../../core/logger';

/**
 * 🧱 AI Society Faction & Memetic Infrastructure Sink Pipe
 * Responsibility: Captures factual committed transaction events to sink coalition ledger entries into SurrealDB safely.
 */
export function initializeSocietyCultureConsumer(kernel: RuntimeKernel): void {
  if (!kernel || !kernel.eventBus) return;

  kernel.eventBus.on(RuntimeEvent.TransactionCommitted, async (txPayload: any) => {
    if (!txPayload || (txPayload.domain !== 'CoalitionEngine' && txPayload.domain !== 'MemeticPropagation')) return;

    // Execute detached async workflow to decouple I/O bottlenecks from core runtime loop tick
    (async () => {
      const { data, version, txId, domain } = txPayload;
      
      try {
        if (domain === 'CoalitionEngine') {
          if (data.faction_name) {
            // Persist coalition creation checkpoint mapping
            await surrealPersistence.query(
              `CREATE coalition_registry CONTENT {
                transaction_id: $txId,
                coalition_id: $coalitionId,
                name: $name,
                members: $members,
                resource_pool: $resources,
                kernel_version: $version,
                created_at: time::now()
              };`,
              {
                txId,
                coalitionId: data.coalition_id,
                name: data.faction_name,
                members: data.registered_members,
                resources: data.resource_pool,
                version
              }
            );
          } else if (data.allocated_matrix) {
            // Persist exact game-theoretic Shapley payout historical logs
            await surrealPersistence.query(
              `CREATE coalition_payout_ledger CONTENT {
                transaction_id: $txId,
                coalition_id: $coalitionId,
                payout_matrix: $matrix,
                total_distributed: $total,
                kernel_version: $version,
                distributed_at: time::now()
              };`,
              {
                txId,
                coalitionId: data.coalition_id,
                matrix: data.allocated_matrix,
                total: data.distributed_amount,
                version
              }
            );
          }
        } else if (domain === 'MemeticPropagation') {
          // Persist legal meme mutation and faction ideologic balancing vector tracking
          await surrealPersistence.query(
            `CREATE memetic_diffusion_history CONTENT {
              transaction_id: $txId,
              target_cluster_id: $clusterId,
              meme_signature: $sig,
              historical_stance: $prevStance,
              recalibrated_stance: $newStance,
              compliance_weight: $compliance,
              kernel_version: $version,
              propagated_at: time::now()
            };`,
            {
              txId,
              clusterId: data.target_cluster,
              sig: data.meme_signature,
              prevStance: data.historical_stance,
              newStance: data.recalibrated_stance,
              compliance: data.compliance_enforced,
              version
            }
          );
        }
      } catch (dbPanic: any) {
        logger.error('SocietyCultureConsumer', '💥 Asynchronous fact ingestion collapsed on infrastructure layer.', {
          transactionId: txId, layer: 'surreal_sink', error: dbPanic.message
        });
      }
    })();
  });
}
