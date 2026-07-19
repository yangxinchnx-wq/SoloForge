// src/data/consumers/court-adjudication-consumer.ts
import { RuntimeKernel } from '../../kernel/runtime-kernel';
import { RuntimeEvent } from '../../core/events/runtime-events'; // 🔒 High-compiled static alignment to standard enum keys
import { surrealPersistence } from '../surreal_persistence';
import { logger } from '../../core/logger';

/**
 * 🧱 AI Society Judicial Ledger Ingestion Consumer
 * Responsibility: Captures factual committed transaction events to sink primary and supreme verdicts safely.
 */
export function initializeCourtAdjudicationConsumer(kernel: RuntimeKernel): void {
  if (!kernel || !kernel.eventBus) return;

  kernel.eventBus.on(RuntimeEvent.TransactionCommitted, async (txPayload: any) => {
    if (!txPayload || (txPayload.domain !== 'ConsensAgentCourt' && txPayload.domain !== 'LlmSupremeEscalation')) return;

    // Immediately-Invoked Function Expression (IIFE) detaches the execution tree to achieve unblocked I/O
    (async () => {
      const { data, version, txId, domain } = txPayload;

      try {
        if (domain === 'ConsensAgentCourt') {
          // Sink primary courtroom arbitration fact logs
          await surrealPersistence.query(
            `CREATE primary_court_verdict CONTENT {
              transaction_id: $txId,
              verdict_id: $verdictId,
              resolution_status: $status,
              winning_agent: $winner,
              metric_score: $score,
              kernel_version: $version,
              recorded_at: time::now()
            };`,
            {
              txId,
              verdictId: data.verdict_id,
              status: data.status_seal,
              winner: data.winner_signature,
              score: data.metric_score,
              version
            }
          );
        } else if (domain === 'LlmSupremeEscalation') {
          // Sink high-level multimodal semantic supreme room verdicts
          await surrealPersistence.query(
            `CREATE supreme_court_verdict CONTENT {
              transaction_id: $txId,
              supreme_verdict_id: $supremeId,
              ultimate_winner: $winner,
              evicted_loser: $loser,
              semantic_rationale: $rationale,
              confidence_score: $confidence,
              kernel_version: $version,
              recorded_at: time::now()
            };`,
            {
              txId,
              supremeId: data.supreme_verdict_id,
              winner: data.ultimate_winner,
              loser: data.evicted_loser,
              rationale: data.semantic_rationale,
              confidence: data.confidence,
              version
            }
          );
        }
      } catch (dbPanic: any) {
        logger.error('CourtAdjudicationConsumer', '💥 Judicial ledger asynchronous sink collapsed on infrastructure layer.', {
          transactionId: txId, error: dbPanic.message
        });
      }
    })();
  });
}
