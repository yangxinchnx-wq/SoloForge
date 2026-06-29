/**
 * types.ts — LLM provider 抽象接口
 *
 * 设计原则（backend-patterns: Repository Pattern）：
 *   - 定义 Provider 接口（不绑死 OpenAI / Anthropic）
 *   - 任何兼容 OpenAI Chat Completions API 的服务都可接入
 *   - 真实 provider 在 OpenAICompatibleProvider.ts
 *   - 测试 provider 在 MockLLMProvider.ts
 */

export type LLMRole = 'system' | 'user' | 'assistant';

export interface LLMMessage {
  role: LLMRole;
  content: string;
}

export interface LLMRequest {
  /** 系统提示词（来自 LanguageAdapter.buildSystemPrompt） */
  systemPrompt?: string;
  /** 用户目标（来自 chat input） */
  userGoal: string;
  /** 历史消息（多轮对话） */
  history?: LLMMessage[];
  /** 模型名（默认 gpt-4o-mini / claude-3-5-sonnet-latest 视 provider） */
  model?: string;
  /** 采样温度 0~2 */
  temperature?: number;
  /** 最大输出 token */
  maxTokens?: number;
  /** 是否走 JSON 模式（部分 provider 支持） */
  jsonMode?: boolean;
}

export interface LLMProviderConfig {
  /** API base URL */
  baseUrl: string;
  /** API key（生产环境从 env 注入） */
  apiKey?: string;
  /** 默认模型 */
  defaultModel: string;
  /** 额外请求头 */
  headers?: Record<string, string>;
  /** 超时（ms） */
  timeoutMs?: number;
}

export interface LLMStreamHandle {
  /** 取消正在进行的流 */
  cancel(): void;
  /** 等待流结束 */
  done: Promise<void>;
  /** 异步迭代每个文本片段 */
  [Symbol.asyncIterator](): AsyncIterator<string>;
}

/**
 * LLM Provider 接口
 * 所有实现都必须：
 *   - 支持流式输出
 *   - 返回 AsyncIterable<string>
 *   - 支持取消
 */
export interface LLMProvider {
  readonly name: string;
  chatStream(req: LLMRequest): LLMStreamHandle;
}
