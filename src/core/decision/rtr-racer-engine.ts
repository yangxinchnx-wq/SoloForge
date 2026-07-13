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
  /** 并行执行的所有 worker 输出 (2026-07-09 恢复并行后新增) */
  allOutputs?: Array<{
    agentId: string;
    output: string;
    score: number;
    durationMs: number;
    provider: string; // 使用的 LLM 模型名
    actualTokenUsage?: {
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
      cachedTokens: number;
      llmCallCount: number;
    };
  }>;
  /** 实际并行度 */
  parallelism: number;
}

/** 单个 worker 的执行结果 */
export interface WorkerExecResult {
  output: string;
  durationMs: number;
  provider: string; // 实际使用的 LLM 模型名
  toolCallCount?: number;
  cacheHits?: number;
  /** 真实 token 消耗 (从 LLM usage 字段累加) */
  actualTokenUsage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cachedTokens: number;
    llmCallCount: number;
  };
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
    executionWorkerNode: (selectedTarget: ModelStrategyCandidate, workerIdx: number) => Promise<WorkerExecResult>,
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

    // 4. 自适应并行度选择 (2026-07-09: 恢复并行,配合副模型实现真正的多模型择优)
    //    并行度由置信度决定:
    //    - confidence >= 0.75 (高置信): N=1, 只跑 top1 (省 token)
    //    - 0.60 <= confidence < 0.75 (中置信): N=2, 双路并行 (主+1副)
    //    - confidence < 0.60 && candidates >= 3 (低置信): N=3, 三路并行 (主+2副)
    //    与 2026-07-07 删除的旧三路并行不同:
    //    - 旧版: 3 路用同一个 mainProvider = 3 倍浪费
    //    - 新版: winner 用 mainProvider, 其他 worker 用 subProviders (真正多模型)
    //    - 新版: 通过 AgentCommBus 共享工具发现,避免重复探索
    const topN = this.selectTopN(matrixScoringMap, aggregateConfidenceIndex, candidates.length);

    this.kernel.getEventBus().emit(DecisionEvent.ROUTE_COMPLETED, {
      strategy: matrixScoringMap[0].instance.reasoningStrategy,
      parallelism: topN,
      confidence: aggregateConfidenceIndex,
    });

    if (topN === 1) {
      // 单路执行 (高置信,省 token)
      const winner = matrixScoringMap[0].instance;
      const result = await executionWorkerNode(winner, 0);
      return {
        winnerModelName: winner.modelName,
        output: result.output,
        winnerScore: matrixScoringMap[0].score,
        allOutputs: [{
          agentId: winner.modelName,
          output: result.output,
          score: matrixScoringMap[0].score,
          durationMs: result.durationMs,
          provider: result.provider,
          actualTokenUsage: result.actualTokenUsage,
        }],
        parallelism: 1,
      };
    }

    // 多路并行执行 (中/低置信, 多模型择优)
    const workers = matrixScoringMap.slice(0, topN);

    // 发出投票触发事件,记录并行子集大小
    this.kernel.getEventBus().emit(DecisionEvent.VOTE_TRIGGERED, {
      subsetExpandedSize: workers.length,
      candidates: workers.map(w => w.instance.modelName),
    });

    const workerResults = await Promise.all(
      workers.map((w, idx) => executionWorkerNode(w.instance, idx).catch(err => ({
        output: `[WORKER_ERROR] ${err?.message ?? String(err)}`,
        durationMs: 0,
        provider: 'error',
        toolCallCount: 0,
        cacheHits: 0,
      } as WorkerExecResult)))
    );

    // 选 winner: 优先用 score 最高的成功 worker
    // (并行场景下各 worker 用不同模型,不能用 LLM 自评分,改用 RACER score)
    let winnerIdx = 0;
    for (let i = 1; i < workerResults.length; i++) {
      if (!workerResults[i].output.startsWith('[WORKER_ERROR]') &&
          workerResults[i].output.length > workerResults[winnerIdx].output.length) {
        winnerIdx = i;
      }
    }
    const winnerCandidate = workers[winnerIdx];
    const winnerResult = workerResults[winnerIdx];

    return {
      winnerModelName: winnerCandidate.instance.modelName,
      output: winnerResult.output,
      winnerScore: winnerCandidate.score,
      allOutputs: workers.map((w, i) => ({
        agentId: w.instance.modelName,
        output: workerResults[i].output,
        score: w.score,
        durationMs: workerResults[i].durationMs,
        provider: workerResults[i].provider,
        actualTokenUsage: workerResults[i].actualTokenUsage,
      })),
      parallelism: topN,
    };
  }

  /**
   * 根据置信度和候选数选择并行度
   */
  private selectTopN(
    matrixScoringMap: Array<{ instance: ModelStrategyCandidate; score: number }>,
    confidence: number,
    candidateCount: number
  ): number {
    // 高置信: 单路
    if (confidence >= 0.75) return 1;
    // 中置信: 双路
    if (confidence >= 0.60) return Math.min(2, candidateCount);
    // 低置信 + 候选充足: 三路
    if (candidateCount >= 3) return Math.min(3, candidateCount);
    // 低置信但候选不足: 双路
    return Math.min(2, candidateCount);
  }
}