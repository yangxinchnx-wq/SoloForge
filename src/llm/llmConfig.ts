/**
 * llmConfig.ts — 后端 LLM 配置（从 env 读）
 *
 * 设计原则：
 *   - API key 永远只在后端进程，绝不发给前端
 *   - 支持任意 OpenAI 兼容服务（OpenAI / DeepSeek / OpenRouter / Moonshot / 自建）
 *   - 启动时打印当前 provider + model + baseUrl（**不打印 key**）
 *
 * 必需环境变量（要调用真实 LLM 时）：
 *   SOLOFORGE_LLM_PROVIDER=openai  (或 deepseek / openai-compatible)
 *   SOLOFORGE_LLM_API_KEY=sk-...
 *   SOLOFORGE_LLM_BASE_URL=https://api.openai.com/v1   (默认)
 *   SOLOFORGE_LLM_MODEL=gpt-4o-mini                    (默认)
 *
 * 可选：
 *   SOLOFORGE_LLM_TIMEOUT_MS=60000
 *   SOLOFORGE_LLM_API_TOKEN=xxx  ← 前端调用 /api/llm/stream 时需要带的简单 token
 *                                 留空表示同源即可（开发模式）
 */

export interface LLMProxyConfig {
  provider: string;
  baseUrl: string;
  apiKey: string;
  defaultModel: string;
  timeoutMs: number;
  /** 前端访问代理所需 token；空字符串 = 不校验（仅同源） */
  apiToken: string;
}

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_MODEL = 'gpt-4o-mini';
const DEFAULT_TIMEOUT_MS = 60_000;

let cached: LLMProxyConfig | null = null;

function loadFromEnv(): LLMProxyConfig {
  const env = process.env ?? {};
  return {
    provider: env.SOLOFORGE_LLM_PROVIDER ?? 'openai',
    baseUrl: env.SOLOFORGE_LLM_BASE_URL ?? DEFAULT_BASE_URL,
    apiKey: env.SOLOFORGE_LLM_API_KEY ?? '',
    defaultModel: env.SOLOFORGE_LLM_MODEL ?? DEFAULT_MODEL,
    timeoutMs: parseInt(env.SOLOFORGE_LLM_TIMEOUT_MS ?? String(DEFAULT_TIMEOUT_MS), 10),
    apiToken: env.SOLOFORGE_LLM_API_TOKEN ?? '',
  };
}

export function getLLMProxyConfig(): LLMProxyConfig {
  if (!cached) cached = loadFromEnv();
  return cached;
}

/** 强制刷新缓存（从环境变量重新加载） */
export function refreshLLMProxyConfig(): LLMProxyConfig {
  cached = loadFromEnv();
  return cached;
}

/** 测试用：注入新配置 */
export function setLLMProxyConfig(overrides: Partial<LLMProxyConfig>): void {
  cached = { ...getLLMProxyConfig(), ...overrides };
}

/** 测试用：清缓存 */
export function resetLLMProxyConfig(): void {
  cached = null;
}

/** 是否配置齐全（apiKey 非空） */
export function isLLMProxyReady(): boolean {
  const c = getLLMProxyConfig();
  return Boolean(c.apiKey && c.baseUrl && c.defaultModel);
}

/** 脱敏后的配置描述（用于日志/管理界面，**不包含 key**） */
export function describeLLMProxyConfig(): {
  provider: string;
  baseUrl: string;
  defaultModel: string;
  ready: boolean;
  tokenRequired: boolean;
} {
  const c = getLLMProxyConfig();
  return {
    provider: c.provider,
    baseUrl: c.baseUrl,
    defaultModel: c.defaultModel,
    ready: isLLMProxyReady(),
    tokenRequired: c.apiToken.length > 0,
  };
}
