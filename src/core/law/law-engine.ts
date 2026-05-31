// src/core/law/law-engine.ts
import crypto from 'crypto';
import { ulid } from 'ulid';
import { RuntimeKernel } from '../../kernel/runtime-kernel';
import { RuntimeEvent } from '../events/runtime-events'; // 🔒 High-compiled static alignment to standard enum keys
import { logger } from '../logger';

export type ViolationSeverity = 'minor' | 'moderate' | 'severe';
export type ViolationStatus = 'pending' | 'appealed' | 'decided' | 'executed';

export interface Law {
  id: string;
  name: string;
  description: string;
  condition: string;
  consequence: string;
  severity: ViolationSeverity;
  appeals: boolean;
  penalty: {
    type: 'warning' | 'penalty' | 'isolation' | 'suspension' | 'ban';
    amount?: number;
    durationMs?: number;
  };
  metadata: Record<string, any>;
  createdAt: number;
  updatedAt: number;
  active: boolean;
}

export interface Violation {
  id: string;
  lawId: string;
  lawName: string;
  entityId: string;
  entityType: 'agent' | 'plugin' | 'tool' | 'mcp';
  severity: ViolationSeverity;
  description: string;
  evidence: string[];
  status: ViolationStatus;
  consequence: string;
  penalty: Law['penalty'];
  appealReason?: string;
  decidedBy?: string;
  decidedAt?: number;
  executedAt?: number | null;
  createdAt: number;
}

export interface Appeal {
  id: string;
  violationId: string;
  appellant: string;
  reason: string;
  evidence: string[];
  status: 'pending' | 'accepted' | 'rejected';
  decision?: string;
  decidedBy?: string;
  decidedAt?: number;
  createdAt: number;
}

/**
 * 🧱 Hardened Constitutional Law Enforcement Engine
 * Responsibility: Manages system-level security constraints under strict two-phase serialization.
 * Design Spec: Eradicates raw global singletons to prevent cross-replay memory contamination.
 */
export class LawEngine {
  private isOperational = false;
  private readonly moduleName = 'LawEngine';

  private laws: Map<string, Law> = new Map();
  private violations: Map<string, Violation> = new Map();
  private appeals: Map<string, Appeal> = new Map();

  constructor(private kernel: RuntimeKernel) {
    if (!kernel || !kernel.transactionManager || !kernel.commandBus || !kernel.configCenter) {
      throw new Error('CRITICAL_SF_CONSTITUTION: LawEngine dependencies missing from central bootstrap container.');
    }
  }

  /**
   * 🔌 Component Lifecycle Bootstrapper
   */
  public async boot(): Promise<void> {
    if (this.isOperational) return;

    this.initializeDefaultLaws();

    // Register primary judicial and legal action chains onto CommandBus
    this.kernel.commandBus.registerHandler('RECORD_VIOLATION_FACT', async (command: any) => {
      return this.handleRecordViolationTransaction(command);
    });

    this.kernel.commandBus.registerHandler('EXECUTE_VIOLATION_PENALTY', async (command: any) => {
      return this.handleExecutePenaltyTransaction(command);
    });

    this.kernel.commandBus.registerHandler('LODGE_LAW_APPEAL', async (command: any) => {
      return this.handleAppealTransaction(command);
    });

    this.isOperational = true;
    logger.info(this.moduleName, '🧱 [OS Phase 3 Law Rim] Hardened constitutional compliance enforcement engine armed.');
  }

  private initializeDefaultLaws(): void {
    const cc = this.kernel.configCenter;
    const isWALIsolationActive = cc.get('society.law.default_active_wal', true);

    this.registerInternalLawNode({
      name: 'Unauthorized File Deletion Exception',
      description: 'Prohibits unconfirmed raw disk file deletion actions.',
      condition: 'file_delete_without_confirmation',
      consequence: 'Isolate execution cluster for 24h, fine 50 points.',
      severity: 'severe',
      appeals: true,
      penalty: { type: 'isolation', amount: 50, durationMs: 86400000 }
    });

    this.registerInternalLawNode({
      name: 'Counterfeit Evidentiary Poisoning',
      description: 'Prohibits injecting aligned counterfeit pointers during primary court debates.',
      condition: 'forged_evidence',
      consequence: 'Permanent banishment, zero account credit liquidity.',
      severity: 'severe',
      appeals: false,
      penalty: { type: 'ban', amount: 1000 }
    });
  }

  private registerInternalLawNode(data: Omit<Law, 'id' | 'createdAt' | 'updatedAt' | 'active' | 'metadata'>): void {
    const id = `law_${ulid()}`;
    const now = Date.now();
    this.laws.set(id, {
      id, ...data, metadata: {}, createdAt: now, updatedAt: now, active: true
    });
  }

  public checkViolation(entityId: string, entityType: string, action: string): { violated: boolean; law?: Law } {
    if (!action) return { violated: false };
    const actionLower = action.toLowerCase();

    for (const law of this.laws.values()) {
      if (!law.active) continue;

      const cond = law.condition.toLowerCase();
      let matched = false;

      if (cond === 'file_delete_without_confirmation') {
        matched = actionLower.includes('delete') || actionLower.includes('remove');
      } else if (cond === 'forged_evidence') {
        matched = actionLower.includes('forge') || actionLower.includes('fake') || actionLower.includes('poison');
      }

      if (matched) return { violated: true, law };
    }
    return { violated: false };
  }

  /**
   * 🏗️ Command Handler: Two-Phase Version Asserted Violation Appender
   */
  private async handleRecordViolationTransaction(command: any): Promise<Violation> {
    const { traceId, entityId, entityType, lawId, description, evidence } = command.payload;
    const initialVersion = this.kernel.version;

    const law = this.laws.get(lawId);
    if (!law || !law.active) throw new Error(`ERR_SF_LAW_NOT_FOUND: Targets inactive or invalid law signature: ${lawId}`);

    const tx = await this.kernel.transactionManager.begin(
      command.id || crypto.randomUUID(),
      this.moduleName,
      { traceId, entityId, lawId, readVersionStamp: initialVersion }
    );

    try {
      if (this.kernel.version !== initialVersion) {
        throw new Error(`ERR_SF_LAW_RACE: Version lock mismatch during historical lineage audit block recording.`);
      }

      const violationId = `violation_${ulid()}`;
      const violationBlock: Violation = {
        id: violationId,
        lawId,
        lawName: law.name,
        entityId,
        entityType,
        severity: law.severity,
        description,
        evidence: evidence || [],
        status: 'pending',
        consequence: law.consequence,
        penalty: law.penalty,
        executedAt: null,
        createdAt: Date.now()
      };

      this.violations.set(violationId, violationBlock);

      tx.payload = {
        ...tx.payload,
        violation_id: violationId,
        law_name_seal: law.name,
        target_entity: entityId,
        target_type: entityType,
        severity_rank: law.severity,
        evidence_fingerprints: violationBlock.evidence,
        finalized_at: violationBlock.createdAt
      };

      await this.kernel.transactionManager.commit(tx.id);
      this.pushMetrics('society.law.violations_recorded', 1);

      return violationBlock;

    } catch (panic: any) {
      await this.kernel.transactionManager.rollback(tx.commandId, panic);
      this.pushMetrics('society.law.failures_count', 1);
      throw panic;
    }
  }

  /**
   * 🏗️ Command Handler: Executed Penalty Mutator Shield
   */
  private async handleExecutePenaltyTransaction(command: any): Promise<Violation> {
    const { traceId, violationId, executor } = command.payload;
    const initialVersion = this.kernel.version;

    const violation = this.violations.get(violationId);
    if (!violation || violation.status === 'executed') {
      throw new Error(`ERR_SF_LAW_FLOW: Violation slot ${violationId} already resolved or absent.`);
    }

    const tx = await this.kernel.transactionManager.begin(
      command.id || crypto.randomUUID(),
      this.moduleName,
      { traceId, violationId, readVersionStamp: initialVersion }
    );

    try {
      if (this.kernel.version !== initialVersion) {
        throw new Error(`ERR_SF_LAW_CONCURRENCY: Race mismatch on account execution path constraint verification.`);
      }

      violation.status = 'executed';
      violation.decidedBy = executor;
      violation.decidedAt = Date.now();
      violation.executedAt = Date.now();

      tx.payload = {
        ...tx.payload,
        violation_id: violationId,
        executor_signature: executor,
        execution_status: 'executed',
        penalty_type: violation.penalty.type,
        fine_amount: violation.penalty.amount ?? 0,
        finalized_at: violation.executedAt
      };

      await this.kernel.transactionManager.commit(tx.id);

      // Cascade resource reallocation: automatically lock tokens via economic command pipelines
      if (violation.penalty.amount) {
        await this.kernel.executeCommand({
          id: crypto.randomUUID(),
          type: 'DISTRIBUTE_ROLE_ALLOCATION_REWARD',
          domain: this.moduleName,
          caller: 'LAW_COMPLIANCE_EXECUTION_BARRIER',
          payload: { traceId, agentId: violation.entityId, targetRole: 'WORKER', allocationBonusFactor: -(violation.penalty.amount / 100.0) }
        });
      }

      this.pushMetrics('society.law.penalties_executed', 1);
      return violation;

    } catch (panic: any) {
      await this.kernel.transactionManager.rollback(tx.commandId, panic);
      throw panic;
    }
  }

  /**
   * 🏗️ Command Handler: Appeal Fact Registration Wrapper
   */
  private async handleAppealTransaction(command: any): Promise<Appeal> {
    const { traceId, violationId, appellant, reason, supportingEvidence } = command.payload;
    const initialVersion = this.kernel.version;

    const violation = this.violations.get(violationId);
    if (!violation) throw new Error(`ERR_SF_LAW_TARGET: Target violation ledger entry missing: ${violationId}`);

    const law = this.laws.get(violation.lawId);
    if (!law?.appeals) throw new Error(`ERR_SF_LAW_CONSTITUTION: Appeal process blocked for law regime: ${violation.lawName}`);

    const tx = await this.kernel.transactionManager.begin(
      command.id || crypto.randomUUID(),
      this.moduleName,
      { traceId, violationId, readVersionStamp: initialVersion }
    );

    try {
      if (this.kernel.version !== initialVersion) {
        throw new Error(`ERR_SF_LAW_RACE: Version lock collision during judicial appeal initialization.`);
      }

      const appealId = `appeal_${ulid()}`;
      const appealBlock: Appeal = {
        id: appealId,
        violationId,
        appellant,
        reason,
        evidence: supportingEvidence || [],
        status: 'pending',
        createdAt: Date.now()
      };

      this.appeals.set(appealId, appealBlock);
      violation.status = 'appealed';

      tx.payload = {
        ...tx.payload,
        appeal_id: appealId,
        target_violation: violationId,
        appellant_node: appellant,
        rationale_manifesto: reason,
        finalized_at: appealBlock.createdAt
      };

      await this.kernel.transactionManager.commit(tx.id);
      return appealBlock;

    } catch (panic: any) {
      await this.kernel.transactionManager.rollback(tx.commandId, panic);
      throw panic;
    }
  }

  private pushMetrics(metricName: string, value: number) {
    if (this.kernel?.metricsCollector?.counter) {
      this.kernel.metricsCollector.counter(metricName, value, { domain: 'society', layer: 'law_enforcement' });
    }
  }

  public clearLawRegistry(): void {
    this.laws.clear();
    this.violations.clear();
    this.appeals.clear();
    this.isOperational = false;
  }
}
