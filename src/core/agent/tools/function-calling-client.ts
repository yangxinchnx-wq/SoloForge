/**
 * function-calling-client.ts — 支持 OpenAI Function Calling 的 LLM 客户端
 *
 * 与 openaiStreamClient.ts 的区别:
 *   - 支持 tools + tool_choice 参数
 *   - 解析 tool_calls 响应（非流式）
 *   - 支持多轮 tool_calls 循环
 *
 * 2026-07-08 L3+L4 优化 (Loop Engineering):
 *   L3: 无进展检测 — 状态指纹追踪,连续 N 轮相同工具调用触发软退出
 *   L4: Token 预算 — 累计 token 估算,超预算时注入压缩指令或强制退出
 *
 * 参考: Claude Code Agent Loop 的 no-progress detection + token budget 机制,
 *        Loop Engineering 的 5 大要素 (Goal/Termination/Verification/No-Progress/Budget)
 */

import { createHash } from 'crypto';
import { getLLMProxyConfig } from '../../../llm/llmConfig';
import { supportsTools, learnCapability, describeCapabilities } from '../../../llm/modelCapabilities';
import type { ToolSchema, ToolCallRequest, ToolCallResult } from './tool-definitions';
import { executeToolCall } from './tool-definitions';

// ─── 类型定义 ───────────────────────────────────────────────────────

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: LLMToolCall[];
  tool_call_id?: string;
  name?: string;
  /** Anthropic cache_control 标记 (内部用,不发送给 OpenAI) */
  cache_control?: { type: 'ephemeral' };
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
  maxRounds?: number;
  signal?: AbortSignal;
  onToolCall?: (call: ToolCallRequest) => Promise<ToolCallResult>;
  onThinking?: (text: string) => void;
  /**
   * 每轮 LLM 调用前的 hook (2026-07-09 新增)
   * 返回 LLMMessage[] 会在本轮 LLM 调用前注入到 messages 末尾
   * 用于 CommBus poll peer 发现并注入同侪信息
   */
  onRoundStart?: (round: number) => LLMMessage[] | void;
  /** 可选: LLM provider 覆盖 */
  llmConfig?: { baseUrl: string; apiKey: string; model: string };
  /**
   * L4: Token 预算上限 (估算值)。
   * 整个 Agent Loop 的累计 token 消耗超过此值时,触发压缩或强制退出。
   * 默认 50000 (约 200k 字符,覆盖大多数中等复杂度任务)。
   * 设为 0 或 Infinity 可禁用。
   */
  tokenBudget?: number;
}

export interface CallWithToolsResult {
  finalMessage: LLMMessage;
  allMessages: LLMMessage[]; // 完整的多轮对话历史
  toolCallCount: number;
  totalDurationMs: number;
  /** L4: 累计估算 token 消耗 */
  totalTokensEstimated: number;
  /** L3: 循环是否因无进展而提前退出 */
  exitedByStallDetection: boolean;
  /** L4: 循环是否因超预算而提前退出 */
  exitedByTokenBudget: boolean;
  /** 工具结果缓存命中次数 (本次 dispatch 内去重命中) */
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

// ─── L3+L4 内部工具函数 ────────────────────────────────────────────

/**
 * 粗略估算消息列表的 token 数。
 * 精度不高但足够做预算控制 (误差 ±30%)。
 * 规则: 英文约 4 字符/token,中文约 2 字符/token,JSON 结构有额外开销。
 * 这里用 3.5 字符/token 作为混合估算中位数。
 */
function estimateTokens(messages: LLMMessage[]): number {
  let totalChars = 0;
  for (const m of messages) {
    // 角色标记 + 内容
    totalChars += 10; // role 开销
    if (m.content) totalChars += m.content.length;
    if (m.tool_calls) {
      for (const tc of m.tool_calls) {
        totalChars += tc.function.name.length + tc.function.arguments.length + 20;
      }
    }
  }
  return Math.ceil(totalChars / 3.5);
}

/**
 * L3: 计算本轮工具调用的状态指纹。
 * 将本轮所有 tool_call 的 (name, arguments) 排序后 hash,
 * 用于检测 LLM 是否卡在同一个操作上反复调用。
 *
 * 为什么用 hash 而不是直接比较字符串:
 *   - arguments 可能很长 (如 write_file 的 content),直接比较性能差
 *   - hash 固定 16 字符,比较和日志都方便
 */
function computeToolFingerprint(toolCalls: LLMToolCall[]): string {
  const sig = toolCalls
    .map(tc => `${tc.function.name}:${tc.function.arguments}`)
    .sort()
    .join('|');
  return createHash('sha256').update(sig).digest('hex').slice(0, 16);
}

/**
 * L4: 构建 nudge 消息 — 鼓励 LLM 基于已有信息给出最终回答。
 * 参考 Claude Code 的 token_budget_continuation: 在预算充足时注入 nudge,
 * 但这里是在预算耗尽时注入,让 LLM 尽量收尾。
 */
function buildBudgetNudge(): LLMMessage {
  return {
    role: 'user',
    content:
      '[System: Token budget approaching limit. Please synthesize your findings so far ' +
      'and provide a final answer based on the information you have gathered. ' +
      'Do NOT call any more tools. Give your best answer now.]',
  };
}

/**
 * L3: 构建 stall nudge 消息 — 告知 LLM 它在重复,请给出最终回答。
 */
function buildStallNudge(): LLMMessage {
  return {
    role: 'user',
    content:
      '[System: You have been making the same tool calls repeatedly without progress. ' +
      'Please stop calling tools and provide your final answer based on what you have gathered so far.]',
  };
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
 *
 * L3 优化 — 无进展检测:
 *   - 每轮计算工具调用的状态指纹 (name+arguments hash)
 *   - 连续 3 轮指纹相同 → 注入 stall nudge,移除 tools,强制最终回答
 *   - 防止 LLM 卡在同一操作上反复空转
 *
 * L4 优化 — Token 预算:
 *   - 每轮估算累计 token 消耗
 *   - 超过预算的 80% → 注入 budget nudge,提示 LLM 收尾
 *   - 超过预算 → 移除 tools,强制最终回答
 *   - 参考 Claude Code 的 token_budget_continuation 机制
 */
export async function callLLMWithTools(opts: CallWithToolsOptions): Promise<CallWithToolsResult> {
  // 优先使用传入的 llmConfig, 否则回退到环境变量
  let baseUrl: string;
  let apiKey: string;
  let model: string;

  if (opts.llmConfig && opts.llmConfig.apiKey) {
    baseUrl = opts.llmConfig.baseUrl.replace(/\/$/, '');
    apiKey = opts.llmConfig.apiKey;
    model = opts.model ?? opts.llmConfig.model;
  } else {
    const cfg = getLLMProxyConfig();
    baseUrl = cfg.baseUrl.replace(/\/$/, '');
    apiKey = cfg.apiKey;
    model = opts.model ?? cfg.defaultModel;
  }

  // hardCap 作为安全网防止 LLM 死循环,正常情况 LLM 答完(不调工具)就停
  const hardCap = opts.maxRounds ?? 20;
  // L4: Token 预算上限 (默认 50000 token,设为 0 或 Infinity 禁用)
  const tokenBudget = opts.tokenBudget ?? 50000;
  const budgetEnabled = tokenBudget > 0 && isFinite(tokenBudget);

  if (!apiKey) throw new Error('LLM API key not configured (neither in request nor env)');
  if (!model) throw new Error('LLM model not configured');

  // ── 能力预检: 本地查询模型是否支持 tools (零网络请求) ──────────────
  // 如果已知模型不支持 function calling, 直接跳过 tools, 避免 400/404/500
  const toolSupport = supportsTools(model);
  const hasTools = opts.tools.length > 0;
  let toolsStripped = false;

  if (hasTools && toolSupport === false) {
    console.log(`[ModelCapabilities] ${model} 已知不支持 function calling (${describeCapabilities(model)}), 跳过 tools`);
    toolsStripped = true;
  }

  const allMessages: LLMMessage[] = [...opts.messages];
  const start = Date.now();
  let toolCallCount = 0;

  // ── 工具结果缓存: 本次 dispatch 内去重 ──────────────────────────
  // key = `${toolName}:${JSON.stringify(args)}`, value = output string
  // 生命周期: 单次 callLLMWithTools 调用,不跨 dispatch
  // 实测 50% 工具调用是重复的,缓存后直接砍掉重复 IO + 对应 LLM 推理轮次
  const toolResultCache = new Map<string, string>();
  let cacheHits = 0;

  // ── 真实 token 累加器 (从 LLM usage 字段) ──────────────────────
  const actualUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0, llmCallCount: 0 };

  // ── L3 状态: 无进展检测 ──
  let previousFingerprint = '';        // 上一轮工具调用的指纹
  let consecutiveStallRounds = 0;      // 连续无进展轮数
  let stallNudgeSent = false;          // 是否已发送 stall nudge (只发一次)
  let exitedByStallDetection = false;

  // ── L4 状态: Token 预算 ──
  let cumulativeTokens = estimateTokens(allMessages); // 初始消息的 token
  let budgetNudgeSent = false;         // 是否已发送 budget nudge (只发一次)
  let exitedByTokenBudget = false;

  // 当前使用的工具定义 (L3/L4 可能在中途移除 tools)
  // 如果能力预检发现模型不支持 tools, 直接清空
  let currentTools = toolsStripped ? [] : opts.tools;

  for (let round = 0; round < hardCap; round++) {
    // ── L4: 预算检查 (在调用 LLM 之前) ──
    if (budgetEnabled && cumulativeTokens > tokenBudget) {
      // 超出预算: 移除 tools 强制最终回答 (如果还没移除的话)
      if (currentTools.length > 0) {
        currentTools = [];
        if (!budgetNudgeSent) {
          allMessages.push(buildBudgetNudge());
          budgetNudgeSent = true;
        }
        // 不 break,让 LLM 用剩余上下文给一个最终回答 (不带 tools)
      } else {
        // 已经没有 tools 了,LLM 还没回答 → 强制退出
        exitedByTokenBudget = true;
        break;
      }
    }

    // ── CommBus: 每轮 LLM 调用前注入 peer 发现 (2026-07-09) ──
    if (opts.onRoundStart) {
      try {
        const injected = opts.onRoundStart(round);
        if (injected && injected.length > 0) {
          allMessages.push(...injected);
        }
      } catch {
        // onRoundStart 失败不影响主流程
      }
    }

    const response = await callLLMOnce({
      baseUrl,
      apiKey,
      model,
      messages: allMessages,
      tools: currentTools,
      temperature: opts.temperature ?? 0.2,
      maxTokens: opts.maxTokens ?? 4096,
      signal: opts.signal,
    });

    // 累加真实 token usage (callLLMOnce 在 message 上挂 __usage)
    const u = (response as any).__usage;
    if (u) {
      actualUsage.promptTokens += u.promptTokens ?? 0;
      actualUsage.completionTokens += u.completionTokens ?? 0;
      actualUsage.totalTokens += u.totalTokens ?? 0;
      actualUsage.cachedTokens += u.cachedTokens ?? 0;
      actualUsage.llmCallCount += 1;
    }

    // ── L4: 估算本轮 token 消耗 ──
    cumulativeTokens += estimateTokens([response]);

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
        totalTokensEstimated: cumulativeTokens,
        exitedByStallDetection,
        exitedByTokenBudget,
        cacheHits,
        actualTokenUsage: { ...actualUsage },
      };
    }

    // 有 tool_calls，执行每个工具
    allMessages.push(response);
    toolCallCount += toolCalls.length;

    // ── L3: 无进展检测 ──
    const currentFingerprint = computeToolFingerprint(toolCalls);
    if (currentFingerprint === previousFingerprint) {
      consecutiveStallRounds++;
    } else {
      consecutiveStallRounds = 0;
    }
    previousFingerprint = currentFingerprint;

    // 连续 2 轮相同工具调用 → 注入 stall nudge (软提示)
    if (consecutiveStallRounds === 2 && !stallNudgeSent) {
      allMessages.push(buildStallNudge());
      stallNudgeSent = true;
    }

    // 连续 3 轮相同工具调用 → 移除 tools,强制最终回答
    if (consecutiveStallRounds >= 3 && currentTools.length > 0) {
      currentTools = [];
      exitedByStallDetection = true;
    }

    // ── 工具执行: 缓存优先 + 并行执行 ──────────────────────────────
    // 优化点 (2026-07-09):
    //   1. 工具结果去重缓存: 相同 toolName+args 在本次 dispatch 内不重复执行
    //      实测 50% 工具调用是重复的 (read_file("README.md") 被调 4 次等)
    //   2. 并行执行: LLM 一次返回多个 tool_calls 时, 用 Promise.all 并行
    //      原来是 for...of + await 串行, 现在并行减少总等待时间
    //   3. 缓存命中时标记 [CACHED], 让 LLM 知道这是复用结果

    const toolResults = await Promise.all(toolCalls.map(async (tc) => {
      const request: ToolCallRequest = {
        id: tc.id,
        name: tc.function.name,
        arguments: JSON.parse(tc.function.arguments),
      };

      // 缓存 key: toolName + 参数 hash
      const cacheKey = `${request.name}:${JSON.stringify(request.arguments)}`;

      // 缓存命中: 直接复用, 不执行工具, 不消耗 IO
      const cached = toolResultCache.get(cacheKey);
      if (cached) {
        cacheHits++;
        return {
          tool_call_id: request.id,
          name: request.name,
          output: cached + '\n[CACHED: 此结果由前次相同调用复用,无需再次请求]',
        };
      }

      // 缓存未命中: 执行工具
      const result = opts.onToolCall
        ? await opts.onToolCall(request)
        : await executeToolCall(request);

      // 写入缓存 (仅缓存成功的结果,错误结果不缓存)
      if (!result.output.startsWith('Error:') && !result.output.startsWith('Tool error:')) {
        toolResultCache.set(cacheKey, result.output);
      }

      return result;
    }));

    // 将所有工具结果追加到消息列表
    for (const result of toolResults) {
      allMessages.push({
        role: 'tool',
        tool_call_id: result.tool_call_id,
        name: result.name,
        content: result.output,
      });
      cumulativeTokens += estimateTokens([{ role: 'tool', content: result.output }] as LLMMessage[]);
    }

    // ── L4: 预算预警 (80% 阈值) — 注入 nudge 提示 LLM 收尾 ──
    if (budgetEnabled && !budgetNudgeSent && cumulativeTokens > tokenBudget * 0.8) {
      allMessages.push(buildBudgetNudge());
      budgetNudgeSent = true;
    }

    // 继续下一轮，让 LLM 看到工具结果
  }

  // 超过最大轮数或 L3/L4 强制退出，返回最后一条消息
  const lastMsg = allMessages[allMessages.length - 1];
  return {
    finalMessage: lastMsg as LLMMessage,
    allMessages,
    toolCallCount,
    totalDurationMs: Date.now() - start,
    totalTokensEstimated: cumulativeTokens,
    exitedByStallDetection,
    exitedByTokenBudget,
    cacheHits,
    actualTokenUsage: { ...actualUsage },
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

  // 检测 Anthropic provider (baseUrl 含 anthropic 或 claude)
  // OpenAI 自动缓存 tools 参数,无需显式标记;Anthropic 需显式 cache_control
  const isAnthropic = /anthropic|claude/i.test(opts.baseUrl);

  // 按稳定性排序 messages: system(稳定) → user(不稳定)
  // Anthropic cache_control 标记在 system prompt 和 tools 最后一个元素上
  let messagesForBody = opts.messages;
  if (isAnthropic && messagesForBody.length > 0 && messagesForBody[0].role === 'system') {
    messagesForBody = messagesForBody.map((m, i) =>
      i === 0 ? { ...m, cache_control: { type: 'ephemeral' } } : m
    );
  }

  // tools 数组: Anthropic 在最后一个工具标记 cache_control
  let toolsForBody = opts.tools;
  if (isAnthropic && toolsForBody.length > 0) {
    toolsForBody = toolsForBody.map((t, i) =>
      i === toolsForBody.length - 1
        ? { ...t, cache_control: { type: 'ephemeral' } }
        : t
    );
  }

  const body: Record<string, any> = {
    model: opts.model,
    messages: messagesForBody,
    tools: toolsForBody,
    tool_choice: 'auto',
    temperature: opts.temperature,
    max_tokens: opts.maxTokens,
  };

  // ── 429/5xx 指数退避重试 ──────────────────────────────────────────
  // 避免单次限流导致整个 Agent Loop 失败(已积累的工具调用历史会全部丢失)
  // 策略:
  //   - 429 (Too Many Requests): 优先用 Retry-After 头,否则指数退避
  //   - 5xx (服务端瞬时错误): 指数退避重试
  //   - 4xx 其他 (401/403/400): 不重试,直接抛出(认证/参数错误不会自愈)
  //   - AbortError (用户取消/超时): 不重试,立即抛出
  // 上限: 最多 4 次重试,总等待上限 ~15s (200ms→800ms→2400ms→4800ms 基础退避)
  const MAX_RETRIES = 4;
  const BASE_BACKOFF_MS = 200;
  const MAX_BACKOFF_MS = 8000;

  const sleep = (ms: number, signal?: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
      if (signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'));
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        reject(new DOMException('Aborted', 'AbortError'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    });

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    // 每次重试新建 controller (上一次的已 abort 或完成)
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 120_000); // 2 分钟超时
    if (opts.signal) {
      if (opts.signal.aborted) { clearTimeout(timeoutId); controller.abort(); }
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
        const status = response.status;

        // 不可重试: 4xx (除 429) — 认证/参数错误不会自愈
        // 但 400/404 + 有 tools 时可能是模型不支持 function calling → 降级重试
        if (status >= 400 && status < 500 && status !== 429) {
          // 能力降级: 如果请求带 tools 且返回 400/404/500, 可能是模型不支持 function calling
          // 学习这个事实, 下次直接跳过 tools
          if ((status === 400 || status === 404 || status === 500) && body.tools && body.tools.length > 0) {
            learnCapability(body.model, 'tools', false);
            console.log(`[ModelCapabilities] 从 HTTP ${status} 学习: ${body.model} 不支持 tools, 已记录`);
            // 降级重试: 移除 tools 后重试一次 (不计入正常重试次数)
            const degradedBody = { ...body, tools: undefined, tool_choice: undefined };
            try {
              const degradedResponse = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${opts.apiKey}` },
                body: JSON.stringify(degradedBody),
                signal: controller.signal,
              });
              if (degradedResponse.ok) {
                const json = await degradedResponse.json() as any;
                const choice = json?.choices?.[0];
                if (choice) {
                  const msg = choice.message;
                  const assistantMsg: LLMMessage = {
                    role: 'assistant',
                    content: msg.content ?? null,
                    tool_calls: undefined, // 降级后无 tool_calls
                  };
                  const usage = json?.usage;
                  if (usage && typeof usage === 'object') {
                    (assistantMsg as any).__usage = {
                      promptTokens: usage.prompt_tokens ?? 0,
                      completionTokens: usage.completion_tokens ?? 0,
                      totalTokens: usage.total_tokens ?? 0,
                      cachedTokens: usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens ?? 0,
                    };
                  }
                  console.log(`[ModelCapabilities] 降级重试成功: ${body.model} (无 tools)`);
                  return assistantMsg;
                }
              }
            } catch (degradedErr) {
              // 降级也失败了, 继续抛出原始错误
              console.log(`[ModelCapabilities] 降级重试也失败: ${degradedErr}`);
            }
          }
          throw new Error(`LLM HTTP ${status}: ${errText.slice(0, 300)}`);
        }

        // 可重试: 429 / 5xx
        // 5xx + 有 tools 时, 先尝试降级 (可能是模型不支持 tools 导致的 500)
        if (status === 500 && body.tools && body.tools.length > 0 && attempt === 0) {
          learnCapability(body.model, 'tools', false);
          console.log(`[ModelCapabilities] 从 HTTP 500 学习: ${body.model} 可能不支持 tools, 尝试降级`);
          const degradedBody = { ...body, tools: undefined, tool_choice: undefined };
          try {
            const degradedResponse = await fetch(url, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${opts.apiKey}` },
              body: JSON.stringify(degradedBody),
              signal: controller.signal,
            });
            if (degradedResponse.ok) {
              const json = await degradedResponse.json() as any;
              const choice = json?.choices?.[0];
              if (choice) {
                const msg = choice.message;
                const assistantMsg: LLMMessage = {
                  role: 'assistant',
                  content: msg.content ?? null,
                  tool_calls: undefined,
                };
                const usage = json?.usage;
                if (usage && typeof usage === 'object') {
                  (assistantMsg as any).__usage = {
                    promptTokens: usage.prompt_tokens ?? 0,
                    completionTokens: usage.completion_tokens ?? 0,
                    totalTokens: usage.total_tokens ?? 0,
                    cachedTokens: usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens ?? 0,
                  };
                }
                console.log(`[ModelCapabilities] 降级重试成功: ${body.model} (无 tools)`);
                return assistantMsg;
              }
            }
          } catch (degradedErr) {
            console.log(`[ModelCapabilities] 降级重试也失败: ${degradedErr}`);
          }
        }

        if (attempt < MAX_RETRIES) {
          // 解析 Retry-After 头 (秒或 HTTP-date,这里只处理秒)
          const retryAfter = response.headers.get('retry-after');
          let waitMs: number;
          if (retryAfter && /^\d+$/.test(retryAfter.trim())) {
            waitMs = Math.min(parseInt(retryAfter, 10) * 1000, MAX_BACKOFF_MS);
          } else {
            // 指数退避: 200 * 2^attempt + 抖动(避免同步重试风暴)
            const jitter = Math.random() * 100;
            waitMs = Math.min(BASE_BACKOFF_MS * Math.pow(2, attempt) + jitter, MAX_BACKOFF_MS);
          }
          lastError = new Error(`LLM HTTP ${status}: ${errText.slice(0, 300)}`);
          // 限流提示日志(仅首次限流,避免重试刷屏)
          if (attempt === 0) {
            // logger 在文件下方导入,这里用 console 避免循环依赖
            console.log(`[LLM-Retry] HTTP ${status} (attempt ${attempt + 1}/${MAX_RETRIES + 1}), waiting ${Math.round(waitMs)}ms before retry...`);
          }
          await sleep(waitMs, opts.signal);
          continue;
        }

        // 重试耗尽,抛出
        throw new Error(`LLM HTTP ${status}: ${errText.slice(0, 300)}`);
      }

      const json = await response.json() as any;
      const choice = json?.choices?.[0];
      if (!choice) throw new Error('LLM returned empty choices');

      const msg = choice.message;
      const assistantMsg: LLMMessage = {
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
      // 捕获 LLM 返回的真实 token usage (2026-07-09)
      // OpenAI 兼容 API 在 usage 字段返回 prompt_tokens / completion_tokens / total_tokens
      // 缓存命中时还有 prompt_tokens_details.cached_tokens (Anthropic/OpenAI 缓存)
      const usage = json?.usage;
      if (usage && typeof usage === 'object') {
        (assistantMsg as any).__usage = {
          promptTokens: usage.prompt_tokens ?? 0,
          completionTokens: usage.completion_tokens ?? 0,
          totalTokens: usage.total_tokens ?? 0,
          cachedTokens: usage.prompt_tokens_details?.cached_tokens
            ?? usage.prompt_cache_hit_tokens
            ?? 0,
        };
      }
      return assistantMsg;
    } catch (err: any) {
      // 用户取消 / 超时: 不重试,立即抛出
      if (err?.name === 'AbortError') {
        throw err;
      }
      // 网络错误 (ECONNRESET / fetch failed 等): 可重试
      if (attempt < MAX_RETRIES) {
        const jitter = Math.random() * 100;
        const waitMs = Math.min(BASE_BACKOFF_MS * Math.pow(2, attempt) + jitter, MAX_BACKOFF_MS);
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt === 0) {
          console.log(`[LLM-Retry] Network error (attempt ${attempt + 1}/${MAX_RETRIES + 1}): ${lastError.message.slice(0, 100)}, waiting ${Math.round(waitMs)}ms...`);
        }
        await sleep(waitMs, opts.signal);
        continue;
      }
      throw err;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  // 所有重试耗尽 (理论上不会走到这里,for 循环内已 throw)
  throw lastError ?? new Error('LLM call failed after all retries');
}
