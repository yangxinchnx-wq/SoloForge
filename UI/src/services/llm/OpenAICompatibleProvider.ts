/**
 * OpenAICompatibleProvider.ts — OpenAI Chat Completions 兼容客户端
 *
 * 适用：OpenAI / Anthropic（带 proxy） / OpenRouter / DeepSeek / Moonshot / 任何 OpenAI 兼容服务
 *
 * SSE 格式：
 *   data: {"choices":[{"delta":{"content":"hello"}}]}
 *   data: {"choices":[{"delta":{"content":" world"}}]}
 *   data: [DONE]
 *
 * 实现要点：
 *   - 使用浏览器原生 fetch + ReadableStream（零依赖）
 *   - R2.3 fix: SSE 解析改用 utils/sseStream.parseSseFromStream (与主对话流统一)
 *   - 支持 AbortController 取消
 *   - 自动重试 1 次（仅对网络错误）
 */

import type {
  LLMProvider,
  LLMProviderConfig,
  LLMRequest,
  LLMStreamHandle,
} from './types';
import { parseSseFromStream } from '../../utils/sseStream';

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_RETRIES = 1;

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

    // push queue 桥接 parseSseFromStream (callback) 到 generator (pull)
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

          // R2.3: 用统一 parseSseFromStream 解析
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
          return; // 成功完成
        } catch (err) {
          attempt++;
          if (cancelled) return;
          if (attempt > MAX_RETRIES) {
            error = err instanceof Error ? err : new Error(String(err));
            streamClosed = true;
            notify();
            return;
          }
          // 退避 200ms
          await new Promise((r) => setTimeout(r, 200 * attempt));
        }
      }
      // 重试耗尽但未成功 → 关闭流
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

    // 监听 streamPromise 完成
    streamPromise
      .then(() => resolveDone())
      .catch((err) => rejectDone(err instanceof Error ? err : new Error(String(err))));

    return {
      cancel() {
        if (cancelled) return;
        cancelled = true;
        // R2.3 fix: 必须先唤醒 pendingResolve, 否则 iterator 卡在 await 上不会退出
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
