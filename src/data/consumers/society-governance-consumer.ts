// src/data/consumers/society-governance-consumer.ts
import { RuntimeKernel } from '../../kernel/runtime-kernel';
import { RuntimeEvent } from '../../core/events/runtime-events'; // 🔒 High-compiled static alignment to standard enum keys
import { surrealPersistence } from '../surreal_persistence';
import { logger } from '../../core/logger';

/**
 * 🧱 AI Society Norms & Governance Analytics Sink Channel
 * Responsibility: Asynchronously intercepts commit streams to sink institution records into SurrealDB universes safely.
 */
export function initializeSocietyGovernanceConsumer(kernel: RuntimeKernel): void {
  if (!kernel || !kernel.eventBus) return;

  kernel.eventBus.on(RuntimeEvent.TransactionCommitted, async (txPayload: any) => {
    if (!txPayload || (txPayload.domain !== 'InstitutionEngine' && txPayload.domain !== 'GovernancePolicy')) return;

    // Isolate database transactional operations inside detached execution contexts
    (async () => {
      const { data, version, txId, domain } = txPayload;

      try {
        if (domain === 'InstitutionEngine' && data.norm_name_seal) {
          await surrealPersistence.query(
            `CREATE society_institution_registry CONTENT {
              transaction_id: $txId,
              institution_id: $instId,
              norm_title: $name,
              target_scope: $scope,
              priority_rank: $priority,
              kernel_version: $version,
              logged_at: time::now()
            };`,
            { txId, instId: data.institution_id, name: data.norm_name_seal, scope: data.scope_rank, priority: data.priority_coefficient, version }
          );
        } else if (domain === 'GovernancePolicy') {
          if (data.assessment_id) {
            // Sink ongoing automated target assessment logs
            await surrealPersistence.query(
              `CREATE society_governance_assessment CONTENT {
                transaction_id: $txId,
                assessment_id: $assessId,
                implicated_node: $target,
                efficiency_index: $eff,
                violation_tps: $viol,
                governance_status: $status,
                recorded_tick: $tick,
                kernel_version: $version,
                assessed_at: time::now()
              };`,
              { txId, assessId: data.assessment_id, target: data.target_node, eff: data.calculated_efficiency, viol: data.violation_tps_count, status: data.status_seal, tick: data.current_tick_stamp, version }
            );
          } else if (data.triggered_action) {
            // Sink critical policy enforcement actions tracking metrics
            await surrealPersistence.query(
              `CREATE society_governance_action_log CONTENT {
                transaction_id: $txId,
                associated_policy: $policyId,
                executed_action_type: $action,
                sanctioned_node: $target,
                triggered_tick: $tick,
                kernel_version: $version,
                fired_at: time::now()
              };`,
              { txId, policyId: data.policy_id, action: data.triggered_action, target: data.target_entity_node, tick: data.executed_at_tick, version }
            );
          }
        }
      } catch (dbPanic: any) {
        logger.error('SocietyGovernanceConsumer', '💥 Compliance registry asynchronous flush collapsed on infrastructure ingestion layer.', {
          transactionId: txId, error: dbPanic.message
        });
      }
    })();
  });
}
