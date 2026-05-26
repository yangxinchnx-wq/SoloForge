// ─────────────────────────────────────────────────────────────────
// SoloForge Storage Driver: Official Client Interface Wrapper
// Path: src/data/surreal_driver_live.ts
// ─────────────────────────────────────────────────────────────────

import { Surreal } from 'surrealdb';
import { SurrealDbDriverInterface } from './surreal_persistence';

/**
 * ⚡ 适配桥接层：将官方 Surreal 驱动方法物理对齐底座的强类型查询签名
 */
export class SurrealLiveWebSocketDriver implements SurrealDbDriverInterface {
  private client: Surreal;

  constructor(clientInstance: Surreal) {
    this.client = clientInstance;
  }

  // 精准映射并转发底座持久化引擎所下达的 SQL 动作
  public async query(sqlStatement: string, queryBindings: Record<string, any>): Promise<any[][]> {
    try {
      return await this.client.query(sqlStatement, queryBindings) as any[][];
    } catch (err) {
      throw new Error(`DB_PHYSICAL_FORWARD_ERROR: ${(err as Error).message}`);
    }
  }
}