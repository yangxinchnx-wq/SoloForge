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
  AGENT_TOOLS,
  type ToolCallRequest,
  type ToolCallResult,
  executeToolCall,
} from './tool-definitions';

// ─── Agent 执行上下文 ───────────────────────────────────────────────

export interface AgentExecutionContext {
  agentId: string;
  domain: string;
  role: string;
  systemPrompt: string;
  skills: string[]; // 从技能库检索的经验
  maxRounds?: number;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  /**
   * 可选: 流送区事件注入点
   *   chatId — 前端 chat id, 用于 SSE 路由
   *   subTaskId — 前端 subTask id, 事件挂到该 subTask 的 stepHistory
   *   emit — 推送 tool_started / tool_completed 事件
   *          (未传时只走 logger, 向后兼容)
   */
  streamHook?: {
    chatId: string;
    subTaskId: string;
    emit: (eventName: 'tool_started' | 'tool_completed', payload: {
      chatId: string;
      subTaskId: string;
      agentId: string;
      tool: string;
      args?: string;
      success?: boolean;
      result?: string;
      error?: string;
      durationMs?: number;
      ts: number;
    }) => void;
  };
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

  // 构建 System Prompt
  const systemPrompt = buildFullSystemPrompt(ctx);

  // 构建初始消息
  const messages: LLMMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userTask },
  ];

  logger.info('AgentLoop', `[${ctx.agentId}] Starting: "${userTask.slice(0, 80)}..."`);

  // 调用 LLM + 工具循环
  const result: CallWithToolsResult = await callLLMWithTools({
    messages,
    tools: AGENT_TOOLS,
    model: ctx.model,
    temperature: ctx.temperature ?? 0.2,
    maxTokens: ctx.maxTokens ?? 4096,
    maxRounds: ctx.maxRounds ?? 10,
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
            args: argsJson,
            ts: Date.now(),
          });
        } catch (emitErr: any) {
          logger.warn('AgentLoop', `[${ctx.agentId}] streamHook emit(tool_started) failed: ${emitErr?.message ?? emitErr}`);
        }
      }

      const toolStart = Date.now();
      const toolResult = await executeToolCall(call);
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

      return toolResult;
    },
    onThinking: (text: string) => {
      logger.info('AgentLoop', `[${ctx.agentId}] Thinking: "${text.slice(0, 100)}..."`);
    },
  });

  const finalAnswer = result.finalMessage.content ?? '';

  logger.info('AgentLoop',
    `[${ctx.agentId}] Done: ${result.toolCallCount} tool calls, ` +
    `${result.totalDurationMs}ms, answer=${finalAnswer.length} chars`
  );

  return {
    finalAnswer,
    messages: result.allMessages,
    toolCallCount: result.toolCallCount,
    durationMs: result.totalDurationMs,
    usedTools: result.toolCallCount > 0,
    toolSteps,
  };
}

// ─── System Prompt 构建 ─────────────────────────────────────────────

function buildFullSystemPrompt(ctx: AgentExecutionContext): string {
  const parts: string[] = [];

  // 1. 角色定义
  parts.push(ctx.systemPrompt);

  // 2. 工具说明
  parts.push(`
## 可用工具

你可以使用以下工具来完成任务：

${AGENT_TOOLS.map(t => `- **${t.function.name}**: ${t.function.description}`).join('\n')}

**重要规则：**
- 不要猜测文件内容，先用 read_file 或 search_code 查看现有代码
- 写文件前先确认目录结构
- 生成代码后用 execute_cmd 运行测试验证
- 如果遇到错误，分析原因并修复
- 给出最终答案时，说明你做了什么、为什么这样做`);

  // 3. 技能库经验注入
  if (ctx.skills.length > 0) {
    parts.push(`
## 历史经验（从过去的任务中学习）

${ctx.skills.map((s, i) => `${i + 1}. ${s}`).join('\n')}

请参考这些经验，但不要盲目套用。根据当前任务的具体情况调整方案。`);
  }

  return parts.join('\n\n');
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
