// ─────────────────────────────────────────────────────────────────
// SoloForge Data Layer: SurrealDB Portable Repository Base
// Path: src/data/surreal_persistence.ts
// ─────────────────────────────────────────────────────────────────

/**
 * 🔌 仓储层上层抽象驱动契约接口
 */
export interface SurrealDbDriverInterface {
  query(sqlStatement: string, queryBindings: Record<string, any>): Promise<any[][]>;
}

/**
 * 💾 SoloForge 骨干网一站式中心仓储管理器（Repository Core）
 */
export class GeminiPersistenceManager {
  private driver: SurrealDbDriverInterface;

  constructor(driver: SurrealDbDriverInterface) {
    this.driver = driver;
  }

  /**
   * 🐍 轨迹表持久化：记录 MARL 遥测特征流
   */
  public async logMarlEpisode(data: {
    id: string;
    traceId: string;
    episodeCount: number;
    cpuMetric: number;
    memoryMetric: number;
    executedAction: number;
  }): Promise<void> {
    const sql = `
      CREATE type::record('marlEpisode', $id) SET 
        traceId = $traceId, 
        episodeCount = $episodeCount, 
        cpuMetric = $cpuMetric, 
        memoryMetric = $memoryMetric, 
        executedAction = $executedAction,
        version = 1,
        createdAt = time::now(),
        updatedAt = time::now();
    `;
    await this.driver.query(sql, data);
  }

  /**
   * 📜 审计表持久化：记录 eventLog 内核审计日志
   */
  public async logEvent(data: {
    id: string;
    traceId: string;
    event: string;
    payload: string;
    timestamp: number;
  }): Promise<void> {
    // 🛡️ 精准对齐 eventLog 专属轻量约束：没有 createdAt/updatedAt，只保留标准 timestamp 转换
    const sql = `
      CREATE type::record('eventLog', $id) SET 
        traceId = $traceId, 
        event = $event, 
        payload = $payload, 
        timestamp = time::from_unix($timestamp);
    `;
    await this.driver.query(sql, data);
  }

  /**
   * 🎯 决策表持久化：记录 RACER 引擎动态竞价流控细节
   */
  public async commitDecision(data: {
    id: string;
    traceId: string;
    selectedStrategy: string;
    strategyReason: string;
    budgetUsed: number;
    budgetLimit: number;
    confidenceTier: string;
    subsetSize: number;
    aggregationMethod: string;
    aggregatedCandidates: string[];
  }): Promise<void> {
    const sql = `
      CREATE type::record('decision', $id) SET 
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
    await this.driver.query(sql, data);
  }

  /**
   * ⚖️ 司法表持久化：记录一审盲审与大模型终审决议卷宗
   */
  public async commitCourtSubmission(data: {
    id: string;
    traceId: string;
    phase: 'complete' | 'phase_1';
    phase1Deadline: number;
    judgmentBasis: string;
    winnerScore: number;
    loserScore: number;
    escalatedToHuman: boolean;
    escalationReason: string;
  }): Promise<void> {
    const sql = `
      CREATE type::record('courtSubmission', $id) SET 
        traceId = $traceId, 
        phase = $phase, 
        phase1Deadline = time::from_unix($phase1Deadline),
        judgmentBasis = $judgmentBasis, 
        winnerScore = $winnerScore, 
        loserScore = $loserScore, 
        escalatedToHuman = $escalatedToHuman, 
        escalationReason = $escalationReason,
        version = 1,
        createdAt = time::now(),
        updatedAt = time::now();
    `;
    await this.driver.query(sql, data);
  }

  /**
   * 🔍 完备追溯硬指标：跨表一键抽干物理硬盘，还原完备的多维时序卷宗
   */
  public async queryTrace(traceId: string): Promise<{
    marlEpisodes: any[];
    decisions: any[];
    courtSubmissions: any[];
    events: any[];
  }> {
    const sql = `
      SELECT * FROM marlEpisode WHERE traceId = $traceId;
      SELECT * FROM decision WHERE traceId = $traceId;
      SELECT * FROM courtSubmission WHERE traceId = $traceId;
      SELECT * FROM eventLog WHERE traceId = $traceId;
    `;
    
    const rawResult = await this.driver.query(sql, { traceId });
    
    return {
      marlEpisodes: rawResult[0] || [],
      decisions: rawResult[1] || [],
      courtSubmissions: rawResult[2] || [],
      events: rawResult[3] || []
    };
  }
}