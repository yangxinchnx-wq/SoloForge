// src/data/consumers/social-memory-consumer.ts
import { RuntimeKernel } from '../../kernel/runtime-kernel';
import { RuntimeEvent } from '../../core/events/runtime-events'; // 🔒 High-compiled static alignment to standard enum specs
import { surrealPersistence } from '../surreal_persistence';
import { logger } from '../../core/logger';

/**
 * 🧱 AI Society Social Memory Storage Sink Channel
 * Responsibility: Intercepts transactional facts to commit collective agent experiences into SurrealDB asynchronously.
 */
export function initializeSocialMemoryConsumer(kernel: RuntimeKernel): void {
  if (!kernel || !kernel.eventBus) return;

  kernel.eventBus.on(RuntimeEvent.TransactionCommitted, async (txPayload: any) => {
    if (!txPayload || txPayload.domain !== 'SocialMemory') return;

    // Detach thread promise chain via IIFE mechanism ensuring 0% event-loop stalling
    (async () => {
      const { data, version, txId } = txPayload;

      try {
        await surrealPersistence.query(
          `CREATE collective_social_memory CONTENT {
            transaction_id: $txId,
            memory_block_id: $memoryId,
            event_log: $eventText,
            extracted_tokens: $keywords,
            lessons_learned: $lessons,
            active_participants: $agents,
            kernel_version_seal: $version,
            metadata_extension: $metadata,
            沉淀_at: time::now()
          };`,
          {
            txId,
            memoryId: data.memory_id,
            eventText: data.event_description,
            keywords: data.extracted_tokens,
            lessons: data.associated_lessons,
            agents: data.implicated_agents,
            metadata: data.serialized_metadata,
            version
          }
        );
      } catch (dbPanic: any) {
        logger.error('SocialMemoryConsumer', '💥 Experience pipeline collapsed on infrastructure ingestion layer.', {
          transactionId: txId, error: dbPanic.message
        });
      }
    })();
  });
}
