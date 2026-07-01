/**
 * function-calling-client.ts — 支持 OpenAI Function Calling 的 LLM 客户端
 *
 * 与 openaiStreamClient.ts 的区别:
 *   - 支持 tools + tool_choice 参数
 *   - 解析 tool_calls 响应（非流式）
 *   - 支持多轮 tool_calls 循环
 *
 * 使用:
 *   const result = await callLLMWithTools({
 *     messages: [...],
 *     tools: AGENT_TOOLS,
 *     onToolCall: async (call) => { ... return result; },
 *   });
 */

import { getLLMProxyConfig } from '../../../llm/llmConfig';
import type { ToolSchema, ToolCallRequest, ToolCallResult } from './tool-definitions';
import { executeToolCall } from './tool-definitions';

// ─── 类型定义 ───────────────────────────────────────────────────────

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: LLMToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface LLMToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string; // JSON string
  };
}

export interface CallWithToolsOptions {
  messages: LLMMessage[];
  tools: ToolSchema[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
  maxRounds?: number; // 最大 tool_calls 轮数，默认 10
  signal?: AbortSignal;
  onToolCall?: (call: ToolCallRequest) => Promise<ToolCallResult>; // 自定义工具执行
  onThinking?: (text: string) => void; // 每轮 assistant 文本回调
}

export interface CallWithToolsResult {
  finalMessage: LLMMessage;
  allMessages: LLMMessage[]; // 完整的多轮对话历史
  toolCallCount: number;
  totalDurationMs: number;
}

// ─── 核心函数 ───────────────────────────────────────────────────────

/**
 * 调用 LLM，支持 Function Calling 多轮循环
 *
 * 流程:
 *   1. 发送 messages + tools 给 LLM
 *   2. 如果 LLM 返回 tool_calls → 执行工具 → 将结果追加到 messages → 回到 1
 *   3. 如果 LLM 返回纯文本 → 结束
 *   4. 最多循环 maxRounds 轮
 */
export async function callLLMWithTools(opts: CallWithToolsOptions): Promise<CallWithToolsResult> {
  const cfg = getLLMProxyConfig();
  const baseUrl = (cfg.baseUrl).replace(/\/$/, '');
  const apiKey = cfg.apiKey;
  const model = opts.model ?? cfg.defaultModel;
  const maxRounds = opts.maxRounds ?? 10;

  if (!apiKey) throw new Error('SOLOFORGE_LLM_API_KEY not set');
  if (!model) throw new Error('LLM model not configured');

  const allMessages: LLMMessage[] = [...opts.messages];
  const start = Date.now();
  let toolCallCount = 0;

  for (let round = 0; round < maxRounds; round++) {
    const response = await callLLMOnce({
      baseUrl,
      apiKey,
      model,
      messages: allMessages,
      tools: opts.tools,
      temperature: opts.temperature ?? 0.2,
      maxTokens: opts.maxTokens ?? 4096,
      signal: opts.signal,
    });

    // 检查是否有 tool_calls
    const toolCalls = response.tool_calls;

    if (!toolCalls || toolCalls.length === 0) {
      // 纯文本回复，结束循环
      allMessages.push(response);
      if (opts.onThinking && response.content) {
        opts.onThinking(response.content);
      }
      return {
        finalMessage: response,
        allMessages,
        toolCallCount,
        totalDurationMs: Date.now() - start,
      };
    }

    // 有 tool_calls，执行每个工具
    allMessages.push(response);
    toolCallCount += toolCalls.length;

    for (const tc of toolCalls) {
      const request: ToolCallRequest = {
        id: tc.id,
        name: tc.function.name,
        arguments: JSON.parse(tc.function.arguments),
      };

      // 执行工具（自定义或内置）
      const result = opts.onToolCall
        ? await opts.onToolCall(request)
        : await executeToolCall(request);

      // 将工具结果追加到消息列表
      allMessages.push({
        role: 'tool',
        tool_call_id: result.tool_call_id,
        name: result.name,
        content: result.output,
      });
    }

    // 继续下一轮，让 LLM 看到工具结果
  }

  // 超过最大轮数，返回最后一条消息
  const lastMsg = allMessages[allMessages.length - 1];
  return {
    finalMessage: lastMsg as LLMMessage,
    allMessages,
    toolCallCount,
    totalDurationMs: Date.now() - start,
  };
}

// ─── 单次 LLM 调用（非流式，支持 tool_calls 解析） ─────────────────

interface CallOnceOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: LLMMessage[];
  tools: ToolSchema[];
  temperature: number;
  maxTokens: number;
  signal?: AbortSignal;
}

async function callLLMOnce(opts: CallOnceOptions): Promise<LLMMessage> {
  const url = `${opts.baseUrl}/chat/completions`;

  const body: Record<string, any> = {
    model: opts.model,
    messages: opts.messages,
    tools: opts.tools,
    tool_choice: 'auto',
    temperature: opts.temperature,
    max_tokens: opts.maxTokens,
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 120_000); // 2 分钟超时
  if (opts.signal) {
    if (opts.signal.aborted) controller.abort();
    else opts.signal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${opts.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new Error(`LLM HTTP ${response.status}: ${errText.slice(0, 300)}`);
    }

    const json = await response.json() as any;
    const choice = json?.choices?.[0];
    if (!choice) throw new Error('LLM returned empty choices');

    const msg = choice.message;
    return {
      role: 'assistant',
      content: msg.content ?? null,
      tool_calls: msg.tool_calls?.map((tc: any) => ({
        id: tc.id,
        type: 'function' as const,
        function: {
          name: tc.function.name,
          arguments: tc.function.arguments,
        },
      })),
    };
  } finally {
    clearTimeout(timeoutId);
  }
}
