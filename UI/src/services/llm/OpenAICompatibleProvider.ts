/**
 * OpenAICompatibleProvider.ts 鈥?OpenAI Chat Completions 鍏煎瀹㈡埛绔?
 *
 * 閫傜敤锛歄penAI / Anthropic锛堝甫 proxy锛?/ OpenRouter / DeepSeek / Moonshot / 浠讳綍 OpenAI 鍏煎鏈嶅姟
 *
 * SSE 鏍煎紡锛?
 *   data: {"choices":[{"delta":{"content":"hello"}}]}
 *   data: {"choices":[{"delta":{"content":" world"}}]}
 *   data: [DONE]
 *
 * 瀹炵幇瑕佺偣锛?
 *   - 浣跨敤娴忚鍣ㄥ師鐢?fetch + ReadableStream锛堥浂渚濊禆锛?
 *   - R2.3 fix: SSE 瑙ｆ瀽鏀圭敤 utils/sseStream.parseSseFromStream (涓庝富瀵硅瘽娴佺粺涓€)
 *   - 鏀寔 AbortController 鍙栨秷
 *   - 鑷姩閲嶈瘯 1 娆★紙浠呭缃戠粶閿欒锛?
 */

import type {
  LLMProvider,
  LLMProviderConfig,
  LLMRequest,
  LLMStreamHandle,
} from './types';
import { parseSseFromStream } from '../../utils/sseStream';

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 60_000;

function shouldRetryStatus(status: number): boolean {
  return status === 429 || status === 503 || (status >= 500 && status < 600);
}

function calculateBackoff(attempt: number, retryAfterSeconds?: number): number {
  if (retryAfterSeconds && retryAfterSeconds > 0) {
    const ms = retryAfterSeconds * 1000;
    return Math.min(ms + ms * 0.1 * Math.random(), MAX_BACKOFF_MS);
  }
  const exp = BASE_BACKOFF_MS * Math.pow(2, attempt);
  const capped = Math.min(exp, MAX_BACKOFF_MS);
  const jitter = capped * 0.2 * (Math.random() * 2 - 1);
  return Math.max(100, Math.round(capped + jitter));
}

interface OpenAIChunk {
  choices?: Array<{ delta?: { content?: string } }>;
}

export class OpenAICompatibleProvider implements LLMProvider {
  readonly name: string;
  private config: Required<Pick<LLMProviderConfig, 'baseUrl' | 'defaultModel' | 'timeoutMs'>> & LLMProviderConfig;

  constructor(name: string, config: LLMProviderConfig) {
    this.name = name;
    this.config = {
      timeoutMs: DEFAULT_TIMEOUT_MS,
      ...config,
    };
  }

  chatStream(req: LLMRequest): LLMStreamHandle {
    const url = `${this.config.baseUrl.replace(/\/$/, '')}/chat/completions`;
    const model = req.model ?? this.config.defaultModel;

    const messages = [
      ...(req.systemPrompt ? [{ role: 'system' as const, content: req.systemPrompt }] : []),
      ...(req.history ?? []),
      { role: 'user' as const, content: req.userGoal },
    ];

    const body = {
      model,
      messages,
      stream: true,
      temperature: req.temperature ?? 0.7,
      max_tokens: req.maxTokens ?? 4096,
      ...(req.jsonMode ? { response_format: { type: 'json_object' } } : {}),
    };

    const controller = new AbortController();
    let cancelled = false;

    const timeoutId = setTimeout(() => controller.abort('timeout'), this.config.timeoutMs);

    // push queue 妗ユ帴 parseSseFromStream (callback) 鍒?generator (pull)
    const queue: string[] = [];
    let error: Error | null = null;
    let streamClosed = false;
    let pendingResolve: (() => void) | null = null;

    const notify = () => {
      if (pendingResolve) {
        const r = pendingResolve;
        pendingResolve = null;
        r();
      }
    };

    const streamPromise = (async () => {
      let attempt = 0;
      while (attempt <= MAX_RETRIES && !cancelled) {
        try {
          const response = await fetch(url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {}),
              ...(this.config.headers ?? {}),
            },
            body: JSON.stringify(body),
            signal: controller.signal,
          });

          if (!response.ok) {
            const errText = await response.text().catch(() => '');
            throw new Error(`${this.name} HTTP ${response.status}: ${errText.slice(0, 200)}`);
          }

          if (!response.body) {
            throw new Error(`${this.name}: empty response body`);
          }

          // R2.3: 鐢ㄧ粺涓€ parseSseFromStream 瑙ｆ瀽
          await parseSseFromStream(response.body, (raw) => {
            if (cancelled) return;
            const json = raw as OpenAIChunk;
            const delta = json?.choices?.[0]?.delta?.content;
            if (typeof delta === 'string' && delta.length > 0) {
              queue.push(delta);
              notify();
            }
          });
          streamClosed = true;
          notify();
          return; // 鎴愬姛瀹屾垚
        } catch (err) {
          attempt++;
          if (cancelled) return;
          if (attempt > MAX_RETRIES) {
            error = err instanceof Error ? err : new Error(String(err));
            streamClosed = true;
            notify();
            return;
          }
          // exponential backoff + 429 retry + Retry-After header parsing
          const errMsg = err instanceof Error ? err.message : String(err);
          const statusMatch = errMsg.match(/HTTP\s+(\d+)/);
          const statusCode = statusMatch ? parseInt(statusMatch[1]) : 0;
          if (!shouldRetryStatus(statusCode) && statusCode !== 0) {
            error = err instanceof Error ? err : new Error(String(err));
            streamClosed = true;
            notify();
            return;
          }
          const retryAfterMatch = errMsg.match(/retry-after\s*[:=]\s*(\d+)/i);
          const retryAfter = retryAfterMatch ? parseInt(retryAfterMatch[1]) : undefined;
          const delay = calculateBackoff(attempt - 1, retryAfter);
          await new Promise((r) => setTimeout(r, delay));
        }
      }
      // 閲嶈瘯鑰楀敖浣嗘湭鎴愬姛 鈫?鍏抽棴娴?
      if (!streamClosed) {
        error = new Error('OpenAI compatible: retries exhausted');
        streamClosed = true;
        notify();
      }
    })();

    const wrappedIterator = (async function* () {
      try {
        while (true) {
          if (cancelled) return;
          if (error) throw error;
          if (queue.length > 0) {
            yield queue.shift()!;
            continue;
          }
          if (streamClosed) return;
          await new Promise<void>(resolve => { pendingResolve = resolve; });
        }
      } finally {
        cancelled = true;
        controller.abort('cancelled');
        clearTimeout(timeoutId);
      }
    })();

    let resolveDone: () => void = () => {};
    let rejectDone: (err: Error) => void = () => {};
    const donePromise = new Promise<void>((resolve, reject) => {
      resolveDone = resolve;
      rejectDone = reject;
    });

    // 鐩戝惉 streamPromise 瀹屾垚
    streamPromise
      .then(() => resolveDone())
      .catch((err) => rejectDone(err instanceof Error ? err : new Error(String(err))));

    return {
      cancel() {
        if (cancelled) return;
        cancelled = true;
        // R2.3 fix: 蹇呴』鍏堝敜閱?pendingResolve, 鍚﹀垯 iterator 鍗″湪 await 涓婁笉浼氶€€鍑?
        notify();
        controller.abort('cancelled');
      },
      done: donePromise,
      [Symbol.asyncIterator]() {
        return wrappedIterator[Symbol.asyncIterator]();
      },
    };
  }
}
