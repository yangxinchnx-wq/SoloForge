// ─────────────────────────────────────────────────────────────────
// SoloForge Repository Layer: EventLogRepository
// Path: src/data/repositories/event-log-repository.ts
// Description: 事件审计日志仓储 - 内核事件审计链路
// 文档要求：
//   - 幂等写入策略
//   - 按 trace_id 查询
//   - 完整审计追溯
// ─────────────────────────────────────────────────────────────────

// ============================================================
// 类型定义
// ============================================================

/**
 * 事件状态枚举
 */
export type EventStatus = 'pending' | 'processed' | 'failed' | 'ignored';

/**
 * 事件类型枚举（来自决策事件）
 */
export type DecisionEventType =
  | 'ROUTE_REQUESTED'
  | 'CONFIDENCE_CALCULATED'
  | 'ROUTE_COMPLETED'
  | 'VOTE_TRIGGERED'
  | 'ADAPTIVE_PENALTY_APPLIED';

/**
 * 事件类型枚举（来自法庭事件）
 */
export type CourtEventType =
  | 'EVIDENCE_EVALUATED'
  | 'CLAIM_SUBMITTED'
  | 'DEADLOCK_DETECTED'
  | 'ARBITRATION_DECIDED'
  | 'ESCALATION_TRIGGERED';

/**
 * 事件类型枚举（来自运行时事件）
 */
export type RuntimeEventType =
  | 'sys.heartbeat'
  | 'sys.startup'
  | 'sys.shutdown'
  | 'sys.recovery'
  | 'sys.error';

/**
 * 全局事件类型
 */
export type EventType = DecisionEventType | CourtEventType | RuntimeEventType | string;

/**
 * 事件日志记录
 */
export interface EventLogRecord {
  id?: string;
  traceId: string;
  event: EventType;
  domain: string;
  source?: string;
  caller: string;
  payload: string;
  status: EventStatus;
  errorMessage?: string;
  processingLatencyMs?: number;
  version: number;
  timestamp: Date;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * 追踪链路记录
 */
export interface TraceLinkageRecord {
  id?: string;
  traceId: string;
  decisionId?: string;
  courtSubmissionId?: string;
  courtVerdictId?: string;
  marlEpisodeId?: string;
  startEventId?: string;
  endEventId?: string;
  status: 'IN_PROGRESS' | 'COMPLETED' | 'FAILED' | 'ROLLED_BACK';
  completedAt?: Date;
  totalDurationMs?: number;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * 创建事件日志选项
 */
export interface CreateEventLogOptions {
  traceId: string;
  event: EventType;
  domain: string;
  source?: string;
  caller: string;
  payload: Record<string, unknown>;
  status?: EventStatus;
}

/**
 * 创建追踪链路选项
 */
export interface CreateTraceLinkageOptions {
  traceId: string;
  decisionId?: string;
  courtSubmissionId?: string;
  courtVerdictId?: string;
  marlEpisodeId?: string;
}

/**
 * Repository 接口
 */
export interface EventLogRepository {
  /**
   * 记录事件（幂等）
   */
  logEvent(options: CreateEventLogOptions): Promise<EventLogRecord>;

  /**
   * 按 ID 查询事件
   */
  findEventById(id: string): Promise<EventLogRecord | null>;

  /**
   * 按 traceId 查询所有事件
   */
  findEventsByTraceId(traceId: string): Promise<EventLogRecord[]>;

  /**
   * 查询事件（带分页）
   */
  findEvents(limit?: number, offset?: number): Promise<EventLogRecord[]>;

  /**
   * 按事件类型查询
   */
  findEventsByType(eventType: EventType, limit?: number): Promise<EventLogRecord[]>;

  /**
   * 创建追踪链路
   */
  createTraceLinkage(options: CreateTraceLinkageOptions): Promise<TraceLinkageRecord>;

  /**
   * 按 traceId 查询追踪链路
   */
  findTraceLinkageByTraceId(traceId: string): Promise<TraceLinkageRecord | null>;

  /**
   * 更新追踪链路
   */
  updateTraceLinkage(traceId: string, options: Partial<CreateTraceLinkageOptions & { status: string; completedAt: Date; totalDurationMs: number }>): Promise<TraceLinkageRecord>;

  /**
   * 完成追踪链路
   */
  completeTraceLinkage(traceId: string): Promise<TraceLinkageRecord>;

  /**
   * 标记追踪链路失败
   */
  failTraceLinkage(traceId: string, errorMessage?: string): Promise<TraceLinkageRecord>;
}
