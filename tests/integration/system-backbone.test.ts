// ─────────────────────────────────────────────────────────────────
// SoloForge System Backbone: End-to-End Lifecycle Orchestration
// Path: tests/integration/system-backbone.test.ts
// ─────────────────────────────────────────────────────────────────

import { describe, it, expect, afterAll } from 'vitest';
import { TransactionKernel, StatePatch } from '../../src/data/transaction_kernel';
import { DeleteProtection, DeleteCommand } from '../../src/data/delete_protection';
import { GeminiPersistenceManager, SurrealDbDriverInterface } from '../../src/data/surreal_persistence';
import { GeminiMappoResourceGovernorClient } from '../../src/core/governor/mappo-client';

// 内存高保真 SurrealDB 驱动，用于总装测试中的断言捕获
class SystemIntegrationSurrealDriver implements SurrealDbDriverInterface {
  public tableStore: Map<string, any> = new Map();

  public async query(sqlStatement: string, queryBindings: Record<string, any>): Promise<any[][]> {
    const id = queryBindings.id;
    if (sqlStatement.trim().startsWith('CREATE')) {
      this.tableStore.set(id, queryBindings);
      return [[queryBindings]];
    }
    return [[]];
  }
}

describe('SoloForge Layer 6 全链路跨语言总装主生命周期流验收测试套件', () => {
  // 1. 物理点火跨语言原生常驻子进程（唤醒 Python 核心）
  const mappoClient = new GeminiMappoResourceGovernorClient();
  const mockDbDriver = new SystemIntegrationSurrealDriver();
  const persistence = new GeminiPersistenceManager(mockDbDriver);

  afterAll(() => {
    // 物理释放，确保 Windows 操作系统中不残留任何孤儿进程
    mappoClient.safelyTerminateGovernorContext();
  });

  it('验收全链路大闭环：从[遥测数据输入] -> [Python顶置熔断] -> [SurrealDB强类型归档] -> [内核原子事务落盘]', async () => {
    
    // ──────── STEP 1: 模拟多智能体系统资源环境极度超载 ────────
    const systemLiveCpu = 0.98; // 故意引爆 0.95 憲法级硬熔断边界
    const globalStateVector = [systemLiveCpu, 0.45, 0.22];
    const localizedObsVector = [0.1, 0.1];

    // 物理通过 Stdin 管道发射给 Python，等待时序自愈 Map 锁分发响应
    const recommendedAction = await mappoClient.evaluateMappoResourceVector(globalStateVector, localizedObsVector);
    
    // 断言：跨语言通信完好，Python 必须精准返回顶置硬熔断动作代码 2
    expect(recommendedAction).toBe(2);

    // ──────── STEP 2: 将分布式控流决策强类型记录归档 ────────
    const decisionUuid = 'sys_tx_backbone_001';
    await persistence.commitDecision({
      id: decisionUuid,
      selectedStrategy: 'HEURISTIC_CRITICAL_FALLBACK',
      strategyReason: 'System CPU Overload detected via MAPPO IPC stream',
      budgetUsed: 0.0,
      budgetLimit: 5.0,
      confidenceTier: 'high',
      subsetSize: 0,
      aggregationMethod: 'circuit_breaker',
      aggregatedCandidates: ['python_marl_service_node']
    });

    // 断言：数据已被持久化管理器正确格式化并推送给底层驱动
    const savedDbRecord = mockDbDriver.tableStore.get(decisionUuid);
    expect(savedDbRecord).toBeDefined();
    expect(savedDbRecord.confidenceTier).toBe('high');

    // ──────── STEP 3: 触发原子事务内核执行全局状态递增 ────────
    const initialRegistry = {
      'system_runtime_status': { mode: 'nominal' }
    };
    const kernel = new TransactionKernel(initialRegistry);

    const runtimePatches: StatePatch[] = [
      { targetKey: 'system_runtime_status', value: { mode: 'emergency_paused', triggerSource: decisionUuid } }
    ];

    // 提交事务，预期当前初始版本号为 1
    const txSuccess = kernel.commitTransaction(runtimePatches, 1);
    
    // 断言：内核成功抵挡并发冲突，版本原子性自增至 2，且数据完好改写
    expect(txSuccess).toBe(true);
    expect(kernel.getSnapshot().version).toBe(2);
    expect(kernel.getSnapshot().data['system_runtime_status'].mode).toBe('emergency_paused');

    // ──────── STEP 4: 联动安全护盾验证不可变资产边界 ────────
    const shield = new DeleteProtection();
    const rogueCommand: DeleteCommand = {
      targetId: 'core_scheduler_global_lock', // 包含 'core_scheduler' 硬拦截前缀
      contentType: 'kernel_resource',
      requestedBy: 'evading_agent_malicious'
    };

    const currentLiveNodeContent = { active: true };
    const shieldResult = shield.interceptAndExecute(rogueCommand, currentLiveNodeContent);

    // 断言：全链路总装状态下，底座护盾依然冷酷，成功切断删库企图
    expect(shieldResult.success).toBe(false);
    expect(shieldResult.action).toBe('BLOCKED');
  });
});