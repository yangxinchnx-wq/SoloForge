/**
 * openaiSyncClient.ts — Node.js 端 OpenAI 兼容 非流式 单次补全客户端
 *
 * 用途:
 *   - health probe (发一个 1-token 补全,验证 baseUrl+apiKey 可达)
 *   - tool-calling / function-calling 一次性请求
 *   - 后台批处理(不需要给用户看流式过程)
 *
 * 与 openaiStreamClient.ts 的区别:
 *   - 非流式:整段返回,不解析 SSE chunk
 *   - 多返回 completion + usage 指标,便于 observability 聚合
 *
 * 同源设计原则 (保持一致):
 *   - 零 npm 依赖,仅用 Node 18+ 自带 fetch + AbortController
 *   - 自动继承 Node OpenSSL 3,避开 Windows Schannel OCSP 墙
 *   - 与 openaiStreamClient 共用 llmConfig 环境变量
 *
 * 协议: OpenAI Chat Completions 非流式
 *   响应: { id, choices: [{ message: { role, content }, finish_reason }], usage, model }
 */

import { getLLMProxyConfig } from './llmConfig';

export interface SyncChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface SyncChatOptions {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  messages: SyncChatMessage[];
  temperature?: number;
  maxTokens?: number;
  jsonMode?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface SyncChatResult {
  id: string;
  model: string;
  content: string;
  finishReason: string;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  /** 完整 JSON 响应(便于上层审计/调试) */
  raw: unknown;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export async function callOpenAIChat(opts: SyncChatOptions): Promise<SyncChatResult> {
  const cfg = getLLMProxyConfig();
  const baseUrl = (opts.baseUrl ?? cfg.baseUrl).replace(/\/$/, '');
  const apiKey = opts.apiKey ?? cfg.apiKey;
  const model = opts.model ?? cfg.defaultModel;
  const timeoutMs = opts.timeoutMs ?? cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  if (!apiKey) {
    throw new Error('openaiSyncClient: apiKey is empty (set SOLOFORGE_LLM_API_KEY)');
  }
  if (!model) {
    throw new Error('openaiSyncClient: model is empty');
  }

  const url = `${baseUrl}/chat/completions`;
  const body = {
    model,
    messages: opts.messages,
    stream: false,
    temperature: opts.temperature ?? 0.7,
    max_tokens: opts.maxTokens ?? 512,
    ...(opts.jsonMode ? { response_format: { type: 'json_object' } } : {}),
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort('timeout'), timeoutMs);
  if (opts.signal) {
    if (opts.signal.aborted) controller.abort('external-abort');
    else opts.signal.addEventListener('abort', () => controller.abort('external-abort'), { once: true });
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    throw err instanceof Error ? err : new Error(String(err));
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`openaiSyncClient: HTTP ${response.status} ${errText.slice(0, 200)}`);
  }

  const json = (await response.json()) as Record<string, unknown>;
  const choices = (json.choices as Array<Record<string, unknown>> | undefined) ?? [];
  const first = choices[0] ?? {};
  const message = (first.message as Record<string, unknown> | undefined) ?? {};
  const usage = (json.usage as Record<string, number> | undefined) ?? {};

  return {
    id: typeof json.id === 'string' ? json.id : '',
    model: typeof json.model === 'string' ? json.model : model,
    content: typeof message.content === 'string' ? message.content : '',
    finishReason: typeof first.finish_reason === 'string' ? first.finish_reason : '',
    usage: {
      promptTokens: usage.prompt_tokens ?? 0,
      completionTokens: usage.completion_tokens ?? 0,
      totalTokens: usage.total_tokens ?? 0,
    },
    raw: json,
  };
}
