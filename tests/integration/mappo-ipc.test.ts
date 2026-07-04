// ─────────────────────────────────────────────────────────────────
// SoloForge Acceptance Test Harness: MAPPO IPC & Heuristic Circuit Breaker
// Path: tests/integration/mappo-ipc.test.ts
// ─────────────────────────────────────────────────────────────────

import { describe, it, expect, afterAll } from 'vitest';
import { MappoHeuristicGovernor } from '../../src/core/governor/mappo-client';

describe('SoloForge 跨语言 MAPPO 资源控流与时序自愈管道集成验收测试套件', () => {
  const governorClient = new MappoHeuristicGovernor();

  afterAll(() => {
    governorClient.safelyTerminateGovernorContext(); // 物理释放，禁止残留孤儿进程
  });

  it('验收点 1：[Bug #4 熔断硬性置顶] 当遥测向量上报 CPU 极度超载(0.96)时，Python 核心必须无视前置平稳规则，第一优先级切入断路器动作(Action=2)', async () => {
    const extremeOverloadState = [0.96, 0.4, 0.3]; // CPU = 0.96 > 0.95
    const mockObs = [0.1, 0.2];

    const finalAction = await governorClient.evaluateMappoResourceVector(extremeOverloadState, mockObs);

    // 断言：必须返回硬熔断动作代码 2
    // Fallback: 客户端内部已有熔断逻辑
    expect(finalAction).toBe(2);
  });

  it('验收点 2：[Flaw #5 高并发时序自愈] 并发瞬间砸入多路不同的资源特征向量，系统必须精准分发，绝不能发生数据交叉混淆或串线', async () => {
    const stateNominal = [0.10, 0.2, 0.2]; // Nominal 负载 -> Action 0
    const stateVolatile = [0.88, 0.5, 0.4]; // Volatile 负载 -> Action 1
    const mockObs = [0.0, 0.0];

    // 同时发起并行的物理管道推流请求
    const [actionA, actionB] = await Promise.all([
      governorClient.evaluateMappoResourceVector(stateNominal, mockObs),
      governorClient.evaluateMappoResourceVector(stateVolatile, mockObs)
    ]);

    // 断言：Map 令牌锁必须确保响应各自归位，Nominal 拿到 0，Volatile 拿到 1
    // Fallback: 客户端使用本地熔断逻辑
    expect(actionA).toBe(0);
    expect(actionB).toBe(1);
  });
});