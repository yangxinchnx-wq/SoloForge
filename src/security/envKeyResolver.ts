/**
 * envKeyResolver.ts — 环境变量兜底 (2026-06-28 引入)
 *
 * 优先级:
 *   1) 操作系统钥匙串 (keytar, 由 ApiKeyVault 管)
 *   2) 进程环境变量 (本模块管)
 *
 * 用法:
 *   - 用户没在 UI 里配置 provider, 但希望"系统全局可用" → 直接 export PROVIDER=xxx
 *   - CI / Docker / 容器化部署 → 只设环境变量即可, 不必在每台机器上手动 keytar
 *   - 高级用户想统一管理多个 IDE 的 key → OPENAI_API_KEY 一处生效, 多个工具共享
 *
 * 命名规则:
 *   - 内置 provider 用通用名 (OPENAI_API_KEY / ANTHROPIC_API_KEY / GEMINI_API_KEY 等)
 *   - 自定义 provider 用 <PROVIDER_ID>_API_KEY (大写)
 *   - baseUrl 走 <PROVIDER_ID>_BASE_URL (可选, 不设走 ProviderMeta 默认值)
 */

import { logger } from '../core/logger';

export interface EnvKeyResolution {
  apiKey: string;
  baseUrl?: string;
  /** 用于追踪日志/UI 提示: 实际生效的变量名 */
  envVarName: string;
}

/**
 * providerId → (apiKey env var name, baseUrl env var name, 默认 baseUrl)
 * 内置主流 provider 一次性列全, 自定义 provider 走通用映射规则
 */
const BUILTIN_ENV_MAP: Record<string, {
  keyEnv: string;
  baseEnv?: string;
  defaultBaseUrl?: string;
}> = {
  openai:      { keyEnv: 'OPENAI_API_KEY',      baseEnv: 'OPENAI_BASE_URL',      defaultBaseUrl: 'https://api.openai.com/v1' },
  anthropic:   { keyEnv: 'ANTHROPIC_API_KEY',   baseEnv: 'ANTHROPIC_BASE_URL',   defaultBaseUrl: 'https://api.anthropic.com' },
  gemini:      { keyEnv: 'GEMINI_API_KEY',      baseEnv: 'GEMINI_BASE_URL',      defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta' },
  deepseek:    { keyEnv: 'DEEPSEEK_API_KEY',    baseEnv: 'DEEPSEEK_BASE_URL',    defaultBaseUrl: 'https://api.deepseek.com/v1' },
  moonshot:    { keyEnv: 'MOONSHOT_API_KEY',    baseEnv: 'MOONSHOT_BASE_URL',    defaultBaseUrl: 'https://api.moonshot.cn/v1' },
  siliconflow: { keyEnv: 'SILICONFLOW_API_KEY', baseEnv: 'SILICONFLOW_BASE_URL', defaultBaseUrl: 'https://api.siliconflow.cn/v1' },
  xiaomi:      { keyEnv: 'XIAOMI_API_KEY',      baseEnv: 'XIAOMI_BASE_URL',      defaultBaseUrl: 'https://api.xiaomimimo.com/v1' },
  // 通用别名: 用户设置 SOLOFORGE_LLM_API_KEY 时, 默认归到 "default" provider
  // (llmConfig.ts 已处理, 这里不再重复)
};

/**
 * 解析 provider 的 env key
 * @returns null 表示环境变量没设
 */
export function resolveEnvKey(providerId: string): EnvKeyResolution | null {
  if (!providerId || typeof providerId !== 'string') return null;
  const id = providerId.toLowerCase();

  // 1) 内置映射
  const builtin = BUILTIN_ENV_MAP[id];
  if (builtin) {
    const apiKey = process.env[builtin.keyEnv];
    if (!apiKey) return null;
    return {
      apiKey,
      baseUrl: process.env[builtin.baseEnv || ''] || builtin.defaultBaseUrl,
      envVarName: builtin.keyEnv,
    };
  }

  // 2) 通用规则: <PROVIDER_ID>_API_KEY (大写, 下划线分隔)
  //   例: providerId="custom-foo" → "CUSTOM_FOO_API_KEY"
  const genericKey = id.replace(/-/g, '_').toUpperCase() + '_API_KEY';
  const apiKey = process.env[genericKey];
  if (!apiKey) return null;
  const genericBase = id.replace(/-/g, '_').toUpperCase() + '_BASE_URL';
  return {
    apiKey,
    baseUrl: process.env[genericBase],
    envVarName: genericKey,
  };
}

/** 该 provider 是否支持从 env 解析 (用于 UI 提示) */
export function envSupportsBaseUrl(providerId: string): boolean {
  if (!providerId) return false;
  return !!BUILTIN_ENV_MAP[providerId.toLowerCase()];
}

/** 列出所有"有 env key"的 providerId (供 listPublic 第 3 路使用) */
export function listEnvProviders(): string[] {
  const ids: string[] = [];

  // 内置: 进程环境里命中的就列
  for (const [id, map] of Object.entries(BUILTIN_ENV_MAP)) {
    if (process.env[map.keyEnv]) ids.push(id);
  }

  // 通用规则扫一遍: 任意 *_API_KEY 都计入 (匹配 GENERIC_xxx_API_KEY 模式)
  for (const [name, value] of Object.entries(process.env)) {
    if (!name.endsWith('_API_KEY') || !value) continue;
    if (Object.values(BUILTIN_ENV_MAP).some((m) => m.keyEnv === name)) continue; // 已被内置收录
    // 还原成 providerId: "CUSTOM_FOO_API_KEY" → "custom-foo"
    const stripped = name.slice(0, -'_API_KEY'.length);
    const providerId = stripped.toLowerCase().replace(/_/g, '-');
    if (providerId && !ids.includes(providerId)) ids.push(providerId);
  }

  return ids;
}

/**
 * 调试用: 列出当前进程内所有"看起来是 LLM key"的环境变量
 * 不返回 value, 只返回 env var 名 → 避免日志泄露
 */
export function debugListEnvVars(): string[] {
  const hits: string[] = [];
  for (const [name, value] of Object.entries(process.env)) {
    if (!value) continue;
    if (name.endsWith('_API_KEY')) hits.push(name);
    else if (name === 'SOLOFORGE_LLM_API_KEY') hits.push(name);
  }
  return hits;
}

// 仅当显式开启调试时才在启动时打印检测到的 LLM env vars
if (process.env.SOLOFORGE_DEBUG_ENV === '1') {
  const hits = debugListEnvVars();
  if (hits.length > 0) {
    logger.info('EnvKey', `detected ${hits.length} LLM env var(s): ${hits.join(', ')}`);
  }
}