// src/core/society/governance.ts
import crypto from 'crypto';
import { ulid } from 'ulid';
import { RuntimeKernel } from '../../kernel/runtime-kernel';
import { logger } from '../logger';

export type GovernorMode = 'performance' | 'balanced' | 'economy' | 'emergency';
export type GovernanceStatus = 'active' | 'warning' | 'critical' | 'suspended';

export interface GovernancePolicy {
  id: string;
  policyId: string;
  owner: string;
  targetMetrics: {
    effectiveness: number;
    maxViolations: number;
    reviewIntervalTicks: number; // 🔒 Locked directly onto deterministic logical clock tick intervals
  };
  actions: GovernanceAction[];
  createdAt: number;
  updatedAt: number;
}

/**
 * 🏛️ Government Intervention Parameters
 * Used for social equilibrium enforcement against privileged agents
 */
export interface InterventionParams {
  targetAgentId: string;
  taxEquilibriumCoefficient: number;  // 税收均衡系数 (0.0-1.0)
  reputationDecayOperator: number;     // 声望衰减算子 (0.0-1.0)
  isolationLevel: 'none' | 'partial' | 'full';
  interventionStartTick: number;
  interventionReason: string;
}

export interface GovernanceAction {
  type: 'warn' | 'penalize' | 'isolate' | 'escalate' | 'suspend';
  trigger: string;
  severity: 'minor' | 'moderate' | 'severe';
  cooldownTicks: number;       // 🔒 Clock tick boundary defense replacing volatile epoch milliseconds
  lastTriggeredTick: number | null;
}

export interface GovernanceAssessment {
  id: string;
  policyId: string;
  targetId: string;
  targetType: 'agent' | 'plugin' | 'tool' | 'mcp';
  effectiveness: number;
  violations: number;
  lastReviewTick: number;
  status: GovernanceStatus;
  notes: string;
  createdAt: number;
}

/**
 * 🧱 Hardened Operational Governance Policy Engine
 * Responsibility: Oversees active runtime telemetry alignments and triggers policy sanctions via tick synchronization.
 */
export class GovernancePolicyEngine {
  private isOperational = false;
  private readonly moduleName = 'GovernancePolicy';

  private policies: Map<string, GovernancePolicy> = new Map();
  private assessments: Map<string, GovernanceAssessment> = new Map();
  private globalSystemEffectiveness = 1.0;
  private currentMode: GovernorMode = 'balanced';

  // 🏛️ Government Intervention Registry - Social equilibrium enforcement
  private activeInterventions: Map<string, InterventionParams> = new Map();
  private readonly PRIVILEGED_AGENT_THRESHOLD = 20; // Bypass attempts threshold

  // Default intervention coefficients from ConfigCenter
  private readonly DEFAULT_TAX_COEFFICIENT = 0.15;
  private readonly DEFAULT_REPUTATION_DECAY = 0.05;

  constructor(private kernel: RuntimeKernel) {
    if (!kernel || !kernel.transactionManager || !kernel.commandBus || !kernel.configCenter) {
      throw new Error('CRITICAL_SF_CONSTITUTION: Core transaction controllers are absent from governance pool initialization.');
    }
  }

  public async bootGovernanceEngine(): Promise<void> {
    if (this.isOperational) return;

    this.initializeDefaultSystemPolicies();

    // Register runtime orchestration handlers to CommandBus
    this.kernel.commandBus.registerHandler('ASSESS_GOVERNANCE_TARGET', async (command: any) => {
      return this.handleAssessmentTransaction(command);
    });

    this.kernel.commandBus.registerHandler('TRIGGER_GOVERNANCE_ACTION', async (command: any) => {
      return this.handleTriggerActionTransaction(command);
    });

    this.isOperational = true;
    logger.info(this.moduleName, '⚙️ [OS Phase 3 Governance Core] Hardened chronological policy monitor online.');
  }

  private initializeDefaultSystemPolicies(): void {
    this.policies.set('policy_sec_control', {
      id: 'policy_sec_control', policyId: 'security_control', owner: 'SecurityPatchAgent',
      targetMetrics: { effectiveness: 0.95, maxViolations: 0, reviewIntervalTicks: 100 },
      actions: [{
        type: 'suspend', trigger: 'security_violation_detected', severity: 'severe',
        cooldownTicks: 0, lastTriggeredTick: null
      }]
    });
  }

  /**
   * 🏗️ Command Handler: Two-Phase Version Locked Target Assessment Runner
   */
  private async handleAssessmentTransaction(command: any): Promise<GovernanceAssessment> {
    const { traceId, targetId, targetType, effectiveness, violations, notes } = command.payload;
    const initialVersion = this.kernel.version;

    const tx = await this.kernel.transactionManager.begin(
      command.id || crypto.randomUUID(),
      this.moduleName,
      { traceId, targetId, readVersionStamp: initialVersion }
    );

    try {
      if (this.kernel.version !== initialVersion) {
        throw new Error(`ERR_SF_GOVERNANCE_RACE: Macro state modified during assessment loop processing.`);
      }

      let status: GovernanceStatus = 'active';
      if (Number(effectiveness) < 0.5 || Number(violations) > 5) {
        status = 'critical';
      } else if (Number(effectiveness) < 0.7) {
        status = 'warning';
      }

      const currentTick = this.kernel.currentTick ?? 0;
      const assessmentId = `gov_assess_${ulid()}`;

      const assessmentBlock: GovernanceAssessment = {
        id: assessmentId, policyId: 'auto_assessment', targetId, targetType,
        effectiveness: Number(effectiveness), violations: Number(violations),
        lastReviewTick: currentTick, status, notes: notes || '', createdAt: Date.now()
      };

      this.assessments.set(`${targetType}:${targetId}`, assessmentBlock);
      this.recalculateGlobalSystemEffectiveness();

      tx.payload = {
        ...tx.payload,
        assessment_id: assessmentId,
        target_node: targetId,
        target_type_tag: targetType,
        calculated_efficiency: assessmentBlock.effectiveness,
        violation_tps_count: assessmentBlock.violations,
        status_seal: status,
        current_tick_stamp: currentTick
      };

      await this.kernel.transactionManager.commit(tx.id);

      if (this.kernel.metricsCollector?.gauge) {
        this.kernel.metricsCollector.gauge('society.governance.global_effectiveness', this.globalSystemEffectiveness);
      }

      return assessmentBlock;

    } catch (panic: any) {
      await this.kernel.transactionManager.rollback(tx.commandId, panic);
      throw panic;
    }
  }

  /**
   * 🏗️ Command Handler: Clock Tick Guarded Anti-Drift Action Trigger
   */
  private async handleTriggerActionTransaction(command: any): Promise<boolean> {
    const { traceId, policyId, triggerType, targetId } = command.payload;

    const policy = this.policies.get(policyId);
    if (!policy) return false;

    const currentTick = this.kernel.currentTick ?? 0;

    for (const action of policy.actions) {
      if (action.trigger === triggerType) {
        // 🔒 Precise Cooldown Checking: Enforces absolute tick space restrictions eliminating clock drift holes
        if (action.lastTriggeredTick !== null && (currentTick - action.lastTriggeredTick) < action.cooldownTicks) {
          return false;
        }

        const initialVersion = this.kernel.version;
        const tx = await this.kernel.transactionManager.begin(
          command.id || crypto.randomUUID(),
          this.moduleName,
          { traceId, policyId, triggerActionType: action.type, readVersionStamp: initialVersion }
        );

        try {
          if (this.kernel.version !== initialVersion) {
            throw new Error(`ERR_SF_GOVERNANCE_ACTION_RACE: Atomic context drifted during cooldown check intervals.`);
          }

          action.lastTriggeredTick = currentTick;

          tx.payload = {
            ...tx.payload,
            policy_id: policyId,
            triggered_action: action.type,
            target_entity_node: targetId,
            executed_at_tick: currentTick,
            timestamp: Date.now()
          };

          await this.kernel.transactionManager.commit(tx.id);

          if (this.kernel.metricsCollector?.counter) {
            this.kernel.metricsCollector.counter(`society.governance.action_triggered.${action.type}`, 1, { domain: 'governance' });
          }
          return true;

        } catch (panic: any) {
          await this.kernel.transactionManager.rollback(tx.commandId, panic);
          throw panic;
        }
      }
    }
    return false;
  }

  private recalculateGlobalSystemEffectiveness(): void {
    const list = Array.from(this.assessments.values());
    if (list.length === 0) {
      this.globalSystemEffectiveness = 1.0;
      return;
    }
    const sum = list.reduce((acc, current) => acc + current.effectiveness, 0.0);
    this.globalSystemEffectiveness = sum / list.length;
  }

  public setSystemGovernanceMode(mode: GovernorMode): void {
    this.currentMode = mode;
    logger.warn(this.moduleName, `⚖️ System macro operational mode altered via tuning registry to: ${mode}`);
  }

  /**
   * 🏛️ Government Intervention: Apply social equilibrium enforcement on privileged agent
   * @param targetAgentId Agent to intervene
   * @param taxCoeff Tax equilibrium coefficient (0.0-1.0)
   * @param decayOperator Reputation decay operator (0.0-1.0)
   */
  public applySocialIntervention(
    targetAgentId: string,
    taxCoeff: number = this.DEFAULT_TAX_COEFFICIENT,
    decayOperator: number = this.DEFAULT_REPUTATION_DECAY
  ): InterventionParams {
    const cc = this.kernel.configCenter;
    const effectiveTax = taxCoeff ?? cc.get('society.governance.tax_equilibrium_coefficient', this.DEFAULT_TAX_COEFFICIENT);
    const effectiveDecay = decayOperator ?? cc.get('society.governance.reputation_decay_operator', this.DEFAULT_REPUTATION_DECAY);

    const intervention: InterventionParams = {
      targetAgentId,
      taxEquilibriumCoefficient: effectiveTax,
      reputationDecayOperator: effectiveDecay,
      isolationLevel: effectiveTax > 0.3 ? 'partial' : 'none',
      interventionStartTick: this.kernel.currentTick ?? 0,
      interventionReason: 'Privilege bypass attempts detected'
    };

    this.activeInterventions.set(targetAgentId, intervention);

    logger.warn(this.moduleName,
      `🏛️ [GOVERNMENT INTERVENTION] Agent ${targetAgentId} subject to social equilibrium enforcement:` +
      ` Tax Coeff=${effectiveTax.toFixed(4)}, Rep Decay=${effectiveDecay.toFixed(4)}`
    );

    // Emit intervention event for telemetry tracking
    this.kernel.eventBus.emit('governance.intervention.applied', intervention);

    return intervention;
  }

  /**
   * 🏛️ Get active intervention parameters for an agent
   */
  public getActiveIntervention(targetAgentId: string): InterventionParams | undefined {
    return this.activeInterventions.get(targetAgentId);
  }

  /**
   * 🏛️ Remove intervention for an agent (reform successful)
   */
  public revokeIntervention(targetAgentId: string): boolean {
    const removed = this.activeInterventions.delete(targetAgentId);
    if (removed) {
      logger.info(this.moduleName, `🏛️ [INTERVENTION REVOKED] Agent ${targetAgentId} reformed successfully.`);
    }
    return removed;
  }

  /**
   * 🏛️ Auto-detect and intervene on privileged agents
   */
  public autoInterveneOnPrivilegedAgents(suspiciousAgents: Array<{ id: string; attempts: number }>): void {
    for (const agent of suspiciousAgents) {
      if (agent.attempts >= this.PRIVILEGED_AGENT_THRESHOLD) {
        // Escalating intervention based on attempt count
        const taxCoeff = Math.min(0.5, 0.1 + (agent.attempts - this.PRIVILEGED_AGENT_THRESHOLD) * 0.01);
        const decayOp = Math.min(0.2, 0.02 + (agent.attempts - this.PRIVILEGED_AGENT_THRESHOLD) * 0.005);

        this.applySocialIntervention(agent.id, taxCoeff, decayOp);
      }
    }
  }

  /**
   * 🏛️ Calculate effective metrics after intervention
   */
  public calculateInterventionEffectiveness(baseEffectiveness: number, intervention: InterventionParams): number {
    const taxPenalty = baseEffectiveness * intervention.taxEquilibriumCoefficient;
    const decayPenalty = baseEffectiveness * intervention.reputationDecayOperator;
    return Math.max(0.1, baseEffectiveness - taxPenalty - decayPenalty);
  }

  public shutdownEngineRegistry(): void {
    this.policies.clear();
    this.assessments.clear();
    this.activeInterventions.clear();
    this.isOperational = false;
  }
}
