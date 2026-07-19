// ─────────────────────────────────────────────────────────────────
// SoloForge Service Layer: TraceService
// Path: src/data/repositories/trace-service.ts
// Description: 追踪服务层 - 提供统一的追踪接口
// 文档要求：
//   - createSubmission(...) - 创建法庭提交
//   - issueVerdict(...) - 发布裁决
//   - queryTrace(traceId) - 全链路查询
//   - 事务边界：决策 -> 提交 -> 裁决 -> 事件
//   - 幂等写入：异常重试不产生重复脏数据
// ─────────────────────────────────────────────────────────────────

import { ulid } from 'ulid';
import { DecisionTraceRepository, DecisionRecord, CreateDecisionOptions, UpdateDecisionOptions } from './decision-repository';
import { CourtSubmissionRepository, CourtSubmissionRecord } from './court-submission-repository';
import type { CreateSubmissionOptions as CourtCreateSubmissionOptions, UpdateSubmissionOptions } from './court-submission-repository';
import { CourtVerdictRepository, CourtVerdictRecord } from './court-verdict-repository';
import type { CreateVerdictOptions, IssueVerdictOptions as CourtIssueVerdictOptions } from './court-verdict-repository';
import { EventLogRepository, EventLogRecord, CreateEventLogOptions, TraceLinkageRecord, CreateTraceLinkageOptions } from './event-log-repository';

// ============================================================
// 类型定义
// ============================================================

/**
 * 追踪卷宗 - 包含完整的链路数据
 */
export interface TraceCaseFile {
  traceId: string;
  decision?: DecisionRecord;
  courtSubmissions: CourtSubmissionRecord[];
  courtVerdict?: CourtVerdictRecord;
  events: EventLogRecord[];
  linkage?: TraceLinkageRecord;
}

/**
 * 创建法庭提交选项
 */
export interface CreateSubmissionOptions {
  traceId: string;
  submittingAgentId: string;
  disputedClaimStatement: string;
  linkedEvidenceRegistry?: string[];
  phase?: 'phase_1' | 'phase_2' | 'complete';
  phase1Deadline?: Date;
  disputeLevel?: 'low' | 'medium' | 'high' | 'critical';
}

/**
 * 发布裁决选项
 */
export interface IssueVerdictOptions {
  verdictStatus: 'DECIDED_LEGITIMATE' | 'CONSERVATIVE_DEADLOCK_TRIGGER' | 'ESCAPE_ROUTING_TO_HUMAN' | 'PENDING';
  winningAgentSignature?: string;
  adjudicatedMetricScore: number;
  verdictType: 'CONSENSUS' | 'DEADLOCK' | 'ESCALATION' | 'SPLIT';
  verdictReason?: string;
  llmVerdictContent?: string;
  executedAction?: number;
}

/**
 * 服务层接口
 */
export interface TraceServiceInterface {
  /**
   * 创建法庭提交
   * 文档要求：createSubmission(...)
   */
  createSubmission(options: CreateSubmissionOptions): Promise<CourtSubmissionRecord>;

  /**
   * 发布裁决
   * 文档要求：issueVerdict(...)
   */
  issueVerdict(submissionId: string, options: IssueVerdictOptions): Promise<CourtVerdictRecord>;

  /**
   * 全链路查询
   * 文档要求：queryTrace(traceId)
   */
  queryTrace(traceId: string): Promise<TraceCaseFile>;

  /**
   * 记录决策
   */
  recordDecision(options: CreateDecisionOptions): Promise<DecisionRecord>;

  /**
   * 记录事件
   */
  logEvent(options: CreateEventLogOptions): Promise<EventLogRecord>;
}

// ============================================================
// 追踪服务实现
// ============================================================

export class TraceService implements TraceServiceInterface {
  private readonly decisionRepo: DecisionTraceRepository;
  private readonly submissionRepo: CourtSubmissionRepository;
  private readonly verdictRepo: CourtVerdictRepository;
  private readonly eventRepo: EventLogRepository;

  constructor(
    decisionRepo: DecisionTraceRepository,
    submissionRepo: CourtSubmissionRepository,
    verdictRepo: CourtVerdictRepository,
    eventRepo: EventLogRepository
  ) {
    this.decisionRepo = decisionRepo;
    this.submissionRepo = submissionRepo;
    this.verdictRepo = verdictRepo;
    this.eventRepo = eventRepo;
  }

  /**
   * 创建法庭提交
   * 实现幂等：使用 traceId + submittingAgentId 作为幂等键
   */
  async createSubmission(options: CreateSubmissionOptions): Promise<CourtSubmissionRecord> {
    // 1. 检查是否已存在相同的提交（幂等检查）
    const existing = await this.submissionRepo.findSubmissionsByTraceId(options.traceId);
    const duplicate = existing.find(
      s => s.submittingAgentId === options.submittingAgentId &&
           s.disputedClaimStatement === options.disputedClaimStatement
    );

    if (duplicate) {
      // 返回已有记录，实现幂等
      return duplicate;
    }

    // 2. 创建新提交
    const submission = await this.submissionRepo.createSubmission({
      ...options,
      phase: options.phase || 'phase_1',
      phase1Deadline: options.phase1Deadline || new Date(Date.now() + 30 * 60 * 1000), // 默认 30 分钟
      disputeLevel: options.disputeLevel || 'medium'
    });

    // 3. 创建追踪链路（如果不存在）
    await this.ensureTraceLinkage(options.traceId, {
      courtSubmissionId: submission.id
    });

    // 4. 记录事件
    await this.eventRepo.logEvent({
      traceId: options.traceId,
      event: 'CLAIM_SUBMITTED',
      domain: 'JudicialCourt',
      caller: 'TraceService',
      payload: {
        submissionId: submission.id,
        submittingAgentId: options.submittingAgentId
      }
    });

    return submission;
  }

  /**
   * 发布裁决
   * 实现幂等：同一 submissionId 只能发布一次裁决
   */
  async issueVerdict(submissionId: string, options: IssueVerdictOptions): Promise<CourtVerdictRecord> {
    // 1. 获取提交信息
    const submission = await this.submissionRepo.findSubmissionById(submissionId);
    if (!submission) {
      throw new Error(`CourtSubmission not found: ${submissionId}`);
    }

    // 2. 检查是否已存在裁决（幂等检查）
    const existingVerdict = await this.verdictRepo.findVerdictBySubmissionId(submissionId);
    if (existingVerdict && existingVerdict.verdictStatus !== 'PENDING') {
      // 返回已有裁决，实现幂等
      return existingVerdict;
    }

    // 3. 创建或更新裁决
    let verdict: CourtVerdictRecord;

    if (existingVerdict) {
      // 更新已有裁决
      verdict = await this.verdictRepo.issueVerdict(existingVerdict.id!, options);
    } else {
      // 创建新裁决
      verdict = await this.verdictRepo.createVerdict({
        traceId: submission.traceId,
        submissionId: submission.id!,
        participatingAgents: []
      });
      verdict = await this.verdictRepo.issueVerdict(verdict.id!, options);
    }

    // 4. 更新法庭提交状态
    await this.submissionRepo.updateSubmissionWithOptimisticLock(
      submissionId,
      submission.version,
      {
        phase: 'complete',
        winnerScore: options.adjudicatedMetricScore,
        loserScore: 0,
        escalatedToHuman: options.verdictStatus === 'ESCAPE_ROUTING_TO_HUMAN'
      }
    );

    // 5. 更新追踪链路
    await this.eventRepo.updateTraceLinkage(submission.traceId, {
      courtVerdictId: verdict.id
    });

    // 6. 记录裁决事件
    await this.eventRepo.logEvent({
      traceId: submission.traceId,
      event: options.verdictStatus === 'DECIDED_LEGITIMATE' ? 'ARBITRATION_DECIDED' : 'ESCALATION_TRIGGERED',
      domain: 'JudicialCourt',
      caller: 'TraceService',
      payload: {
        verdictId: verdict.id,
        verdictStatus: options.verdictStatus,
        winningAgentSignature: options.winningAgentSignature
      }
    });

    return verdict;
  }

  /**
   * 全链路查询
   * 文档要求：重放任一 traceId 能还原完整业务路径
   */
  async queryTrace(traceId: string): Promise<TraceCaseFile> {
    // 并行查询所有相关数据
    const [
      decisions,
      courtSubmissions,
      events,
      linkage
    ] = await Promise.all([
      this.decisionRepo.findByTraceId(traceId).catch(() => []),
      this.submissionRepo.findSubmissionsByTraceId(traceId).catch(() => []),
      this.eventRepo.findEventsByTraceId(traceId).catch(() => []),
      this.eventRepo.findTraceLinkageByTraceId(traceId).catch(() => null)
    ]);

    // 获取最新的裁决
    let courtVerdict: CourtVerdictRecord | undefined;
    if (courtSubmissions.length > 0) {
      const latestSubmission = courtSubmissions[courtSubmissions.length - 1];
      courtVerdict = await this.verdictRepo.findVerdictBySubmissionId(latestSubmission.id!).catch(() => undefined);
    }

    return {
      traceId,
      decision: decisions.length > 0 ? decisions[0] : undefined,
      courtSubmissions,
      courtVerdict,
      events,
      linkage: linkage || undefined
    };
  }

  /**
   * 记录决策
   */
  async recordDecision(options: CreateDecisionOptions): Promise<DecisionRecord> {
    // 幂等检查：同一 traceId 只记录一次决策
    const existing = await this.decisionRepo.findByTraceId(options.traceId);
    if (existing.length > 0) {
      return existing[0];
    }

    // 创建决策
    const decision = await this.decisionRepo.create(options);

    // 确保追踪链路存在
    await this.ensureTraceLinkage(options.traceId, {
      decisionId: decision.id
    });

    // 记录事件
    await this.eventRepo.logEvent({
      traceId: options.traceId,
      event: 'ROUTE_COMPLETED',
      domain: 'DecisionEngine',
      caller: 'TraceService',
      payload: {
        decisionId: decision.id,
        selectedStrategy: options.selectedStrategy
      }
    });

    return decision;
  }

  /**
   * 记录事件
   */
  async logEvent(options: CreateEventLogOptions): Promise<EventLogRecord> {
    return this.eventRepo.logEvent(options);
  }

  /**
   * 确保追踪链路存在
   */
  private async ensureTraceLinkage(
    traceId: string,
    update: Partial<CreateTraceLinkageOptions>
  ): Promise<void> {
    const existing = await this.eventRepo.findTraceLinkageByTraceId(traceId);

    if (existing) {
      // 更新现有链路
      await this.eventRepo.updateTraceLinkage(traceId, update);
    } else {
      // 创建新链路
      await this.eventRepo.createTraceLinkage({
        traceId,
        ...update
      });
    }
  }
}
