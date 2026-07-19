// ─────────────────────────────────────────────────────────────────
// SoloForge Repository Factory: 仓储层工厂
// Path: src/data/repositories/factory.ts
// Description: 创建 Repository 实例的工厂函数
// 文档要求：统一管理依赖注入
// ─────────────────────────────────────────────────────────────────

import { Surreal } from 'surrealdb';
import {
  SurrealDbRepositoryDriver,
  SurrealDecisionTraceRepository,
  SurrealCourtSubmissionRepository,
  SurrealCourtVerdictRepository,
  SurrealEventLogRepository,
  DecisionTraceRepository,
  CourtSubmissionRepository,
  CourtVerdictRepository,
  EventLogRepository,
  TraceService,
  TraceServiceInterface
} from './index';

export interface RepositoryFactory {
  decisionRepository: DecisionTraceRepository;
  courtSubmissionRepository: CourtSubmissionRepository;
  courtVerdictRepository: CourtVerdictRepository;
  eventLogRepository: EventLogRepository;
  traceService: TraceServiceInterface;
}

let factoryInstance: RepositoryFactory | null = null;

/**
 * 创建 Repository 工厂
 */
export function createRepositoryFactory(db: Surreal): RepositoryFactory {
  const driver = new SurrealDbRepositoryDriver(db);

  const decisionRepository = new SurrealDecisionTraceRepository(driver);
  const courtSubmissionRepository = new SurrealCourtSubmissionRepository(driver);
  const courtVerdictRepository = new SurrealCourtVerdictRepository(driver);
  const eventLogRepository = new SurrealEventLogRepository(driver);

  const traceService = new TraceService(
    decisionRepository,
    courtSubmissionRepository,
    courtVerdictRepository,
    eventLogRepository
  );

  return {
    decisionRepository,
    courtSubmissionRepository,
    courtVerdictRepository,
    eventLogRepository,
    traceService
  };
}

/**
 * 获取全局 Repository 工厂实例
 */
export function getRepositoryFactory(): RepositoryFactory | null {
  return factoryInstance;
}

/**
 * 设置全局 Repository 工厂实例
 */
export function setRepositoryFactory(factory: RepositoryFactory): void {
  factoryInstance = factory;
}

/**
 * 初始化 Repository 工厂
 */
export async function initializeRepositoryFactory(
  db: Surreal,
  autoInitialize: boolean = true
): Promise<RepositoryFactory> {
  if (factoryInstance) {
    return factoryInstance;
  }

  const factory = createRepositoryFactory(db);

  if (autoInitialize) {
    // 确保必要的表存在（如果通过迁移创建则跳过）
    await ensureSchema(db);
  }

  factoryInstance = factory;
  return factory;
}

/**
 * 确保基础 Schema 存在
 */
async function ensureSchema(db: Surreal): Promise<void> {
  const schemaStatements = [
    // 决策表
    `DEFINE TABLE IF NOT EXISTS decision SCHEMAFULL;`,
    `DEFINE FIELD IF NOT EXISTS traceId ON decision TYPE string;`,
    `DEFINE FIELD IF NOT EXISTS selectedStrategy ON decision TYPE string;`,
    `DEFINE FIELD IF NOT EXISTS strategyReason ON decision TYPE string;`,
    `DEFINE FIELD IF NOT EXISTS confidenceTier ON decision TYPE string;`,

    // 法庭提交表
    `DEFINE TABLE IF NOT EXISTS courtSubmission SCHEMAFULL;`,
    `DEFINE FIELD IF NOT EXISTS traceId ON courtSubmission TYPE string;`,
    `DEFINE FIELD IF NOT EXISTS phase ON courtSubmission TYPE string;`,

    // 法庭裁决表
    `DEFINE TABLE IF NOT EXISTS courtVerdict SCHEMAFULL;`,
    `DEFINE FIELD IF NOT EXISTS traceId ON courtVerdict TYPE string;`,

    // 事件日志表
    `DEFINE TABLE IF NOT EXISTS eventLog SCHEMAFULL;`,
    `DEFINE FIELD IF NOT EXISTS traceId ON eventLog TYPE string;`,

    // 追踪链路表
    `DEFINE TABLE IF NOT EXISTS traceLinkage SCHEMAFULL;`,
    `DEFINE FIELD IF NOT EXISTS traceId ON traceLinkage TYPE string;`
  ];

  for (const statement of schemaStatements) {
    try {
      await db.query(statement);
    } catch (error: any) {
      // 忽略已存在的错误
      if (!error.message?.includes('already exists')) {
        console.warn('[RepositoryFactory] Schema 初始化警告:', error.message);
      }
    }
  }
}
