// ─────────────────────────────────────────────────────────────────
// SoloForge Acceptance Test Harness: Database Persistence Engine
// Path: tests/integration/surreal-persistence.test.ts
// ─────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest';
import { GeminiPersistenceManager, SurrealDbDriverInterface } from '../../src/data/surreal_persistence';

class MockSurrealLiveDriver implements SurrealDbDriverInterface {
  public memoryStore: Map<string, any> = new Map();

  public async query(sqlStatement: string, queryBindings: Record<string, any>): Promise<any[][]> {
    const cleanSql = sqlStatement.trim();
    const id = queryBindings.id;

    if (cleanSql.startsWith('CREATE type::thing(\'decision\'')) {
      const validTiers = ['high', 'medium', 'low'];
      if (queryBindings.confidenceTier && !validTiers.includes(queryBindings.confidenceTier)) {
        throw new Error("DDL_ASSERT_VIOLATION: value must be inside ['high', 'medium', 'low']");
      }
      
      const record = { ...queryBindings, version: 1 };
      this.memoryStore.set(id, record);
      return [[record]];
    }

    if (cleanSql.startsWith('UPDATE')) {
      const currentRecord = this.memoryStore.get(id);
      if (!currentRecord || currentRecord.version !== queryBindings.currentVersion) {
        return [[]]; // 完美匹配 SurrealDB 行为：WHERE 版本未击中时返回空数组
      }
      
      const updatedRecord = {
        ...currentRecord,
        ...queryBindings,
        version: currentRecord.version + 1
      };
      delete (updatedRecord as any).currentVersion;
      this.memoryStore.set(id, updatedRecord);
      return [[updatedRecord]];
    }

    return [[]];
  }
}

describe('SoloForge 持久层 Schema 约束与乐观并发锁集成验收测试套件', () => {

  it('验收点 1：[Schema DDL 约束拦截] 录入违规大写枚举或未知字段，持久层必须拦截底层抛出的 DDL 报错', async () => {
    const mockDb = new MockSurrealLiveDriver();
    const manager = new GeminiPersistenceManager(mockDb);

    const illegalPayload = {
      id: 'tx_uuid_999',
      selectedStrategy: 'chain_of_thought',
      strategyReason: 'test',
      budgetUsed: 0.05,
      budgetLimit: 1.0,
      confidenceTier: 'HIGH' as any, // 🔴 注入大写违规枚举
      subsetSize: 3,
      aggregationMethod: 'plurality_vote',
      aggregatedCandidates: ['gpt-4o']
    };

    await expect(manager.commitDecision(illegalPayload)).rejects.toThrowError(/DDL_ASSERT_VIOLATION/);
  });

  it('验收点 2：[Optimistic Lock 事务弹回] 模拟高并发下两条独立线程同时篡改同一记录，落后线程必须被物理硬拦截', async () => {
    const mockDb = new MockSurrealLiveDriver();
    const manager = new GeminiPersistenceManager(mockDb);

    const basePayload = {
      id: 'tx_uuid_888',
      selectedStrategy: 'direct',
      strategyReason: 'genesis_state',
      budgetUsed: 0.0,
      budgetLimit: 1.0,
      confidenceTier: 'low' as const,
      subsetSize: 1,
      aggregationMethod: 'none',
      aggregatedCandidates: []
    };

    // 写入初始版本（Version = 1）
    await manager.commitDecision(basePayload);

    // 线程 A 抢先提交改写（拿着 Version = 1）
    const promiseA = manager.updateDecisionWithOptimisticLock('tx_uuid_888', 1, { strategyReason: 'Thread_A_Won' });
    
    // 线程 B 时延落后，但仍拿着旧的 Version = 1 企图改写
    const promiseB = manager.updateDecisionWithOptimisticLock('tx_uuid_888', 1, { strategyReason: 'Thread_B_Late' });

    await expect(promiseA).resolves.not.toThrow();
    // 断言：由于版本已被 A 原子性改为 2，B 必须被冷酷抛错拦截
    await expect(promiseB).rejects.toThrowError(/ERR_OPTIMISTIC_LOCK_FAILED/);

    // 验证物理内存完好，未发生数据穿透混淆
    expect(mockDb.memoryStore.get('tx_uuid_888').strategyReason).toBe('Thread_A_Won');
    expect(mockDb.memoryStore.get('tx_uuid_888').version).toBe(2);
  });
});