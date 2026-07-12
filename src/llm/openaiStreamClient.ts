/**
 * openaiStreamClient.ts — Node.js 端 OpenAI 兼容 SSE 客户端 (零依赖)
 *
 * 设计原则 (2026-07-02):
 *   ① 零 npm 依赖: 仅依赖 Node 18+ 自带的 fetch + AbortController + TextDecoder
 *      → 即装即用,不增加 lockfile 体积与安全审计面
 *
 *   ② 避开 Schannel 的 OCSP 墙 (Windows 唯一坑):
 *      Windows 平台的 `curl.exe` 默认绑 Schannel 作为 SSL 后端,会强制做 CRL/OCSP
 *      证书吊销检查;若 CA 吊销服务器不可达,直接抛 CRYPT_E_REVOCATION_OFFLINE。
 *      Node.js 自带的 fetch 用 OpenSSL 3,完全不走 schannel,也不主动走 OCSP,
 *      因此不必每次调用都加 `--ssl-no-revoke` —— 这正是 SoloForge LLM 链路的默认形态。
 *      兜底: 在 Windows 上确实需要调用 curl 时,统一加 `--ssl-no-revoke`
 *      临时禁用 OCSP 校验(只关吊销验证,其他 TLS 安全性保留)。
 *
 *   ③ 与 curl 的对照测试已通过 (Agnes AI 端点):
 *        curl --ssl-no-revoke → HTTP 200 (绕过 schannel OCSP)
 *        Node fetch           → HTTP 200 (OpenSSL 3,天生不需要绕过)
 *
 * 接口:
 *   streamOpenAIChat({ baseUrl, apiKey, model, messages, ...opts })
 *     → AsyncIterable<{ delta: string, done: boolean }>
 *
 * 协议: OpenAI Chat Completions 流式 (与 UI 端 OpenAICompatibleProvider 兼容)
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
  /** ★ usage 统计 (仅流式最后一帧携带, 需 stream_options.include_usage=true) */
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number; cachedTokens?: number };
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
    // ★ 请求流式最后一帧携带 usage (OpenAI 兼容协议: stream_options.include_usage)
    stream_options: { include_usage: true },
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
          // ★ 流式最后一帧携带 usage (stream_options.include_usage=true 时)
          if (json?.usage) {
            const u = json.usage;
            // ★ 兼容 3 种 provider 的缓存命中字段:
            //   OpenAI:    usage.prompt_tokens_details.cached_tokens
            //   DeepSeek:  usage.prompt_cache_hit_tokens
            //   Anthropic: usage.cache_read_input_tokens
            const cachedTokens =
              u.prompt_tokens_details?.cached_tokens ??
              u.prompt_cache_hit_tokens ??
              u.cache_read_input_tokens ??
              0;
            yield {
              delta: '',
              done: false,
              raw: json,
              usage: {
                promptTokens: u.prompt_tokens ?? 0,
                completionTokens: u.completion_tokens ?? 0,
                totalTokens: u.total_tokens ?? 0,
                cachedTokens: cachedTokens > 0 ? cachedTokens : undefined,
              },
            };
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
