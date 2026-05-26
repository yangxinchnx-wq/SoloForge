// ─────────────────────────────────────────────────────────────────
// SoloForge Storage Layer: Sovereign SurrealDB Persistence Core
// Path: src/data/surreal_persistence.ts
// ─────────────────────────────────────────────────────────────────

export interface SurrealDbDriverInterface {
  query(sqlStatement: string, queryBindings: Record<string, any>): Promise<any[][]>;
}

// ─── 📊 强类型实体记录规范对齐 ───

export interface DecisionRecord {
  id: string;
  traceId: string; // 🔗 显式全链路追踪链锚点
  selectedStrategy: string;
  strategyReason: string;
  budgetUsed: number;
  budgetLimit: number;
  confidenceTier: 'high' | 'medium' | 'low';
  subsetSize: number;
  aggregationMethod: string;
  aggregatedCandidates: string[];
  version: number;
}

export interface CourtSubmissionRecord {
  id: string;
  traceId: string; // 🔗 显式全链路追踪链锚点
  phase: 'phase_1' | 'phase_2' | 'complete';
  phase1Deadline: number;
  judgmentBasis: string;
  winnerScore: number;
  loserScore: number;
  escalatedToHuman: boolean;
  escalationReason: string;
  version: number;
}

export interface MarlEpisodeRecord {
  id: string;
  traceId: string; // 🔗 显式全链路追踪链锚点
  episodeCount: number;
  cpuMetric: number;
  memoryMetric: number;
  executedAction: number;
  version: number;
}

// 📜 对齐蓝图 §2.2 v5_events 审计规范要求新增的审计实体
export interface EventLogRecord {
  id: string;
  traceId: string;
  event: string;
  payload: string;
  timestamp: number;
}

// ─────────────────────────────────────────────────────────────────
// 🏛️ 独立仓储层实现（Repository Layer）：隔离业务与原生 SQL 字符串
// ─────────────────────────────────────────────────────────────────

/**
 * 🔍 决策追踪流仓储
 */
export class DecisionTraceRepository {
  constructor(private db: SurrealDbDriverInterface) {}

  public async save(record: Omit<DecisionRecord, 'version'>): Promise<void> {
    const queryStr = `
      CREATE type::thing('decision', $id) SET
        traceId = $traceId,
        selectedStrategy = $selectedStrategy,
        strategyReason = $strategyReason,
        budgetUsed = $budgetUsed,
        budgetLimit = $budgetLimit,
        confidenceTier = $confidenceTier,
        subsetSize = $subsetSize,
        aggregationMethod = $aggregationMethod,
        aggregatedCandidates = $aggregatedCandidates,
        version = 1,
        createdAt = time::now(),
        updatedAt = time::now();
    `;
    await this.db.query(queryStr, record);
  }

  public async findByTraceId(traceId: string): Promise<DecisionRecord[]> {
    const queryStr = `SELECT * FROM decision WHERE traceId = $traceId;`;
    const res = await this.db.query(queryStr, { traceId });
    return (res[0] || []) as DecisionRecord[];
  }
}

/**
 * ⚖️ 司法盲审裁决仓储
 */
export class CourtSubmissionRepository {
  constructor(private db: SurrealDbDriverInterface) {}

  public async save(record: Omit<CourtSubmissionRecord, 'version'>): Promise<void> {
    const queryStr = `
      CREATE type::thing('courtSubmission', $id) SET
        traceId = $traceId,
        phase = $phase,
        phase1Deadline = time::from::unix($phase1Deadline),
        judgmentBasis = $judgmentBasis,
        winnerScore = $winnerScore,
        loserScore = $loserScore,
        escalatedToHuman = $escalatedToHuman,
        escalationReason = $escalationReason,
        version = 1,
        createdAt = time::now(),
        updatedAt = time::now();
    `;
    await this.db.query(queryStr, record);
  }

  public async findByTraceId(traceId: string): Promise<CourtSubmissionRecord[]> {
    const queryStr = `SELECT * FROM courtSubmission WHERE traceId = $traceId;`;
    const res = await this.db.query(queryStr, { traceId });
    return (res[0] || []) as CourtSubmissionRecord[];
  }
}

/**
 * 🐍 MARL 分布式遥测特征流仓储
 */
export class MarlEpisodeRepository {
  constructor(private db: SurrealDbDriverInterface) {}

  public async save(record: Omit<MarlEpisodeRecord, 'version'>): Promise<void> {
    const queryStr = `
      CREATE type::thing('marlEpisode', $id) SET
        traceId = $traceId,
        episodeCount = $episodeCount,
        cpuMetric = $cpuMetric,
        memoryMetric = $memoryMetric,
        executedAction = $executedAction,
        version = 1,
        createdAt = time::now(),
        updatedAt = time::now();
    `;
    await this.db.query(queryStr, record);
  }

  public async findByTraceId(traceId: string): Promise<MarlEpisodeRecord[]> {
    const queryStr = `SELECT * FROM marlEpisode WHERE traceId = $traceId;`;
    const res = await this.db.query(queryStr, { traceId });
    return (res[0] || []) as MarlEpisodeRecord[];
  }
}

/**
 * 📜 蓝图扩展：内核审计日志仓储（v5_events）
 */
export class EventLogRepository {
  constructor(private db: SurrealDbDriverInterface) {}

  public async save(record: EventLogRecord): Promise<void> {
    const queryStr = `
      CREATE type::thing('eventLog', $id) SET
        traceId = $traceId,
        event = $event,
        payload = $payload,
        timestamp = time::from::unix($timestamp);
    `;
    await this.db.query(queryStr, record);
  }

  public async findByTraceId(traceId: string): Promise<EventLogRecord[]> {
    const queryStr = `SELECT * FROM eventLog WHERE traceId = $traceId;`;
    const res = await this.db.query(queryStr, { traceId });
    return (res[0] || []) as EventLogRecord[];
  }
}

// ─────────────────────────────────────────────────────────────────
// 💼 统一数据管理服务层（Service Layer）：串联并聚合四个独立仓储
// ─────────────────────────────────────────────────────────────────

export class GeminiPersistenceManager {
  private decisionRepo: DecisionTraceRepository;
  private courtRepo: CourtSubmissionRepository;
  private marlRepo: MarlEpisodeRepository;
  private eventRepo: EventLogRepository;

  constructor(dbDriver: SurrealDbDriverInterface) {
    // 物理实例化隔离出来的独立仓储对象
    this.decisionRepo = new DecisionTraceRepository(dbDriver);
    this.courtRepo = new CourtSubmissionRepository(dbDriver);
    this.marlRepo = new MarlEpisodeRepository(dbDriver);
    this.eventRepo = new EventLogRepository(dbDriver);
  }

  // 向上层暴露的方法直接转换为面向仓储的代理调用，隐藏原生字符串
  public async commitDecision(record: Omit<DecisionRecord, 'version'>): Promise<void> {
    await this.decisionRepo.save(record);
  }

  public async commitCourtSubmission(record: Omit<CourtSubmissionRecord, 'version'>): Promise<void> {
    await this.courtRepo.save(record);
  }

  public async logMarlEpisode(episode: Omit<MarlEpisodeRecord, 'version'>): Promise<void> {
    await this.marlRepo.save(episode);
  }

  public async logEvent(record: EventLogRecord): Promise<void> {
    await this.eventRepo.save(record);
  }

  /**
   * 🔗 蓝图硬性验收点：提供统一 trace_id 聚合查询，一键还原任意周期的全链路多维时序状态
   */
  public async queryTrace(traceId: string): Promise<{
    decisions: DecisionRecord[];
    courtSubmissions: CourtSubmissionRecord[];
    marlEpisodes: MarlEpisodeRecord[];
    events: EventLogRecord[];
  }> {
    const [decisions, courtSubmissions, marlEpisodes, events] = await Promise.all([
      this.decisionRepo.findByTraceId(traceId),
      this.courtRepo.findByTraceId(traceId),
      this.marlRepo.findByTraceId(traceId),
      this.eventRepo.findByTraceId(traceId)
    ]);

    return { decisions, courtSubmissions, marlEpisodes, events };
  }
}