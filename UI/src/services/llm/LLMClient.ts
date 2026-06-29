/**
 * LLMClient.ts — LLM 客户端顶层 facade
 *
 * 用法：
 *   const client = LLMClient.openai({ apiKey: env.LLM_API_KEY });
 *   const client = LLMClient.mock();          // 测试
 *   const client = LLMClient.fromEnv();       // 根据 import.meta.env 自动选
 *   const client = LLMClient.fromBackend();   // 走后端 /api/llm/stream 代理（P1 推荐）
 *
 *   for await (const chunk of client.stream({ systemPrompt, userGoal })) {
 *     parser.feedChunk(state, chunk);
 *   }
 */

import { OpenAICompatibleProvider } from './OpenAICompatibleProvider';
import { MockLLMProvider } from './MockLLMProvider';
import { BackendProxyProvider } from './BackendProxyProvider';
import type { LLMProvider, LLMRequest, LLMProviderConfig } from './types';

export class LLMClient {
  private constructor(public readonly provider: LLMProvider) {}

  /** OpenAI 官方 */
  static openai(config: Omit<LLMProviderConfig, 'defaultModel'> & { defaultModel?: string }): LLMClient {
    return new LLMClient(
      new OpenAICompatibleProvider('openai', {
        baseUrl: 'https://api.openai.com/v1',
        defaultModel: config.defaultModel ?? 'gpt-4o-mini',
        ...config,
      }),
    );
  }

  /** Anthropic（走 OpenAI 兼容 proxy） */
  static anthropic(config: Omit<LLMProviderConfig, 'defaultModel'> & { defaultModel?: string }): LLMClient {
    return new LLMClient(
      new OpenAICompatibleProvider('anthropic', {
        baseUrl: 'https://api.anthropic.com/v1',
        defaultModel: config.defaultModel ?? 'claude-3-5-sonnet-latest',
        ...config,
      }),
    );
  }

  /** 自定义 OpenAI 兼容服务（DeepSeek / OpenRouter / Moonshot 等） */
  static openaiCompatible(name: string, config: LLMProviderConfig): LLMClient {
    return new LLMClient(new OpenAICompatibleProvider(name, config));
  }

  /** 走后端 /api/llm/stream 代理（P1 推荐：API key 不出后端） */
  static fromBackend(config?: { apiBase?: string; token?: string; defaultModel?: string; timeoutMs?: number }): LLMClient {
    return new LLMClient(new BackendProxyProvider({
      apiBase: config?.apiBase,
      token: config?.token,
      defaultModel: config?.defaultModel ?? 'gpt-4o-mini',
      timeoutMs: config?.timeoutMs ?? 60_000,
      baseUrl: 'unused',
      apiKey: 'unused',
    }));
  }

  /** Mock provider（测试 / 离线开发） */
  static mock(): LLMClient {
    return new LLMClient(new MockLLMProvider());
  }

  /** 从环境变量自动选择 */
  static fromEnv(): LLMClient {
    const provider = (typeof process !== 'undefined' ? process.env?.LLM_PROVIDER : undefined) ?? 'openai';
    const apiKey = typeof process !== 'undefined' ? process.env?.LLM_API_KEY : undefined;
    const baseUrl = typeof process !== 'undefined' ? process.env?.LLM_BASE_URL : undefined;
    const model = typeof process !== 'undefined' ? process.env?.LLM_MODEL : undefined;
    const apiBase = (typeof process !== 'undefined' ? process.env?.VITE_API_BASE : undefined) ?? 'http://localhost:3001';
    const token = typeof process !== 'undefined' ? process.env?.VITE_LLM_API_TOKEN : undefined;

    // 优先级：backend > 直连 > mock
    if (provider === 'backend' || (provider === 'auto' && !apiKey)) {
      return LLMClient.fromBackend({ apiBase, token, defaultModel: model });
    }
    if (provider === 'mock' || !apiKey) {
      return LLMClient.mock();
    }

    return LLMClient.openaiCompatible(provider, {
      baseUrl: baseUrl ?? 'https://api.openai.com/v1',
      defaultModel: model ?? 'gpt-4o-mini',
      apiKey,
    });
  }

  /** 流式调用入口 */
  stream(req: LLMRequest) {
    return this.provider.chatStream(req);
  }
}
