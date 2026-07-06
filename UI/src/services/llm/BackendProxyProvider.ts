/**
 * BackendProxyProvider.ts — 前端 LLM provider，调用后端 /api/llm/stream 代理
 *
 * 与 OpenAICompatibleProvider 接口完全一致，可直接塞到 LLMClient。
 * 关键差异：API key 不在前端，永远走 3001 后端中转。
 *
 * 协议：
 *   POST { apiBase }/api/llm/stream
 *   Body: { systemPrompt, userGoal, history, model, temperature, maxTokens, jsonMode }
 *   Headers: X-SoloForge-Token: <token>   (如果后端配了)
 *   Response: text/event-stream
 *     data: {"delta":"hello","done":false}\n\n
 *     data: {"delta":"","done":true}\n\n
 *     data: {"error":"...","done":true}\n\n
 *
 * R2.3 fix: SSE 解析改用 utils/sseStream.parseSseFromStream (与主对话流统一)
 */

import type {
  LLMProvider,
  LLMProviderConfig,
  LLMRequest,
  LLMStreamHandle,
} from './types';
import { parseSseFromStream } from '../../utils/sseStream';

export interface BackendProxyConfig extends LLMProviderConfig {
  /** 后端 API base URL，默认 http://localhost:3001 */
  apiBase?: string;
  /** 后端 token（如果后端配了 SOLOFORGE_LLM_API_TOKEN） */
  token?: string;
}

interface BackendProxyEvent {
  delta?: string;
  done?: boolean;
  error?: string;
}

export class BackendProxyProvider implements LLMProvider {
  readonly name = 'backend-proxy';
  private config: Required<Pick<BackendProxyConfig, 'apiBase' | 'defaultModel' | 'timeoutMs'>> & BackendProxyConfig;

  constructor(config: BackendProxyConfig) {
    const apiBase = (config.apiBase ?? 'http://localhost:3001').replace(/\/$/, '');
    this.config = {
      apiBase,
      timeoutMs: 60_000,
      defaultModel: 'gpt-4o-mini',
      ...config,
    };
  }

  chatStream(req: LLMRequest): LLMStreamHandle {
    const url = `${this.config.apiBase}/api/llm/stream`;
    const model = req.model ?? this.config.defaultModel;

    // 后端 llmProxyHandler.parseRequestBody() 要求的字段格式:
    //   { userGoal (必填), systemPrompt?, history?, model?, temperature?, maxTokens?, jsonMode? }
    // 而非 OpenAI 风格的 { messages: [...] }
    // history 元素格式: { role: 'system'|'user'|'assistant', content: string }
    const history = req.history ?? [];

    const body = {
      systemPrompt: req.systemPrompt,
      userGoal: req.userGoal,
      history,
      model,
      temperature: req.temperature ?? 0.7,
      maxTokens: req.maxTokens ?? 4096,
      jsonMode: req.jsonMode === true,
    };

    const controller = new AbortController();
    let cancelled = false;
    const timeoutId = setTimeout(() => controller.abort('timeout'), this.config.timeoutMs);

    // 用 push queue 桥接 parseSseFromStream (callback) 到 generator (pull)
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
      let response: Response;
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(this.config.token ? { 'X-SoloForge-Token': this.config.token } : {}),
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (err) {
        clearTimeout(timeoutId);
        const e = err instanceof Error ? err : new Error(String(err));
        error = e;
        streamClosed = true;
        notify();
        throw e;
      }

      if (!response.ok) {
        clearTimeout(timeoutId);
        const errText = await response.text().catch(() => '');
        const e = new Error(`BackendProxy HTTP ${response.status}: ${errText.slice(0, 200)}`);
        error = e;
        streamClosed = true;
        notify();
        throw e;
      }
      if (!response.body) {
        clearTimeout(timeoutId);
        const e = new Error('BackendProxy: empty response body');
        error = e;
        streamClosed = true;
        notify();
        throw e;
      }

      // R2.3: 用统一 parseSseFromStream
      try {
        await parseSseFromStream(response.body, (raw) => {
          if (cancelled) return;
          const evt = raw as BackendProxyEvent;
          if (evt.error) {
            error = new Error(String(evt.error));
            streamClosed = true;
            notify();
            return;
          }
          if (evt.done) {
            streamClosed = true;
            notify();
            return;
          }
          if (typeof evt.delta === 'string' && evt.delta.length > 0) {
            queue.push(evt.delta);
            notify();
          }
        });
      } catch (e) {
        error = e instanceof Error ? e : new Error(String(e));
      } finally {
        clearTimeout(timeoutId);
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
          // 等待新数据
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
