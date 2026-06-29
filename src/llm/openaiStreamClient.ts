/**
 * openaiStreamClient.ts — Node.js 端 OpenAI 兼容 SSE 客户端
 *
 * 为什么不用 SDK：保持零依赖。Node 18+ 自带 fetch + AbortController。
 *
 * 接口：
 *   streamOpenAIChat({ baseUrl, apiKey, model, messages, ...opts })
 *     → AsyncIterable<{ delta: string, done: boolean }>
 *
 * 复用 OpenAI Chat Completions 流式协议（与 UI 端 OpenAICompatibleProvider 完全相同）：
 *   data: {"choices":[{"delta":{"content":"hello"}}]}
 *   data: [DONE]
 */

import { getLLMProxyConfig } from './llmConfig';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface StreamChatOptions {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  jsonMode?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface StreamChunk {
  delta: string;
  done: boolean;
  /** 原始 JSON（如果需要） */
  raw?: unknown;
}

const DEFAULT_TIMEOUT_MS = 60_000;

export async function* streamOpenAIChat(opts: StreamChatOptions): AsyncGenerator<StreamChunk> {
  const cfg = getLLMProxyConfig();
  const baseUrl = (opts.baseUrl ?? cfg.baseUrl).replace(/\/$/, '');
  const apiKey = opts.apiKey ?? cfg.apiKey;
  const model = opts.model ?? cfg.defaultModel;
  const timeoutMs = opts.timeoutMs ?? cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  if (!apiKey) {
    throw new Error('openaiStreamClient: apiKey is empty (set SOLOFORGE_LLM_API_KEY)');
  }
  if (!model) {
    throw new Error('openaiStreamClient: model is empty');
  }

  const url = `${baseUrl}/chat/completions`;
  const body = {
    model,
    messages: opts.messages,
    stream: true,
    temperature: opts.temperature ?? 0.7,
    max_tokens: opts.maxTokens ?? 4096,
    ...(opts.jsonMode ? { response_format: { type: 'json_object' } } : {}),
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort('timeout'), timeoutMs);
  // 把外部 signal 串起来
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
  }

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`openaiStreamClient: HTTP ${response.status} ${errText.slice(0, 200)}`);
  }
  if (!response.body) {
    throw new Error('openaiStreamClient: empty response body');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).trim();
        if (data === '[DONE]') {
          yield { delta: '', done: true };
          return;
        }
        try {
          const json = JSON.parse(data);
          const delta = json?.choices?.[0]?.delta?.content;
          if (typeof delta === 'string' && delta.length > 0) {
            yield { delta, done: false, raw: json };
          }
        } catch {
          // 忽略单行解析失败
        }
      }
    }
  } finally {
    clearTimeout(timeoutId);
    try { reader.releaseLock(); } catch { /* noop */ }
  }
}
