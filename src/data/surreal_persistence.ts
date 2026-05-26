// ─────────────────────────────────────────────────────────────────
// SoloForge Storage Layer: Sovereign SurrealDB Persistence Core
// Path: src/data/surreal_persistence.ts
// ─────────────────────────────────────────────────────────────────

export interface SurrealDbDriverInterface {
  query(sqlStatement: string, queryBindings: Record<string, any>): Promise<any[][]>;
}

export interface DecisionRecord {
  id: string;
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
  episodeCount: number;
  cpuMetric: number;
  memoryMetric: number;
  executedAction: number;
  version: number;
}

export class GeminiPersistenceManager {
  private db: SurrealDbDriverInterface;

  constructor(dbDriver: SurrealDbDriverInterface) {
    this.db = dbDriver;
  }

  /**
   * ✅ 决策记录初始化落盘（对齐 DDL SCHEMAFULL 约束）
   */
  public async commitDecision(record: Omit<DecisionRecord, 'version'>): Promise<void> {
    const queryStr = `
      CREATE type::thing('decision', $id) SET
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
    try {
      await this.db.query(queryStr, record);
    } catch (error) {
      throw new Error(`ERR_STORAGE_VIOLATION: Decision commit broken. ${(error as Error).message}`);
    }
  }

  /**
   * ✅ 宪法级防御：高并发状态更新乐观锁（防止智能体时序覆盖）
   */
  public async updateDecisionWithOptimisticLock(
    id: string, 
    currentVersion: number, 
    updates: Partial<Omit<DecisionRecord, 'id' | 'version'>>
  ): Promise<void> {
    const setClauses = Object.keys(updates)
      .map(key => `${key} = $${key}`)
      .join(', ');

    const queryStr = `
      UPDATE type::thing('decision', $id) SET
        ${setClauses},
        version = version + 1,
        updatedAt = time::now()
      WHERE version = $currentVersion;
    `;

    const bindings = { id, currentVersion, ...updates };
    const queryOutput = await this.db.query(queryStr, bindings);
    
    const updatedRecordSet = queryOutput[0];
    if (!updatedRecordSet || updatedRecordSet.length === 0) {
      throw new Error(`ERR_OPTIMISTIC_LOCK_FAILED: Record [decision:${id}] modification aborted. Stale version identifier detected.`);
    }
  }

  /**
   * ✅ 司法盲审决议记录归档
   */
  public async commitCourtSubmission(record: Omit<CourtSubmissionRecord, 'version'>): Promise<void> {
    const queryStr = `
      CREATE type::thing('courtSubmission', $id) SET
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

  /**
   * ✅ MAPPO 控流遥测特征流高速落盘
   */
  public async logMarlEpisode(episode: Omit<MarlEpisodeRecord, 'version'>): Promise<void> {
    const queryStr = `
      CREATE type::thing('marlEpisode', $id) SET
        episodeCount = $episodeCount,
        cpuMetric = $cpuMetric,
        memoryMetric = $memoryMetric,
        executedAction = $executedAction,
        version = 1,
        createdAt = time::now(),
        updatedAt = time::now();
    `;
    await this.db.query(queryStr, episode);
  }
}