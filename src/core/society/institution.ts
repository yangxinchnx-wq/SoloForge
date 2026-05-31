// src/core/society/institution.ts
import crypto from 'crypto';
import { ulid } from 'ulid';
import { RuntimeKernel } from '../../kernel/runtime-kernel';
import { DeleteProtection } from '../../data/delete_protection'; // 🔒 Synchronized link back to core protection rules
import { logger } from '../logger';

export type InstitutionScope = 'global' | 'agent' | 'task' | 'domain';
export type EnforcementType = 'hard' | 'soft' | 'advisory';

export interface Institution {
  id: string;
  name: string;
  description: string;
  rules: string[];
  scope: InstitutionScope;
  enforcement: EnforcementType;
  priority: number;
  metadata: Record<string, any>;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
}

/**
 * 🧱 Hardened Constitutional Institution Engine
 * Responsibility: Governs system-wide multi-agent behavioral norms under strict transaction boundaries.
 * Design Spec: Eradicates raw mutable singletons to block multi-instance memory cross-contamination.
 */
export class InstitutionEngine {
  private isOperational = false;
  private readonly moduleName = 'InstitutionEngine';
  private institutions: Map<string, Institution> = new Map();
  private deleteProtection = new DeleteProtection();

  constructor(private kernel: RuntimeKernel) {
    if (!kernel || !kernel.transactionManager || !kernel.commandBus || !kernel.configCenter) {
      throw new Error('CRITICAL_SF_CONSTITUTION: Institution system dependencies missing from bootstrap container.');
    }
  }

  /**
   * 🔌 Component Lifecycle Bootstrapper
   */
  public async boot(): Promise<void> {
    if (this.isOperational) return;

    this.initializeDefaultConstitutionalNorms();

    // Register atomic mutation chains onto central CommandBus
    this.kernel.commandBus.registerHandler('CREATE_SOCIETY_INSTITUTION', async (command: any) => {
      return this.handleCreateInstitutionTransaction(command);
    });

    this.kernel.commandBus.registerHandler('SOFT_DELETE_INSTITUTION', async (command: any) => {
      return this.handleDeleteInstitutionTransaction(command);
    });

    this.isOperational = true;
    logger.info(this.moduleName, '🧱 [OS Phase 3 Institution Core] Hardened norm enforcement engine armed.');
  }

  private initializeDefaultConstitutionalNorms(): void {
    this.registerInternalNormNode({
      name: 'CodeInstitution',
      description: 'Code alterations must traverse rigorous asynchronous review pipelines.',
      rules: ['All code changes require review logs.', 'Reviewers must stay isolated from authors.'],
      scope: 'global', enforcement: 'hard', priority: 100
    });

    this.registerInternalNormNode({
      name: 'SecurityInstitution',
      description: 'High-risk disruptive operations enforce two-man dual validation interlocks.',
      rules: ['Destructive file mutations require secondary confirmations.', 'Anomalous actions trip warning metrics.'],
      scope: 'global', enforcement: 'hard', priority: 150
    });
  }

  private registerInternalNormNode(data: Omit<Institution, 'id' | 'createdAt' | 'updatedAt' | 'deletedAt' | 'metadata'>): void {
    const id = `inst_${ulid()}`;
    const now = Date.now();
    this.institutions.set(id, {
      id, ...data, metadata: {}, createdAt: now, updatedAt: now, deletedAt: null
    });
  }

  /**
   * 🏗️ Command Handler: Two-Phase Version Asserted Norm Record Appender
   */
  private async handleCreateInstitutionTransaction(command: any): Promise<Institution> {
    const { traceId, name, description, rules, scope, enforcement, priority, metadata } = command.payload;
    const initialVersion = this.kernel.version;

    const tx = await this.kernel.transactionManager.begin(
      command.id || crypto.randomUUID(),
      this.moduleName,
      { traceId, name, enforcement, readVersionStamp: initialVersion }
    );

    try {
      if (this.kernel.version !== initialVersion) {
        throw new Error(`ERR_SF_INSTITUTION_RACE: Version mismatch during cold norm blueprint compilation.`);
      }

      const id = `inst_${ulid()}`;
      const now = Date.now();
      const institutionBlock: Institution = {
        id, name, description, rules: rules || [], scope, enforcement,
        priority: Number(priority || 100), metadata: metadata || {},
        createdAt: now, updatedAt: now, deletedAt: null
      };

      this.institutions.set(id, institutionBlock);

      tx.payload = {
        ...tx.payload,
        institution_id: id,
        norm_name_seal: name,
        scope_rank: scope,
        priority_coefficient: institutionBlock.priority,
        finalized_at: now
      };

      await this.kernel.transactionManager.commit(tx.id);
      this.pushMetrics('society.institution.norms_created', 1);
      return institutionBlock;

    } catch (panic: any) {
      await this.kernel.transactionManager.rollback(tx.commandId, panic);
      this.pushMetrics('society.institution.failures_count', 1);
      throw panic;
    }
  }

  /**
   * 🏗️ Command Handler: Hardened Soft-Delete Transactional Controller
   */
  private async handleDeleteInstitutionTransaction(command: any): Promise<boolean> {
    const { traceId, institutionId } = command.payload;
    const targetNorm = this.institutions.get(institutionId);
    if (!targetNorm || targetNorm.deletedAt) return false;

    // Rigid check mapping over core protection frameworks prior to initiating state locks
    const check = this.deleteProtection.canDelete('institution', institutionId);
    if (!check.allowed) {
      logger.error(this.moduleName, `🚨 Unauthorized deletion attempt intercepted for norm entry: ${institutionId}. Reason: ${check.reason}`);
      return false;
    }

    const initialVersion = this.kernel.version;
    const tx = await this.kernel.transactionManager.begin(
      command.id || crypto.randomUUID(),
      this.moduleName,
      { traceId, institutionId, readVersionStamp: initialVersion }
    );

    try {
      if (this.kernel.version !== initialVersion) {
        throw new Error(`ERR_SF_INSTITUTION_DELETE_RACE: Version drifted prior to soft-deleting target norm asset.`);
      }

      const now = Date.now();
      targetNorm.deletedAt = now;
      targetNorm.updatedAt = now;

      tx.payload = {
        ...tx.payload,
        institution_id: institutionId,
        deletion_status_seal: 'soft_deleted',
        finalized_at: now
      };

      await this.kernel.transactionManager.commit(tx.id);
      this.pushMetrics('society.institution.norms_deleted', 1);
      return true;

    } catch (panic: any) {
      await this.kernel.transactionManager.rollback(tx.commandId, panic);
      throw panic;
    }
  }

  public getNormProxy(id: string): Institution | undefined {
    const inst = this.institutions.get(id);
    return inst && !inst.deletedAt ? { ...inst } : undefined;
  }

  public getEffectiveNormRules(): Institution[] {
    return Array.from(this.institutions.values())
      .filter(i => !i.deletedAt)
      .sort((x, y) => y.priority - x.priority);
  }

  private pushMetrics(metricName: string, value: number) {
    if (this.kernel?.metricsCollector?.counter) {
      this.kernel.metricsCollector.counter(metricName, value, { domain: 'society', layer: 'institution' });
    }
  }

  public evictEngineCache(): void {
    this.institutions.clear();
    this.isOperational = false;
  }
}
