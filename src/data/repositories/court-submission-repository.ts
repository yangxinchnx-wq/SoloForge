// ─────────────────────────────────────────────────────────────────
// SoloForge Repository Layer: CourtSubmissionRepository
// Path: src/data/repositories/court-submission-repository.ts
// Description: 法庭提交仓储 - 司法共识盲审决议
// 文档要求：
//   - 幂等写入策略
//   - 按 trace_id 查询
//   - 两阶段盲审追踪
// ─────────────────────────────────────────────────────────────────

// ============================================================
// 类型定义
// ============================================================

/**
 * 法庭阶段枚举
 */
export type CourtPhase = 'phase_1' | 'phase_2' | 'complete';

/**
 * 争议级别枚举
 */
export type DisputeLevel = 'low' | 'medium' | 'high' | 'critical';

/**
 * 证据类型枚举
 */
export type EvidenceType = 'execution_result' | 'reasoning_chain' | 'external_knowledge' | 'system_metric';

/**
 * 证据状态枚举
 */
export type EvidenceStatus = 'active' | 'retracted' | 'challenged' | 'superseded';

/**
 * 证据记录
 */
export interface EvidenceRecord {
  id?: string;
  traceId: string;
  originatingAgentId: string;
  credibilityIndex: number;
  relevanceWeight: number;
  temporalRecencyValue: number;
  rawContent: string;
  evidenceType: EvidenceType;
  status: EvidenceStatus;
  challengeRecord?: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * 法庭提交记录
 */
export interface CourtSubmissionRecord {
  id?: string;
  traceId: string;
  submittingAgentId: string;
  phase: CourtPhase;
  phase1Deadline: Date;
  phase1CompletedAt?: Date;
  disputedClaimStatement: string;
  linkedEvidenceRegistry: string[];
  judgmentBasis?: string;
  winnerScore: number;
  loserScore: number;
  escalatedToHuman: boolean;
  escalationReason?: string;
  escalationTarget?: string;
  disputeLevel: DisputeLevel;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * 创建法庭提交选项
 */
export interface CreateSubmissionOptions {
  traceId: string;
  submittingAgentId: string;
  disputedClaimStatement: string;
  linkedEvidenceRegistry?: string[];
  phase?: CourtPhase;
  phase1Deadline?: Date;
  disputeLevel?: DisputeLevel;
}

/**
 * 更新法庭提交选项
 */
export interface UpdateSubmissionOptions {
  phase?: CourtPhase;
  phase1CompletedAt?: Date;
  judgmentBasis?: string;
  winnerScore?: number;
  loserScore?: number;
  escalatedToHuman?: boolean;
  escalationReason?: string;
  escalationTarget?: string;
}

/**
 * 证据选项
 */
export interface CreateEvidenceOptions {
  traceId: string;
  originatingAgentId: string;
  credibilityIndex: number;
  relevanceWeight: number;
  temporalRecencyValue: number;
  rawContent: string;
  evidenceType?: EvidenceType;
}

/**
 * Repository 接口
 */
export interface CourtSubmissionRepository {
  /**
   * 创建法庭提交（幂等）
   */
  createSubmission(options: CreateSubmissionOptions): Promise<CourtSubmissionRecord>;

  /**
   * 创建证据记录
   */
  createEvidence(options: CreateEvidenceOptions): Promise<EvidenceRecord>;

  /**
   * 按 ID 查询法庭提交
   */
  findSubmissionById(id: string): Promise<CourtSubmissionRecord | null>;

  /**
   * 按 traceId 查询所有法庭提交
   */
  findSubmissionsByTraceId(traceId: string): Promise<CourtSubmissionRecord[]>;

  /**
   * 按 ID 查询证据
   */
  findEvidenceById(id: string): Promise<EvidenceRecord | null>;

  /**
   * 按 traceId 查询所有证据
   */
  findEvidenceByTraceId(traceId: string): Promise<EvidenceRecord[]>;

  /**
   * 更新法庭提交（带乐观锁）
   */
  updateSubmissionWithOptimisticLock(id: string, expectedVersion: number, options: UpdateSubmissionOptions): Promise<CourtSubmissionRecord>;

  /**
   * 升级到人工裁决
   */
  escalateToHuman(id: string, reason: string, target?: string): Promise<CourtSubmissionRecord>;

  /**
   * 完成法庭提交
   */
  completeSubmission(id: string, judgmentBasis: string, winnerScore: number, loserScore: number): Promise<CourtSubmissionRecord>;
}
