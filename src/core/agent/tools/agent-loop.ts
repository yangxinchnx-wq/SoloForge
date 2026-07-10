/**
 * agent-loop.ts — Agent 循环引擎
 *
 * 核心循环: think → call tool → observe → think → ... → 最终回复
 *
 * 这是真正让 Agent "活" 起来的模块:
 *   1. 接收用户任务
 *   2. 构建 System Prompt（角色 + 技能库经验 + 工具说明）
 *   3. 调用 LLM，LLM 可以选择调用工具或直接回复
 *   4. 工具结果自动追加到上下文，LLM 继续推理
 *   5. 重复直到 LLM 给出最终文本回复（或达到最大轮数）
 *   6. 提炼经验写入技能库（自进化）
 */

import { logger } from '../../logger/index';
import {
  callLLMWithTools,
  type LLMMessage,
  type CallWithToolsResult,
} from './function-calling-client';
import {
  getToolsForActiveIds,
  type ToolCallRequest,
  type ToolCallResult,
  type ToolStreamHook,
  executeToolCall,
} from './tool-definitions';

// ─── Agent 执行上下文 ───────────────────────────────────────────────

export interface AgentExecutionContext {
  agentId: string;
  domain: string;
  role: string;
  systemPrompt: string;
  skills: string[];
  maxRounds?: number;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  /**
   * 可选: 流送区事件注入点
   */
  streamHook?: {
    chatId: string;
    subTaskId: string;
    emit: (
      eventName: 'tool_started' | 'tool_completed' | 'tool_stdout' | 'tool_stderr' | 'tool_exit',
      payload: {
        chatId: string;
        subTaskId: string;
        agentId?: string;
        tool?: string;
        toolCallId?: string;
        args?: string;
        success?: boolean;
        result?: string;
        error?: string;
        exitCode?: number;
        chunk?: string;
        durationMs?: number;
        ts: number;
      }
    ) => void;
  };
  /**
   * 可选: LLM provider 覆盖 (前端传入的 apiKey + baseUrl + model)
   * 不传时 function-calling-client 使用环境变量配置
   */
  llmConfig?: { baseUrl: string; apiKey: string; model: string };
  /** 工作区文件夹路径 (用于路径强制校验) */
  workspaceFolder?: string;
  /** 前端选中的工具 ID 列表 (控制 LLM 可用的 tools) */
  activeTools?: string[];
  /** 前端选中的技能 ID 列表 */
  activeSkills?: string[];
  /** 前端选中的知识库 ID 列表 */
  activeKnowledge?: string[];
  /**
   * L4: Token 预算上限 (估算值)。
   * 传给 callLLMWithTools,默认 50000 token。
   * 设为 0 或 Infinity 可禁用预算控制。
   */
  tokenBudget?: number;
  /**
   * Agent 通信总线 (2026-07-09 新增)
   * 并行执行时,工具发现通过 commBus.broadcast 共享给 peer agent
   * 每轮 LLM 调用前 commBus.poll 注入 peer 的发现
   */
  commBus?: any;
  /** 并行执行时的 peer agent ID 列表 (commBus.broadcast 的接收方) */
  peerAgentIds?: string[];
}

// ─── Agent 执行结果 ─────────────────────────────────────────────────

export interface AgentLoopResult {
  /** LLM 最终的文本回复 */
  finalAnswer: string;
  /** 完整的多轮对话历史（含工具调用） */
  messages: LLMMessage[];
  /** 工具调用次数 */
  toolCallCount: number;
  /** 总耗时 */
  durationMs: number;
  /** Agent 是否使用了工具 */
  usedTools: boolean;
  /** 每步工具调用的摘要 */
  toolSteps: Array<{ round: number; tool: string; args: string; success: boolean }>;
  /** L4: 累计估算 token 消耗 */
  totalTokensEstimated: number;
  /** L3: 是否因无进展检测提前退出 */
  exitedByStallDetection: boolean;
  /** L4: 是否因超预算提前退出 */
  exitedByTokenBudget: boolean;
  /** 工具结果缓存命中次数 */
  cacheHits?: number;
  /** 真实 token 消耗 (从 LLM usage 字段累加, 2026-07-09) */
  actualTokenUsage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cachedTokens: number;
    llmCallCount: number;
  };
}

// ─── 核心循环 ───────────────────────────────────────────────────────

/**
 * 执行 Agent 循环
 *
 * LLM 被赋予工具后，会自主决定:
 *   - 先读文件了解现有代码？
 *   - 搜索代码找参考？
 *   - 直接写文件生成代码？
 *   - 执行命令验证结果？
 *
 * 整个过程由 LLM 自主驱动，Agent 框架只负责:
 *   - 提供工具
 *   - 执行工具
 *   - 管理上下文
 *   - 控制最大轮数
 */
export async function runAgentLoop(ctx: AgentExecutionContext, userTask: string): Promise<AgentLoopResult> {
  const start = Date.now();
  const toolSteps: AgentLoopResult['toolSteps'] = [];

  // 根据 activeTools 动态构建工具列表
  const effectiveTools = getToolsForActiveIds(ctx.activeTools);

  // 构建消息列表 (按稳定性严格排序,配合 Prompt Caching)
  // 顺序: system(稳定) → system(动态:技能/知识库) → user(任务)
  const stableSystemPrompt = buildStableSystemPrompt(ctx);
  const dynamicContext = buildDynamicContext(ctx);

  const messages: LLMMessage[] = [
    // 第 1 层: 稳定 system prompt (角色 + 画布ACL + 预览指令) - 构成缓存前缀
    { role: 'system', content: stableSystemPrompt },
  ];

  // 第 2 层: 动态上下文 (技能/知识库/工作区) - 独立 system message,变化不影响第 1 层缓存
  if (dynamicContext) {
    messages.push({ role: 'system', content: dynamicContext });
  }

  // 第 3 层: 用户任务 (每轮变化)
  messages.push({ role: 'user', content: userTask });

  logger.info('AgentLoop', `[${ctx.agentId}] Starting: "${userTask.slice(0, 80)}..."`);

  // 调用 LLM + 工具循环
  const result: CallWithToolsResult = await callLLMWithTools({
    messages,
    tools: effectiveTools,
    model: ctx.model,
    temperature: ctx.temperature ?? 0.2,
    maxTokens: ctx.maxTokens ?? 4096,
    maxRounds: ctx.maxRounds ?? 20,
    tokenBudget: ctx.tokenBudget,
    llmConfig: ctx.llmConfig,
    chatId: ctx.streamHook?.chatId, // P2: 传入 chatId 启用跨 dispatch 缓存
    onToolCall: async (call: ToolCallRequest) => {
      logger.info('AgentLoop', `[${ctx.agentId}] Tool: ${call.name}(${JSON.stringify(call.arguments).slice(0, 100)})`);
      const argsJson = JSON.stringify(call.arguments).slice(0, 200);

      // 流送区: tool_started (在执行工具前 emit, 让 UI 立即看到"开始调用")
      const hook = ctx.streamHook;
      if (hook) {
        try {
          hook.emit('tool_started', {
            chatId: hook.chatId,
            subTaskId: hook.subTaskId,
            agentId: ctx.agentId,
            tool: call.name,
            toolCallId: call.id,
            args: argsJson,
            ts: Date.now(),
          });
        } catch (emitErr: any) {
          logger.warn('AgentLoop', `[${ctx.agentId}] streamHook emit(tool_started) failed: ${emitErr?.message ?? emitErr}`);
        }
      }

      // 透传 streamHook 给 executeToolCall, 让 execute_cmd 的 stdout/stderr 流式 emit
      const toolStart = Date.now();
      const toolResult = await executeToolCall({
        ...call,
        streamHook: hook
          ? {
              chatId: hook.chatId,
              subTaskId: hook.subTaskId,
              emit: (eventName, payload) => hook.emit(eventName, payload),
            }
          : undefined,
        workspaceFolder: ctx.workspaceFolder,
      } as ToolCallRequest);
      const toolDurationMs = Date.now() - toolStart;

      toolSteps.push({
        round: toolSteps.length + 1,
        tool: call.name,
        args: argsJson,
        success: !toolResult.isError,
      });
      logger.info('AgentLoop', `[${ctx.agentId}] Tool ${call.name}: ${toolResult.isError ? 'ERROR' : 'OK'} (${toolResult.durationMs}ms)`);

      // 流送区: tool_completed (执行后 emit, UI 看到结果/耗时/成败)
      if (hook) {
        try {
          hook.emit('tool_completed', {
            chatId: hook.chatId,
            subTaskId: hook.subTaskId,
            agentId: ctx.agentId,
            tool: call.name,
            toolCallId: call.id,
            args: argsJson,
            success: !toolResult.isError,
            result: toolResult.output ? toolResult.output.slice(0, 500) : undefined,
            error: toolResult.isError ? toolResult.output : undefined,
            durationMs: toolDurationMs,
            ts: Date.now(),
          });
        } catch (emitErr: any) {
          logger.warn('AgentLoop', `[${ctx.agentId}] streamHook emit(tool_completed) failed: ${emitErr?.message ?? emitErr}`);
        }
      }

      // ── CommBus: 广播工具发现给 peer agent (2026-07-09) ──────────
      // 并行执行时,把工具发现(工具名+参数+结果摘要)广播给 peer
      // peer 在下一轮 LLM 调用前 poll 注入,避免重复探索相同文件
      if (ctx.commBus && ctx.peerAgentIds && ctx.peerAgentIds.length > 0 && !toolResult.isError) {
        try {
          ctx.commBus.broadcast(ctx.agentId, 'INFORM', {
            type: 'tool_finding',
            tool: call.name,
            args: call.arguments,
            summary: toolResult.output?.slice(0, 500) ?? '',
          }, ctx.peerAgentIds);
        } catch {
          // CommBus 广播失败不影响主流程
        }
      }

      return toolResult;
    },
    onThinking: (text: string) => {
      logger.info('AgentLoop', `[${ctx.agentId}] Thinking: "${text.slice(0, 100)}..."`);
    },
    // ── CommBus: 每轮 LLM 调用前 poll peer 发现并注入 (2026-07-09) ──
    onRoundStart: (round: number): LLMMessage[] | void => {
      if (!ctx.commBus || round === 0) return;
      try {
        const peerMsgs = ctx.commBus.poll(ctx.agentId);
        if (peerMsgs.length === 0) return;
        // 把 peer 的工具发现汇总成一条 system 消息注入
        const findings = peerMsgs
          .filter((m: any) => m.content?.type === 'tool_finding')
          .map((m: any) => {
            const c = m.content;
            return `[${m.sender}] ${c.tool}(${JSON.stringify(c.args).slice(0, 80)}) → ${c.summary?.slice(0, 200) ?? ''}`;
          });
        if (findings.length === 0) return;
        return [{
          role: 'system',
          content: `[同侪发现 ${round}]\n其他 agent 已探索的工具结果,你可以参考但不必重复调用:\n${findings.join('\n')}`,
        }];
      } catch {
        return;
      }
    },
  });

  const finalAnswer = result.finalMessage.content ?? '';

  // L3/L4 日志: 记录退出原因,方便调试和监控
  const exitReason = result.exitedByStallDetection
    ? 'STALL_DETECTION'
    : result.exitedByTokenBudget
      ? 'TOKEN_BUDGET'
      : 'NORMAL';
  logger.info('AgentLoop',
    `[${ctx.agentId}] Done: ${result.toolCallCount} tool calls, ` +
    `${result.totalDurationMs}ms, ~${result.totalTokensEstimated} tokens, ` +
    `exit=${exitReason}, answer=${finalAnswer.length} chars`
  );

  return {
    finalAnswer,
    messages: result.allMessages,
    toolCallCount: result.toolCallCount,
    durationMs: result.totalDurationMs,
    usedTools: result.toolCallCount > 0,
    toolSteps,
    totalTokensEstimated: result.totalTokensEstimated,
    exitedByStallDetection: result.exitedByStallDetection,
    exitedByTokenBudget: result.exitedByTokenBudget,
    cacheHits: result.cacheHits,
    actualTokenUsage: result.actualTokenUsage,
  };
}

// ─── System Prompt 构建 ─────────────────────────────────────────────
// 2026-07-07 重构: 拆分为稳定/动态两部分,配合 Prompt Caching
//   - buildStableSystemPrompt: 角色定义 + 画布ACL + 预览指令 (极少变化,构成缓存前缀)
//   - buildDynamicContext: 技能/知识库/工作区 (可能变化,独立 system message)

/**
 * 构建稳定的 system prompt (构成 Prompt Caching 前缀)
 * 只包含极少变化的内容:
 *   1. 角色定义
 *   2. 画布 ACL (chatId,每对话固定)
 *   3. 预览触发指令
 */
function buildStableSystemPrompt(ctx: AgentExecutionContext): string {
  const parts: string[] = [];

  // 1. 角色定义
  parts.push(ctx.systemPrompt);

  // 2. 画布 ACL (必需,否则 LLM 会编造 chatId)
  const chatId = ctx.streamHook?.chatId;
  if (chatId) {
    parts.push(`## 画布上下文
requesterChatSessionId: ${chatId}
调用 solo_canvas_* 工具时,必须把 requesterChatSessionId 参数填成上面这个值。canvasId 参数可选,不传时系统自动用当前对话绑定的画布。`);
  }

  // 3. 预览触发指令 (P1 瘦身: ~300 token → ~120 token, 保留核心信息)
  parts.push(`## 画布预览
前端内置本地翻译器,自动渲染回复中的 UI 代码块 (html/tsx/vue/dart/swift/kotlin/xml/xaml/qml/python/c)。
- 生成 UI 时直接用 markdown 代码块返回,无需调工具或加标记
- canvas_push_ui 仅限非代码场景 (svg/流程图) 或用户明确要求 AST 推送`);

  return parts.join('\n\n');
}

/**
 * 构建动态上下文 (作为独立 system message,变化不影响稳定层缓存)
 * 包含:
 *   1. 工作区限制
 *   2. 技能库历史经验
 *   3. 前端选中的技能
 *   4. 前端选中的知识库
 */
function buildDynamicContext(ctx: AgentExecutionContext): string | null {
  const parts: string[] = [];

  // 1. 工作区限制
  if (ctx.workspaceFolder) {
    parts.push(`## 工作区
当前对话已绑定工作区: ${ctx.workspaceFolder}
文件操作限制在此文件夹范围内。路径校验由工具执行时强制检查,无需手动判断。`);
  }

  // 2. 技能库历史经验
  if (ctx.skills && ctx.skills.length > 0) {
    parts.push(`## 历史经验
${ctx.skills.map((s, i) => `${i + 1}. ${s}`).join('\n')}`);
  }

  // 3. 前端选中的技能
  if (ctx.activeSkills && ctx.activeSkills.length > 0) {
    parts.push(`## 用户启用的技能
${ctx.activeSkills.map((s, i) => `${i + 1}. ${s}`).join('\n')}`);
  }

  // 4. 前端选中的知识库
  if (ctx.activeKnowledge && ctx.activeKnowledge.length > 0) {
    parts.push(`## 用户启用的知识库
${ctx.activeKnowledge.map((k, i) => `${i + 1}. ${k}`).join('\n')}`);
  }

  return parts.length > 0 ? parts.join('\n\n') : null;
}

// ─── 便捷函数 ──────────────────────────────────────────────────────

/**
 * 快速执行一个 Agent 任务（一行调用）
 */
export async function quickAgentTask(
  agentId: string,
  domain: string,
  role: string,
  task: string,
  options?: {
    skills?: string[];
    model?: string;
    maxRounds?: number;
  }
): Promise<AgentLoopResult> {
  const systemPrompt = `你是 ${role}，专业领域：${domain}。
你是一个能够使用工具的真实 Agent，不是单纯的文本生成器。
请主动使用工具来完成任务，而不是只给出文字描述。`;

  return runAgentLoop({
    agentId,
    domain,
    role,
    systemPrompt,
    skills: options?.skills ?? [],
    model: options?.model,
    maxRounds: options?.maxRounds,
  }, task);
}
