// ─────────────────────────────────────────────────────────────────
// SoloForge Execution Matrix: RTR (Joint Scoring) + RACER (Dynamic Multi-Path Flow Control)
// Path: src/core/decision/rtr-racer-engine.ts
// ─────────────────────────────────────────────────────────────────

import { DecisionEvent } from '../events/decision-events';
// ✅ 精准对齐物理寻址路径，引入高性能调度客户端
import { GeminiRustSchedulerClient } from '../../kernel/scheduler-client';

export interface RuntimeKernelInterface {
  verifyOwnership(domain: string, key: string): boolean;
  getEventBus(): { emit(event: string, payload: any): void };
}

export interface ModelStrategyCandidate {
  modelName: string;
  reasoningStrategy: 'direct' | 'chain_of_thought' | 'few_shot' | 'decompose' | 'self_refine';
  baseGenerationQuality: number; 
  normalizedLatencyScore: number; 
  normalizedCostEfficiency: number; 
  historicalSuccessIndex: number; 
}

export interface SystemAdaptiveContext {
  globalFailureRate: number; 
}

export class GeminiRTRRacerEngine {
  private kernel: RuntimeKernelInterface;
  private schedulerClient?: GeminiRustSchedulerClient; // ✅ 挂载底层调度看门狗
  private readonly domainSignature = 'AIRuntime';
  private readonly weightQuality = 0.4;
  private readonly weightLatency = 0.2;
  private readonly weightCost = 0.2;
  private readonly weightHistory = 0.2;
  private readonly deepReasoningBonus = 0.15;
  private readonly analyticalStrategies: Set<string> = new Set(['chain_of_thought', 'decompose']);

  // ✅ 允许可选注入客户端，完美向后兼容旧有绿灯集成测试桩
  constructor(kernelInstance: RuntimeKernelInterface, schedulerClient?: GeminiRustSchedulerClient) {
    this.kernel = kernelInstance;
    this.schedulerClient = schedulerClient;
  }

  public calculateJointScore(
    candidate: ModelStrategyCandidate,
    requiresDeepCognition: boolean,
    context?: SystemAdaptiveContext
  ): number {
    const strategicCompensation = (requiresDeepCognition && this.analyticalStrategies.has(candidate.reasoningStrategy)) 
      ? this.deepReasoningBonus 
      : 0;

    let modifiedHistorySuccessIndex = candidate.historicalSuccessIndex;
    if (context && context.globalFailureRate > 0.5) {
      // 策略自学习适应平滑惩罚项
      modifiedHistorySuccessIndex = candidate.historicalSuccessIndex * (1.0 - (context.globalFailureRate - 0.5));
      // ✅ 激活大盘遥测事件感知
      this.kernel.getEventBus().emit(DecisionEvent.ADAPTIVE_PENALTY_APPLIED, { 
        modelName: candidate.modelName, 
        originalIndex: candidate.historicalSuccessIndex, 
        penalizedIndex: modifiedHistorySuccessIndex 
      });
    }

    return (candidate.baseGenerationQuality + strategicCompensation) * this.weightQuality
      + candidate.normalizedLatencyScore * this.weightLatency
      + candidate.normalizedCostEfficiency * this.weightCost
      + modifiedHistorySuccessIndex * this.weightHistory;
  }

  public compilePluralityVote(executionStreams: string[]): string {
    if (!executionStreams || executionStreams.length === 0) return '';
    const metricFrequencyMap: Record<string, number> = {};
    for (const streamOutput of executionStreams) {
      metricFrequencyMap[streamOutput] = (metricFrequencyMap[streamOutput] || 0) + 1;
    }
    return Object.keys(metricFrequencyMap).reduce((nodeA, nodeB) => 
      metricFrequencyMap[nodeA] >= metricFrequencyMap[nodeB] ? nodeA : nodeB
    );
  }

  /**
   * RACER 智能流控主链驱动入口
   */
  public async coordinateRacerFlow(
    candidates: ModelStrategyCandidate[],
    stateRegistryKey: string,
    requiresDeepCognition: boolean,
    globalConfidenceMetric: number,
    taskComplexityMetrics: number,
    executionWorkerNode: (selectedTarget: ModelStrategyCandidate) => Promise<string>,
    adaptiveContext?: SystemAdaptiveContext
  ): Promise<string> {
    // 1. 严格契约拦截：执行所有权验证，不具备此状态所有权则拒绝变更执行
    if (!this.kernel.verifyOwnership(this.domainSignature, stateRegistryKey)) {
      throw new Error(`ERR_ACCESS_DENIED: Domain [${this.domainSignature}] has no strict write-ownership over [${stateRegistryKey}]`);
    }

    if (!candidates || candidates.length === 0) {
      throw new Error('MOD012: Zero active deployment candidates mapped to current sub-task.');
    }

    this.kernel.getEventBus().emit(DecisionEvent.ROUTE_REQUESTED, { totalCandidates: candidates.length });

    // 2. 四维评分排序演化
    const matrixScoringMap = candidates
      .map(candidate => ({
        instance: candidate,
        score: this.calculateJointScore(candidate, requiresDeepCognition, adaptiveContext)
      }))
      .sort((a, b) => b.score - a.score);

    const primaryScore = matrixScoringMap[0].score;
    const secondaryScore = matrixScoringMap[1] ? matrixScoringMap[1].score : primaryScore;

    // 3. 置信度区间划定
    const calculationGap = primaryScore - secondaryScore;
    const cleanCertaintyScore = 1.0 - taskComplexityMetrics;
    const aggregateConfidenceIndex = (calculationGap * 0.4) + (globalConfidenceMetric * 0.4) + (cleanCertaintyScore * 0.2);

    this.kernel.getEventBus().emit(DecisionEvent.CONFIDENCE_CALCULATED, { confidence: aggregateConfidenceIndex });

    // 4. 三区间物理分层执行路由
    if (aggregateConfidenceIndex > 0.85) {
      // 确定性区间一：单路极速通过
      const output = await executionWorkerNode(matrixScoringMap[0].instance);
      this.kernel.getEventBus().emit(DecisionEvent.ROUTE_COMPLETED, { strategy: matrixScoringMap[0].instance.reasoningStrategy });
      return output;
    } 
    
    if (aggregateConfidenceIndex < 0.60 && matrixScoringMap.length >= 3) {
      // 风险区间三：真正激活 3 路并行探索并触发多数归集判定
      this.kernel.getEventBus().emit(DecisionEvent.VOTE_TRIGGERED, { subsetExpandedSize: 3 });
      
      let targetedTopTrio: ModelStrategyCandidate[] = [];

      // 🔗 熔接核心：如果注入了 Rust 高性能常驻守护进程客户端，则将抉择主导权物理交割给 Rust 最大堆
      if (this.schedulerClient) {
        // 将所有候选者批量打入 Rust 老化优先队列中
        for (const item of matrixScoringMap) {
          // 将评分放大 1000 倍转化为 Rust 所需的 u32 基础优先级
          const u32Priority = Math.floor(item.score * 1000);
          // 动态注入老化系数
          const agingFactor = taskComplexityMetrics * 10.0;
          await this.schedulerClient.pushTask(item.instance.modelName, u32Priority, agingFactor);
        }

        // 从 Rust 进程中顺序弹出当前时序下最优先级最高的 3 个智能体节点
        const poppedNames: string[] = [];
        for (let i = 0; i < 3; i++) {
          const name = await this.schedulerClient.popTask();
          if (name) poppedNames.push(name);
        }

        // 根据 Rust 弹出的物理名字，对齐还原回原生的 Candidate 实例引用
        targetedTopTrio = poppedNames
          .map(name => candidates.find(c => c.modelName === name)!)
          .filter(Boolean);
      }

      // 🛡️ 防御降级：如果没有注入客户端，或者 Rust 弹出异常空槽，则优雅平滑退回原生的内存序列切片
      if (targetedTopTrio.length < 3) {
        targetedTopTrio = matrixScoringMap.slice(0, 3).map(wrapper => wrapper.instance);
      }
      
      const parallelResolutionPromises = targetedTopTrio.map(targetNode => executionWorkerNode(targetNode));
      const synchronousOutputs = await Promise.all(parallelResolutionPromises);
      
      return this.compilePluralityVote(synchronousOutputs);
    }

    // 均衡区间二
    const output = await executionWorkerNode(matrixScoringMap[0].instance);
    this.kernel.getEventBus().emit(DecisionEvent.ROUTE_COMPLETED, { strategy: matrixScoringMap[0].instance.reasoningStrategy });
    return output;
  }
}