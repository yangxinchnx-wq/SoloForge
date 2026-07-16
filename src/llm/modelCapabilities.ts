// ─────────────────────────────────────────────────────────────────
// modelCapabilities.ts — 模型能力范围查询 (本地脚本判断, 零 LLM 消耗)
//
// 设计原则:
//   - 纯本地判断, 不通过 LLM, 不发网络请求
//   - 数据来源: 硬编码已知模型 + 运行时探针结果 + 用户手动覆盖
//   - 匹配策略: 精确匹配 → 前缀匹配 → 模糊包含匹配
//   - 用途: agent 调用前判断模型支持哪些能力, 自动选择最佳路径
//
// 能力项:
//   - tools: Function Calling / tool_use (OpenAI tools 参数)
//   - vision: 图片输入 (image_url in content)
//   - json: JSON Mode (response_format: json_object)
//   - streaming: 流式输出 (stream: true)
//   - embeddings: 向量嵌入 (POST /embeddings)
// ─────────────────────────────────────────────────────────────────

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { logger } from '../core/logger';

const moduleName = 'ModelCapabilities';

// ─── 类型定义 ───────────────────────────────────────────────────

export interface ModelCapability {
  /** 是否支持 function calling / tools */
  supportsTools: boolean | null;
  /** 是否支持视觉 (图片输入) */
  supportsVision: boolean | null;
  /** 是否支持 JSON mode */
  supportsJson: boolean | null;
  /** 是否支持流式输出 */
  supportsStreaming: boolean | null;
  /** 上下文窗口大小 (tokens) */
  contextWindow: number | null;
  /** 最大输出 tokens */
  maxOutput: number | null;
  /** 数据来源: 'builtin' | 'probe' | 'manual' */
  source: 'builtin' | 'probe' | 'manual';
  /** 最后更新时间戳 */
  updatedAt: number;
}

export type CapabilityFeature = 'tools' | 'vision' | 'json' | 'streaming' | 'embeddings';

// ─── 硬编码已知模型能力 (内置兜底) ──────────────────────────────

const BUILTIN_DB: Record<string, ModelCapability> = {
  // ── OpenAI ──
  'gpt-4o':             { supportsTools: true,  supportsVision: true,  supportsJson: true,  supportsStreaming: true,  contextWindow: 128000,  maxOutput: 16384,  source: 'builtin', updatedAt: 0 },
  'gpt-4o-mini':        { supportsTools: true,  supportsVision: true,  supportsJson: true,  supportsStreaming: true,  contextWindow: 128000,  maxOutput: 16384,  source: 'builtin', updatedAt: 0 },
  'gpt-4-turbo':        { supportsTools: true,  supportsVision: true,  supportsJson: true,  supportsStreaming: true,  contextWindow: 128000,  maxOutput: 4096,   source: 'builtin', updatedAt: 0 },
  'gpt-4':              { supportsTools: true,  supportsVision: true,  supportsJson: true,  supportsStreaming: true,  contextWindow: 8192,    maxOutput: 4096,   source: 'builtin', updatedAt: 0 },
  'gpt-3.5-turbo':      { supportsTools: true,  supportsVision: false, supportsJson: true,  supportsStreaming: true,  contextWindow: 16385,   maxOutput: 4096,   source: 'builtin', updatedAt: 0 },
  'o1-preview':         { supportsTools: false, supportsVision: true,  supportsJson: false, supportsStreaming: false, contextWindow: 128000,  maxOutput: 32768,  source: 'builtin', updatedAt: 0 },
  'o1-mini':            { supportsTools: false, supportsVision: false, supportsJson: false, supportsStreaming: false, contextWindow: 128000,  maxOutput: 65536,  source: 'builtin', updatedAt: 0 },
  'o3-mini':            { supportsTools: true,  supportsVision: true,  supportsJson: true,  supportsStreaming: true,  contextWindow: 200000,  maxOutput: 100000, source: 'builtin', updatedAt: 0 },

  // ── Anthropic Claude ──
  'claude-3-5-sonnet':  { supportsTools: true,  supportsVision: true,  supportsJson: true,  supportsStreaming: true,  contextWindow: 200000,  maxOutput: 8192,   source: 'builtin', updatedAt: 0 },
  'claude-3-5-haiku':   { supportsTools: true,  supportsVision: true,  supportsJson: true,  supportsStreaming: true,  contextWindow: 200000,  maxOutput: 8192,   source: 'builtin', updatedAt: 0 },
  'claude-3-opus':      { supportsTools: true,  supportsVision: true,  supportsJson: true,  supportsStreaming: true,  contextWindow: 200000,  maxOutput: 4096,   source: 'builtin', updatedAt: 0 },

  // ── Google Gemini ──
  'gemini-2.0-flash':   { supportsTools: true,  supportsVision: true,  supportsJson: true,  supportsStreaming: true,  contextWindow: 1048576, maxOutput: 8192,   source: 'builtin', updatedAt: 0 },
  'gemini-2.5-pro':     { supportsTools: true,  supportsVision: true,  supportsJson: true,  supportsStreaming: true,  contextWindow: 1048576, maxOutput: 8192,   source: 'builtin', updatedAt: 0 },

  // ── DeepSeek ──
  'deepseek-chat':      { supportsTools: true,  supportsVision: false, supportsJson: true,  supportsStreaming: true,  contextWindow: 64000,   maxOutput: 8192,   source: 'builtin', updatedAt: 0 },
  'deepseek-reasoner':  { supportsTools: false, supportsVision: false, supportsJson: false, supportsStreaming: true,  contextWindow: 64000,   maxOutput: 8192,   source: 'builtin', updatedAt: 0 },

  // ── Qwen ──
  'qwen-turbo':         { supportsTools: true,  supportsVision: false, supportsJson: true,  supportsStreaming: true,  contextWindow: 1000000, maxOutput: 8192,   source: 'builtin', updatedAt: 0 },
  'qwen-plus':          { supportsTools: true,  supportsVision: false, supportsJson: true,  supportsStreaming: true,  contextWindow: 131072,  maxOutput: 8192,   source: 'builtin', updatedAt: 0 },
  'qwen-max':           { supportsTools: true,  supportsVision: false, supportsJson: true,  supportsStreaming: true,  contextWindow: 32768,   maxOutput: 8192,   source: 'builtin', updatedAt: 0 },

  // ── 智谱 GLM ──
  'glm-4':              { supportsTools: true,  supportsVision: true,  supportsJson: true,  supportsStreaming: true,  contextWindow: 128000,  maxOutput: 4096,   source: 'builtin', updatedAt: 0 },
  'glm-4-flash':        { supportsTools: true,  supportsVision: false, supportsJson: true,  supportsStreaming: true,  contextWindow: 128000,  maxOutput: 4096,   source: 'builtin', updatedAt: 0 },

  // ── 小米 MiMo (2026-07-16 实测：支持 function calling + reasoning_content) ──
  'mimo-v2.5':          { supportsTools: true,  supportsVision: false, supportsJson: true,  supportsStreaming: true,  contextWindow: 32768,   maxOutput: 4096,   source: 'builtin', updatedAt: 0 },
  'mimo-v2.5-pro':      { supportsTools: true,  supportsVision: false, supportsJson: true,  supportsStreaming: true,  contextWindow: 32768,   maxOutput: 4096,   source: 'builtin', updatedAt: 0 },

  // ── Moonshot Kimi ──
  'moonshot-v1-8k':     { supportsTools: true,  supportsVision: false, supportsJson: true,  supportsStreaming: true,  contextWindow: 8192,    maxOutput: 4096,   source: 'builtin', updatedAt: 0 },
  'moonshot-v1-32k':    { supportsTools: true,  supportsVision: false, supportsJson: true,  supportsStreaming: true,  contextWindow: 32768,   maxOutput: 4096,   source: 'builtin', updatedAt: 0 },

  // ── 豆包 Doubao ──
  'doubao-pro-32k':     { supportsTools: true,  supportsVision: false, supportsJson: true,  supportsStreaming: true,  contextWindow: 32000,   maxOutput: 4096,   source: 'builtin', updatedAt: 0 },
  'doubao-pro-128k':    { supportsTools: true,  supportsVision: false, supportsJson: true,  supportsStreaming: true,  contextWindow: 128000,  maxOutput: 4096,   source: 'builtin', updatedAt: 0 },
};

// ─── 前缀匹配规则 ──────────────────────────────────────────────

const PREFIX_RULES: Array<{ prefix: string; capability: Partial<ModelCapability> }> = [
  { prefix: 'gpt-4o',         capability: { supportsTools: true,  supportsVision: true  } },
  { prefix: 'gpt-4',          capability: { supportsTools: true,  supportsVision: true  } },
  { prefix: 'gpt-3.5',        capability: { supportsTools: true,  supportsVision: false } },
  { prefix: 'o1',             capability: { supportsTools: false, supportsVision: true  } },
  { prefix: 'o3',             capability: { supportsTools: true,  supportsVision: true  } },
  { prefix: 'claude-3',       capability: { supportsTools: true,  supportsVision: true  } },
  { prefix: 'gemini',         capability: { supportsTools: true,  supportsVision: true  } },
  { prefix: 'deepseek-chat',  capability: { supportsTools: true,  supportsVision: false } },
  { prefix: 'deepseek-coder', capability: { supportsTools: true,  supportsVision: false } },
  { prefix: 'deepseek-reasoner', capability: { supportsTools: false, supportsVision: false } },
  { prefix: 'deepseek-r1',    capability: { supportsTools: false, supportsVision: false } },
  { prefix: 'qwen',           capability: { supportsTools: true,  supportsVision: false } },
  { prefix: 'glm-4',          capability: { supportsTools: true,  supportsVision: true  } },
  { prefix: 'mimo',           capability: { supportsTools: true,  supportsVision: false } },
  { prefix: 'moonshot',       capability: { supportsTools: true,  supportsVision: false } },
  { prefix: 'doubao',         capability: { supportsTools: true,  supportsVision: false } },
  { prefix: 'yi-',            capability: { supportsTools: true,  supportsVision: false } },
  { prefix: 'baichuan',       capability: { supportsTools: true,  supportsVision: false } },
  { prefix: 'step',           capability: { supportsTools: true,  supportsVision: false } },
  { prefix: 'abab',           capability: { supportsTools: true,  supportsVision: false } },
  { prefix: 'mistral',        capability: { supportsTools: true,  supportsVision: false } },
  { prefix: 'mixtral',        capability: { supportsTools: true,  supportsVision: false } },
  { prefix: 'llama',          capability: { supportsTools: false, supportsVision: false } },
  { prefix: 'codellama',      capability: { supportsTools: false, supportsVision: false } },
];

// ─── 运行时状态 ─────────────────────────────────────────────────

/** 运行时探针结果缓存 (modelId → capability) */
const probeCache = new Map<string, ModelCapability>();

/** 用户手动覆盖 (modelId → capability) */
const manualOverrides = new Map<string, ModelCapability>();

/** 持久化文件路径 */
const CAPABILITIES_FILE = join(process.cwd(), 'data', 'model-capabilities.json');

// ─── 初始化: 从文件加载探针结果和手动覆盖 ─────────────────────

function loadFromFile(): void {
  if (!existsSync(CAPABILITIES_FILE)) return;
  try {
    const raw = readFileSync(CAPABILITIES_FILE, 'utf-8');
    const data = JSON.parse(raw);

    if (data.probeResults) {
      for (const [modelId, cap] of Object.entries(data.probeResults)) {
        probeCache.set(modelId, { ...(cap as ModelCapability), source: 'probe' });
      }
    }
    if (data.manualOverrides) {
      for (const [modelId, cap] of Object.entries(data.manualOverrides)) {
        manualOverrides.set(modelId, { ...(cap as ModelCapability), source: 'manual' });
      }
    }

    logger.info(moduleName, `已加载 ${probeCache.size} 条探针结果, ${manualOverrides.size} 条手动覆盖`);
  } catch (err) {
    logger.warn(moduleName, `加载 ${CAPABILITIES_FILE} 失败: ${err}`);
  }
}

function saveToFile(): void {
  try {
    const data = {
      version: '2026-07-09',
      probeResults: Object.fromEntries(probeCache),
      manualOverrides: Object.fromEntries(manualOverrides),
      savedAt: new Date().toISOString(),
    };
    writeFileSync(CAPABILITIES_FILE, JSON.stringify(data, null, 2), 'utf-8');
  } catch (err) {
    logger.warn(moduleName, `保存 ${CAPABILITIES_FILE} 失败: ${err}`);
  }
}

// 启动时加载
loadFromFile();

// ─── 核心查询函数 ──────────────────────────────────────────────

/**
 * 查询模型能力 (本地判断, 零网络请求)
 *
 * 优先级: 手动覆盖 > 探针结果 > 精确匹配内置DB > 前缀匹配 > 默认值
 *
 * @param modelId 模型 ID (如 'mimo-v2.5', 'gpt-4o')
 * @returns ModelCapability, 未匹配的字段为 null
 */
export function getModelCapabilities(modelId: string): ModelCapability {
  if (!modelId) {
    return { supportsTools: null, supportsVision: null, supportsJson: null, supportsStreaming: null, contextWindow: null, maxOutput: null, source: 'builtin', updatedAt: 0 };
  }

  const normalized = modelId.toLowerCase().trim();

  // 1. 手动覆盖 (最高优先级)
  const manual = manualOverrides.get(normalized);
  if (manual) return manual;

  // 2. 探针结果
  const probed = probeCache.get(normalized);
  if (probed) return probed;

  // 3. 精确匹配内置 DB
  const exact = BUILTIN_DB[normalized];
  if (exact) return exact;

  // 4. 前缀匹配
  for (const rule of PREFIX_RULES) {
    if (normalized.startsWith(rule.prefix)) {
      return {
        supportsTools: rule.capability.supportsTools ?? null,
        supportsVision: rule.capability.supportsVision ?? null,
        supportsJson: rule.capability.supportsJson ?? null,
        supportsStreaming: rule.capability.supportsStreaming ?? null,
        contextWindow: rule.capability.contextWindow ?? null,
        maxOutput: rule.capability.maxOutput ?? null,
        source: 'builtin',
        updatedAt: 0,
      };
    }
  }

  // 5. 默认: 未知模型, 所有能力为 null (调用方应做保守处理)
  return { supportsTools: null, supportsVision: null, supportsJson: null, supportsStreaming: null, contextWindow: null, maxOutput: null, source: 'builtin', updatedAt: 0 };
}

/**
 * 检查模型是否支持某项能力
 *
 * @param modelId 模型 ID
 * @param feature 能力项: 'tools' | 'vision' | 'json' | 'streaming' | 'embeddings'
 * @returns true=支持, false=不支持, null=未知
 */
export function supportsFeature(modelId: string, feature: CapabilityFeature): boolean | null {
  const cap = getModelCapabilities(modelId);

  switch (feature) {
    case 'tools':      return cap.supportsTools;
    case 'vision':     return cap.supportsVision;
    case 'json':       return cap.supportsJson;
    case 'streaming':  return cap.supportsStreaming;
    default:           return null;
  }
}

/**
 * 检查模型是否支持 function calling (tools)
 * 这是最常用的查询, 提供快捷方法
 *
 * @returns true=支持, false=不支持, null=未知
 */
export function supportsTools(modelId: string): boolean | null {
  return supportsFeature(modelId, 'tools');
}

// ─── 运行时更新: 探针结果回写 ─────────────────────────────────

/**
 * 保存探针结果到运行时缓存并持久化
 *
 * 由前端 /api/providers/model-probe 回调或后端探针触发
 *
 * @param modelId 模型 ID
 * @param probeResult 探针结果 (部分字段)
 */
export function saveProbeResult(modelId: string, probeResult: {
  supportsTools?: boolean | null;
  supportsVision?: boolean | null;
  supportsJson?: boolean | null;
  supportsStreaming?: boolean | null;
  contextWindow?: number | null;
  maxOutput?: number | null;
}): void {
  if (!modelId) return;

  const normalized = modelId.toLowerCase().trim();
  const existing = probeCache.get(normalized);

  probeCache.set(normalized, {
    supportsTools: probeResult.supportsTools ?? existing?.supportsTools ?? null,
    supportsVision: probeResult.supportsVision ?? existing?.supportsVision ?? null,
    supportsJson: probeResult.supportsJson ?? existing?.supportsJson ?? null,
    supportsStreaming: probeResult.supportsStreaming ?? existing?.supportsStreaming ?? null,
    contextWindow: probeResult.contextWindow ?? existing?.contextWindow ?? null,
    maxOutput: probeResult.maxOutput ?? existing?.maxOutput ?? null,
    source: 'probe',
    updatedAt: Date.now(),
  });

  saveToFile();
  logger.info(moduleName, `已保存探针结果: ${normalized} → tools=${probeResult.supportsTools}, vision=${probeResult.supportsVision}`);
}

/**
 * 从 LLM API 响应中学习模型能力 (运行时自适应)
 *
 * 当请求失败时, 根据错误类型推断模型不支持该能力
 * 当请求成功时, 确认模型支持该能力
 *
 * @param modelId 模型 ID
 * @param feature 能力项
 * @param supported 是否支持 (从实际请求结果推断)
 */
export function learnCapability(modelId: string, feature: CapabilityFeature, supported: boolean): void {
  if (!modelId) return;

  const normalized = modelId.toLowerCase().trim();
  const existing = probeCache.get(normalized) || getModelCapabilities(normalized);

  const updated: ModelCapability = {
    ...existing,
    source: 'probe',
    updatedAt: Date.now(),
  };

  switch (feature) {
    case 'tools':     updated.supportsTools = supported; break;
    case 'vision':    updated.supportsVision = supported; break;
    case 'json':      updated.supportsJson = supported; break;
    case 'streaming': updated.supportsStreaming = supported; break;
  }

  probeCache.set(normalized, updated);
  saveToFile();
  logger.info(moduleName, `运行时学习: ${normalized} ${feature}=${supported}`);
}

// ─── 调试/管理接口 ─────────────────────────────────────────────

/** 获取所有已知模型能力 (内置 + 探针 + 手动) */
export function getAllCapabilities(): Record<string, ModelCapability> {
  const result: Record<string, ModelCapability> = {};

  // 内置 (底层)
  for (const [id, cap] of Object.entries(BUILTIN_DB)) {
    result[id] = cap;
  }

  // 探针结果覆盖
  for (const [id, cap] of probeCache) {
    result[id] = cap;
  }

  // 手动覆盖 (最高层)
  for (const [id, cap] of manualOverrides) {
    result[id] = cap;
  }

  return result;
}

/** 获取模型能力摘要 (用于日志/调试) */
export function describeCapabilities(modelId: string): string {
  const cap = getModelCapabilities(modelId);
  const parts: string[] = [];
  if (cap.supportsTools === true) parts.push('tools');
  if (cap.supportsTools === false) parts.push('no-tools');
  if (cap.supportsVision === true) parts.push('vision');
  if (cap.supportsJson === true) parts.push('json');
  if (cap.supportsStreaming === true) parts.push('streaming');
  if (cap.contextWindow) parts.push(`ctx=${cap.contextWindow}`);
  return `[${cap.source}] ${parts.join(', ') || 'unknown'}`;
}
