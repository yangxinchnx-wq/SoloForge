// ─────────────────────────────────────────────────────────────────
// SoloForge Repository Layer: CourtVerdictRepository
// Path: src/data/repositories/court-verdict-repository.ts
// Description: 法庭裁决仓储 - 司法共识盲审最终裁决
// 文档要求：
//   - 幂等写入策略
//   - 按 trace_id 查询
//   - 裁决一致性保证
// ─────────────────────────────────────────────────────────────────

// ============================================================
// 类型定义
// ============================================================

/**
 * 裁决状态枚举
 */
export type VerdictStatus = 'DECIDED_LEGITIMATE' | 'CONSERVATIVE_DEADLOCK_TRIGGER' | 'ESCAPE_ROUTING_TO_HUMAN' | 'PENDING';

/**
 * 裁决类型枚举
 */
export type VerdictType = 'CONSENSUS' | 'DEADLOCK' | 'ESCALATION' | 'SPLIT';

/**
 * 陪审团成员类型
 */
export type JurorType = 'autonomous' | 'llm' | 'human';

/**
 * 陪审团成员状态
 */
export type JurorStatus = 'active' | 'inactive' | 'disqualified';

/**
 * 陪审团成员记录
 */
export interface CourtJurorRecord {
  id?: string;
  agentId: string;
  jurorType: JurorType;
  capabilityScore: number;
  historicalAccuracy: number;
  status: JurorStatus;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * 法庭裁决记录
 */
export interface CourtVerdictRecord {
  id?: string;
  traceId: string;
  submissionId: string;
  verdictStatus: VerdictStatus;
  winningAgentSignature?: string;
  adjudicatedMetricScore: number;
  verdictType: VerdictType;
  verdictReason?: string;
  participatingAgents: string[];
  llmVerdictContent?: string;
  executedAction?: number;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * 创建裁决选项
 */
export interface CreateVerdictOptions {
  traceId: string;
  submissionId: string;
  participatingAgents: string[];
}

/**
 * 发布裁决选项
 */
export interface IssueVerdictOptions {
  verdictStatus: VerdictStatus;
  winningAgentSignature?: string;
  adjudicatedMetricScore: number;
  verdictType: VerdictType;
  verdictReason?: string;
  llmVerdictContent?: string;
  executedAction?: number;
}

/**
 * 陪审团成员选项
 */
export interface CreateJurorOptions {
  agentId: string;
  jurorType: JurorType;
  capabilityScore?: number;
  historicalAccuracy?: number;
}

/**
 * Repository 接口
 */
export interface CourtVerdictRepository {
  /**
   * 创建裁决记录（初始状态为 PENDING）
   */
  createVerdict(options: CreateVerdictOptions): Promise<CourtVerdictRecord>;

  /**
   * 按 ID 查询裁决
   */
  findVerdictById(id: string): Promise<CourtVerdictRecord | null>;

  /**
   * 按 traceId 查询裁决
   */
  findVerdictByTraceId(traceId: string): Promise<CourtVerdictRecord | null>;

  /**
   * 按 submissionId 查询裁决
   */
  findVerdictBySubmissionId(submissionId: string): Promise<CourtVerdictRecord | null>;

  /**
   * 发布裁决
   */
  issueVerdict(id: string, options: IssueVerdictOptions): Promise<CourtVerdictRecord>;

  /**
   * 创建陪审团成员
   */
  createJuror(options: CreateJurorOptions): Promise<CourtJurorRecord>;

  /**
   * 按 ID 查询陪审团成员
   */
  findJurorById(id: string): Promise<CourtJurorRecord | null>;

  /**
   * 查询所有活跃陪审团成员
   */
  findActiveJurors(): Promise<CourtJurorRecord[]>;

  /**
   * 更新陪审团成员状态
   */
  updateJurorStatus(id: string, status: JurorStatus): Promise<CourtJurorRecord>;
}
