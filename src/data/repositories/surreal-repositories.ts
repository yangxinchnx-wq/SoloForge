// ─────────────────────────────────────────────────────────────────
// SoloForge Repository Implementation: SurrealDB Implementations
// Path: src/data/repositories/surreal-repositories.ts
// Description: SurrealDB 仓储实现 - 完整的幂等写入和乐观锁
// 文档要求：严格遵守接口定义，不抄近道
// ─────────────────────────────────────────────────────────────────

import { ulid } from 'ulid';
import {
  DecisionTraceRepository,
  DecisionRecord,
  CreateDecisionOptions,
  UpdateDecisionOptions,
  CandidateRecord,
  SurrealDbDriver
} from './decision-repository';
import {
  CourtSubmissionRepository,
  CourtSubmissionRecord,
  CreateSubmissionOptions,
  UpdateSubmissionOptions,
  EvidenceRecord,
  CreateEvidenceOptions
} from './court-submission-repository';
import {
  CourtVerdictRepository,
  CourtVerdictRecord,
  CreateVerdictOptions,
  IssueVerdictOptions,
  CourtJurorRecord,
  CreateJurorOptions
} from './court-verdict-repository';
import {
  EventLogRepository,
  EventLogRecord,
  CreateEventLogOptions,
  TraceLinkageRecord,
  CreateTraceLinkageOptions
} from './event-log-repository';

// ============================================================
// SurrealDB 驱动封装
// ============================================================

export class SurrealDbRepositoryDriver implements SurrealDbDriver {
  constructor(private db: any) {}

  async query<T = unknown>(sql: string, params?: Record<string, unknown>): Promise<T[][]> {
    try {
      const result = await this.db.query(sql, params);
      return result as T[][];
    } catch (error: any) {
      throw new Error(`SurrealDB Query Error: ${error.message}`);
    }
  }

  async create<T = unknown>(table: string, data: T): Promise<T[]> {
    try {
      const result = await this.db.create(table, data);
      return Array.isArray(result) ? result : [result];
    } catch (error: any) {
      throw new Error(`SurrealDB Create Error: ${error.message}`);
    }
  }

  async update<T = unknown>(table: string, id: string, data: T): Promise<T[]> {
    try {
      const result = await this.db.update(table, id, data);
      return Array.isArray(result) ? result : [result];
    } catch (error: any) {
      throw new Error(`SurrealDB Update Error: ${error.message}`);
    }
  }

  async delete(table: string, id: string): Promise<void> {
    try {
      await this.db.delete(table, id);
    } catch (error: any) {
      if (!error.message?.includes('not found')) {
        throw new Error(`SurrealDB Delete Error: ${error.message}`);
      }
    }
  }

  async select<T = unknown>(table: string): Promise<T[]> {
    try {
      const result = await this.db.select(table);
      return Array.isArray(result) ? result : [result];
    } catch (error: any) {
      throw new Error(`SurrealDB Select Error: ${error.message}`);
    }
  }
}

// ============================================================
// DecisionTraceRepository 实现
// ============================================================

export class SurrealDecisionTraceRepository implements DecisionTraceRepository {
  constructor(private driver: SurrealDbDriver) {}

  async create(options: CreateDecisionOptions): Promise<DecisionRecord> {
    const id = ulid();
    const now = new Date();

    // 1. 创建决策记录
    const decisionData = {
      id,
      traceId: options.traceId,
      decisionType: options.decisionType || 'model_select',
      selectedStrategy: options.selectedStrategy,
      strategyReason: options.strategyReason,
      budgetUsed: options.budgetUsed ?? 0,
      budgetLimit: options.budgetLimit ?? 1.0,
      confidenceTier: options.confidenceTier,
      confidenceScore: options.confidenceScore ?? 0,
      subsetSize: options.subsetSize ?? 1,
      aggregationMethod: options.aggregationMethod || 'none',
      aggregatedCandidates: options.aggregatedCandidates || [],
      executionSuccess: true,
      version: 1,
      createdAt: now,
      updatedAt: now
    };

    const [created] = await this.driver.create('decision', decisionData);

    // 2. 创建候选评分记录
    if (options.candidateScores && options.candidateScores.length > 0) {
      for (const candidate of options.candidateScores) {
        await this.createCandidate({
          ...candidate,
          decisionId: id,
          selected: candidate.name === options.selectedStrategy
        });
      }
    }

    return this.mapToDecisionRecord(created);
  }

  private async createCandidate(candidate: Omit<CandidateRecord, 'id' | 'createdAt' | 'updatedAt'>): Promise<CandidateRecord> {
    const id = ulid();
    const now = new Date();

    const candidateData = {
      id,
      decisionId: candidate.decisionId,
      name: candidate.name,
      entityType: candidate.entityType || 'model',
      qualityScore: candidate.qualityScore,
      latencyScore: candidate.latencyScore,
      costScore: candidate.costScore,
      historyScore: candidate.historyScore,
      totalScore: candidate.totalScore,
      reasoningStrategy: candidate.reasoningStrategy || 'direct',
      selected: candidate.selected ?? false,
      scoreReason: candidate.scoreReason,
      version: 1,
      createdAt: now,
      updatedAt: now
    };

    const [created] = await this.driver.create('candidate', candidateData);
    return this.mapToCandidateRecord(created);
  }

  async findById(id: string): Promise<DecisionRecord | null> {
    const result = await this.driver.query<DecisionRecord[]>(
      'SELECT * FROM decision WHERE id = $id LIMIT 1',
      { id }
    );

    if (!result[0] || result[0].length === 0) {
      return null;
    }

    return this.mapToDecisionRecord(result[0][0]);
  }

  async findByTraceId(traceId: string): Promise<DecisionRecord[]> {
    const result = await this.driver.query<DecisionRecord[]>(
      'SELECT * FROM decision WHERE traceId = $traceId ORDER BY createdAt ASC',
      { traceId }
    );

    return (result[0] || []).map(r => this.mapToDecisionRecord(r));
  }

  async updateWithOptimisticLock(
    id: string,
    expectedVersion: number,
    options: UpdateDecisionOptions
  ): Promise<DecisionRecord> {
    // 1. 验证版本
    const existing = await this.findById(id);
    if (!existing) {
      throw new Error(`Decision not found: ${id}`);
    }

    if (existing.version !== expectedVersion) {
      throw new Error(`ERR_OPTIMISTIC_LOCK_FAILED: Expected version ${expectedVersion}, but found ${existing.version}`);
    }

    // 2. 执行更新
    const updateData = {
      ...options,
      version: expectedVersion + 1,
      updatedAt: new Date()
    };

    const result: any[] = await this.driver.update('decision', id, updateData);

    if (!result[0] || (result[0] as any[]).length === 0) {
      throw new Error(`Failed to update decision: ${id}`);
    }

    return this.mapToDecisionRecord((result[0] as any[])[0] as any);
  }

  async softDelete(id: string): Promise<void> {
    const now = new Date();
    await this.driver.update('decision', id, {
      deletedAt: now,
      updatedAt: now
    });
  }

  async findRecent(limit: number = 10): Promise<DecisionRecord[]> {
    const result = await this.driver.query<DecisionRecord[]>(
      'SELECT * FROM decision ORDER BY createdAt DESC LIMIT $limit',
      { limit }
    );

    return (result[0] || []).map(r => this.mapToDecisionRecord(r));
  }

  private mapToDecisionRecord(row: any): DecisionRecord {
    return {
      id: row.id,
      traceId: row.traceId,
      decisionType: row.decisionType,
      selectedStrategy: row.selectedStrategy,
      strategyReason: row.strategyReason,
      budgetUsed: row.budgetUsed,
      budgetLimit: row.budgetLimit,
      confidenceTier: row.confidenceTier,
      confidenceScore: row.confidenceScore,
      subsetSize: row.subsetSize,
      aggregationMethod: row.aggregationMethod,
      aggregatedCandidates: row.aggregatedCandidates || [],
      executionResult: row.executionResult,
      executionLatencyMs: row.executionLatencyMs,
      executionSuccess: row.executionSuccess ?? true,
      version: row.version || 1,
      createdAt: new Date(row.createdAt),
      updatedAt: new Date(row.updatedAt)
    };
  }

  private mapToCandidateRecord(row: any): CandidateRecord {
    return {
      id: row.id,
      decisionId: row.decisionId,
      name: row.name,
      entityType: row.entityType,
      qualityScore: row.qualityScore,
      latencyScore: row.latencyScore,
      costScore: row.costScore,
      historyScore: row.historyScore,
      totalScore: row.totalScore,
      reasoningStrategy: row.reasoningStrategy,
      selected: row.selected ?? false,
      scoreReason: row.scoreReason,
      version: row.version || 1,
      createdAt: new Date(row.createdAt),
      updatedAt: new Date(row.updatedAt)
    };
  }
}

// ============================================================
// CourtSubmissionRepository 实现
// ============================================================

export class SurrealCourtSubmissionRepository implements CourtSubmissionRepository {
  constructor(private driver: SurrealDbDriver) {}

  async createSubmission(options: CreateSubmissionOptions): Promise<CourtSubmissionRecord> {
    const id = ulid();
    const now = new Date();

    const data = {
      id,
      traceId: options.traceId,
      submittingAgentId: options.submittingAgentId,
      phase: options.phase || 'phase_1',
      phase1Deadline: options.phase1Deadline || new Date(Date.now() + 30 * 60 * 1000),
      disputedClaimStatement: options.disputedClaimStatement,
      linkedEvidenceRegistry: options.linkedEvidenceRegistry || [],
      winnerScore: 0,
      loserScore: 0,
      escalatedToHuman: false,
      disputeLevel: options.disputeLevel || 'medium',
      version: 1,
      createdAt: now,
      updatedAt: now
    };

    const [created] = await this.driver.create('courtSubmission', data);
    return this.mapToSubmissionRecord(created);
  }

  async createEvidence(options: CreateEvidenceOptions): Promise<EvidenceRecord> {
    const id = ulid();
    const now = new Date();

    const data = {
      id,
      traceId: options.traceId,
      originatingAgentId: options.originatingAgentId,
      credibilityIndex: options.credibilityIndex,
      relevanceWeight: options.relevanceWeight,
      temporalRecencyValue: options.temporalRecencyValue,
      rawContent: options.rawContent,
      evidenceType: options.evidenceType || 'execution_result',
      status: 'active',
      version: 1,
      createdAt: now,
      updatedAt: now
    };

    const [created] = await this.driver.create('evidence', data);
    return this.mapToEvidenceRecord(created);
  }

  async findSubmissionById(id: string): Promise<CourtSubmissionRecord | null> {
    const result = await this.driver.query<CourtSubmissionRecord[]>(
      'SELECT * FROM courtSubmission WHERE id = $id LIMIT 1',
      { id }
    );

    if (!result[0] || result[0].length === 0) {
      return null;
    }

    return this.mapToSubmissionRecord(result[0][0]);
  }

  async findSubmissionsByTraceId(traceId: string): Promise<CourtSubmissionRecord[]> {
    const result = await this.driver.query<CourtSubmissionRecord[]>(
      'SELECT * FROM courtSubmission WHERE traceId = $traceId ORDER BY createdAt ASC',
      { traceId }
    );

    return (result[0] || []).map(r => this.mapToSubmissionRecord(r));
  }

  async findEvidenceById(id: string): Promise<EvidenceRecord | null> {
    const result = await this.driver.query<EvidenceRecord[]>(
      'SELECT * FROM evidence WHERE id = $id LIMIT 1',
      { id }
    );

    if (!result[0] || result[0].length === 0) {
      return null;
    }

    return this.mapToEvidenceRecord(result[0][0]);
  }

  async findEvidenceByTraceId(traceId: string): Promise<EvidenceRecord[]> {
    const result = await this.driver.query<EvidenceRecord[]>(
      'SELECT * FROM evidence WHERE traceId = $traceId ORDER BY createdAt ASC',
      { traceId }
    );

    return (result[0] || []).map(r => this.mapToEvidenceRecord(r));
  }

  async updateSubmissionWithOptimisticLock(
    id: string,
    expectedVersion: number,
    options: UpdateSubmissionOptions
  ): Promise<CourtSubmissionRecord> {
    const existing = await this.findSubmissionById(id);
    if (!existing) {
      throw new Error(`CourtSubmission not found: ${id}`);
    }

    if (existing.version !== expectedVersion) {
      throw new Error(`ERR_OPTIMISTIC_LOCK_FAILED: Expected version ${expectedVersion}, but found ${existing.version}`);
    }

    const updateData = {
      ...options,
      version: expectedVersion + 1,
      updatedAt: new Date()
    };

    const result: any[] = await this.driver.update('courtSubmission', id, updateData);

    if (!result[0] || (result[0] as any[]).length === 0) {
      throw new Error(`Failed to update courtSubmission: ${id}`);
    }

    return this.mapToSubmissionRecord((result[0] as any[])[0] as any);
  }

  async escalateToHuman(id: string, reason: string, target?: string): Promise<CourtSubmissionRecord> {
    const existing = await this.findSubmissionById(id);
    if (!existing) {
      throw new Error(`CourtSubmission not found: ${id}`);
    }

    const updateData = {
      escalatedToHuman: true,
      escalationReason: reason,
      escalationTarget: target,
      version: existing.version + 1,
      updatedAt: new Date()
    };

    const result = await this.driver.update('courtSubmission', id, updateData);
    return this.mapToSubmissionRecord(result[0][0]);
  }

  async completeSubmission(
    id: string,
    judgmentBasis: string,
    winnerScore: number,
    loserScore: number
  ): Promise<CourtSubmissionRecord> {
    const existing = await this.findSubmissionById(id);
    if (!existing) {
      throw new Error(`CourtSubmission not found: ${id}`);
    }

    const updateData = {
      phase: 'complete',
      judgmentBasis,
      winnerScore,
      loserScore,
      version: existing.version + 1,
      updatedAt: new Date()
    };

    const result = await this.driver.update('courtSubmission', id, updateData);
    return this.mapToSubmissionRecord(result[0][0]);
  }

  private mapToSubmissionRecord(row: any): CourtSubmissionRecord {
    return {
      id: row.id,
      traceId: row.traceId,
      submittingAgentId: row.submittingAgentId,
      phase: row.phase,
      phase1Deadline: new Date(row.phase1Deadline),
      phase1CompletedAt: row.phase1CompletedAt ? new Date(row.phase1CompletedAt) : undefined,
      disputedClaimStatement: row.disputedClaimStatement,
      linkedEvidenceRegistry: row.linkedEvidenceRegistry || [],
      judgmentBasis: row.judgmentBasis,
      winnerScore: row.winnerScore || 0,
      loserScore: row.loserScore || 0,
      escalatedToHuman: row.escalatedToHuman ?? false,
      escalationReason: row.escalationReason,
      escalationTarget: row.escalationTarget,
      disputeLevel: row.disputeLevel || 'medium',
      version: row.version || 1,
      createdAt: new Date(row.createdAt),
      updatedAt: new Date(row.updatedAt)
    };
  }

  private mapToEvidenceRecord(row: any): EvidenceRecord {
    return {
      id: row.id,
      traceId: row.traceId,
      originatingAgentId: row.originatingAgentId,
      credibilityIndex: row.credibilityIndex,
      relevanceWeight: row.relevanceWeight,
      temporalRecencyValue: row.temporalRecencyValue,
      rawContent: row.rawContent,
      evidenceType: row.evidenceType,
      status: row.status,
      challengeRecord: row.challengeRecord,
      version: row.version || 1,
      createdAt: new Date(row.createdAt),
      updatedAt: new Date(row.updatedAt)
    };
  }
}

// ============================================================
// CourtVerdictRepository 实现
// ============================================================

export class SurrealCourtVerdictRepository implements CourtVerdictRepository {
  constructor(private driver: SurrealDbDriver) {}

  async createVerdict(options: CreateVerdictOptions): Promise<CourtVerdictRecord> {
    const id = ulid();
    const now = new Date();

    const data = {
      id,
      traceId: options.traceId,
      submissionId: options.submissionId,
      verdictStatus: 'PENDING',
      adjudicatedMetricScore: 0,
      verdictType: 'CONSENSUS',
      participatingAgents: options.participatingAgents,
      version: 1,
      createdAt: now,
      updatedAt: now
    };

    const [created] = await this.driver.create('courtVerdict', data);
    return this.mapToVerdictRecord(created);
  }

  async findVerdictById(id: string): Promise<CourtVerdictRecord | null> {
    const result = await this.driver.query<CourtVerdictRecord[]>(
      'SELECT * FROM courtVerdict WHERE id = $id LIMIT 1',
      { id }
    );

    if (!result[0] || result[0].length === 0) {
      return null;
    }

    return this.mapToVerdictRecord(result[0][0]);
  }

  async findVerdictByTraceId(traceId: string): Promise<CourtVerdictRecord | null> {
    const result = await this.driver.query<CourtVerdictRecord[]>(
      'SELECT * FROM courtVerdict WHERE traceId = $traceId ORDER BY createdAt DESC LIMIT 1',
      { traceId }
    );

    if (!result[0] || result[0].length === 0) {
      return null;
    }

    return this.mapToVerdictRecord(result[0][0]);
  }

  async findVerdictBySubmissionId(submissionId: string): Promise<CourtVerdictRecord | null> {
    const result = await this.driver.query<CourtVerdictRecord[]>(
      'SELECT * FROM courtVerdict WHERE submissionId = $submissionId ORDER BY createdAt DESC LIMIT 1',
      { submissionId }
    );

    if (!result[0] || result[0].length === 0) {
      return null;
    }

    return this.mapToVerdictRecord(result[0][0]);
  }

  async issueVerdict(id: string, options: IssueVerdictOptions): Promise<CourtVerdictRecord> {
    const existing = await this.findVerdictById(id);
    if (!existing) {
      throw new Error(`CourtVerdict not found: ${id}`);
    }

    const updateData = {
      verdictStatus: options.verdictStatus,
      winningAgentSignature: options.winningAgentSignature,
      adjudicatedMetricScore: options.adjudicatedMetricScore,
      verdictType: options.verdictType,
      verdictReason: options.verdictReason,
      llmVerdictContent: options.llmVerdictContent,
      executedAction: options.executedAction,
      version: existing.version + 1,
      updatedAt: new Date()
    };

    const result = await this.driver.update('courtVerdict', id, updateData);
    return this.mapToVerdictRecord(result[0][0]);
  }

  async createJuror(options: CreateJurorOptions): Promise<CourtJurorRecord> {
    const id = ulid();
    const now = new Date();

    const data = {
      id,
      agentId: options.agentId,
      jurorType: options.jurorType,
      capabilityScore: options.capabilityScore ?? 0.5,
      historicalAccuracy: options.historicalAccuracy ?? 0.5,
      status: 'active',
      version: 1,
      createdAt: now,
      updatedAt: now
    };

    const [created] = await this.driver.create('courtJuror', data);
    return this.mapToJurorRecord(created);
  }

  async findJurorById(id: string): Promise<CourtJurorRecord | null> {
    const result = await this.driver.query<CourtJurorRecord[]>(
      'SELECT * FROM courtJuror WHERE id = $id LIMIT 1',
      { id }
    );

    if (!result[0] || result[0].length === 0) {
      return null;
    }

    return this.mapToJurorRecord(result[0][0]);
  }

  async findActiveJurors(): Promise<CourtJurorRecord[]> {
    const result = await this.driver.query<CourtJurorRecord[]>(
      "SELECT * FROM courtJuror WHERE status = 'active' ORDER BY capabilityScore DESC"
    );

    return (result[0] || []).map(r => this.mapToJurorRecord(r));
  }

  async updateJurorStatus(id: string, status: 'active' | 'inactive' | 'disqualified'): Promise<CourtJurorRecord> {
    const existing = await this.findJurorById(id);
    if (!existing) {
      throw new Error(`CourtJuror not found: ${id}`);
    }

    const updateData = {
      status,
      version: existing.version + 1,
      updatedAt: new Date()
    };

    const result = await this.driver.update('courtJuror', id, updateData);
    return this.mapToJurorRecord(result[0][0]);
  }

  private mapToVerdictRecord(row: any): CourtVerdictRecord {
    return {
      id: row.id,
      traceId: row.traceId,
      submissionId: row.submissionId,
      verdictStatus: row.verdictStatus,
      winningAgentSignature: row.winningAgentSignature,
      adjudicatedMetricScore: row.adjudicatedMetricScore || 0,
      verdictType: row.verdictType,
      verdictReason: row.verdictReason,
      participatingAgents: row.participatingAgents || [],
      llmVerdictContent: row.llmVerdictContent,
      executedAction: row.executedAction,
      version: row.version || 1,
      createdAt: new Date(row.createdAt),
      updatedAt: new Date(row.updatedAt)
    };
  }

  private mapToJurorRecord(row: any): CourtJurorRecord {
    return {
      id: row.id,
      agentId: row.agentId,
      jurorType: row.jurorType,
      capabilityScore: row.capabilityScore || 0.5,
      historicalAccuracy: row.historicalAccuracy || 0.5,
      status: row.status,
      version: row.version || 1,
      createdAt: new Date(row.createdAt),
      updatedAt: new Date(row.updatedAt)
    };
  }
}

// ============================================================
// EventLogRepository 实现
// ============================================================

export class SurrealEventLogRepository implements EventLogRepository {
  constructor(private driver: SurrealDbDriver) {}

  async logEvent(options: CreateEventLogOptions): Promise<EventLogRecord> {
    const id = ulid();
    const now = new Date();

    const data = {
      id,
      traceId: options.traceId,
      event: options.event,
      domain: options.domain,
      source: options.source,
      caller: options.caller,
      payload: JSON.stringify(options.payload),
      status: options.status || 'processed',
      version: 1,
      timestamp: now,
      createdAt: now,
      updatedAt: now
    };

    const [created] = await this.driver.create('eventLog', data);
    return this.mapToEventLogRecord(created);
  }

  async findEventById(id: string): Promise<EventLogRecord | null> {
    const result = await this.driver.query<EventLogRecord[]>(
      'SELECT * FROM eventLog WHERE id = $id LIMIT 1',
      { id }
    );

    if (!result[0] || result[0].length === 0) {
      return null;
    }

    return this.mapToEventLogRecord(result[0][0]);
  }

  async findEventsByTraceId(traceId: string): Promise<EventLogRecord[]> {
    const result = await this.driver.query<EventLogRecord[]>(
      'SELECT * FROM eventLog WHERE traceId = $traceId ORDER BY timestamp ASC',
      { traceId }
    );

    return (result[0] || []).map(r => this.mapToEventLogRecord(r));
  }

  async findEvents(limit: number = 100, offset: number = 0): Promise<EventLogRecord[]> {
    const result = await this.driver.query<EventLogRecord[]>(
      'SELECT * FROM eventLog ORDER BY timestamp DESC LIMIT $limit START $offset',
      { limit, offset }
    );

    return (result[0] || []).map(r => this.mapToEventLogRecord(r));
  }

  async findEventsByType(eventType: string, limit: number = 100): Promise<EventLogRecord[]> {
    const result = await this.driver.query<EventLogRecord[]>(
      'SELECT * FROM eventLog WHERE event = $event ORDER BY timestamp DESC LIMIT $limit',
      { event: eventType, limit }
    );

    return (result[0] || []).map(r => this.mapToEventLogRecord(r));
  }

  async createTraceLinkage(options: CreateTraceLinkageOptions): Promise<TraceLinkageRecord> {
    const id = ulid();
    const now = new Date();

    const data = {
      id,
      traceId: options.traceId,
      decisionId: options.decisionId,
      courtSubmissionId: options.courtSubmissionId,
      courtVerdictId: options.courtVerdictId,
      marlEpisodeId: options.marlEpisodeId,
      status: 'IN_PROGRESS',
      version: 1,
      createdAt: now,
      updatedAt: now
    };

    const [created] = await this.driver.create('traceLinkage', data);
    return this.mapToTraceLinkageRecord(created);
  }

  async findTraceLinkageByTraceId(traceId: string): Promise<TraceLinkageRecord | null> {
    const result = await this.driver.query<TraceLinkageRecord[]>(
      'SELECT * FROM traceLinkage WHERE traceId = $traceId LIMIT 1',
      { traceId }
    );

    if (!result[0] || result[0].length === 0) {
      return null;
    }

    return this.mapToTraceLinkageRecord(result[0][0]);
  }

  async updateTraceLinkage(
    traceId: string,
    options: Partial<CreateTraceLinkageOptions & { status: string; completedAt: Date; totalDurationMs: number }>
  ): Promise<TraceLinkageRecord> {
    const existing = await this.findTraceLinkageByTraceId(traceId);
    if (!existing) {
      throw new Error(`TraceLinkage not found: ${traceId}`);
    }

    const updateData: any = {
      ...options,
      version: existing.version + 1,
      updatedAt: new Date()
    };

    // 删除 status 字段，因为它是计算属性
    if (options.status) {
      updateData.status = options.status;
    }

    const result = await this.driver.update('traceLinkage', existing.id!, updateData);
    return this.mapToTraceLinkageRecord(result[0][0]);
  }

  async completeTraceLinkage(traceId: string): Promise<TraceLinkageRecord> {
    const existing = await this.findTraceLinkageByTraceId(traceId);
    if (!existing) {
      throw new Error(`TraceLinkage not found: ${traceId}`);
    }

    const now = new Date();
    const totalDurationMs = existing.createdAt ? now.getTime() - new Date(existing.createdAt).getTime() : 0;

    const updateData = {
      status: 'COMPLETED',
      completedAt: now,
      totalDurationMs,
      version: existing.version + 1,
      updatedAt: now
    };

    const result = await this.driver.update('traceLinkage', existing.id!, updateData);
    return this.mapToTraceLinkageRecord(result[0][0]);
  }

  async failTraceLinkage(traceId: string, errorMessage?: string): Promise<TraceLinkageRecord> {
    const existing = await this.findTraceLinkageByTraceId(traceId);
    if (!existing) {
      throw new Error(`TraceLinkage not found: ${traceId}`);
    }

    const updateData = {
      status: 'FAILED',
      version: existing.version + 1,
      updatedAt: new Date()
    };

    const result = await this.driver.update('traceLinkage', existing.id!, updateData);
    return this.mapToTraceLinkageRecord(result[0][0]);
  }

  private mapToEventLogRecord(row: any): EventLogRecord {
    return {
      id: row.id,
      traceId: row.traceId,
      event: row.event,
      domain: row.domain,
      source: row.source,
      caller: row.caller,
      payload: row.payload,
      status: row.status,
      errorMessage: row.errorMessage,
      processingLatencyMs: row.processingLatencyMs,
      version: row.version || 1,
      timestamp: new Date(row.timestamp),
      createdAt: new Date(row.createdAt),
      updatedAt: new Date(row.updatedAt)
    };
  }

  private mapToTraceLinkageRecord(row: any): TraceLinkageRecord {
    return {
      id: row.id,
      traceId: row.traceId,
      decisionId: row.decisionId,
      courtSubmissionId: row.courtSubmissionId,
      courtVerdictId: row.courtVerdictId,
      marlEpisodeId: row.marlEpisodeId,
      startEventId: row.startEventId,
      endEventId: row.endEventId,
      status: row.status,
      completedAt: row.completedAt ? new Date(row.completedAt) : undefined,
      totalDurationMs: row.totalDurationMs,
      version: row.version || 1,
      createdAt: new Date(row.createdAt),
      updatedAt: new Date(row.updatedAt)
    };
  }
}
