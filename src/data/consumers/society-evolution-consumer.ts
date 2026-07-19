// src/data/consumers/society-evolution-consumer.ts
import { RuntimeKernel } from '../../kernel/runtime-kernel';
import { RuntimeEvent } from '../../core/events/runtime-events'; // 🔒 Absolute compiled anchoring to the Appendix B unified standard enum
import { surrealPersistence } from '../surreal_persistence';
import { logger } from '../../core/logger';

/**
 * 🧱 AI Society Evolution & Economy & Coalition Infrastructure Sink Pipe
 * Responsibility: Asynchronously captures transaction committed events to flush evolution metrics into SurrealDB温温宇宙
 * Handles three domains: RoleEvolution, TokenEconomy, CoalitionEngine
 */
export function initializeSocietyEvolutionConsumer(kernel: RuntimeKernel): void {
  if (!kernel || !kernel.eventBus) return;

  // 🔒 Intercept standard committed notifications emitted directly from the TransactionManager core pipeline
  kernel.eventBus.on(RuntimeEvent.TransactionCommitted, async (txPayload: any) => {
    if (!txPayload) return;

    // Check if domain is one of the three tracked domains
    const { domain } = txPayload;
    if (domain !== 'RoleEvolution' && domain !== 'TokenEconomy' && domain !== 'CoalitionEngine') return;

    // Immediately-Invoked Function Expression (IIFE) explicitly detaches promise tree chain to achieve unblocked I/O平摊
    (async () => {
      const { data, version, txId } = txPayload;

      try {
        if (domain === 'RoleEvolution') {
          // 🧱 Secure Fact Persistence append: exclusive table allocation protecting four-universe database isolation constraints
          await surrealPersistence.query(
            `CREATE agent_regime_history CONTENT {
              transaction_id: $txId,
              agent_id: $agentId,
              previous_regime: $oldRegime,
              target_regime: $newRegime,
              reputation_seal: $reputation,
              kernel_version: $version,
              recorded_at: time::now()
            };`,
            {
              txId,
              agentId: data.agent_id,
              oldRegime: data.old_regime,
              newRegime: data.new_regime,
              reputation: data.reputation_snapshot,
              version
            }
          );
        } else if (domain === 'TokenEconomy') {
          // Flush credit liquidity ledger mutations into main project warm database schema
          await surrealPersistence.query(
            `CREATE agent_economic_ledger CONTENT {
              transaction_id: $txId,
              account_id: $accountId,
              allocated_bonus_mint: $bonus,
              consolidated_balance: $balance,
              tax_tier_factor: $taxTier,
              kernel_version: $version,
              recorded_at: time::now()
            };`,
            {
              txId,
              accountId: data.agent_id,
              bonus: data.allocated_bonus,
              balance: data.new_balance,
              taxTier: data.tax_tier_snapshot,
              version
            }
          );
        } else if (domain === 'CoalitionEngine') {
          // Flush coalition formation and payout distribution facts into warm database schema
          if (data.coalition_id) {
            // Coalition formation event
            await surrealPersistence.query(
              `CREATE coalition_formation_history CONTENT {
                transaction_id: $txId,
                coalition_id: $coalitionId,
                faction_name: $factionName,
                registered_members: $members,
                resource_pool: $resourcePool,
                kernel_version: $version,
                recorded_at: time::now()
              };`,
              {
                txId,
                coalitionId: data.coalition_id,
                factionName: data.faction_name,
                members: data.registered_members,
                resourcePool: data.resource_pool,
                version
              }
            );
          }

          // Coalition payout distribution event
          if (data.allocated_matrix) {
            await surrealPersistence.query(
              `CREATE coalition_payout_history CONTENT {
                transaction_id: $txId,
                coalition_id: $coalitionId,
                allocated_matrix: $allocationMatrix,
                distributed_amount: $distributedAmount,
                kernel_version: $version,
                recorded_at: time::now()
              };`,
              {
                txId,
                coalitionId: data.coalition_id,
                allocationMatrix: data.allocated_matrix,
                distributedAmount: data.distributed_amount,
                version
              }
            );
          }
        }
      } catch (dbPanic: any) {
        logger.error('SocietyEvolutionConsumer', '💥 Asynchronous cold data flush intercepted I/O block. Dropping metric metrics payload for resilience self-healing.', {
          transactionId: txId, error: dbPanic.message, domain
        });
      }
    })();
  });
}
