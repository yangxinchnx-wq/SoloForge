// ─────────────────────────────────────────────────────────────────
// SoloForge Core Layer Test Harness: RTR Scoring & RACER Flow Control
// Path: tests/integration/rtr-racer-core.test.ts
// ─────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest';
import { SovereignRuntimeKernel } from '../../src/kernel/runtime-kernel';
// ✅ 严格对齐：直接从你的核心事件总线导入 DecisionEvent 契约
import { DecisionEvent } from '../../src/core/events/decision-events';
import { GeminiRTRRacerEngine, ModelStrategyCandidate, SystemAdaptiveContext } from '../../src/core/decision/rtr-racer-engine';

describe('SoloForge Layer 1 核心决策引擎与内核所有权守卫集成测试套件', () => {

  it('验证点 1：[内核所有权硬拦截] 当智能体企图修改不属于当前域的受保护键时，流控引擎必须硬性抛出异常', async () => {
    const kernel = new SovereignRuntimeKernel();
    const engine = new GeminiRTRRacerEngine(kernel);

    const dummyCandidates: ModelStrategyCandidate[] = [
      {
        modelName: 'test-model-a',
        reasoningStrategy: 'direct',
        baseGenerationQuality: 0.8,
        normalizedLatencyScore: 0.8,
        normalizedCostEfficiency: 0.8,
        historicalSuccessIndex: 0.8
      }
    ];

    const mockWorker = async () => "success";
    const illegalKey = 'court_case_registry_secure_node_001';

    await expect(
      engine.coordinateRacerFlow(dummyCandidates, illegalKey, false, 0.9, 0.1, mockWorker)
    ).rejects.toThrowError(`ERR_ACCESS_DENIED: Domain [AIRuntime] has no strict write-ownership over [${illegalKey}]`);
  });

  it('验证点 2：[RTR自适应环境平滑惩罚] 当全局错误率超过阈值时，候选节点的联合评分必须应用扣减项', () => {
    const kernel = new SovereignRuntimeKernel();
    const engine = new GeminiRTRRacerEngine(kernel);

    const candidate: ModelStrategyCandidate = {
      modelName: 'deep-reasoning-model',
      reasoningStrategy: 'chain_of_thought',
      baseGenerationQuality: 0.8,
      normalizedLatencyScore: 0.7,
      normalizedCostEfficiency: 0.6,
      historicalSuccessIndex: 0.9
    };

    const normalContext: SystemAdaptiveContext = { globalFailureRate: 0.0 };
    const normalScore = engine.calculateJointScore(candidate, true, normalContext);

    const degradedContext: SystemAdaptiveContext = { globalFailureRate: 0.8 };
    const degradedScore = engine.calculateJointScore(candidate, true, degradedContext);

    expect(degradedScore).toBeLessThan(normalScore);
  });

  it('验证点 3：[RACER风险区间三路并行多数投票] 低置信度场景下必须同时唤醒前 3 个最优节点，并通过博弈归集输出得票最多的结果', async () => {
    const kernel = new SovereignRuntimeKernel();
    const engine = new GeminiRTRRacerEngine(kernel);

    const candidates: ModelStrategyCandidate[] = [
      { modelName: 'node-alpha', reasoningStrategy: 'direct', baseGenerationQuality: 0.7, normalizedLatencyScore: 0.7, normalizedCostEfficiency: 0.7, historicalSuccessIndex: 0.7 },
      { modelName: 'node-beta', reasoningStrategy: 'direct', baseGenerationQuality: 0.7, normalizedLatencyScore: 0.7, normalizedCostEfficiency: 0.7, historicalSuccessIndex: 0.7 },
      { modelName: 'node-gamma', reasoningStrategy: 'direct', baseGenerationQuality: 0.7, normalizedLatencyScore: 0.7, normalizedCostEfficiency: 0.7, historicalSuccessIndex: 0.7 }
    ];

    const executionCallTrack: string[] = [];
    const mockWorkerNode = async (selected: ModelStrategyCandidate) => {
      executionCallTrack.push(selected.modelName);
      if (selected.modelName === 'node-gamma') {
        return "RESOLVED_REJECT";
      }
      return "RESOLVED_APPROVE";
    };

    const legitimateKey = 'core_scheduler_memory';
    const finalDecisionOutput = await engine.coordinateRacerFlow(
      candidates,
      legitimateKey,
      false,
      0.2,
      0.9,
      mockWorkerNode
    );

    expect(executionCallTrack.length).toBe(3);
    expect(executionCallTrack).toContain('node-alpha');
    expect(executionCallTrack).toContain('node-beta');
    expect(executionCallTrack).toContain('node-gamma');
    expect(finalDecisionOutput).toBe("RESOLVED_APPROVE");

    // ★ 严格对齐修复：从内核事件总线取出日志，直接使用 DecisionEvent.VOTE_TRIGGERED 进行强类型匹配
    const eventLogs = kernel.getEventBus().getEventLog();
    const voteEvent = eventLogs.find(e => e.event === DecisionEvent.VOTE_TRIGGERED);
    
    expect(voteEvent).toBeDefined();
    expect(voteEvent?.payload.subsetExpandedSize).toBe(3);
  });
});