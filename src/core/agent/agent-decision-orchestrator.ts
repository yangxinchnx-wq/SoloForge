// ─────────────────────────────────────────────────────────────────
// SoloForge Agent Core: Decision Orchestrator
// Path: src/core/agent/agent-decision-orchestrator.ts
//
// v3: 真实 LLM 调用 — prompt 全链路透传，streamHook 后端直接创建
// v3.1 (2026-07-08): L1 入口分流 — Orchestrator 模式
//   简单任务跳过 RACER + Agent Loop,直接单次 LLM 调用;
//   复杂任务走完整 RACER 选路 + Agent 工具循环。
//   参考: Orchestrator vs AgenticLoop 架构 (LLM 决策与执行分离)
// ─────────────────────────────────────────────────────────────────

import crypto from 'crypto';
import { SoloForgeRTRRacerEngine, ModelStrategyCandidate, RacerFlowResult } from '../decision/rtr-racer-engine';
import { AgentRegistry, AgentDispatchRequest, AgentDispatchResult } from './agent-registry';
import { RuntimeEvent } from '../events/runtime-events';
import { logger } from '../logger';
import type { RuntimeKernel } from '../../kernel/runtime-kernel';
import { callLLMWithTools, type LLMMessage } from './tools/function-calling-client';
import { getLLMProxyConfig } from '../../llm/llmConfig';

export class AgentDecisionOrchestrator {
  private readonly moduleName = 'AgentDecisionOrchestrator';
  private readonly racerEngine: SoloForgeRTRRacerEngine;
  private readonly registry: AgentRegistry;
  private readonly kernel: RuntimeKernel;

  constructor(kernel: RuntimeKernel, registry: AgentRegistry) {
    this.kernel = kernel;
    this.registry = registry;
    this.racerEngine = new SoloForgeRTRRacerEngine(kernel as any, kernel.schedulerClient);
  }

  /**
   * 高层入口: 派发一个网络包任务，让 RACER 选 agent 执行
   * v3: prompt 全链路透传到真实 LLM，streamHook 后端直接创建（不依赖前端 bindSubTask）
   * v3.1: L1 入口分流 — 简单任务直接 LLM 调用,跳过 RACER + Agent Loop
   */
  public async dispatchPacket(req: AgentDispatchRequest): Promise<AgentDispatchResult> {
    const start = Date.now();
    const packetUuid = req.packetUuid ?? `pkt_${crypto.randomBytes(4).toString('hex')}`;
    const chatId = req.chatId ?? '__no_chat__';
    const prompt = req.prompt ?? '';

    if (!prompt) {
      throw new Error('DISPATCH_ERROR: prompt is required');
    }

    // ── L1 入口分流: 简单任务跳过 RACER + Agent Loop ──
    // 参考 Orchestrator 模式: LLM 只在路由和合成时介入,中间执行是确定性代码。
    // 这里用确定性规则分类,零 LLM 消耗 (类似 Wayfinder Router 思路)。
    if (!this.shouldUseAgent(prompt, req)) {
      logger.info(this.moduleName,
        `L1 bypass: simple task detected, direct LLM call (prompt=${prompt.length} chars)`
      );
      return this.executeDirectLLM(req, packetUuid, chatId, start);
    }

    // ── 复杂任务: 走完整 RACER 选路 + Agent 工具循环 ──

    const packetSizeKb = req.packetSizeKb ?? Math.floor(Math.random() * 64) + 1;
    const history = req.history ?? [];
    const activeFile = req.activeFile ?? null;
    const mainProvider = req.mainProvider;
    const workspaceFolder = req.workspaceFolder;
    const activeTools = req.activeTools;
    const activeSkills = req.activeSkills;
    const activeKnowledge = req.activeKnowledge;

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
    } catch (e: unknown) {
      const errMsg = e instanceof Error ? e.message : String(e);
      logger.debug(this.moduleName, `releasePacketBindings(${packetUuid}) failed: ${errMsg}`);
    }

    return result;
  }

  private isLowConfidence(req: AgentDispatchRequest, candidates: ModelStrategyCandidate[]): boolean {
    const confidence = req.globalConfidenceMetric ?? 0.75;
    const complexity = req.taskComplexityMetrics ?? 0.30;
    return confidence < 0.6 && complexity > 0.4 && candidates.length >= 3;
  }

  // ── L1 入口分流: 确定性分类器 ──────────────────────────────────────

  /**
   * 判断任务是否需要走 Agent (RACER + 工具循环)。
   *
   * 设计原则 (参考 Wayfinder Router):
   *   - 纯确定性规则,零 LLM 消耗
   *   - 基于 prompt 结构特征,不是关键词匹配
   *   - 宁可漏判 (走 Agent),不可误判 (跳过需要工具的任务)
   *
   * 判断维度:
   *   1. 文件操作意图 — 包含文件路径或代码操作动词 → 需要工具
   *   2. 多步骤指令 — 包含"然后/接着/第一步"等连接词 → 需要 Agent 编排
   *   3. 上下文依赖 — 有文件上下文或对话历史 → 可能需要工具
   *   4. 纯问答类 — 问答句式且长度短 → 不需要工具
   */
  private shouldUseAgent(prompt: string, req: AgentDispatchRequest): boolean {
    // 维度 1: 文件路径引用 (如 src/foo.ts, ./config.json, /path/to/file)
    // 最强信号 — 几乎一定需要 read_file / write_file
    if (/[a-zA-Z]:\\|\.\/|\/[a-zA-Z]|\\\\/.test(prompt) && /\.\w{1,5}\b/.test(prompt)) {
      return true;
    }

    // 维度 2: 代码操作意图动词 (中英文)
    const actionPattern = /(?:修改|创建|删除|重构|编写|修复|实现|添加|更新|迁移|优化|调试|fix|refactor|write|create|delete|implement|add|update|migrate|optimize|debug|build)/i;
    if (actionPattern.test(prompt)) {
      return true;
    }

    // 维度 3: 多步骤指令 (需要 Agent 编排)
    const multiStepPattern = /(?:然后|接着|第一步|第二步|首先.*然后|先.*再|step\s*\d|first.*then)/i;
    if (multiStepPattern.test(prompt)) {
      return true;
    }

    // 维度 4: 有文件上下文 → 可能需要分析文件
    if (req.activeFile?.content && req.activeFile.content.length > 50) {
      return true;
    }

    // 维度 5: 有活跃工具/技能 → 用户期望走 Agent
    if (req.activeTools && req.activeTools.length > 0) {
      return true;
    }

    // 维度 6: 纯问答类短消息 → 跳过 Agent
    // 匹配常见问答句式: "什么是X", "如何Y", "解释Z", "hello", "你好" 等
    const questionPattern = /^(?:什么是|如何|为什么|怎么|请问|解释|翻译|总结|概括|hello|hi|你好|hey|explain|what is|how to|why|summarize|translate)/i;
    if (questionPattern.test(prompt.trim()) && prompt.length < 300) {
      return false;
    }

    // 维度 7: 短消息 (< 80 字符) 且无明确操作意图 → 跳过 Agent
    if (prompt.length < 80 && !actionPattern.test(prompt)) {
      return false;
    }

    // 默认: 走 Agent (宁可多走,不可漏判)
    return true;
  }

  /**
   * 简单任务直连 LLM — 跳过 RACER + Agent Loop,只做一次 LLM 调用。
   *
   * 参考 Orchestrator 模式:
   *   - LLM 调用 1 (路由): 已由 shouldUseAgent() 的确定性规则替代,零消耗
   *   - 执行: 这里的单次 LLM 调用 (无工具)
   *   - LLM 调用 2 (合成): 不需要,直接返回 LLM 原始输出
   *
   * 节省的 token:
   *   - 工具定义 (~1200 token): 不发送 tools 参数
   *   - Agent system prompt (~200 token): 不注入角色定义
   *   - 多轮工具循环 (1000-20000+ token): 不存在多轮
   *   总计: 简单任务从 ~2500 token 降到 ~500 token
   */
  private async executeDirectLLM(
    req: AgentDispatchRequest,
    packetUuid: string,
    chatId: string,
    start: number,
  ): Promise<AgentDispatchResult> {
    const prompt = req.prompt ?? '';
    const history = req.history ?? [];
    const activeFile = req.activeFile ?? null;
    const mainProvider = req.mainProvider;

    // 构建消息列表 (与 Agent Loop 相同的格式,但不注入 Agent 角色)
    const messages: LLMMessage[] = [];

    // 如果有对话历史,作为上下文注入
    if (history.length > 0) {
      const historyText = history
        .slice(-10)
        .map(h => `[${h.sender}]: ${h.content}`)
        .join('\n');
      messages.push({ role: 'system', content: `对话历史:\n${historyText}` });
    }

    // 如果有文件上下文,注入
    if (activeFile?.content) {
      messages.push({
        role: 'system',
        content: `当前文件: ${activeFile.name}\n\`\`\`\n${activeFile.content.slice(0, 4000)}\n\`\`\``,
      });
    }

    messages.push({ role: 'user', content: prompt });

    // 单次 LLM 调用,无工具,无循环
    const llmConfig = mainProvider;
    let baseUrl: string;
    let apiKey: string;
    let model: string;

    if (llmConfig?.apiKey) {
      baseUrl = llmConfig.baseUrl.replace(/\/$/, '');
      apiKey = llmConfig.apiKey;
      model = llmConfig.model;
    } else {
      const cfg = getLLMProxyConfig();
      baseUrl = cfg.baseUrl.replace(/\/$/, '');
      apiKey = cfg.apiKey;
      model = cfg.defaultModel;
    }

    const result = await callLLMWithTools({
      messages,
      tools: [], // 无工具 → LLM 直接回复,不走工具循环
      model,
      temperature: 0.3,
      maxTokens: 4096,
      maxRounds: 1, // 只允许 1 轮
      llmConfig: mainProvider,
      tokenBudget: 0, // 禁用预算 (只有 1 轮,不需要)
    });

    const output = result.finalMessage.content ?? '';
    const winnerAgentId = 'direct_llm';

    // 发送流送区事件 (保持与 RACER 路径一致的事件流)
    this.kernel.eventBus.emit(RuntimeEvent.AgentTaskDispatched, {
      packetUuid,
      packetSizeKb: 0,
      candidateCount: 0,
      chatId,
      timestamp: Date.now(),
    });
    this.kernel.eventBus.emit('phase3_deliver_done', {
      packetUuid,
      chatId,
      reply: output,
      ts: Date.now(),
    });

    logger.info(this.moduleName,
      `L1 direct: ${result.totalDurationMs}ms, ~${result.totalTokensEstimated} tokens`
    );

    return {
      packetUuid,
      winnerAgentId,
      strategy: 'direct',
      output,
      score: 1.0,
      parallel: false,
      candidateCount: 0,
      durationMs: Date.now() - start,
    };
  }
}
