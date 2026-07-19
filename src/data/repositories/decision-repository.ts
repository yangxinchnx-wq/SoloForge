// ─────────────────────────────────────────────────────────────────
// SoloForge Repository Layer: DecisionTraceRepository
// Path: src/data/repositories/decision-repository.ts
// Description: 决策链路仓储 - 屏蔽业务层直连 SQL/SurrealQL
// 文档要求：
//   - 幂等写入策略
//   - 按 trace_id 查询
//   - 乐观锁版本控制
// ─────────────────────────────────────────────────────────────────

import { ulid } from 'ulid';

// ============================================================
// 类型定义
// ============================================================

/**
 * 置信度层级枚举
 */
export type ConfidenceTier = 'high' | 'medium' | 'low';

/**
 * 决策类型枚举
 */
export type DecisionType = 'model_select' | 'tool_select' | 'agent_select';

/**
 * 聚合方法枚举
 */
export type AggregationMethod = 'none' | 'plurality_vote' | 'weighted_average' | 'max_score';

/**
 * 推理策略枚举
 */
export type ReasoningStrategy = 'direct' | 'chain_of_thought' | 'few_shot' | 'decompose' | 'self_refine';

/**
 * 实体类型枚举
 */
export type EntityType = 'model' | 'tool' | 'agent';

/**
 * 决策记录
 */
export interface DecisionRecord {
  id?: string;
  traceId: string;
  decisionType: DecisionType;
  selectedStrategy: string;
  strategyReason: string;
  budgetUsed: number;
  budgetLimit: number;
  confidenceTier: ConfidenceTier;
  confidenceScore: number;
  subsetSize: number;
  aggregationMethod: AggregationMethod;
  aggregatedCandidates: string[];
  candidateScores?: CandidateRecord[];
  executionResult?: string;
  executionLatencyMs?: number;
  executionSuccess: boolean;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * 候选评分记录
 */
export interface CandidateRecord {
  id?: string;
  decisionId: string;
  name: string;
  entityType: EntityType;
  qualityScore: number;
  latencyScore: number;
  costScore: number;
  historyScore: number;
  totalScore: number;
  reasoningStrategy: ReasoningStrategy;
  selected: boolean;
  scoreReason?: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * 创建决策选项
 */
export interface CreateDecisionOptions {
  traceId: string;
  decisionType?: DecisionType;
  selectedStrategy: string;
  strategyReason: string;
  budgetUsed?: number;
  budgetLimit?: number;
  confidenceTier: ConfidenceTier;
  confidenceScore?: number;
  subsetSize?: number;
  aggregationMethod?: AggregationMethod;
  aggregatedCandidates?: string[];
  candidateScores?: Omit<CandidateRecord, 'id' | 'decisionId' | 'createdAt' | 'updatedAt'>[];
}

/**
 * 更新决策选项
 */
export interface UpdateDecisionOptions {
  selectedStrategy?: string;
  strategyReason?: string;
  budgetUsed?: number;
  confidenceTier?: ConfidenceTier;
  confidenceScore?: number;
  executionResult?: string;
  executionLatencyMs?: number;
  executionSuccess?: boolean;
}

/**
 * Repository 接口
 */
export interface DecisionTraceRepository {
  /**
   * 创建决策记录（幂等）
   */
  create(options: CreateDecisionOptions): Promise<DecisionRecord>;

  /**
   * 按 ID 查询决策
   */
  findById(id: string): Promise<DecisionRecord | null>;

  /**
   * 按 traceId 查询所有决策
   */
  findByTraceId(traceId: string): Promise<DecisionRecord[]>;

  /**
   * 带乐观锁更新决策
   */
  updateWithOptimisticLock(id: string, expectedVersion: number, options: UpdateDecisionOptions): Promise<DecisionRecord>;

  /**
   * 删除决策（软删除）
   */
  softDelete(id: string): Promise<void>;

  /**
   * 查询最近的决策
   */
  findRecent(limit?: number): Promise<DecisionRecord[]>;
}

/**
 * SurrealDB 驱动接口
 */
export interface SurrealDbDriver {
  query<T = unknown>(sql: string, params?: Record<string, unknown>): Promise<T[][]>;
  create<T = unknown>(table: string, data: T): Promise<T[]>;
  update<T = unknown>(table: string, id: string, data: T): Promise<T[]>;
  delete(table: string, id: string): Promise<void>;
  select<T = unknown>(table: string): Promise<T[]>;
}
