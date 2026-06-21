// ─────────────────────────────────────────────────────────────────
// SoloForge Acceptance Test Harness: Data Governance & Rollback
// Path: tests/integration/data-governance.test.ts
// ─────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest';
// 100% 精准对齐 delete_protection.ts 物理导出的接口与类名
import { DeleteProtection, DeleteCommand } from '../../src/data/delete_protection';
// 100% 精准对齐 transaction_kernel.ts 物理导出的接口与类名
import { TransactionKernel, StatePatch } from '../../src/data/transaction_kernel';

describe('SoloForge Layer 3 数据治理阻断与原子内核事务自愈集成验收测试套件', () => {

  it('验收点 1：[不可变宪法硬拦截] 当任意智能体企图物理 drop 或篡改核心宪法资产时，治理拦截器必须硬性阻断，拒绝物理抹除', async () => {
    // 物理实例化本地原装类
    const interceptor = new DeleteProtection();

    // 严密构造完全符合 DeleteCommand 契约的数据荷载
    const command: DeleteCommand = {
      targetId: 'constitution_global', // 触发 'constitution_' 硬拦截前缀
      contentType: 'governance_rule',
      requestedBy: 'rogue_agent_xyz'
    };

    const mockLiveExtractedData = { version: 3, content: "Sovereign Rules" };

    // 执行真实的拦截方法
    const result = await interceptor.interceptAndExecute(command, mockLiveExtractedData);

    // 断言：系统必须阻断物理删除，返回 success = false 且 action = 'BLOCKED'
    expect(result.success).toBe(false);
    expect(result.action).toBe('BLOCKED');
    
    // 断言：硬拦截请求绝不能漏进软删除冷备回收站中
    expect((await interceptor.getTrashManifest()).length).toBe(0);
  });

  it('验收点 2：[可降级软删除归档] 当删除非核心普通文档资产时，系统必须允许通过，但必须剥离出活跃矩阵并路由至 30天 TTL 冷备区', async () => {
    const interceptor = new DeleteProtection();

    const command: DeleteCommand = {
      targetId: 'document_old_obsolete_logs_2025', // 普通日志，不命中任何 immutablePrefixes 阻断前缀
      contentType: 'document',
      requestedBy: 'agent_beta'
    };

    const mockData = { size: "12MB", payload: "stale text data" };

    // 执行真实的软删除归档方法
    const result = await interceptor.interceptAndExecute(command, mockData);

    // 断言：普通资产允许下线软删除，返回 success = true 且 action = 'SOFT_DELETED'
    expect(result.success).toBe(true);
    expect(result.action).toBe('SOFT_DELETED');

    // 断言：回收站冷备区（mockTrashDb）中必须能精准追溯到这一条被抹平数据的历史物理快照
    const trash = await interceptor.getTrashManifest();
    expect(trash.length).toBe(1);
    expect(trash[0].deletedBy).toBe('agent_beta');
    expect(trash[0].payload.size).toBe('12MB');
  });

  it('验收点 3：[事务原子性与内核灾难自愈] 验证内核在版本冲突时拒绝提交，并在遭遇运行时异常时通过 rollback 栈完美原子化复原', async () => {
    const initialRegistry = {
      'core_scheduler_memory': { status: 'nominal' }
    };
    
    // 1. 物理实例化事务内核，当前底层 currentSnapshot.version 默认为 1
    const kernel = new TransactionKernel(initialRegistry);

    // 2. 测试正常提交链路
    const validPatches: StatePatch[] = [
      { targetKey: 'core_scheduler_memory', value: { status: 'active_running' } }
    ];
    const success = kernel.commitTransaction(validPatches, 1); // 传入预期版本号 1
    expect(success).toBe(true);
    expect(kernel.getSnapshot().version).toBe(2); // 版本原子性自增为 2
    expect(kernel.getSnapshot().data['core_scheduler_memory'].status).toBe('active_running');

    // 3. 测试版本冲突拦截链路 (OCC)
    const conflictPatches: StatePatch[] = [
      { targetKey: 'core_scheduler_memory', value: { status: 'hacked_state' } }
    ];
    // 故意传入已经过期的预期版本号 1（当前实际版本已经是 2）
    const conflictResult = kernel.commitTransaction(conflictPatches, 1);
    expect(conflictResult).toBe(false); // 触发冲突拦截，拒绝提交
    expect(kernel.getSnapshot().version).toBe(2); // 版本号稳固锁定在 2
    expect(kernel.getSnapshot().data['core_scheduler_memory'].status).toBe('active_running'); // 数据未被脏化

    // 4. 测试事务在迭代 patches 应用失败时，try-catch 代码块中自动触发 this.rollback() 的应急倒卷自愈能力
    // 故意在 patches 数组中混入一个 undefined 项，使得 for 循环在执行 patch.targetKey 时物理引爆 TypeError
    const brokenPatches = [
      { targetKey: 'core_scheduler_memory', value: { status: 'broken_dirty_data' } },
      undefined as unknown as StatePatch
    ];

    // 执行提交。发生崩溃后，catch 块捕获并执行 this.rollback()，根据物理源码，rollback 成功最终返回布尔值 true
    const rollbackResult = kernel.commitTransaction(brokenPatches, 2);
    expect(rollbackResult).toBe(true);

    // 核心自愈断言：检查回滚后的底层物理状态快照
    const finalSnapshot = kernel.getSnapshot();
    expect(finalSnapshot.version).toBe(2); // 版本号必须原子性回滚倒卷到 2，拒绝变成错误的 3
    expect(finalSnapshot.data['core_scheduler_memory'].status).toBe('active_running'); // 前一步写入的 broken_dirty_data 必须被彻底抹除，状态完好如初！
  });
});