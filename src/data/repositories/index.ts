// ─────────────────────────────────────────────────────────────────
// SoloForge Repository Layer: 仓储层索引文件
// Path: src/data/repositories/index.ts
// Description: 统一导出所有 Repository 接口和实现
// 文档要求：屏蔽业务层直连 SQL/SurrealQL
// ─────────────────────────────────────────────────────────────────

// Repository 接口
export type {
  DecisionRecord,
  CandidateRecord,
  ConfidenceTier,
  DecisionType,
  AggregationMethod,
  ReasoningStrategy,
  EntityType,
  CreateDecisionOptions,
  UpdateDecisionOptions,
  DecisionTraceRepository,
  SurrealDbDriver
} from './decision-repository';

export type {
  CourtSubmissionRecord,
  EvidenceRecord,
  CourtPhase,
  DisputeLevel,
  EvidenceType,
  EvidenceStatus,
  CreateSubmissionOptions,
  UpdateSubmissionOptions,
  CreateEvidenceOptions,
  CourtSubmissionRepository
} from './court-submission-repository';

export type {
  CourtVerdictRecord,
  CourtJurorRecord,
  VerdictStatus,
  VerdictType,
  JurorType,
  JurorStatus,
  CreateVerdictOptions,
  IssueVerdictOptions,
  CreateJurorOptions,
  CourtVerdictRepository
} from './court-verdict-repository';

export type {
  EventLogRecord,
  TraceLinkageRecord,
  EventStatus,
  EventType,
  CreateEventLogOptions,
  CreateTraceLinkageOptions,
  EventLogRepository
} from './event-log-repository';

// 服务层
export { TraceService } from './trace-service';
export type { TraceCaseFile, TraceServiceInterface } from './trace-service';

// SurrealDB 实现
export {
  SurrealDbRepositoryDriver,
  SurrealDecisionTraceRepository,
  SurrealCourtSubmissionRepository,
  SurrealCourtVerdictRepository,
  SurrealEventLogRepository
} from './surreal-repositories';

// 数据归档服务
export { DataArchiverService, dataArchiver } from '../data-archiver';
export type { ArchiveMeta, DataRecord, ArchiveStats } from '../data-archiver';
