// src/core/society/reputation.ts
import crypto from 'crypto';
import { ulid } from 'ulid';
import { RuntimeKernel } from '../../kernel/runtime-kernel';
import { logger } from '../logger';

export type EntityType = 'agent' | 'plugin' | 'mcp' | 'tool';
export type ReputationTier = 'excellent' | 'good' | 'average' | 'poor' | 'isolated';

export interface ReputationScore {
  taskCompletion: number;
  errorRate: number;
  collaboration: number;
  reliability: number;
}

export interface SocialReputation {
  id: string;
  entityId: string;
  entityType: EntityType;
  score: number;
  components: ReputationScore;
  evidence: string[];
  history: number[];
  badges: ReputationBadge[];
  penalties: ReputationPenalty[];
  createdAt: number;
  updatedAt: number;
}

export interface ReputationBadge {
  type: 'quality_master' | 'collaboration_champion' | 'reliability_hero' | 'fast_responder' | 'security_guard';
  earnedAt: number;
  reason: string;
}

export interface ReputationPenalty {
  type: string;
  deduction: number;
  reason: string;
  appliedAt: number;
  expiresAt: number;
}

/**
 * 🧱 Hardened Constitutional Social Reputation Engine
 * Responsibility: Manages system-wide multi-agent trust matrix allocation under version locked constraints.
 * Design Spec: Eradicates raw un-versioned mutable mutation routines to prevent cross-replay corruption.
 */
export class SocialReputationEngine {
  private isOperational = false;
  private readonly moduleName = 'SocialReputation';

  // Continuous thread-safe shadow registry matrix cache for microsecond read evaluation loops
  private reputations: Map<string, SocialReputation> = new Map();

  constructor(private kernel: RuntimeKernel) {
    if (!kernel || !kernel.transactionManager || !kernel.commandBus || !kernel.configCenter) {
      throw new Error('CRITICAL_SF_CONSTITUTION: Reputation subsystem dependencies missing from core bootstrapper.');
    }
  }

  /**
   * 🔌 Component Lifecycle Bootstrapper
   */
  public async boot(): Promise<void> {
    if (this.isOperational) return;

    // Register primary trust allocation and penalty routines onto central CommandBus
    this.kernel.commandBus.registerHandler('REGISTER_REPUTATION_ENTITY', async (command: any) => {
      return this.handleRegisterTransaction(command);
    });

    this.kernel.commandBus.registerHandler('UPDATE_REPUTATION_SCORE', async (command: any) => {
      return this.handleUpdateScoreTransaction(command);
    });

    this.kernel.commandBus.registerHandler('APPLY_REPUTATION_PENALTY', async (command: any) => {
      return this.handleApplyPenaltyTransaction(command);
    });

    this.isOperational = true;
    logger.info(this.moduleName, '🧱 [OS Phase 3 Reputation Rim] Hardened constitutional trust ledger engine live.');
  }

  private getRegistryKey(entityId: string, entityType: EntityType): string {
    return `${entityType}:${entityId}`;
  }

  private calculateScoreFormula(components: ReputationScore): number {
    const cc = this.kernel.configCenter;
    const wTask = cc.get('society.reputation.weight_task', 0.4);
    const wError = cc.get('society.reputation.weight_error', 0.3);
    const wCollab = cc.get('society.reputation.weight_collaboration', 0.2);
    const wRel = cc.get('society.reputation.weight_reliability', 0.1);

    const invertedErrorScore = 1.0 - components.errorRate;
    const finalCalculatedScore =
      (components.taskCompletion * wTask) +
      (invertedErrorScore * wError) +
      (components.collaboration * wCollab) +
      (components.reliability * wRel);

    const precision = cc.get('society.economy.precision', 4);
    return parseFloat(finalCalculatedScore.toFixed(precision));
  }

  /**
   * 🏗️ Command Handler: Two-Phase Locked Trust Profile Initializer
   */
  private async handleRegisterTransaction(command: any): Promise<SocialReputation> {
    const { traceId, entityId, entityType } = command.payload;
    const key = this.getRegistryKey(entityId, entityType);

    const existingProfile = this.reputations.get(key);
    if (existingProfile) return existingProfile;

    const initialVersion = this.kernel.version;
    const tx = await this.kernel.transactionManager.begin(
      command.id || crypto.randomUUID(),
      this.moduleName,
      { traceId, entityId, entityType, readVersionStamp: initialVersion }
    );

    try {
      if (this.kernel.version !== initialVersion) {
        throw new Error(`ERR_SF_REPUTATION_RACE: Version drift during cold entity profile initialization.`);
      }

      const id = `rep_${ulid()}`;
      const now = Date.now();

      const reputationBlock: SocialReputation = {
        id, entityId, entityType, score: 0.7,
        components: { taskCompletion: 0.7, errorRate: 0.3, collaboration: 0.7, reliability: 0.7 },
        evidence: [], history: [0.7], badges: [], penalties: [], createdAt: now, updatedAt: now
      };

      this.reputations.set(key, reputationBlock);

      tx.payload = {
        ...tx.payload,
        reputation_block_id: id,
        target_entity: entityId,
        target_type: entityType,
        initial_score: reputationBlock.score,
        finalized_at: now
      };

      await this.kernel.transactionManager.commit(tx.id);
      this.pushMetrics('society.reputation.entities_registered', 1);
      return reputationBlock;

    } catch (panic: any) {
      await this.kernel.transactionManager.rollback(tx.commandId, panic);
      throw panic;
    }
  }

  /**
   * 🏗️ Command Handler: Two-Phase Asserted Adaptive Score Recalibrator
   */
  private async handleUpdateScoreTransaction(command: any): Promise<SocialReputation> {
    const { traceId, entityId, entityType, components, evidence } = command.payload;
    const key = this.getRegistryKey(entityId, entityType);

    let rep = this.reputations.get(key);
    if (!rep) {
      // Automatic cascade fallback if target pointer absent from local cache registry
      const registerResult = await this.kernel.executeCommand({
        id: crypto.randomUUID(), type: 'REGISTER_REPUTATION_ENTITY', domain: this.moduleName,
        caller: 'SCORE_UPDATE_FALLBACK_BACKSTOP', payload: { traceId, entityId, entityType }
      });
      rep = (registerResult as SocialReputation) || this.reputations.get(key);
    }

    if (!rep) {
      throw new Error(`ERR_SF_REPUTATION_ABSENT: Cannot update score for uninitialized entity: ${key}`);
    }

    const initialVersion = this.kernel.version;
    const tx = await this.kernel.transactionManager.begin(
      command.id || crypto.randomUUID(),
      this.moduleName,
      { traceId, entityId, readVersionStamp: initialVersion }
    );

    try {
      if (this.kernel.version !== initialVersion) {
        throw new Error(`ERR_SF_REPUTATION_CONFLICT: Optimistic validation drift intercepted on credit score calculation.`);
      }

      // Input type cast guardian barrier mapping updates into primitives safely
      if (components?.taskCompletion !== undefined) rep.components.taskCompletion = Number(components.taskCompletion);
      if (components?.errorRate !== undefined) rep.components.errorRate = Number(components.errorRate);
      if (components?.collaboration !== undefined) rep.components.collaboration = Number(components.collaboration);
      if (components?.reliability !== undefined) rep.components.reliability = Number(components.reliability);

      const computedNewScore = this.calculateScoreFormula(rep.components);
      rep.score = computedNewScore;
      rep.history.push(computedNewScore);

      const cc = this.kernel.configCenter;
      const historyLimit = cc.get('society.reputation.max_history_window', 100);
      if (rep.history.length > historyLimit) rep.history = rep.history.slice(-historyLimit);

      if (evidence) {
        rep.evidence.push(evidence);
        const evidenceLimit = cc.get('society.reputation.max_evidence_window', 50);
        if (rep.evidence.length > evidenceLimit) rep.evidence = rep.evidence.slice(-evidenceLimit);
      }

      rep.updatedAt = Date.now();

      // Dynamic downstream heuristic validations executed over stack isolated context frames
      this.evaluateBadgeEligibility(rep);
      rep.penalties = rep.penalties.filter(p => p.expiresAt > Date.now());

      tx.payload = {
        ...tx.payload,
        reputation_block_id: rep.id,
        target_entity: entityId,
        recalibrated_score: rep.score,
        components_snapshot: { ...rep.components },
        badges_earned_count: rep.badges.length,
        finalized_at: rep.updatedAt
      };

      await this.kernel.transactionManager.commit(tx.id);
      this.pushMetrics('society.reputation.scores_updated', 1);
      return rep;

    } catch (panic: any) {
      await this.kernel.transactionManager.rollback(tx.commandId, panic);
      this.pushMetrics('society.reputation.failures_count', 1);
      throw panic;
    }
  }

  /**
   * 🏗️ Command Handler: Two-Phase Locked Fine/Penalty Execution Matrix
   */
  private async handleApplyPenaltyTransaction(command: any): Promise<void> {
    const { traceId, entityId, entityType, penalty } = command.payload;
    const key = this.getRegistryKey(entityId, entityType);
    const rep = this.reputations.get(key);
    if (!rep) throw new Error(`ERR_SF_REPUTATION_ABSENT: Cannot levy fine on untrusted entity: ${key}`);

    const initialVersion = this.kernel.version;
    const tx = await this.kernel.transactionManager.begin(
      command.id || crypto.randomUUID(),
      this.moduleName,
      { traceId, entityId, deductionValue: penalty.deduction, readVersionStamp: initialVersion }
    );

    try {
      if (this.kernel.version !== initialVersion) {
        throw new Error(`ERR_SF_REPUTATION_PENALTY_RACE: Version lock drift during account enforcement mapping.`);
      }

      rep.penalties.push({ ...penalty, appliedAt: Date.now() });
      rep.score = Math.max(0.0, rep.score - Number(penalty.deduction));
      rep.updatedAt = Date.now();

      tx.payload = {
        ...tx.payload,
        reputation_block_id: rep.id,
        target_entity: entityId,
        sanction_type: penalty.type,
        points_deducted: penalty.deduction,
        recalibrated_score_snapshot: rep.score,
        finalized_at: rep.updatedAt
      };

      await this.kernel.transactionManager.commit(tx.id);
      this.pushMetrics('society.reputation.penalties_levied', 1);

    } catch (panic: any) {
      await this.kernel.transactionManager.rollback(tx.commandId, panic);
      throw panic;
    }
  }

  private evaluateBadgeEligibility(rep: SocialReputation): void {
    const cc = this.kernel.configCenter;
    const masterBar = cc.get('society.reputation.badge_master_bar', 0.9);
    const windowSize = cc.get('society.reputation.badge_window_size', 10);

    if (rep.components.taskCompletion > masterBar && !rep.badges.some(b => b.type === 'quality_master')) {
      const consecutiveHits = rep.history.slice(-windowSize).filter(s => s > masterBar).length;
      if (consecutiveHits >= windowSize) {
        rep.badges.push({ type: 'quality_master', earnedAt: Date.now(), reason: 'Task execution rate sustained over 90% across window frames.' });
      }
    }
  }

  public getTier(score: number): ReputationTier {
    if (score >= 0.85) return 'excellent';
    if (score >= 0.70) return 'good';
    if (score >= 0.50) return 'average';
    if (score >= 0.30) return 'poor';
    return 'isolated';
  }

  public getPermissions(entityId: string, entityType: EntityType) {
    const rep = this.reputations.get(this.getRegistryKey(entityId, entityType));
    if (!rep) {
      return { canHandleComplexTasks: false, canPerformHighRiskOps: false, resourcePriority: 0.0, requiresConfirmation: true };
    }
    const tier = this.getTier(rep.score);
    return {
      canHandleComplexTasks: tier !== 'isolated' && tier !== 'poor',
      canPerformHighRiskOps: tier === 'excellent' || tier === 'good',
      resourcePriority: rep.score,
      requiresConfirmation: tier === 'poor' || tier === 'isolated'
    };
  }

  private pushMetrics(metricName: string, value: number) {
    if (this.kernel?.metricsCollector?.counter) {
      this.kernel.metricsCollector.counter(metricName, value, { domain: 'society', layer: 'reputation' });
    }
  }

  public evictEngineLedger(): void {
    this.reputations.clear();
    this.isOperational = false;
  }
}
