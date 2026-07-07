// ─────────────────────────────────────────────────────────────────
// SoloForge Agent Core: Decision Orchestrator
// Path: src/core/agent/agent-decision-orchestrator.ts
//
// v3: 真实 LLM 调用 — prompt 全链路透传，streamHook 后端直接创建
// ─────────────────────────────────────────────────────────────────

import crypto from 'crypto';
import { SoloForgeRTRRacerEngine, ModelStrategyCandidate, RacerFlowResult } from '../decision/rtr-racer-engine';
import { AgentRegistry, AgentDispatchRequest, AgentDispatchResult } from './agent-registry';
import { RuntimeEvent } from '../events/runtime-events';
import { logger } from '../logger';
import type { RuntimeKernel } from '../../kernel/runtime-kernel';

export class AgentDecisionOrchestrator {
  private readonly moduleName = 'AgentDecisionOrchestrator';
  private readonly racerEngine: SoloForgeRTRRacerEngine;
  private readonly registry: AgentRegistry;
  private readonly kernel: RuntimeKernel;

  constructor(kernel: RuntimeKernel, registry: AgentRegistry) {
    this.kernel = kernel;
    this.registry = registry;
    this.racerEngine = new SoloForgeRTRRacerEngine(kernel as any, (kernel as any).schedulerClient);
  }

  /**
   * 高层入口: 派发一个网络包任务，让 RACER 选 agent 执行
   * v3: prompt 全链路透传到真实 LLM，streamHook 后端直接创建（不依赖前端 bindSubTask）
   */
  public async dispatchPacket(req: AgentDispatchRequest): Promise<AgentDispatchResult> {
    const start = Date.now();
    const packetUuid = req.packetUuid ?? `pkt_${crypto.randomBytes(4).toString('hex')}`;
    const packetSizeKb = req.packetSizeKb ?? Math.floor(Math.random() * 64) + 1;
    const chatId = req.chatId ?? '__no_chat__';
    const prompt = req.prompt ?? '';
    const history = req.history ?? [];
    const activeFile = req.activeFile ?? null;
    const mainProvider = req.mainProvider;
    const workspaceFolder = req.workspaceFolder;
    const activeTools = req.activeTools;
    const activeSkills = req.activeSkills;
    const activeKnowledge = req.activeKnowledge;

    if (!prompt) {
      throw new Error('DISPATCH_ERROR: prompt is required');
    }

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

    // 4) RACER 选路 + 执行
    const racerResult: RacerFlowResult = await this.racerEngine.coordinateRacerFlow(
      candidates,
      stateRegistryKey,
      req.requiresDeepCognition ?? packetSizeKb > 32,
      req.globalConfidenceMetric ?? 0.75,
      req.taskComplexityMetrics ?? 0.30,
      async (selected: ModelStrategyCandidate) => {
        const workerIdx = candidates.findIndex(c => c.modelName === selected.modelName);
        const effectiveWorkerIdx = workerIdx >= 0 ? workerIdx : 0;

        // 4.1) 流送区 phase1_worker_start
        this.kernel.eventBus.emit('phase1_worker_start', {
          packetUuid,
          chatId,
          workerIdx: effectiveWorkerIdx,
          modelName: selected.modelName,
          ts: Date.now(),
        });

        // 4.2) 后端直接创建 streamHook（不依赖前端 bindSubTask API 调用）
        const subTaskId = `${packetUuid}_w${effectiveWorkerIdx}`;
        this.registry.bindSubTask({
          packetUuid,
          workerIdx: effectiveWorkerIdx,
          chatId,
          subTaskId,
          agentId: selected.modelName,
        });

        // 4.3) 执行 — 传递真实 prompt + LLM config
        const out = await this.registry.executeOnAgent(
          selected.modelName,
          packetUuid,
          packetSizeKb,
          effectiveWorkerIdx,
          {
            prompt,
            history,
            activeFile,
            mainProvider,
            workspaceFolder,
            activeTools,
            activeSkills,
            activeKnowledge,
          },
        );

        // 4.4) 流送区 phase1_worker_done
        this.kernel.eventBus.emit('phase1_worker_done', {
          packetUuid,
          chatId,
          workerIdx: effectiveWorkerIdx,
          modelName: selected.modelName,
          content: out ?? '',
          ts: Date.now(),
        });
        return out;
      },
      req.adaptiveContext
    );

    // 5) 使用 RACER 返回的 winner
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

    // 释放 subTaskBinding
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
