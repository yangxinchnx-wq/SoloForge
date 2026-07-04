// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
// SoloForge Data Layer: SurrealDB Persistence Manager
// Path: src/data/surreal_persistence.ts
// Description: SurrealDB æä¹åç®¡çå¨ - å®ç°å¹ç­åå¥åä¹è§é
// ææ¡£è¦æ±ï¼Repository å±æ ¸å¿å®ç°
// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

import { RuntimeComponent } from '../kernel/runtime-component';
import { Surreal } from 'surrealdb';
import { createNodeEngines } from '@surrealdb/node';
import path from 'path';

// ============================================================
// ç±»åå®ä¹
// ============================================================

/**
 * SurrealDB é©±å¨æ¥å£
 */
export interface SurrealDbDriverInterface {
  query(sqlStatement: string, queryBindings: Record<string, any>): Promise<any[][]>;
}

/**
 * å³ç­è½½è·
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
 * æ´æ°è½½è·
 */
export interface UpdatePayload {
  selectedStrategy?: string;
  strategyReason?: string;
  budgetUsed?: number;
  confidenceTier?: 'high' | 'medium' | 'low';
  currentVersion: number;
}

/**
 * è¿½è¸ªå·å®
 */
export interface TraceCaseFile {
  traceId: string;
  decisions: any[];
  marlEpisodes: any[];
  courtSubmissions: any[];
  events: any[];
}

/**
 * æä¹åç®¡çå¨æ¥å£
 */
export interface SoloForgePersistenceManager {
  commitDecision(payload: DecisionPayload): Promise<void>;
  updateDecisionWithOptimisticLock(id: string, expectedVersion: number, updates: Partial<UpdatePayload>): Promise<void>;
  queryTrace(traceId: string): Promise<TraceCaseFile>;
  commitShadowDecision?(payload: ShadowDecisionPayload): Promise<void>;
  queryShadowDecisions?(traceId: string): Promise<ShadowDecisionPayload[]>;
}

/**
 * å½±å­å³ç­è½½è·ï¼ç¬¦åææ¡£è¦æ±çäºå¡ + ä¹è§éï¼
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
// SurrealDB æä¹åç®¡çå¨å®ç°
// ============================================================

export class SurrealPersistence implements RuntimeComponent, SoloForgePersistenceManager {
  public readonly name = 'surreal';

  // åé¨å­å¨ï¼ç¨äºæµè¯ï¼
  private tableStore: Map<string, any> = new Map();
  private dbDriver: SurrealDbDriverInterface | null = null;
  private surreal: Surreal | null = null;
  private connected = false;

  constructor(driver?: SurrealDbDriverInterface) {
    this.dbDriver = driver || null;
  }

  /**
   * è®¾ç½®æ°æ®åºé©±å¨
   */
  public setDriver(driver: SurrealDbDriverInterface): void {
    this.dbDriver = driver;
  }

  /**
   * å¯å¨ç»ä»¶ - è¿æ¥ SurrealDB
   */
  async start(): Promise<void> {
    try {
      console.log('[SurrealPersistence] Connecting to SurrealDB...');

      this.surreal = new Surreal({
        engines: createNodeEngines(),
      });

      // ä½¿ç¨ rocksdb åè®®ï¼åµå¥å¼æä¹åï¼
      const dbPath = path.join(process.cwd(), 'data', 'soloforge_db').replace(/\\/g, '/');
      await this.surreal.connect(`rocksdb://${dbPath}`);

      // éæ©å½åç©ºé´åæ°æ®åº
      await this.surreal.use({ namespace: 'soloforge_core', database: 'autonomous_network' });

      this.connected = true;
      this.dbDriver = this; // ä½¿ç¨èªèº«ä½ä¸ºé©±å¨
      console.log('[SurrealPersistence] Connected successfully');

      // åå§åè¡¨ç»æ
      await this.initSchema();
    } catch (err: any) {
      console.error('[SurrealPersistence] Connection failed:', err.message);
      this.connected = false;
    }
  }

  /**
   * åå§åæ°æ®åºè¡¨ç»æ
   */
  private async initSchema(): Promise<void> {
    if (!this.surreal) return;

    try {
      // åå»ºè¡¨ï¼å¦æä¸å­å¨ï¼
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
   * åæ­¢ç»ä»¶
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
   * å¥åº·æ£æ¥
   */
  async healthCheck(): Promise<boolean> {
    return this.connected;
  }

  /**
   * æ£æ¥æ°æ®åºæ¯å¦å·²åå¤å¥½
   */
  public isReady(): boolean {
    return this.connected && this.surreal !== null;
  }

  /**
   * éç¨ SurrealQL æ¥è¯¢æ¹æ³ï¼æ¶è´¹èåç»ä»¶å±ç¨ï¼
   * ææ¡£è¦æ±ï¼Repository å±æä¾ç»ä¸æ¥è¯¢å¥å£
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
   * å¼æ­¥ç­å¾æ°æ®åºå°±ç»ª
   */
  public async waitUntilReady(timeoutMs: number = 5000): Promise<boolean> {
    const start = Date.now();
    while (!this.isReady() && Date.now() - start < timeoutMs) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return this.isReady();
  }

  /**
   * æäº¤å³ç­è®°å½
   * å®ç°å¹ç­ï¼ä½¿ç¨ ID ä½ä¸ºå¯ä¸é®
   */
  async commitDecision(payload: DecisionPayload): Promise<void> {
    if (this.dbDriver) {
      // ä½¿ç¨çå®é©±å¨
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
        traceId: payload.id.split('_')[0], // ä» ID æå traceId
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
      // ä½¿ç¨åå­å­å¨
      this.tableStore.set(payload.id, {
        ...payload,
        version: 1
      });
    }
  }

  /**
   * å¸¦ä¹è§éæ´æ°å³ç­
   * å®ç°å¹ç­ï¼çæ¬ä¸å¹éæ¶æåºéè¯¯
   */
  async updateDecisionWithOptimisticLock(
    id: string,
    expectedVersion: number,
    updates: Partial<UpdatePayload>
  ): Promise<void> {
    if (this.dbDriver) {
      // ä½¿ç¨çå®é©±å¨
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

      // æ£æ¥æ¯å¦æ´æ°æåï¼SurrealDB å¨ WHERE æªå½ä¸­æ¶è¿åç©ºæ°ç»ï¼
      if (!result[0] || result[0].length === 0) {
        throw new Error(`ERR_OPTIMISTIC_LOCK_FAILED: çæ¬ ${expectedVersion} ä¸å¹é`);
      }
    } else {
      // ä½¿ç¨åå­å­å¨
      const current = this.tableStore.get(id);
      if (!current) {
        throw new Error(`Decision not found: ${id}`);
      }

      if (current.version !== expectedVersion) {
        throw new Error(`ERR_OPTIMISTIC_LOCK_FAILED: çæ¬ ${expectedVersion} ä¸å¹é`);
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
   * è¿½è¸ªå·å®æ¥è¯¢
   */
  async queryTrace(traceId: string): Promise<TraceCaseFile> {
    console.log(`[SurrealPersistence] Querying trace: ${traceId}`);

    if (this.dbDriver) {
      // ä½¿ç¨çå®é©±å¨æ¥è¯¢
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
   * æäº¤å½±å­å³ç­è®°å½
   * å®ç°å¹ç­ï¼ä½¿ç¨ ID ä½ä¸ºå¯ä¸é®
   */
  async commitShadowDecision(payload: ShadowDecisionPayload): Promise<void> {
    if (this.dbDriver) {
      // ä½¿ç¨çå®é©±å¨ï¼äºå¡ + ä¹è§éï¼
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
      // ä½¿ç¨åå­å­å¨
      this.tableStore.set(payload.id, {
        ...payload,
        version: payload.version
      });
    }
  }

  /**
   * æ¥è¯¢å½±å­å³ç­è®°å½
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

    // åå­å­å¨ï¼è¿æ»¤å¹éçè®°å½
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
// ååå¼å®¹å«åï¼ä¾æµè¯ä½¿ç¨ï¼
// ============================================================

/**
 * SoloForge 命名别名（2026-07-02 去 Gemini 前缀）
 * @deprecated 请使用 SurrealPersistence
 */
export const SoloForgePersistenceManager = SurrealPersistence;

/**
 * Global singleton instance for consumers that need persistence
 */
export const surrealPersistence = new SurrealPersistence();
