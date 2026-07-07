// ─────────────────────────────────────────────────────────────────
// SoloForge Agent Core: Agent Registry / Pool (v2)
// Path: src/core/agent/agent-registry.ts
//
// v2: 集成多维度声誉、FIPA-ACL 通信、CAS 版本同步、Commit-Reveal 仲裁
// ─────────────────────────────────────────────────────────────────

import crypto from 'crypto';
import { AutonomousNetworkAgent } from './autonomous_agent';
import {
  ModelStrategyCandidate,
  SystemAdaptiveContext,
} from '../decision/rtr-racer-engine';
import { CourtEvent } from '../events/court-events';
import { RuntimeEvent } from '../events/runtime-events';
import { AdjudicationArgumentClaim } from '../court/consensagent';
import { MultiDimensionalReputation, ReputationComponents } from './reputation/multi-dimensional-reputation';
import { AgentCommunicationBus, FIPAACLMessage } from './communication/agent-communication-bus';
import { logger } from '../logger';
import type { RuntimeKernel } from '../../kernel/runtime-kernel';
import { SpecializedAgent } from './specialized-agent';
import { executeToolCall } from './tools/tool-definitions';

export interface AgentSnapshot {
  agentId: string;
  strategyType: string;
  reputationScore: number;
  reputationComponents: ReputationComponents;
  evidenceCount: number;
  stakeBalance: number;
  totalExecutions: number;
  totalDisputes: number;
  totalWins: number;
  totalLosses: number;
}

export interface LLMProviderConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface AgentDispatchRequest {
  packetUuid?: string;
  packetSizeKb?: number;
  requiresDeepCognition?: boolean;
  globalConfidenceMetric?: number;
  taskComplexityMetrics?: number;
  adaptiveContext?: SystemAdaptiveContext;
  /** 前端 chatId (用于 phase 事件路由回流送区) */
  chatId?: string;
  /** 用户输入的原始 prompt */
  prompt?: string;
  /** 对话历史 */
  history?: Array<{ sender: string; content: string }>;
  /** 当前打开的文件上下文 */
  activeFile?: { name: string; content: string } | null;
  /** 前端配置的 LLM provider (apiKey + baseUrl + model) */
  mainProvider?: LLMProviderConfig;
  /** 工作区文件夹路径 (用于 AI 作用域限制) */
  workspaceFolder?: string;
  /** 前端资源管理器选中的工具 ID 列表 */
  activeTools?: string[];
  /** 前端资源管理器选中的技能 ID 列表 */
  activeSkills?: string[];
  /** 前端资源管理器选中的知识库 ID 列表 */
  activeKnowledge?: string[];
}

export interface AgentDispatchResult {
  packetUuid: string;
  winnerAgentId: string;
  strategy: string;
  output: string;
  score: number;
  parallel: boolean;
  candidateCount: number;
  durationMs: number;
}

/**
 * 默认 agent 种子配置
 */
const DEFAULT_AGENT_SEEDS: Array<{
  id: string;
  strategy: 'direct' | 'chain_of_thought' | 'few_shot';
  reputation: number;
  initialComponents?: Partial<ReputationComponents>;
}> = [
  { id: 'agent_alpha_fast_edge', strategy: 'direct', reputation: 0.92, initialComponents: { competence: 0.85, reliability: 0.95, integrity: 0.90, collaboration: 0.80 } },
  { id: 'agent_alpha_mirror_edge', strategy: 'direct', reputation: 0.85, initialComponents: { competence: 0.80, reliability: 0.88, integrity: 0.85, collaboration: 0.75 } },
  { id: 'agent_beta_deep_reasoner', strategy: 'chain_of_thought', reputation: 0.88, initialComponents: { competence: 0.95, reliability: 0.90, integrity: 0.88, collaboration: 0.70 } },
  { id: 'agent_beta_analytical', strategy: 'chain_of_thought', reputation: 0.78, initialComponents: { competence: 0.90, reliability: 0.80, integrity: 0.78, collaboration: 0.65 } },
  { id: 'agent_gamma_sybil_intruder', strategy: 'direct', reputation: 0.45, initialComponents: { competence: 0.60, reliability: 0.40, integrity: 0.30, collaboration: 0.20 } },
];

/**
 * Agent 注册中心 — v2: 集成声誉、通信、CAS 同步
 */
export class AgentRegistry {
  private readonly moduleName = 'AgentRegistry';
  private readonly agents: Map<string, AutonomousNetworkAgent> = new Map();
  private readonly metrics: Map<string, {
    executions: number;
    disputes: number;
    wins: number;
    losses: number;
    lastDelta: number;
    version: number;
  }> = new Map();

  /** 多维度声誉引擎 */
  public readonly reputationEngine: MultiDimensionalReputation;

  /** Agent 通信总线 */
  public readonly commBus: AgentCommunicationBus;

  /**
   * 真实 LLM 驱动的 SpecializedAgent 缓存 (B+C 升级: 让 RACER 多模型也支持工具调用)
   *   key: agentId
   *   value: SpecializedAgent 实例,按需懒加载
   */
  private readonly specializedAgents: Map<string, SpecializedAgent> = new Map();

  /**
   * subTaskBinding: 前端 streamPanel subTaskId 绑定表
   *   key: `${packetUuid}:${workerIdx}`
   *   value: { chatId, subTaskId, agentId }
   *   由前端在 phase0 阶段调 /api/agents/bindSubTask 注册
   *   executeOnAgent 查这个表, 构造 streamHook → runAgentLoop 内部 onToolCall emit
   */
  private readonly subTaskBindings: Map<string, { chatId: string; subTaskId: string; agentId: string }> = new Map();

  private readonly kernel: RuntimeKernel;
  private isOperational = false;
  private syncTimer: NodeJS.Timeout | null = null;
  private gossipTimer: NodeJS.Timeout | null = null;
  private currentCpuLoad = 0.3;

  constructor(kernel: RuntimeKernel) {
    if (!kernel) {
      throw new Error('CRITICAL_AGENT_REGISTRY: RuntimeKernel is required.');
    }
    this.kernel = kernel;
    this.reputationEngine = new MultiDimensionalReputation();
    this.commBus = new AgentCommunicationBus(kernel);
  }

  // ============================================================
  // 生命周期
  // ============================================================

  public async boot(): Promise<void> {
    if (this.isOperational) return;

    for (const seed of DEFAULT_AGENT_SEEDS) {
      this.spawnAgent(seed.id, seed.strategy, seed.reputation, seed.initialComponents);
      this.commBus.register(seed.id);
      this.reputationEngine.register(seed.id, seed.initialComponents);
    }

    // 注册到 SocialReputationEngine
    for (const seed of DEFAULT_AGENT_SEEDS) {
      try {
        await this.kernel.commandBus.execute({
          id: crypto.randomUUID(),
          type: 'REGISTER_REPUTATION_ENTITY',
          domain: 'AgentRegistry',
          caller: this.moduleName,
          payload: {
            traceId: `agent_init_${seed.id}`,
            entityId: seed.id,
            entityType: 'agent',
          },
        });
      } catch (e: any) {
        logger.debug(this.moduleName, `Reputation register fallback for ${seed.id}: ${e.message}`);
      }
    }

    // 订阅法院裁决
    this.subscribeToCourtAdjudications();

    // 启动周期同步 (5s)
    this.syncTimer = setInterval(() => {
      this.syncReputationToSociety().catch((e) =>
        logger.warn(this.moduleName, `reputation sync failed: ${e.message}`)
      );
    }, 5000);

    // 启动 Gossip 周期 (10s)
    this.gossipTimer = setInterval(() => {
      this.runGossipCycle();
    }, 10000);

    this.isOperational = true;
    logger.info(this.moduleName, `${this.agents.size} agents online, court-bridge + society-bridge + comm-bus mounted`);
  }

  public async shutdown(): Promise<void> {
    if (this.syncTimer) { clearInterval(this.syncTimer); this.syncTimer = null; }
    if (this.gossipTimer) { clearInterval(this.gossipTimer); this.gossipTimer = null; }
    this.isOperational = false;
  }

  // ============================================================
  // Agent 池管理
  // ============================================================

  public spawnAgent(
    id: string,
    strategy: 'direct' | 'chain_of_thought' | 'few_shot',
    initialReputation = 1.0,
    initialComponents?: Partial<ReputationComponents>
  ): AutonomousNetworkAgent {
    if (this.agents.has(id)) {
      return this.agents.get(id)!;
    }
    const agent = new AutonomousNetworkAgent(id, strategy, initialReputation, initialComponents);
    this.agents.set(id, agent);
    this.metrics.set(id, { executions: 0, disputes: 0, wins: 0, losses: 0, lastDelta: 0, version: 1 });
    logger.info(this.moduleName, `agent [${id}] (${strategy}) spawned with rep=${initialReputation.toFixed(2)}`);
    return agent;
  }

  public getAgent(agentId: string): AutonomousNetworkAgent | undefined {
    return this.agents.get(agentId);
  }

  public listAgents(): AutonomousNetworkAgent[] {
    return Array.from(this.agents.values());
  }

  public generateRoutingCandidates(cpuLoad?: number): ModelStrategyCandidate[] {
    const load = cpuLoad ?? this.currentCpuLoad;
    if (cpuLoad !== undefined) this.currentCpuLoad = cpuLoad;
    return Array.from(this.agents.values()).map((agent) =>
      agent.generateRoutingCandidateState(load)
    );
  }

  public async executeOnAgent(
    agentId: string,
    packetUuid: string,
    packetSizeKb: number,
    workerIdx?: number,
    taskContext?: {
      prompt: string;
      history?: Array<{ sender: string; content: string }>;
      activeFile?: { name: string; content: string } | null;
      mainProvider?: { baseUrl: string; apiKey: string; model: string };
      workspaceFolder?: string;
      activeTools?: string[];
      activeSkills?: string[];
      activeKnowledge?: string[];
    },
  ): Promise<string> {
    const agent = this.agents.get(agentId);
    if (!agent) {
      throw new Error(`AGENT_NOT_FOUND: ${agentId}`);
    }
    const m = this.metrics.get(agentId)!;
    m.executions += 1;
    m.version += 1;

    // 1) 查 subTaskBinding: 拿当前 worker 对应的 chatId + subTaskId
    let binding: { chatId: string; subTaskId: string; agentId: string } | undefined;
    if (workerIdx !== undefined) {
      binding = this.subTaskBindings.get(this.bindingKey(packetUuid, workerIdx));
    } else {
      const idx = this.findWorkerIdxForAgent(agentId, packetUuid);
      if (idx !== undefined) {
        binding = this.subTaskBindings.get(this.bindingKey(packetUuid, idx));
      }
    }

    // 2) 构造 streamHook (有 binding 就用, 没有就用 packetUuid 做占位)
    const streamHook = binding
      ? {
          chatId: binding.chatId,
          subTaskId: binding.subTaskId,
          emit: (
            eventName: 'tool_started' | 'tool_completed' | 'tool_stdout' | 'tool_stderr' | 'tool_exit',
            payload: any,
          ) => {
            this.kernel.eventBus.emit(eventName, payload);
          },
        }
      : undefined;

    // 3) 构造真实任务描述 — 用户 prompt + 历史对话 + 文件上下文
    const prompt = taskContext?.prompt ?? '';
    const history = taskContext?.history ?? [];
    const activeFile = taskContext?.activeFile ?? null;
    const mainProvider = taskContext?.mainProvider;
    const workspaceFolder = taskContext?.workspaceFolder;
    const activeTools = taskContext?.activeTools;
    const activeSkills = taskContext?.activeSkills;
    const activeKnowledge = taskContext?.activeKnowledge;

    let taskDesc = prompt;
    if (history.length > 0) {
      const historyText = history
        .slice(-10) // 最近 10 条
        .map(h => `[${h.sender}]: ${h.content}`)
        .join('\n');
      taskDesc = `## 对话历史\n${historyText}\n\n## 当前问题\n${prompt}`;
    }
    if (activeFile) {
      taskDesc += `\n\n## 当前文件: ${activeFile.name}\n\`\`\`\n${activeFile.content.slice(0, 4000)}\n\`\`\``;
    }
    if (workspaceFolder) {
      taskDesc += `\n\n## 工作区\n当前对话已绑定工作区文件夹: \`${workspaceFolder}\`\n你的所有文件操作 (读写/创建/删除) 必须限制在此文件夹范围内。如果需要操作文件夹外的资源, 请在回复中明确说明原因并询问用户。`;
    }

    // 4) 始终走真实 LLM (SpecializedAgent)
    const specialized = this.getOrCreateSpecializedAgent(agentId, agent.strategyType);

    let output: string;
    try {
      const result = await specialized.executeTask({
        taskId: packetUuid,
        description: taskDesc,
        streamHook,
        llmConfig: mainProvider,
        workspaceFolder,
        activeTools,
        activeSkills,
        activeKnowledge,
      });
      output = result.answer ?? '';
      logger.info(this.moduleName, `executeOnAgent [${agentId}] via LLM packet=${packetUuid} tools=${result.toolCallCount}`);
    } catch (e: any) {
      // LLM 调用失败 — 抛出错误, 不再降级到模拟
      logger.error(this.moduleName, `executeOnAgent [${agentId}] LLM failed: ${e?.message ?? e}`);
      throw new Error(`LLM_EXECUTION_FAILED [${agentId}]: ${e?.message ?? e}`);
    }

    // 更新多维度声誉
    this.reputationEngine.updateFromDirectInteraction(agentId, 'reliability', 0.01, m.version);
    this.reputationEngine.updateFromDirectInteraction(agentId, 'competence', 0.005, m.version);

    this.kernel.eventBus.emit(RuntimeEvent.AgentTaskExecuted, {
      agentId,
      packetUuid,
      packetSizeKb,
      llmExecuted: true,
      durationSimulatedMs: 0,
      timestamp: Date.now(),
    });
    return output;
  }

  // ============================================================
  // subTaskBinding API (B+C 升级配套)
  // ============================================================

  /**
   * 注册 subTaskBinding (前端 phase0 阶段调用, 告诉后端哪个 worker 对应流送区哪个 subTask)
   *   POST /api/agents/bindSubTask { packetUuid, workerIdx, chatId, subTaskId, agentId }
   */
  public bindSubTask(opts: {
    packetUuid: string;
    workerIdx: number;
    chatId: string;
    subTaskId: string;
    agentId: string;
  }): { ok: true; key: string } {
    const key = this.bindingKey(opts.packetUuid, opts.workerIdx);
    this.subTaskBindings.set(key, {
      chatId: opts.chatId,
      subTaskId: opts.subTaskId,
      agentId: opts.agentId,
    });
    logger.debug(this.moduleName, `bind subTask key=${key} → subTaskId=${opts.subTaskId}`);
    return { ok: true, key };
  }

  /**
   * 查 subTaskBinding (供 executeOnAgent 内部 / 测试)
   */
  public getSubTaskBinding(packetUuid: string, workerIdx: number) {
    return this.subTaskBindings.get(this.bindingKey(packetUuid, workerIdx));
  }

  /**
   * 释放 binding (phase3_deliver_done 之后调用, 防止内存泄漏)
   */
  public releasePacketBindings(packetUuid: string): number {
    let released = 0;
    const prefix = `${packetUuid}:`;
    for (const k of this.subTaskBindings.keys()) {
      if (k.startsWith(prefix)) {
        this.subTaskBindings.delete(k);
        released += 1;
      }
    }
    return released;
  }

  private bindingKey(packetUuid: string, workerIdx: number): string {
    return `${packetUuid}:${workerIdx}`;
  }

  /**
   * 在 candidates 里找指定 agentId 对应的 workerIdx
   * 注: 这里简化为线性查找; 真实场景可在 executeOnAgent 调用方把 workerIdx 一并传入
   */
  private findWorkerIdxForAgent(agentId: string, _packetUuid: string): number | undefined {
    // 简化版: 默认 workerIdx=0 (每个 packet 复用同一个 agent 时)
    // 完整版需要在 RACER 调 executeOnAgent 时把 workerIdx 一并传入
    // 这里采用 "packet:agent → 唯一 binding" 的简化策略
    for (const [k, v] of this.subTaskBindings.entries()) {
      if (v.agentId === agentId) {
        const colon = k.lastIndexOf(':');
        if (colon > 0) return Number(k.slice(colon + 1));
      }
    }
    return undefined;
  }

  /**
   * 懒加载 SpecializedAgent
   *   - 第一次调用某 agentId 时, 按其 strategy 构造一个 SpecializedAgent
   *   - 后续调用复用同一个实例 (技能库持续累积)
   */
  public getOrCreateSpecializedAgent(agentId: string, strategy: string): SpecializedAgent {
    if (this.specializedAgents.has(agentId)) {
      return this.specializedAgents.get(agentId)!;
    }
    const strategyMap: Record<string, 'aggressive' | 'conservative' | 'precision' | 'balanced'> = {
      direct: 'aggressive',
      chain_of_thought: 'precision',
      few_shot: 'conservative',
    };
    const execStrategy = strategyMap[strategy] ?? 'balanced';

    const specialized = new SpecializedAgent({
      agentId,
      domain: 'code-dev',
      level: 'senior',
      role: `RACER ${strategy} worker`,
      capabilities: ['read', 'write', 'search', 'execute', 'analyze'],
      defaultStrategy: execStrategy,
      systemPrompt:
        'You are a SoloForge RACER worker. You can use tools (read_file, write_file, search_code, execute_cmd) to solve the user\'s task. ' +
        'If a tool can help, call it. After enough information is gathered, give a concise final answer.',
    });
    this.specializedAgents.set(agentId, specialized);
    logger.info(this.moduleName, `SpecializedAgent created for [${agentId}] (${strategy} → ${execStrategy})`);
    return specialized;
  }

  // ============================================================
  // 法院事件桥接
  // ============================================================

  private subscribeToCourtAdjudications(): void {
    this.kernel.eventBus.on(CourtEvent.ARBITRATION_DECIDED, (payload: any) => {
      const winnerId: string | null = payload?.winner || null;
      if (!winnerId) return;

      this.rewardReputation(winnerId, 0.05, 'court_victory');

      for (const [agentId, m] of this.metrics.entries()) {
        if (agentId !== winnerId && m.disputes > 0) {
          this.penalizeReputation(agentId, 0.10, 'court_defeat');
        }
      }
    });

    this.kernel.eventBus.on(CourtEvent.DEADLOCK_DETECTED, () => {
      for (const id of this.agents.keys()) {
        this.penalizeReputation(id, 0.02, 'court_deadlock');
      }
    });
  }

  public async raiseDispute(claim: AdjudicationArgumentClaim, traceId: string): Promise<any> {
    const m = this.metrics.get(claim.originatingAgentId);
    if (m) m.disputes += 1;
    this.kernel.eventBus.emit(RuntimeEvent.AgentDisputeRaised, {
      traceId,
      agentId: claim.originatingAgentId,
      statement: claim.disputedClaimStatement,
      evidenceCount: claim.linkedEvidenceRegistry.length,
      timestamp: Date.now(),
    });
    return this.kernel.commandBus.execute({
      id: crypto.randomUUID(),
      type: 'EXECUTE_EVIDENTIARY_ARBITRATION',
      domain: 'AgentRegistry',
      caller: this.moduleName,
      payload: {
        traceId,
        argumentsList: [claim],
        evidenceSnapshotMap: this.buildEvidenceSnapshot(claim),
      },
    });
  }

  private buildEvidenceSnapshot(claim: AdjudicationArgumentClaim): Record<string, any> {
    const snapshot: Record<string, any> = {};
    let idx = 0;
    for (const evidence of claim.linkedEvidenceRegistry) {
      const key = `ev_${idx++}`;
      const isFraud = evidence.includes('fraud_poison');
      snapshot[key] = {
        id: key,
        credibilityIndex: isFraud ? 0.05 : 0.85,
        relevanceWeight: isFraud ? 0.10 : 0.80,
        temporalRecencyValue: 0.70,
        rawContent: evidence,
      };
    }
    return snapshot;
  }

  // ============================================================
  // 信用分操作 — v2: 带 CAS 版本号
  // ============================================================

  public penalizeReputation(agentId: string, deduction: number, reason: string): void {
    const agent = this.agents.get(agentId);
    if (!agent) return;
    const m = this.metrics.get(agentId)!;
    m.version += 1;

    agent.penalizeReputation(deduction);
    m.lastDelta = -deduction;
    if (reason === 'court_defeat') m.losses += 1;

    // 更新多维度声誉: 根据原因选择维度
    const dimension = reason.includes('fraud') ? 'integrity' : 'reliability';
    this.reputationEngine.updateFromDirectInteraction(agentId, dimension, -deduction, m.version);

    this.kernel.eventBus.emit(RuntimeEvent.AgentReputationUpdated, {
      agentId,
      delta: -deduction,
      reason,
      newScore: agent.reputationScore,
      version: m.version,
    });
  }

  public rewardReputation(agentId: string, bonus: number, reason: string): void {
    const agent = this.agents.get(agentId);
    if (!agent) return;
    const m = this.metrics.get(agentId)!;
    m.version += 1;

    agent.rewardReputation(bonus);
    m.lastDelta = bonus;
    if (reason === 'court_victory') m.wins += 1;

    this.reputationEngine.updateFromDirectInteraction(agentId, 'integrity', bonus, m.version);

    this.kernel.eventBus.emit(RuntimeEvent.AgentReputationUpdated, {
      agentId,
      delta: bonus,
      reason,
      newScore: agent.reputationScore,
      version: m.version,
    });
  }

  // ============================================================
  // 社会层信用同步 — v2: 带版本号 CAS
  // ============================================================

  private async syncReputationToSociety(): Promise<void> {
    for (const [agentId, agent] of this.agents.entries()) {
      const m = this.metrics.get(agentId)!;
      const repSnapshot = this.reputationEngine.get(agentId);
      const components = repSnapshot?.components ?? {
        taskCompletion: agent.reputationScore,
        errorRate: 1.0 - agent.reputationScore,
        collaboration: agent.reputationScore * 0.9,
        reliability: agent.reputationScore,
      };

      try {
        await this.kernel.commandBus.execute({
          id: crypto.randomUUID(),
          type: 'UPDATE_REPUTATION_SCORE',
          domain: 'AgentRegistry',
          caller: this.moduleName,
          payload: {
            traceId: `agent_sync_${agentId}_${Date.now()}`,
            entityId: agentId,
            entityType: 'agent',
            version: m.version,
            components,
            evidence: `agent_pool_sync @ ${new Date().toISOString()}`,
          },
        });
      } catch (e: any) {
        logger.debug(this.moduleName, `social sync skipped for ${agentId}: ${e.message}`);
      }
    }
  }

  // ============================================================
  // Gossip 周期 — 参考 RepuNet 间接闲谈传播
  // ============================================================

  private runGossipCycle(): void {
    const agentIds = Array.from(this.agents.keys());
    if (agentIds.length < 2) return;

    // 每个 Agent 随机选择 1-2 个其他 Agent 进行闲谈
    for (const agentId of agentIds) {
      const others = agentIds.filter(id => id !== agentId);
      const gossipTargets = others.sort(() => Math.random() - 0.5).slice(0, Math.min(2, others.length));

      for (const targetId of gossipTargets) {
        const rep = this.reputationEngine.get(targetId);
        if (rep) {
          // 传播关于目标的声誉信息
          const gossip = this.reputationEngine.createGossip(agentId, targetId, 'reliability', rep.components.reliability > 0.7 ? 0.02 : -0.01);
          this.reputationEngine.receiveGossip(gossip);
        }
      }
    }

    // 处理 Gossip 缓冲
    this.reputationEngine.processGossipBuffer();
  }

  // ============================================================
  // 快照 / 调试
  // ============================================================

  public snapshot(): AgentSnapshot[] {
    return Array.from(this.agents.values()).map((agent) => {
      const m = this.metrics.get(agent.agentId)!;
      return {
        agentId: agent.agentId,
        strategyType: agent.strategyType,
        reputationScore: agent.reputationScore,
        reputationComponents: { ...agent.reputationComponents },
        evidenceCount: agent.evidenceVault.size,
        stakeBalance: agent.stakeBalance,
        totalExecutions: m.executions,
        totalDisputes: m.disputes,
        totalWins: m.wins,
        totalLosses: m.losses,
      };
    });
  }

  public setCpuLoad(load: number): void {
    this.currentCpuLoad = Math.max(0, Math.min(1, load));
  }

  public getCpuLoad(): number {
    return this.currentCpuLoad;
  }
}
