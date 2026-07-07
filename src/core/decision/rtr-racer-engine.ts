// ─────────────────────────────────────────────────────────────────
// SoloForge Execution Matrix: RTR (Joint Scoring) + RACER (Dynamic Multi-Path Flow Control)
// Path: src/core/decision/rtr-racer-engine.ts
// ─────────────────────────────────────────────────────────────────

import { DecisionEvent } from '../events/decision-events';
// ✅ 精准对齐物理寻址路径，引入高性能调度客户端
import { SoloForgeRustSchedulerClient } from '../../kernel/scheduler-client';
// 🧠 引入训练调度器：用于在置信度计算后注入 MARL POLICY_QUERY 信号
import { TrainingScheduler } from '../agent/evolution/training-scheduler';

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

/** RACER 流控结果：包含获胜者模型名、输出文本、获胜者得分 */
export interface RacerFlowResult {
  winnerModelName: string;
  output: string;
  winnerScore: number;
}

export class SoloForgeRTRRacerEngine {
  private kernel: RuntimeKernelInterface;
  private schedulerClient?: SoloForgeRustSchedulerClient;
  private trainingScheduler?: TrainingScheduler;       // 🧠 可选：MARL 训练后的策略查询
  private readonly domainSignature = 'AIRuntime';
  private readonly weightQuality = 0.4;
  private readonly weightLatency = 0.2;
  private readonly weightCost = 0.2;
  private readonly weightHistory = 0.2;
  private readonly deepReasoningBonus = 0.15;
  private readonly analyticalStrategies: Set<string> = new Set(['chain_of_thought', 'decompose']);

  // MARL POLICY_QUERY 决策：
  //   action=2 (熔断) 且 confidence >= 0.55 时,将 aggregateConfidenceIndex 往下压 0.25
  //   阈值低于 0.55 视为 MARL 自身不确定,不让它主导决策
  private readonly marlCircuitConfidenceFloor = 0.55;
  private readonly marlCircuitPenalty = 0.25;

  constructor(
    kernelInstance: RuntimeKernelInterface,
    schedulerClient?: SoloForgeRustSchedulerClient,
    trainingScheduler?: TrainingScheduler
  ) {
    this.kernel = kernelInstance;
    this.schedulerClient = schedulerClient;
    this.trainingScheduler = trainingScheduler;
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
  ): Promise<RacerFlowResult> {
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
    let aggregateConfidenceIndex = (calculationGap * 0.4) + (globalConfidenceMetric * 0.4) + (cleanCertaintyScore * 0.2);

    // 3.5 🧠 MARL POLICY_QUERY 信号注入
    //    把当前 context 转成 10 维观测,询问 8765 上训练好的策略;
    //    仅当 MARL 给出高置信 CIRCUIT_BREAKER(action=2) 时,把置信度往下压,
    //    强制把决策推进到"风险区间三"(多路并行探索)以应对异常路径。
    //    同步等 ACK 超时 1000ms,失败/不可用时静默跳过,不阻塞主流程。
    if (this.trainingScheduler) {
      try {
        const observation: number[] = [
          Math.min(1.0, taskComplexityMetrics),                    // task_complexity
          globalConfidenceMetric,                                  // global_confidence
          cleanCertaintyScore,                                     // clean_certainty
          Math.min(1.0, calculationGap),                           // calculation_gap
          aggregateConfidenceIndex,                                // aggregate_confidence
          Math.min(1.0, candidates.length / 5.0),                 // candidate_count_norm
          adaptiveContext?.globalFailureRate ?? 0.0,              // global_failure_rate
          (requiresDeepCognition ? 1.0 : 0.0),                     // requires_deep_cognition
          (matrixScoringMap[0]?.instance.baseGenerationQuality ?? 0.5), // top_quality
          (matrixScoringMap[0]?.instance.normalizedLatencyScore ?? 0.5), // top_latency
        ];
        const policyResult = await this.trainingScheduler.queryTrainedPolicy(observation);
        if (
          policyResult.source === 'trained_policy' &&
          policyResult.action === 2 &&
          policyResult.confidence >= this.marlCircuitConfidenceFloor
        ) {
          const original = aggregateConfidenceIndex;
          aggregateConfidenceIndex = Math.max(0.0, aggregateConfidenceIndex - this.marlCircuitPenalty);
          this.kernel.getEventBus().emit(DecisionEvent.MARL_POLICY_INJECTED, {
            source: policyResult.source,
            action: policyResult.action,
            confidence: policyResult.confidence,
            originalConfidence: original,
            adjustedConfidence: aggregateConfidenceIndex,
            adjustment: -this.marlCircuitPenalty,
          });
        }
      } catch {
        // MARL 不可用/超时:静默跳过,不影响 RTR/RACER 主流程
      }
    }

    this.kernel.getEventBus().emit(DecisionEvent.CONFIDENCE_CALCULATED, { confidence: aggregateConfidenceIndex });

    // 4. 单路执行路由 (2026-07-07: 砍掉三路并行)
    //    原区间三 (confidence < 0.60 && candidates >= 3) 的三路并行逻辑已删除:
    //    - 3 路用同一个 mainProvider 是 3 倍浪费,不是真正的多模型择优
    //    - 业界共识 (Claude Code/Cursor/Aider) 均不这样做
    //    - LLM 自主 Function Calling 已隐含"需要思考时就多调几轮工具"
    //    保留区间一和区间二,都走单路执行
    const winner = matrixScoringMap[0].instance;
    const output = await executionWorkerNode(winner);
    this.kernel.getEventBus().emit(DecisionEvent.ROUTE_COMPLETED, { strategy: winner.reasoningStrategy });
    return { winnerModelName: winner.modelName, output, winnerScore: matrixScoringMap[0].score };
  }
}