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
    // Vite 浏览器环境: import.meta.env (优先), Node 环境: process.env
    const viteEnv = (typeof import.meta !== 'undefined' && (import.meta as any).env) || {};
    const nodeEnv = (typeof process !== 'undefined' ? process.env : undefined) || {};

    const provider = viteEnv.VITE_LLM_PROVIDER || nodeEnv.LLM_PROVIDER;
    const apiKey = viteEnv.VITE_LLM_API_KEY || nodeEnv.LLM_API_KEY;
    const baseUrl = viteEnv.VITE_LLM_BASE_URL || nodeEnv.LLM_BASE_URL;
    const model = viteEnv.VITE_LLM_MODEL || nodeEnv.LLM_MODEL;
    // 浏览器端 apiBase 留空 → 相对 URL, 走 3000 代理
    const apiBase = nodeEnv.VITE_API_BASE ?? '';
    const token = viteEnv.VITE_LLM_API_TOKEN || nodeEnv.VITE_LLM_API_TOKEN;

    // 未显式指定 provider 时的默认行为:
    //   - 浏览器环境 → backend 代理 (API key 不出前端)
    //   - Node/测试环境 + 无 API key → mock (安全默认值)
    if (!provider) {
      if (typeof window === 'undefined' && !apiKey && !token) {
        return LLMClient.mock();
      }
      return LLMClient.fromBackend({ apiBase, token, defaultModel: model });
    }

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
