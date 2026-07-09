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
import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { SoloForgeRTRRacerEngine, ModelStrategyCandidate, RacerFlowResult, WorkerExecResult } from '../decision/rtr-racer-engine';
import { AgentRegistry, AgentDispatchRequest, AgentDispatchResult } from './agent-registry';
import { RuntimeEvent } from '../events/runtime-events';
import { logger } from '../logger';
import type { RuntimeKernel } from '../../kernel/runtime-kernel';
import { callLLMWithTools, type LLMMessage } from './tools/function-calling-client';
import { getLLMProxyConfig } from '../../llm/llmConfig';
import { ExperienceCache, type ExperienceLookup } from './evolution/experience-cache';

export class AgentDecisionOrchestrator {
  private readonly moduleName = 'AgentDecisionOrchestrator';
  private readonly racerEngine: SoloForgeRTRRacerEngine;
  private readonly registry: AgentRegistry;
  private readonly kernel: RuntimeKernel;
  private readonly experience: ExperienceCache;

  constructor(kernel: RuntimeKernel, registry: AgentRegistry) {
    this.kernel = kernel;
    this.registry = registry;
    this.racerEngine = new SoloForgeRTRRacerEngine(kernel as any, kernel.schedulerClient);
    // 经验缓存: 持久化到 data/agent-experience.jsonl
    const dataDir = join(process.cwd(), 'data');
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
    this.experience = new ExperienceCache(dataDir);
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

    // ── 经验缓存优先 (2026-07-09 "不断进化"核心) ──────────────────
    // 用户原话: "这次的agent解决了问题，下次就不请求那么多次了，直接把经验翻出来让llm照着做就行了"
    // 命中经验 → 1 次 LLM 调用 (经验注入), 跳过 RACER + Agent Loop + 工具调用
    // 请求量: 12次 LLM + 工具 IO → 1次 LLM (省 90%+)
    const expHit = this.experience.lookup(prompt);
    if (expHit && expHit.record.successRate >= 0.7) {
      logger.info(this.moduleName,
        `经验命中 [${expHit.record.fingerprint}] ${expHit.matchType}(sim=${expHit.similarity.toFixed(2)}) ` +
        `reuse=${expHit.record.reuseCount} rate=${expHit.record.successRate.toFixed(2)} → 走经验路径`
      );
      return this.executeViaExperience(req, packetUuid, chatId, start, expHit);
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
    const subProviders = req.subProviders ?? [];
    const peerAgentIds = candidates.map(c => c.modelName);

    const racerResult: RacerFlowResult = await this.racerEngine.coordinateRacerFlow(
      candidates,
      stateRegistryKey,
      req.requiresDeepCognition ?? packetSizeKb > 32,
      req.globalConfidenceMetric ?? 0.75,
      req.taskComplexityMetrics ?? 0.30,
      async (selected: ModelStrategyCandidate, workerIdx: number): Promise<WorkerExecResult> => {
        const effectiveWorkerIdx = workerIdx >= 0 ? workerIdx : candidates.findIndex(c => c.modelName === selected.modelName);
        const t0 = Date.now();

        // Staggered launch: 并行 worker 错开 400ms 启动, 避免瞬间并发触发 429
        // winner (workerIdx=0) 立即启动, 后续 worker 依次延迟 400ms
        // 这让前面的请求先进入 LLM 队列, 减少 RPM 瞬时压力
        if (workerIdx > 0) {
          await new Promise(r => setTimeout(r, workerIdx * 400));
        }

        // 副模型分配: workerIdx=0 (winner) 用 mainProvider, 其他用 subProviders
        // 无副模型时所有 worker 共用 mainProvider (向后兼容)
        const effectiveProvider = (workerIdx > 0 && subProviders[workerIdx - 1])
          ? subProviders[workerIdx - 1]
          : mainProvider;

        // 4.1) 流送区 phase1_worker_start
        this.kernel.eventBus.emit('phase1_worker_start', {
          packetUuid,
          chatId,
          workerIdx: effectiveWorkerIdx,
          modelName: selected.modelName,
          provider: effectiveProvider?.model ?? 'unknown',
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

        // 4.3) 执行 — 传递真实 prompt + LLM config + peerAgentIds (CommBus)
        // 并行 worker (workerIdx > 0) 降 maxRounds 控制 token 消耗
        // winner 保留 20 轮,worker 降到 8 轮 (够探索+回答,避免 429)
        const execResult = await this.registry.executeOnAgent(
          selected.modelName,
          packetUuid,
          packetSizeKb,
          effectiveWorkerIdx,
          {
            prompt,
            history,
            activeFile,
            mainProvider: effectiveProvider,
            workspaceFolder,
            activeTools,
            activeSkills,
            activeKnowledge,
            peerAgentIds,
            maxRounds: workerIdx === 0 ? undefined : 8,
          },
        );
        const out = execResult.output;

        const elapsed = Date.now() - t0;

        // 4.4) 流送区 phase1_worker_done
        this.kernel.eventBus.emit('phase1_worker_done', {
          packetUuid,
          chatId,
          workerIdx: effectiveWorkerIdx,
          modelName: selected.modelName,
          provider: effectiveProvider?.model ?? 'unknown',
          content: out,
          ts: Date.now(),
        });

        return {
          output: out,
          durationMs: elapsed,
          provider: effectiveProvider?.model ?? 'unknown',
          actualTokenUsage: execResult.actualTokenUsage,
        };
      },
      req.adaptiveContext
    );

    // 5) 使用 RACER 返回的 winner
    const winnerAgentId = racerResult.winnerModelName;
    const winnerCandidate = candidates.find(c => c.modelName === winnerAgentId) ?? candidates[0];
    const parallel = racerResult.parallelism > 1;

    // 聚合所有 worker 的真实 token 消耗 (2026-07-09)
    const tokenUsage = this.aggregateTokenUsage(racerResult.allOutputs);

    const result: AgentDispatchResult = {
      packetUuid,
      winnerAgentId,
      strategy: winnerCandidate.reasoningStrategy,
      output: racerResult.output,
      score: racerResult.winnerScore,
      parallel,
      candidateCount: candidates.length,
      durationMs: Date.now() - start,
      tokenUsage,
    };

    const tu = tokenUsage;
    const tokenLog = tu ? ` tokens=${tu.totalTokens}(p=${tu.promptTokens} c=${tu.completionTokens}${tu.cachedTokens ? ` cached=${tu.cachedTokens}` : ''} calls=${tu.llmCallCount} workers=${tu.workerCount})` : '';
    logger.info(
      this.moduleName,
      `packet=${packetUuid} -> winner=[${result.winnerAgentId}] (${result.strategy}) ` +
        `score=${result.score.toFixed(3)} parallel=${parallel} t=${result.durationMs}ms${tokenLog}`
    );

    // ── 保存经验 (2026-07-09 "不断进化") ──────────────────────────
    // 成功解决的问题自动入库, 下次相同/相似问题直接复用, 跳过工具调用
    if (racerResult.output && racerResult.output.length > 20 && !racerResult.output.startsWith('[WORKER_ERROR]')) {
      this.saveExperienceFromRacerResult(prompt, racerResult, tokenUsage);
    }

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

  /**
   * 聚合所有 worker 的真实 token 消耗 (2026-07-09)
   * 单路执行时 allOutputs 只有 1 个, 多路并行时累加所有 worker
   */
  private aggregateTokenUsage(
    allOutputs?: Array<{ actualTokenUsage?: { promptTokens: number; completionTokens: number; totalTokens: number; cachedTokens: number; llmCallCount: number } }>
  ): { promptTokens: number; completionTokens: number; totalTokens: number; cachedTokens: number; llmCallCount: number; workerCount: number } | undefined {
    if (!allOutputs || allOutputs.length === 0) return undefined;
    const agg = { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0, llmCallCount: 0, workerCount: 0 };
    for (const w of allOutputs) {
      if (!w.actualTokenUsage) continue;
      agg.promptTokens += w.actualTokenUsage.promptTokens ?? 0;
      agg.completionTokens += w.actualTokenUsage.completionTokens ?? 0;
      agg.totalTokens += w.actualTokenUsage.totalTokens ?? 0;
      agg.cachedTokens += w.actualTokenUsage.cachedTokens ?? 0;
      agg.llmCallCount += w.actualTokenUsage.llmCallCount ?? 0;
      agg.workerCount += 1;
    }
    return agg.workerCount > 0 ? agg : undefined;
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
   *   1. 文件引用 — 路径前缀 OR 裸文件名(扩展名白名单) → 需要工具
   *   2. 纯问答句式优先 — "什么是X/如何Y" 短消息且无文件名 → 跳过 (提前判断,避免动作词误伤)
   *   3. 文件/数据/系统操作动词 — 读取/查看/分析/运行/部署/查询/导出/审查/检查/重启...
   *   4. 多步骤指令 — "然后/接着/第一步" → 需要 Agent 编排
   *   5. 上下文依赖 — 有文件上下文或对话历史 → 可能需要工具
   *   6. 纯问答短消息兜底 — < 80 字符且无动作意图 → 跳过
   */
  private shouldUseAgent(prompt: string, req: AgentDispatchRequest): boolean {
    // 维度 1: 文件引用 — 路径前缀 OR 裸文件名(扩展名白名单)
    // 裸文件名白名单避免误匹配域名(github.com)和版本号(v1.2)
    const pathPrefix = /[a-zA-Z]:\\|\.\/|\/[a-zA-Z]|\\\\/;
    const bareFilename = /\b[a-zA-Z_][\w-]*\.(?:json|yaml|yml|csv|tsv|xlsx|xls|pdf|docx|doc|txt|md|ts|js|tsx|jsx|py|go|rs|java|c|cpp|h|hpp|sql|db|sqlite|parquet|xml|html|css|scss|less|toml|ini|conf|log|env|sh|bash|bat|ps1)\b/i;
    if ((pathPrefix.test(prompt) && /\.\w{1,5}\b/.test(prompt)) || bareFilename.test(prompt)) {
      return true;
    }

    // 维度 2: req 显式信号优先 (用户已激活工具/提供了文件上下文 → 一定走 Agent)
    // 必须在问答句式之前,否则"你好"+activeTools 会被问答判断拦截
    if (req.activeFile?.content && req.activeFile.content.length > 50) {
      return true;
    }
    if (req.activeTools && req.activeTools.length > 0) {
      return true;
    }

    // 维度 3: 纯问答句式优先判断
    // 提前到动作词之前,避免"什么是分析"被动作词误判为需要工具
    const questionPattern = /^(?:什么是|如何|为什么|怎么|请问|解释|翻译|总结|概括|介绍|讲解|说明|hello|hi|你好|hey|explain|what is|how to|why|summarize|translate|introduce)/i;
    if (questionPattern.test(prompt.trim()) && prompt.length < 300 && !bareFilename.test(prompt)) {
      return false;
    }

    // 维度 4: 文件/数据/系统操作意图动词 (中英文,覆盖热门行业)
    const actionPattern = /(?:修改|创建|删除|重构|编写|修复|实现|添加|更新|迁移|优化|调试|读取|查看|分析|运行|部署|安装|提交|导入|导出|查询|清洗|校对|解读|整理|审查|对比|批改|抽取|抓取|检查|重启|监控|搜索|执行|编译|打包|发布|启动|停止|备份|恢复|扫描|诊断|测试|生成报告|fix|refactor|write|create|delete|implement|add|update|migrate|optimize|debug|build|read|view|analyze|run|deploy|install|commit|import|export|query|clean|review|audit|compare|extract|crawl|check|restart|monitor|search|execute|compile|package|publish|start|stop|backup|restore|scan|diagnose|test)/i;
    if (actionPattern.test(prompt)) {
      return true;
    }

    // 维度 5: 多步骤指令 (需要 Agent 编排)
    const multiStepPattern = /(?:然后|接着|第一步|第二步|首先.*然后|先.*再|step\s*\d|first.*then)/i;
    if (multiStepPattern.test(prompt)) {
      return true;
    }

    // 维度 6: 短消息 (< 80 字符) 且无明确操作意图 → 跳过 Agent
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

    const atu = result.actualTokenUsage;
    const tokenLog = atu ? ` actual=${atu.totalTokens}(p=${atu.promptTokens} c=${atu.completionTokens})` : '';
    logger.info(this.moduleName,
      `L1 direct: ${result.totalDurationMs}ms, ~${result.totalTokensEstimated} est tokens${tokenLog}${result.cacheHits ? `, cache=${result.cacheHits}` : ''}`
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
      tokenUsage: atu ? {
        promptTokens: atu.promptTokens,
        completionTokens: atu.completionTokens,
        totalTokens: atu.totalTokens,
        cachedTokens: atu.cachedTokens,
        llmCallCount: atu.llmCallCount,
        workerCount: 1,
      } : undefined,
    };
  }

  /**
   * 经验路径: 1 次 LLM 调用, 把经验作为上下文, 让 LLM 直接生成答案
   * 不调工具, 不走 RACER, 不走 Agent Loop
   * 请求量: 1 次 LLM (vs 正常路径 12+ 次 LLM + 工具 IO)
   */
  private async executeViaExperience(
    req: AgentDispatchRequest,
    packetUuid: string,
    chatId: string,
    start: number,
    expHit: ExperienceLookup,
  ): Promise<AgentDispatchResult> {
    const rec = expHit.record;
    const prompt = req.prompt ?? '';
    const mainProvider = req.mainProvider;

    // 构建 system message: 注入历史经验 (工具序列 + 最终答案)
    const toolSeq = rec.toolSteps.length > 0
      ? rec.toolSteps.map((s, i) => `${i + 1}. ${s.tool}(${s.args.slice(0, 60)}) → ${s.resultSummary.slice(0, 100)}`).join('\n')
      : '(无工具调用, 纯知识回答)';

    const expSystemMsg: LLMMessage = {
      role: 'system',
      content: `[历史经验 #${rec.fingerprint} | 复用 ${rec.reuseCount} 次 | 成功率 ${(rec.successRate * 100).toFixed(0)}%]
你之前解决过相同/相似的问题。以下是当时的探索路径和最终答案:

【当时的工具调用序列】
${toolSeq}

【当时的最终答案】
${rec.finalAnswer.slice(0, 1500)}

请基于以上经验, 直接回答用户当前的问题。如果当前问题与历史经验完全一致, 可以直接复用答案要点; 如果有细微差异, 请针对性调整。不要重复调用工具。`,
    };

    const messages: LLMMessage[] = [expSystemMsg];

    // 注入 history
    if (req.history && req.history.length > 0) {
      for (const h of req.history.slice(-4)) {
        messages.push({ role: h.sender === 'user' ? 'user' : 'assistant', content: h.content });
      }
    }

    messages.push({ role: 'user', content: prompt });

    const result = await callLLMWithTools({
      messages,
      tools: [], // 无工具 → 直接基于经验回答
      model: mainProvider?.model,
      temperature: 0.2,
      maxTokens: 2048,
      maxRounds: 1,
      llmConfig: mainProvider,
      tokenBudget: 0,
    });

    const output = result.finalMessage.content ?? '';
    const atu = result.actualTokenUsage;

    // 记录经验被复用 (更新使用统计)
    this.experience.recordReuse(rec.fingerprint, true);

    // 流送区事件
    this.kernel.eventBus.emit('phase3_deliver_done', {
      packetUuid,
      chatId,
      reply: output,
      ts: Date.now(),
    });

    const tu = atu ? ` tokens=${atu.totalTokens}(p=${atu.promptTokens} c=${atu.completionTokens})` : '';
    logger.info(this.moduleName,
      `经验路径: ${Date.now() - start}ms${tu} reuse=${rec.reuseCount + 1} sim=${expHit.similarity.toFixed(2)}`
    );

    return {
      packetUuid,
      winnerAgentId: 'experience_cache',
      strategy: 'experience',
      output,
      score: expHit.similarity,
      parallel: false,
      candidateCount: 0,
      durationMs: Date.now() - start,
      tokenUsage: atu ? {
        promptTokens: atu.promptTokens,
        completionTokens: atu.completionTokens,
        totalTokens: atu.totalTokens,
        cachedTokens: atu.cachedTokens,
        llmCallCount: atu.llmCallCount,
        workerCount: 1,
      } : undefined,
      experienceFingerprint: rec.fingerprint,
    };
  }

  /**
   * 对经验打分 (供前端 👍/👎 反馈调用)
   * 返回 { alive, successRate } — alive=false 表示经验已因低分失效
   */
  public rateExperience(fingerprint: string, positive: boolean): { alive: boolean; successRate: number } {
    const alive = this.experience.rateExperience(fingerprint, positive);
    const rec = this.experience.getAll().find(r => r.fingerprint === fingerprint);
    return { alive, successRate: rec?.successRate ?? 0 };
  }

  /** 根据 prompt 文本查找经验 fingerprint (前端反馈时定位) */
  public findExperienceFingerprint(prompt: string): string | null {
    return this.experience.findFingerprint(prompt);
  }

  /**
   * 从 RACER 结果保存经验 (Agent Loop 成功后调用)
   * 提取 winner 的工具调用序列 + 最终答案, 存入经验缓存
   */
  private saveExperienceFromRacerResult(
    prompt: string,
    racerResult: RacerFlowResult,
    tokenUsage: { totalTokens: number; promptTokens: number; completionTokens: number; cachedTokens: number; llmCallCount: number; workerCount: number } | undefined,
  ): void {
    try {
      // 找 winner 的输出 (allOutputs 中 agentId == winnerModelName 的)
      const winnerOutput = racerResult.allOutputs?.find(o => o.agentId === racerResult.winnerModelName);
      if (!winnerOutput) return;

      // 工具序列: allOutputs 没有保存详细 toolSteps, 用 output 摘要代替
      // (详细的 toolSteps 在 AgentLoopResult 里, 但没传递到 RACER 层)
      // 这里用 output 的前 500 字符作为 "工具发现摘要"
      const toolSteps = [{
        tool: 'agent_loop',
        args: prompt.slice(0, 100),
        resultSummary: winnerOutput.output.slice(0, 500),
      }];

      this.experience.record({
        prompt,
        toolSteps,
        finalAnswer: racerResult.output,
        tokenCost: tokenUsage?.totalTokens ?? 0,
        durationMs: winnerOutput.durationMs,
      });
    } catch (e) {
      logger.warn(this.moduleName, `保存经验失败: ${e instanceof Error ? e.message : e}`);
    }
  }
}
