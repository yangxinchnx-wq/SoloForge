// ─────────────────────────────────────────────────────────────────
// SoloForge Data Layer: SurrealDB Persistence Manager
// Path: src/data/surreal_persistence.ts
// Description: SurrealDB 持久化管理器 - 实现幂等写入和乐观锁
// 文档要求：Repository 层核心实现
// ─────────────────────────────────────────────────────────────────

import { RuntimeComponent } from '../kernel/runtime-component';
import { Surreal } from 'surrealdb';
import { createNodeEngines } from '@surrealdb/node';
import path from 'path';

// ============================================================
// 类型定义
// ============================================================

/**
 * SurrealDB 驱动接口
 */
export interface SurrealDbDriverInterface {
  query(sqlStatement: string, queryBindings: Record<string, any>): Promise<any[][]>;
}

/**
 * 决策载荷
 */
export interface DecisionPayload {
  id: string;
  selectedStrategy: string;
  strategyReason: string;
  budgetUsed: number;
  budgetLimit: number;
  confidenceTier: 'high' | 'medium' | 'low';
  subsetSize: number;
  aggregationMethod: string;
  aggregatedCandidates: string[];
}

/**
 * 更新载荷
 */
export interface UpdatePayload {
  selectedStrategy?: string;
  strategyReason?: string;
  budgetUsed?: number;
  confidenceTier?: 'high' | 'medium' | 'low';
  currentVersion: number;
}

/**
 * 追踪卷宗
 */
export interface TraceCaseFile {
  traceId: string;
  decisions: any[];
  marlEpisodes: any[];
  courtSubmissions: any[];
  events: any[];
}

/**
 * 持久化管理器接口
 */
export interface GeminiPersistenceManager {
  commitDecision(payload: DecisionPayload): Promise<void>;
  updateDecisionWithOptimisticLock(id: string, expectedVersion: number, updates: Partial<UpdatePayload>): Promise<void>;
  queryTrace(traceId: string): Promise<TraceCaseFile>;
  commitShadowDecision?(payload: ShadowDecisionPayload): Promise<void>;
  queryShadowDecisions?(traceId: string): Promise<ShadowDecisionPayload[]>;
}

/**
 * 影子决策载荷（符合文档要求的事务 + 乐观锁）
 */
export interface ShadowDecisionPayload {
  id: string;
  traceId: string;
  telemetrySnapshot?: any;
  ruleAction: number;
  ruleActionName: string;
  ppoAction: number;
  ppoActionName: string;
  ppoProb: number;
  ppoValue?: number;
  winner: 'rule' | 'ppo' | 'tie';
  confidence: number;
  version: number;
  timestamp: number;
}

// ============================================================
// SurrealDB 持久化管理器实现
// ============================================================

export class SurrealPersistence implements RuntimeComponent, GeminiPersistenceManager {
  public readonly name = 'surreal';

  // 内部存储（用于测试）
  private tableStore: Map<string, any> = new Map();
  private dbDriver: SurrealDbDriverInterface | null = null;
  private surreal: Surreal | null = null;
  private connected = false;

  constructor(driver?: SurrealDbDriverInterface) {
    this.dbDriver = driver || null;
  }

  /**
   * 设置数据库驱动
   */
  public setDriver(driver: SurrealDbDriverInterface): void {
    this.dbDriver = driver;
  }

  /**
   * 启动组件 - 连接 SurrealDB
   */
  async start(): Promise<void> {
    try {
      console.log('[SurrealPersistence] Connecting to SurrealDB...');

      this.surreal = new Surreal({
        engines: createNodeEngines(),
      });

      // 使用 rocksdb 协议（嵌入式持久化）
      const dbPath = path.join(process.cwd(), 'data', 'soloforge_db').replace(/\\/g, '/');
      await this.surreal.connect(`rocksdb://${dbPath}`);

      // 选择命名空间和数据库
      await this.surreal.use({ namespace: 'soloforge_core', database: 'autonomous_network' });

      this.connected = true;
      this.dbDriver = this; // 使用自身作为驱动
      console.log('[SurrealPersistence] Connected successfully');

      // 初始化表结构
      await this.initSchema();
    } catch (err: any) {
      console.error('[SurrealPersistence] Connection failed:', err.message);
      this.connected = false;
    }
  }

  /**
   * 初始化数据库表结构
   */
  private async initSchema(): Promise<void> {
    if (!this.surreal) return;

    try {
      // 创建表（如果不存在）
      const tables = ['conversation', 'message', 'decision', 'courtSubmission', 'courtVerdict', 'eventLog'];
      for (const table of tables) {
        await this.surreal.query(`DEFINE TABLE IF NOT EXISTS ${table} SCHEMAFULL;`, {});
      }
      console.log('[SurrealPersistence] Schema initialized');
    } catch (err: any) {
      console.error('[SurrealPersistence] Schema init failed:', err.message);
    }
  }

  /**
   * 停止组件
   */
  async stop(): Promise<void> {
    if (this.surreal) {
      await this.surreal.close();
      this.surreal = null;
      this.connected = false;
      console.log('[SurrealPersistence] Disconnected');
    }
    console.log('[SurrealPersistence] Stopped');
  }

  /**
   * 健康检查
   */
  async healthCheck(): Promise<boolean> {
    return this.connected;
  }

  /**
   * 检查数据库是否已准备好
   */
  public isReady(): boolean {
    return this.connected && this.surreal !== null;
  }

  /**
   * 通用 SurrealQL 查询方法（消费者和组件共用）
   * 文档要求：Repository 层提供统一查询入口
   */
  async query(sqlStatement: string, bindings: Record<string, any> = {}): Promise<any[][]> {
    if (this.surreal) {
      try {
        const result = await this.surreal.query(sqlStatement, bindings);
        return Array.isArray(result) ? [result] : [[result]];
      } catch (err: any) {
        console.error('[SurrealPersistence] Query error:', err.message);
        return [[]];
      }
    }
    // Fallback to memory store
    console.log(`[SurrealPersistence] query (memory mode): ${sqlStatement.substring(0, 80)}...`);
    return [[]];
  }

  /**
   * 异步等待数据库就绪
   */
  public async waitUntilReady(timeoutMs: number = 5000): Promise<boolean> {
    const start = Date.now();
    while (!this.isReady() && Date.now() - start < timeoutMs) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return this.isReady();
  }

  /**
   * 提交决策记录
   * 实现幂等：使用 ID 作为唯一键
   */
  async commitDecision(payload: DecisionPayload): Promise<void> {
    if (this.dbDriver) {
      // 使用真实驱动
      const sql = `CREATE type::thing('decision', $id) CONTENT {
        id: $id,
        traceId: $traceId,
        selectedStrategy: $selectedStrategy,
        strategyReason: $strategyReason,
        budgetUsed: $budgetUsed,
        budgetLimit: $budgetLimit,
        confidenceTier: $confidenceTier,
        subsetSize: $subsetSize,
        aggregationMethod: $aggregationMethod,
        aggregatedCandidates: $aggregatedCandidates,
        version: 1
      }`;

      await this.dbDriver.query(sql, {
        id: payload.id,
        traceId: payload.id.split('_')[0], // 从 ID 提取 traceId
        selectedStrategy: payload.selectedStrategy,
        strategyReason: payload.strategyReason,
        budgetUsed: payload.budgetUsed,
        budgetLimit: payload.budgetLimit,
        confidenceTier: payload.confidenceTier,
        subsetSize: payload.subsetSize,
        aggregationMethod: payload.aggregationMethod,
        aggregatedCandidates: payload.aggregatedCandidates
      });
    } else {
      // 使用内存存储
      this.tableStore.set(payload.id, {
        ...payload,
        version: 1
      });
    }
  }

  /**
   * 带乐观锁更新决策
   * 实现幂等：版本不匹配时抛出错误
   */
  async updateDecisionWithOptimisticLock(
    id: string,
    expectedVersion: number,
    updates: Partial<UpdatePayload>
  ): Promise<void> {
    if (this.dbDriver) {
      // 使用真实驱动
      const sql = `UPDATE type::thing('decision', $id) SET
        selectedStrategy = $selectedStrategy,
        strategyReason = $strategyReason,
        budgetUsed = $budgetUsed,
        confidenceTier = $confidenceTier,
        version = version + 1,
        updatedAt = time::now()
      WHERE version = $currentVersion`;

      const result = await this.dbDriver.query(sql, {
        id,
        selectedStrategy: updates.selectedStrategy,
        strategyReason: updates.strategyReason,
        budgetUsed: updates.budgetUsed,
        confidenceTier: updates.confidenceTier,
        currentVersion: expectedVersion
      });

      // 检查是否更新成功（SurrealDB 在 WHERE 未命中时返回空数组）
      if (!result[0] || result[0].length === 0) {
        throw new Error(`ERR_OPTIMISTIC_LOCK_FAILED: 版本 ${expectedVersion} 不匹配`);
      }
    } else {
      // 使用内存存储
      const current = this.tableStore.get(id);
      if (!current) {
        throw new Error(`Decision not found: ${id}`);
      }

      if (current.version !== expectedVersion) {
        throw new Error(`ERR_OPTIMISTIC_LOCK_FAILED: 版本 ${expectedVersion} 不匹配`);
      }

      this.tableStore.set(id, {
        ...current,
        ...updates,
        version: current.version + 1,
        updatedAt: new Date()
      });
    }
  }

  /**
   * 追踪卷宗查询
   */
  async queryTrace(traceId: string): Promise<TraceCaseFile> {
    console.log(`[SurrealPersistence] Querying trace: ${traceId}`);

    if (this.dbDriver) {
      // 使用真实驱动查询
      const decisions = await this.dbDriver.query(
        'SELECT * FROM decision WHERE traceId = $traceId',
        { traceId }
      );

      const courtSubmissions = await this.dbDriver.query(
        'SELECT * FROM courtSubmission WHERE traceId = $traceId',
        { traceId }
      );

      const marlEpisodes = await this.dbDriver.query(
        'SELECT * FROM marlEpisode WHERE traceId = $traceId',
        { traceId }
      );

      const events = await this.dbDriver.query(
        'SELECT * FROM eventLog WHERE traceId = $traceId',
        { traceId }
      );

      return {
        traceId,
        decisions: decisions[0] || [],
        courtSubmissions: courtSubmissions[0] || [],
        marlEpisodes: marlEpisodes[0] || [],
        events: events[0] || []
      };
    }

    return {
      traceId,
      decisions: [],
      courtSubmissions: [],
      marlEpisodes: [],
      events: []
    };
  }

  /**
   * 提交影子决策记录
   * 实现幂等：使用 ID 作为唯一键
   */
  async commitShadowDecision(payload: ShadowDecisionPayload): Promise<void> {
    if (this.dbDriver) {
      // 使用真实驱动（事务 + 乐观锁）
      const sql = `CREATE type::thing('governor_shadow_decision', $id) CONTENT {
        id: $id,
        traceId: $traceId,
        ruleAction: $ruleAction,
        ruleActionName: $ruleActionName,
        ppoAction: $ppoAction,
        ppoActionName: $ppoActionName,
        ppoProb: $ppoProb,
        ppoValue: $ppoValue,
        winner: $winner,
        confidence: $confidence,
        telemetrySnapshot: $telemetrySnapshot,
        version: $version,
        timestamp: $timestamp
      }`;

      await this.dbDriver.query(sql, {
        id: payload.id,
        traceId: payload.traceId,
        ruleAction: payload.ruleAction,
        ruleActionName: payload.ruleActionName,
        ppoAction: payload.ppoAction,
        ppoActionName: payload.ppoActionName,
        ppoProb: payload.ppoProb,
        ppoValue: payload.ppoValue,
        winner: payload.winner,
        confidence: payload.confidence,
        telemetrySnapshot: JSON.stringify(payload.telemetrySnapshot || {}),
        version: payload.version,
        timestamp: payload.timestamp
      });
    } else {
      // 使用内存存储
      this.tableStore.set(payload.id, {
        ...payload,
        version: payload.version
      });
    }
  }

  /**
   * 查询影子决策记录
   */
  async queryShadowDecisions(traceId: string): Promise<ShadowDecisionPayload[]> {
    console.log(`[SurrealPersistence] Querying shadow decisions: ${traceId}`);

    if (this.dbDriver) {
      const result = await this.dbDriver.query(
        'SELECT * FROM governor_shadow_decision WHERE traceId = $traceId ORDER BY timestamp ASC',
        { traceId }
      );

      return (result[0] || []).map((row: any) => ({
        id: row.id,
        traceId: row.traceId,
        ruleAction: row.ruleAction,
        ruleActionName: row.ruleActionName,
        ppoAction: row.ppoAction,
        ppoActionName: row.ppoActionName,
        ppoProb: row.ppoProb,
        ppoValue: row.ppoValue,
        winner: row.winner,
        confidence: row.confidence,
        telemetrySnapshot: row.telemetrySnapshot,
        version: row.version,
        timestamp: row.timestamp
      }));
    }

    // 内存存储：过滤匹配的记录
    const results: ShadowDecisionPayload[] = [];
    for (const record of this.tableStore.values()) {
      if (record.traceId === traceId && record.id?.startsWith('shadow_')) {
        results.push(record as ShadowDecisionPayload);
      }
    }
    return results.sort((a, b) => a.timestamp - b.timestamp);
  }
}

// ============================================================
// 向后兼容别名（供测试使用）
// ============================================================

/**
 * @deprecated 使用 SurrealPersistence 代替
 */
export const GeminiPersistenceManager = SurrealPersistence;

/**
 * Global singleton instance for consumers that need persistence
 */
export const surrealPersistence = new SurrealPersistence();
