// ─────────────────────────────────────────────────────────────────
// SoloForge Agent Core: Decision Orchestrator
// Path: src/core/agent/agent-decision-orchestrator.ts
//
// v2: 使用 RacerFlowResult 显式返回 winner，消除反推猜测
// v2: 集成 CAS 版本同步
// ─────────────────────────────────────────────────────────────────

import crypto from 'crypto';
import { GeminiRTRRacerEngine, ModelStrategyCandidate, RacerFlowResult } from '../decision/rtr-racer-engine';
import { AgentRegistry, AgentDispatchRequest, AgentDispatchResult } from './agent-registry';
import { RuntimeEvent } from '../events/runtime-events';
import { logger } from '../logger';
import type { RuntimeKernel } from '../../kernel/runtime-kernel';

export class AgentDecisionOrchestrator {
  private readonly moduleName = 'AgentDecisionOrchestrator';
  private readonly racerEngine: GeminiRTRRacerEngine;
  private readonly registry: AgentRegistry;
  private readonly kernel: RuntimeKernel;

  constructor(kernel: RuntimeKernel, registry: AgentRegistry) {
    this.kernel = kernel;
    this.registry = registry;
    this.racerEngine = new GeminiRTRRacerEngine(kernel as any, (kernel as any).schedulerClient);
  }

  /**
   * 高层入口: 派发一个网络包任务，让 RACER 选 agent 执行
   * v2: 使用 RacerFlowResult 显式获取 winner
   * v3: 每步 emit phase 事件 → 自动通过 eventBus 广播 → SSE 推到前端流送区
   */
  public async dispatchPacket(req: AgentDispatchRequest): Promise<AgentDispatchResult> {
    const start = Date.now();
    const packetUuid = req.packetUuid ?? `pkt_${crypto.randomBytes(4).toString('hex')}`;
    const packetSizeKb = req.packetSizeKb ?? Math.floor(Math.random() * 64) + 1;
    const chatId = req.chatId;

    // 1) 拉候选
    const candidates = this.registry.generateRoutingCandidates();
    if (candidates.length === 0) {
      throw new Error('AGENT_POOL_EMPTY: No agents registered.');
    }

    // 2) 状态所有权 key
    const stateRegistryKey = `AIRuntime_packet_${packetUuid}`;

    // 3) 事件广播
    this.kernel.eventBus.emit(RuntimeEvent.AgentTaskDispatched, {
      packetUuid,
      packetSizeKb,
      candidateCount: candidates.length,
      chatId,
      timestamp: Date.now(),
    });

    // 3.1) 流送区 phase0 — 拆解为 N 个候选子任务
    //      payload 与前端 phaseMappers.ts#phase0_subtask 对齐
    this.kernel.eventBus.emit('phase0_subtask', {
      packetUuid,
      chatId,
      subtasks: candidates.map((c, i) => ({
        workerIdx: i,
        modelName: c.modelName,
        taskDesc: c.reasoningStrategy ?? `Worker ${i}`,
      })),
      ts: Date.now(),
    });

    // 4) RACER 选路 + 执行 — v2: 返回 RacerFlowResult
    const racerResult: RacerFlowResult = await this.racerEngine.coordinateRacerFlow(
      candidates,
      stateRegistryKey,
      req.requiresDeepCognition ?? packetSizeKb > 32,
      req.globalConfidenceMetric ?? 0.75,
      req.taskComplexityMetrics ?? 0.30,
      async (selected: ModelStrategyCandidate) => {
        // 4.1) 流送区 phase1_worker_start — 每个 worker 开始执行
        const workerIdx = candidates.findIndex(c => c.modelName === selected.modelName);
        this.kernel.eventBus.emit('phase1_worker_start', {
          packetUuid,
          chatId,
          workerIdx: workerIdx >= 0 ? workerIdx : 0,
          modelName: selected.modelName,
          ts: Date.now(),
        });
        const out = await this.registry.executeOnAgent(selected.modelName, packetUuid, packetSizeKb, workerIdx >= 0 ? workerIdx : undefined);
        // 4.2) 流送区 phase1_worker_done — worker 执行完
        this.kernel.eventBus.emit('phase1_worker_done', {
          packetUuid,
          chatId,
          workerIdx: workerIdx >= 0 ? workerIdx : 0,
          modelName: selected.modelName,
          content: out ?? '',
          ts: Date.now(),
        });
        return out;
      },
      req.adaptiveContext
    );

    // 5) 直接使用 RACER 返回的 winner — 不再猜测
    const winnerAgentId = racerResult.winnerModelName;
    const winnerCandidate = candidates.find(c => c.modelName === winnerAgentId) ?? candidates[0];
    const parallel = candidates.length >= 3 && this.isLowConfidence(req, candidates);

    const result: AgentDispatchResult = {
      packetUuid,
      winnerAgentId,
      strategy: winnerCandidate.reasoningStrategy,
      output: racerResult.output,
      score: racerResult.winnerScore,
      parallel,
      candidateCount: candidates.length,
      durationMs: Date.now() - start,
    };

    logger.info(
      this.moduleName,
      `packet=${packetUuid} -> winner=[${result.winnerAgentId}] (${result.strategy}) ` +
        `score=${result.score.toFixed(3)} parallel=${parallel} t=${result.durationMs}ms`
    );

    // 5.1) 流送区 phase2_judge + phase3_deliver_done — 终态
    this.kernel.eventBus.emit('phase2_judge', {
      packetUuid,
      chatId,
      chosen: [winnerAgentId],
      score: result.score,
      ts: Date.now(),
    });
    this.kernel.eventBus.emit('phase3_deliver_done', {
      packetUuid,
      chatId,
      reply: racerResult.output,
      ts: Date.now(),
    });

    // B+C 升级: 释放 subTaskBinding (防止内存泄漏)
    try {
      this.registry.releasePacketBindings(packetUuid);
    } catch (e: any) {
      logger.debug(this.moduleName, `releasePacketBindings(${packetUuid}) failed: ${e?.message ?? e}`);
    }

    return result;
  }

  private isLowConfidence(req: AgentDispatchRequest, candidates: ModelStrategyCandidate[]): boolean {
    const confidence = req.globalConfidenceMetric ?? 0.75;
    const complexity = req.taskComplexityMetrics ?? 0.30;
    return confidence < 0.6 && complexity > 0.4 && candidates.length >= 3;
  }
}
