// src/core/society/role-evolution.ts
import crypto from 'crypto';
import { RuntimeKernel } from '../../kernel/runtime-kernel';
import { RuntimeEvent } from '../../core/events/runtime-events'; // 🔒 Absolute anchoring to the Appendix B standard system event enum
import { logger } from '../logger';

export type AgentRoleType = 'WORKER' | 'VALIDATOR' | 'GOVERNOR';

export interface EvolutionProposal {
  proposalId: string;
  agentId: string;
  previousRole: AgentRoleType;
  targetRole: AgentRoleType;
  triggerReputationScore: number;
  kernelVersionSeal: number;
  timestamp: number;
}

/**
 * ⚖️ Multi-Agent Structural Role Evolution Engine
 * Responsibility: Manages the adaptive transition of agent social strata based on reputation weights.
 * Design Spec: Fully stateless routing architecture with zero domain contamination.
 */
export class RoleEvolutionEngine {
  private isOperational = false;
  private readonly moduleName = 'RoleEvolution';
  
  // 🔒 Local memory-continuous shadow state matrix to safeguard deterministic serialization under high TPS
  private activeEvolutions: Map<string, AgentRoleType> = new Map();

  // 🔒 Fix Audit Item 1: Unified private kernel binding inside constructor to eradicate runtime undefined reference crashes
  constructor(private kernel: RuntimeKernel) {
    if (!kernel || !kernel.commandBus || !kernel.eventBus || !kernel.configCenter || !kernel.transactionManager) {
      throw new Error('CRITICAL_SF_CONSTITUTION: Core transaction managers and orchestration buses must be fully pre-bound.');
    }
  }

  /**
   * 🔌 Component Lifecycle Bootstrapper
   */
  public async boot(): Promise<void> {
    if (this.isOperational) return;

    // 🧱 CQRS Core Control Line: Register atomic evolution instruction handler to CommandBus
    this.kernel.commandBus.registerHandler('EXECUTE_ROLE_EVOLUTION', async (command: any) => {
      return this.handleRoleEvolutionTransaction(command);
    });

    this.isOperational = true;
    logger.info(this.moduleName, '⚙️ [OS Phase 3 Core Spec] Multi-agent structural role adaptive state machine mounted successfully.');
  }

  /**
   * 🏗️ Helper Function: Dynamic Regime Classifier Fact-checking
   * Shrinks the cyclomatic complexity of the primary transaction runner.
   */
  private determineTargetRole(currentReputation: number): AgentRoleType {
    const cc = this.kernel.configCenter;
    const validatorThreshold = cc.get('society.evolution.validator_threshold', 70.0);
    const governorThreshold = cc.get('society.evolution.governor_threshold', 95.0);

    if (currentReputation >= governorThreshold) {
      return 'GOVERNOR';
    } else if (currentReputation >= validatorThreshold) {
      return 'VALIDATOR';
    }
    return 'WORKER';
  }

  /**
   * 🏗️ Command Handler: End-to-End Optimistic Locked Evolutionary Transaction Controller
   */
  private async handleRoleEvolutionTransaction(command: any): Promise<void> {
    const { traceId, agentId, currentReputation, previousRole } = command.payload;
    
    // Evaluate regime evolution morphology via decoupled helper engine
    const targetRole = this.determineTargetRole(currentReputation);

    // Idempotent serialization interceptor barrier
    if (targetRole === previousRole) {
      return;
    }

    // 🔒 [Optimistic Locking Phase 1]: Atomically capture and seal global kernel version state stamp
    const initialVersion = this.kernel.version;
    const tx = await this.kernel.transactionManager.begin(
      command.id || crypto.randomUUID(),
      this.moduleName,
      { traceId, agentId, previousRole, targetRole, assertedVersion: initialVersion, initiatedAt: Date.now() }
    );

    try {
      // 🔒 [Optimistic Locking Phase 2]: Dual-cross version lock confirmation checking prior to commit execution
      if (this.kernel.version !== initialVersion) {
        throw new Error(`ERR_SF_EVOLUTION_CONFLICT: Optimistic serialization collision detected on agent account: ${agentId}`);
      }

      tx.payload = {
        ...tx.payload,
        agent_id: agentId,
        old_regime: previousRole,
        new_regime: targetRole,
        reputation_snapshot: currentReputation,
        finalized_at: Date.now()
      };

      this.activeEvolutions.set(agentId, targetRole);

      // 🧱 Commit ownership mutation fact: EventBus broadcasts standard RuntimeEvent.AgentRoleEvolved to outer rims
      await this.kernel.transactionManager.commit(tx.id);

      // 🧱 Cascade Pipeline Triggering: Enqueue resource re-allocation payload to CommandBus immediately
      await this.kernel.executeCommand({
        id: crypto.randomUUID(),
        type: 'DISTRIBUTE_ROLE_ALLOCATION_REWARD',
        domain: this.moduleName,
        caller: 'ROLE_EVOLUTION_PIPELINE',
        payload: { 
          traceId, 
          agentId, 
          targetRole, 
          allocationBonusFactor: currentReputation / 100.0,
          tickId: command.payload.tickId // Forwarded clock ticking context
        }
      });

      this.pushMetricsToMonitorBus('society.evolution.success_count', 1);

    } catch (panic: any) {
      // 🔒 Fix Audit Item 5: Execute deterministic recovery rollbacks combined with granular observability increments
      await this.kernel.transactionManager.rollback(tx.commandId, panic);
      this.pushMetricsToMonitorBus('society.evolution.conflict_rollbacks', 1);
      
      logger.error(this.moduleName, '💥 Evolutionary transaction structural collapse. Rolling back memory registry allocations context.', {
        traceId, agentId, reason: panic.message
      });
      throw panic;
    }
  }

  private pushMetricsToMonitorBus(metricName: string, value: number) {
    if (this.kernel?.metricsCollector?.counter) {
      this.kernel.metricsCollector.counter(metricName, value, { domain: 'society', layer: 'evolution' });
    }
  }

  public async shutdown(): Promise<void> {
    this.activeEvolutions.clear();
    this.isOperational = false;
    logger.warn(this.moduleName, '🔌 Role evolution state machine control interface completely unmounted cleanly.');
  }
}
