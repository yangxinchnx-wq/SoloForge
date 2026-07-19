// =====================================================
// 本地模型元数据库
// 上游 /models 接口 (OpenAI 兼容) 通常不返回上下文窗口、
// 模态等详细参数。此文件为常见模型提供硬编码元数据兜底。
//
// 数据来源：各厂商官方文档 (2025-01 ~ 2025-06)
// 匹配策略：精确匹配 → 前缀匹配 → 模糊包含匹配
// =====================================================
import type { ModelMetadata } from './providersRegistry';

const DB: Record<string, ModelMetadata> = {
  // ── OpenAI ──
  'gpt-4o': { contextWindow: 128000, maxOutput: 16384, inputModalities: ['text', 'image', 'audio'], outputModalities: ['text', 'image'], supportsTools: true, supportsJson: true, supportsStreaming: true, supportsVision: true, owner: 'openai', description: 'GPT-4o 多模态旗舰模型', pricingInput: 2.5, pricingOutput: 10 },
  'gpt-4o-mini': { contextWindow: 128000, maxOutput: 16384, inputModalities: ['text', 'image', 'audio'], outputModalities: ['text', 'image'], supportsTools: true, supportsJson: true, supportsStreaming: true, supportsVision: true, owner: 'openai', description: 'GPT-4o mini 高性价比多模态', pricingInput: 0.15, pricingOutput: 0.6 },
  'gpt-4-turbo': { contextWindow: 128000, maxOutput: 4096, inputModalities: ['text', 'image'], outputModalities: ['text'], supportsTools: true, supportsJson: true, supportsStreaming: true, supportsVision: true, owner: 'openai', description: 'GPT-4 Turbo', pricingInput: 10, pricingOutput: 30 },
  'gpt-4': { contextWindow: 8192, maxOutput: 4096, inputModalities: ['text', 'image'], outputModalities: ['text'], supportsTools: true, supportsJson: true, supportsStreaming: true, supportsVision: true, owner: 'openai', description: 'GPT-4 基础版', pricingInput: 30, pricingOutput: 60 },
  'gpt-3.5-turbo': { contextWindow: 16385, maxOutput: 4096, inputModalities: ['text'], outputModalities: ['text'], supportsTools: true, supportsJson: true, supportsStreaming: true, supportsVision: false, owner: 'openai', description: 'GPT-3.5 Turbo 经济型', pricingInput: 0.5, pricingOutput: 1.5 },
  'o1-preview': { contextWindow: 128000, maxOutput: 32768, inputModalities: ['text', 'image'], outputModalities: ['text'], supportsTools: false, supportsJson: false, supportsStreaming: false, supportsVision: true, owner: 'openai', description: 'o1 推理模型预览版', pricingInput: 15, pricingOutput: 60 },
  'o1-mini': { contextWindow: 128000, maxOutput: 65536, inputModalities: ['text'], outputModalities: ['text'], supportsTools: false, supportsJson: false, supportsStreaming: false, supportsVision: false, owner: 'openai', description: 'o1 mini 推理模型', pricingInput: 3, pricingOutput: 12 },
  'o3-mini': { contextWindow: 200000, maxOutput: 100000, inputModalities: ['text', 'image'], outputModalities: ['text'], supportsTools: true, supportsJson: true, supportsStreaming: true, supportsVision: true, owner: 'openai', description: 'o3-mini 推理模型', pricingInput: 1.1, pricingOutput: 4.4 },

  // ── Anthropic Claude ──
  'claude-3-5-sonnet': { contextWindow: 200000, maxOutput: 8192, inputModalities: ['text', 'image'], outputModalities: ['text'], supportsTools: true, supportsJson: true, supportsStreaming: true, supportsVision: true, owner: 'anthropic', description: 'Claude 3.5 Sonnet 旗舰', pricingInput: 3, pricingOutput: 15 },
  'claude-3-5-sonnet-latest': { contextWindow: 200000, maxOutput: 8192, inputModalities: ['text', 'image'], outputModalities: ['text'], supportsTools: true, supportsJson: true, supportsStreaming: true, supportsVision: true, owner: 'anthropic', description: 'Claude 3.5 Sonnet 最新版', pricingInput: 3, pricingOutput: 15 },
  'claude-3-5-haiku': { contextWindow: 200000, maxOutput: 8192, inputModalities: ['text', 'image'], outputModalities: ['text'], supportsTools: true, supportsJson: true, supportsStreaming: true, supportsVision: true, owner: 'anthropic', description: 'Claude 3.5 Haiku 快速型', pricingInput: 0.8, pricingOutput: 4 },
  'claude-3-5-haiku-latest': { contextWindow: 200000, maxOutput: 8192, inputModalities: ['text', 'image'], outputModalities: ['text'], supportsTools: true, supportsJson: true, supportsStreaming: true, supportsVision: true, owner: 'anthropic', description: 'Claude 3.5 Haiku 最新版', pricingInput: 0.8, pricingOutput: 4 },
  'claude-3-opus': { contextWindow: 200000, maxOutput: 4096, inputModalities: ['text', 'image'], outputModalities: ['text'], supportsTools: true, supportsJson: true, supportsStreaming: true, supportsVision: true, owner: 'anthropic', description: 'Claude 3 Opus', pricingInput: 15, pricingOutput: 75 },
  'claude-3-opus-20240229': { contextWindow: 200000, maxOutput: 4096, inputModalities: ['text', 'image'], outputModalities: ['text'], supportsTools: true, supportsJson: true, supportsStreaming: true, supportsVision: true, owner: 'anthropic', description: 'Claude 3 Opus (日期版)', pricingInput: 15, pricingOutput: 75 },
  'claude-3-sonnet': { contextWindow: 200000, maxOutput: 4096, inputModalities: ['text', 'image'], outputModalities: ['text'], supportsTools: true, supportsJson: true, supportsStreaming: true, supportsVision: true, owner: 'anthropic', description: 'Claude 3 Sonnet', pricingInput: 3, pricingOutput: 15 },
  'claude-3-haiku': { contextWindow: 200000, maxOutput: 4096, inputModalities: ['text', 'image'], outputModalities: ['text'], supportsTools: true, supportsJson: true, supportsStreaming: true, supportsVision: true, owner: 'anthropic', description: 'Claude 3 Haiku 经济型', pricingInput: 0.25, pricingOutput: 1.25 },

  // ── Google Gemini ──
  'gemini-2.0-flash': { contextWindow: 1048576, maxOutput: 8192, inputModalities: ['text', 'image', 'audio', 'video'], outputModalities: ['text'], supportsTools: true, supportsJson: true, supportsStreaming: true, supportsVision: true, owner: 'google', description: 'Gemini 2.0 Flash 快速多模态' },
  'gemini-2.0-flash-exp': { contextWindow: 1048576, maxOutput: 8192, inputModalities: ['text', 'image', 'audio', 'video'], outputModalities: ['text'], supportsTools: true, supportsJson: true, supportsStreaming: true, supportsVision: true, owner: 'google', description: 'Gemini 2.0 Flash 实验版' },
  'gemini-1.5-pro': { contextWindow: 2097152, maxOutput: 8192, inputModalities: ['text', 'image', 'audio', 'video'], outputModalities: ['text'], supportsTools: true, supportsJson: true, supportsStreaming: true, supportsVision: true, owner: 'google', description: 'Gemini 1.5 Pro 超长上下文', pricingInput: 1.25, pricingOutput: 5 },
  'gemini-1.5-flash': { contextWindow: 1048576, maxOutput: 8192, inputModalities: ['text', 'image', 'audio', 'video'], outputModalities: ['text'], supportsTools: true, supportsJson: true, supportsStreaming: true, supportsVision: true, owner: 'google', description: 'Gemini 1.5 Flash 快速型', pricingInput: 0.075, pricingOutput: 0.3 },
  'gemini-2.5-pro': { contextWindow: 1048576, maxOutput: 8192, inputModalities: ['text', 'image', 'audio', 'video'], outputModalities: ['text'], supportsTools: true, supportsJson: true, supportsStreaming: true, supportsVision: true, owner: 'google', description: 'Gemini 2.5 Pro' },
  'gemini-2.5-flash': { contextWindow: 1048576, maxOutput: 8192, inputModalities: ['text', 'image', 'audio', 'video'], outputModalities: ['text'], supportsTools: true, supportsJson: true, supportsStreaming: true, supportsVision: true, owner: 'google', description: 'Gemini 2.5 Flash' },

  // ── DeepSeek ──
  'deepseek-chat': { contextWindow: 64000, maxOutput: 8192, inputModalities: ['text'], outputModalities: ['text'], supportsTools: true, supportsJson: true, supportsStreaming: true, supportsVision: false, owner: 'deepseek', description: 'DeepSeek-V3 通用对话', pricingInput: 0.27, pricingOutput: 1.1 },
  'deepseek-reasoner': { contextWindow: 64000, maxOutput: 8192, inputModalities: ['text'], outputModalities: ['text'], supportsTools: false, supportsJson: false, supportsStreaming: true, supportsVision: false, owner: 'deepseek', description: 'DeepSeek-R1 推理模型', pricingInput: 0.55, pricingOutput: 2.19 },

  // ── Qwen 通义千问 ──
  'qwen-turbo': { contextWindow: 1000000, maxOutput: 8192, inputModalities: ['text'], outputModalities: ['text'], supportsTools: true, supportsJson: true, supportsStreaming: true, supportsVision: false, owner: 'alibaba', description: 'Qwen Turbo 快速型' },
  'qwen-plus': { contextWindow: 131072, maxOutput: 8192, inputModalities: ['text'], outputModalities: ['text'], supportsTools: true, supportsJson: true, supportsStreaming: true, supportsVision: false, owner: 'alibaba', description: 'Qwen Plus 均衡型' },
  'qwen-max': { contextWindow: 32768, maxOutput: 8192, inputModalities: ['text'], outputModalities: ['text'], supportsTools: true, supportsJson: true, supportsStreaming: true, supportsVision: false, owner: 'alibaba', description: 'Qwen Max 旗舰型' },
  'qwen-vl-max': { contextWindow: 32768, maxOutput: 8192, inputModalities: ['text', 'image'], outputModalities: ['text'], supportsTools: true, supportsJson: true, supportsStreaming: true, supportsVision: true, owner: 'alibaba', description: 'Qwen VL Max 视觉理解' },
  'qwen-vl-plus': { contextWindow: 32768, maxOutput: 8192, inputModalities: ['text', 'image'], outputModalities: ['text'], supportsTools: true, supportsJson: true, supportsStreaming: true, supportsVision: true, owner: 'alibaba', description: 'Qwen VL Plus 视觉理解' },

  // ── 智谱 GLM ──
  'glm-4': { contextWindow: 128000, maxOutput: 4096, inputModalities: ['text', 'image'], outputModalities: ['text'], supportsTools: true, supportsJson: true, supportsStreaming: true, supportsVision: true, owner: 'zhipu', description: 'GLM-4 旗舰模型' },
  'glm-4-plus': { contextWindow: 128000, maxOutput: 4096, inputModalities: ['text', 'image'], outputModalities: ['text'], supportsTools: true, supportsJson: true, supportsStreaming: true, supportsVision: true, owner: 'zhipu', description: 'GLM-4 Plus' },
  'glm-4-flash': { contextWindow: 128000, maxOutput: 4096, inputModalities: ['text'], outputModalities: ['text'], supportsTools: true, supportsJson: true, supportsStreaming: true, supportsVision: false, owner: 'zhipu', description: 'GLM-4 Flash 免费快速型' },
  'glm-4v': { contextWindow: 8192, maxOutput: 1024, inputModalities: ['text', 'image'], outputModalities: ['text'], supportsTools: false, supportsJson: false, supportsStreaming: true, supportsVision: true, owner: 'zhipu', description: 'GLM-4V 视觉模型' },

  // ── 豆包 Doubao ──
  'doubao-pro-32k': { contextWindow: 32000, maxOutput: 4096, inputModalities: ['text'], outputModalities: ['text'], supportsTools: true, supportsJson: true, supportsStreaming: true, supportsVision: false, owner: 'bytedance', description: '豆包 Pro 32K' },
  'doubao-pro-128k': { contextWindow: 128000, maxOutput: 4096, inputModalities: ['text'], outputModalities: ['text'], supportsTools: true, supportsJson: true, supportsStreaming: true, supportsVision: false, owner: 'bytedance', description: '豆包 Pro 128K' },
  'doubao-vision-pro-32k': { contextWindow: 32000, maxOutput: 4096, inputModalities: ['text', 'image'], outputModalities: ['text'], supportsTools: true, supportsJson: true, supportsStreaming: true, supportsVision: true, owner: 'bytedance', description: '豆包视觉理解 Pro' },

  // ── 月之暗面 Kimi ──
  'moonshot-v1-8k': { contextWindow: 8192, maxOutput: 4096, inputModalities: ['text'], outputModalities: ['text'], supportsTools: true, supportsJson: true, supportsStreaming: true, supportsVision: false, owner: 'moonshot', description: 'Kimi 8K 上下文', pricingInput: 1.67, pricingOutput: 1.67 },
  'moonshot-v1-32k': { contextWindow: 32768, maxOutput: 4096, inputModalities: ['text'], outputModalities: ['text'], supportsTools: true, supportsJson: true, supportsStreaming: true, supportsVision: false, owner: 'moonshot', description: 'Kimi 32K 上下文', pricingInput: 3.34, pricingOutput: 3.34 },
  'moonshot-v1-128k': { contextWindow: 128000, maxOutput: 4096, inputModalities: ['text'], outputModalities: ['text'], supportsTools: true, supportsJson: true, supportsStreaming: true, supportsVision: false, owner: 'moonshot', description: 'Kimi 128K 超长上下文', pricingInput: 8.4, pricingOutput: 8.4 },

  // ── MiniMax ──
  'abab6.5-chat': { contextWindow: 245760, maxOutput: 8192, inputModalities: ['text'], outputModalities: ['text'], supportsTools: true, supportsJson: true, supportsStreaming: true, supportsVision: false, owner: 'minimax', description: 'abab6.5 对话模型' },
  'abab6.5s-chat': { contextWindow: 245760, maxOutput: 8192, inputModalities: ['text'], outputModalities: ['text'], supportsTools: true, supportsJson: true, supportsStreaming: true, supportsVision: false, owner: 'minimax', description: 'abab6.5s 快速型' },

  // ── 百川 Baichuan ──
  'Baichuan4-Turbo': { contextWindow: 192000, maxOutput: 4096, inputModalities: ['text'], outputModalities: ['text'], supportsTools: true, supportsJson: true, supportsStreaming: true, supportsVision: false, owner: 'baichuan', description: '百川4 Turbo' },
  'Baichuan4-Air': { contextWindow: 32000, maxOutput: 4096, inputModalities: ['text'], outputModalities: ['text'], supportsTools: true, supportsJson: true, supportsStreaming: true, supportsVision: false, owner: 'baichuan', description: '百川4 Air 轻量' },

  // ── 零一万物 Yi ──
  'yi-large': { contextWindow: 32768, maxOutput: 4096, inputModalities: ['text'], outputModalities: ['text'], supportsTools: true, supportsJson: true, supportsStreaming: true, supportsVision: false, owner: '01ai', description: 'Yi Large 旗舰' },
  'yi-medium': { contextWindow: 16384, maxOutput: 4096, inputModalities: ['text'], outputModalities: ['text'], supportsTools: true, supportsJson: true, supportsStreaming: true, supportsVision: false, owner: '01ai', description: 'Yi Medium 均衡' },
  'yi-vision': { contextWindow: 16384, maxOutput: 4096, inputModalities: ['text', 'image'], outputModalities: ['text'], supportsTools: true, supportsJson: true, supportsStreaming: true, supportsVision: true, owner: '01ai', description: 'Yi Vision 视觉模型' },

  // ── 阶跃星辰 Step ──
  'step-1-8k': { contextWindow: 8192, maxOutput: 4096, inputModalities: ['text'], outputModalities: ['text'], supportsTools: true, supportsJson: true, supportsStreaming: true, supportsVision: false, owner: 'stepfun', description: 'Step-1 8K' },
  'step-1-32k': { contextWindow: 32768, maxOutput: 4096, inputModalities: ['text'], outputModalities: ['text'], supportsTools: true, supportsJson: true, supportsStreaming: true, supportsVision: false, owner: 'stepfun', description: 'Step-1 32K' },
  'step-1-128k': { contextWindow: 128000, maxOutput: 4096, inputModalities: ['text'], outputModalities: ['text'], supportsTools: true, supportsJson: true, supportsStreaming: true, supportsVision: false, owner: 'stepfun', description: 'Step-1 128K 超长上下文' },
  'step-1v-8k': { contextWindow: 8192, maxOutput: 4096, inputModalities: ['text', 'image'], outputModalities: ['text'], supportsTools: true, supportsJson: true, supportsStreaming: true, supportsVision: true, owner: 'stepfun', description: 'Step-1V 8K 视觉模型' },

  // ── 小米 MiMo ──
  'mimo-v2.5': { contextWindow: 32768, maxOutput: 4096, inputModalities: ['text'], outputModalities: ['text'], supportsTools: true, supportsJson: true, supportsStreaming: true, supportsVision: false, owner: 'xiaomi', description: 'MiMo v2.5 对话模型' },
  'mimo-v2.5-pro': { contextWindow: 32768, maxOutput: 4096, inputModalities: ['text'], outputModalities: ['text'], supportsTools: true, supportsJson: true, supportsStreaming: true, supportsVision: false, owner: 'xiaomi', description: 'MiMo v2.5 Pro 旗舰' },

  // ── Mistral ──
  'mistral-large-latest': { contextWindow: 128000, maxOutput: 8192, inputModalities: ['text'], outputModalities: ['text'], supportsTools: true, supportsJson: true, supportsStreaming: true, supportsVision: false, owner: 'mistral', description: 'Mistral Large 旗舰', pricingInput: 2, pricingOutput: 6 },
  'mistral-small-latest': { contextWindow: 32000, maxOutput: 8192, inputModalities: ['text'], outputModalities: ['text'], supportsTools: true, supportsJson: true, supportsStreaming: true, supportsVision: false, owner: 'mistral', description: 'Mistral Small 快速型', pricingInput: 0.2, pricingOutput: 0.6 },
  'pixtral-large-latest': { contextWindow: 128000, maxOutput: 8192, inputModalities: ['text', 'image'], outputModalities: ['text'], supportsTools: true, supportsJson: true, supportsStreaming: true, supportsVision: true, owner: 'mistral', description: 'Pixtral Large 视觉', pricingInput: 2, pricingOutput: 6 },

  // ── Groq (开源模型加速) ──
  'llama-3.3-70b-versatile': { contextWindow: 128000, maxOutput: 32768, inputModalities: ['text'], outputModalities: ['text'], supportsTools: true, supportsJson: true, supportsStreaming: true, supportsVision: false, owner: 'meta', description: 'Llama 3.3 70B (Groq加速)' },
  'llama-3.1-8b-instant': { contextWindow: 128000, maxOutput: 8192, inputModalities: ['text'], outputModalities: ['text'], supportsTools: true, supportsJson: true, supportsStreaming: true, supportsVision: false, owner: 'meta', description: 'Llama 3.1 8B (Groq加速)' },

  // ── Cohere ──
  'command-r-plus': { contextWindow: 128000, maxOutput: 4096, inputModalities: ['text'], outputModalities: ['text'], supportsTools: true, supportsJson: true, supportsStreaming: true, supportsVision: false, owner: 'cohere', description: 'Command R+ 企业级' },
  'command-r': { contextWindow: 128000, maxOutput: 4096, inputModalities: ['text'], outputModalities: ['text'], supportsTools: true, supportsJson: true, supportsStreaming: true, supportsVision: false, owner: 'cohere', description: 'Command R' },
};

/** 前缀匹配规则：model id 以某前缀开头时套用对应元数据 */
const PREFIX_RULES: Array<{ prefix: string; meta: ModelMetadata }> = [
  { prefix: 'gpt-4o', meta: DB['gpt-4o'] },
  { prefix: 'gpt-4-turbo', meta: DB['gpt-4-turbo'] },
  { prefix: 'gpt-4', meta: DB['gpt-4'] },
  { prefix: 'gpt-3.5', meta: DB['gpt-3.5-turbo'] },
  { prefix: 'o1-preview', meta: DB['o1-preview'] },
  { prefix: 'o1-mini', meta: DB['o1-mini'] },
  { prefix: 'o3-mini', meta: DB['o3-mini'] },
  { prefix: 'claude-3-5-sonnet', meta: DB['claude-3-5-sonnet'] },
  { prefix: 'claude-3-5-haiku', meta: DB['claude-3-5-haiku'] },
  { prefix: 'claude-3-opus', meta: DB['claude-3-opus'] },
  { prefix: 'claude-3-sonnet', meta: DB['claude-3-sonnet'] },
  { prefix: 'claude-3-haiku', meta: DB['claude-3-haiku'] },
  { prefix: 'gemini-2.5-pro', meta: DB['gemini-2.5-pro'] },
  { prefix: 'gemini-2.5-flash', meta: DB['gemini-2.5-flash'] },
  { prefix: 'gemini-2.0-flash', meta: DB['gemini-2.0-flash'] },
  { prefix: 'gemini-1.5-pro', meta: DB['gemini-1.5-pro'] },
  { prefix: 'gemini-1.5-flash', meta: DB['gemini-1.5-flash'] },
  { prefix: 'deepseek-chat', meta: DB['deepseek-chat'] },
  { prefix: 'deepseek-reasoner', meta: DB['deepseek-reasoner'] },
  { prefix: 'qwen-vl', meta: DB['qwen-vl-max'] },
  { prefix: 'qwen-turbo', meta: DB['qwen-turbo'] },
  { prefix: 'qwen-plus', meta: DB['qwen-plus'] },
  { prefix: 'qwen-max', meta: DB['qwen-max'] },
  { prefix: 'glm-4-plus', meta: DB['glm-4-plus'] },
  { prefix: 'glm-4-flash', meta: DB['glm-4-flash'] },
  { prefix: 'glm-4v', meta: DB['glm-4v'] },
  { prefix: 'glm-4', meta: DB['glm-4'] },
  { prefix: 'doubao-vision', meta: DB['doubao-vision-pro-32k'] },
  { prefix: 'doubao-pro-128k', meta: DB['doubao-pro-128k'] },
  { prefix: 'doubao-pro-32k', meta: DB['doubao-pro-32k'] },
  { prefix: 'moonshot-v1-128k', meta: DB['moonshot-v1-128k'] },
  { prefix: 'moonshot-v1-32k', meta: DB['moonshot-v1-32k'] },
  { prefix: 'moonshot-v1-8k', meta: DB['moonshot-v1-8k'] },
  { prefix: 'mimo-v2.5-pro', meta: DB['mimo-v2.5-pro'] },
  { prefix: 'mimo-v2.5', meta: DB['mimo-v2.5'] },
  { prefix: 'mistral-large', meta: DB['mistral-large-latest'] },
  { prefix: 'mistral-small', meta: DB['mistral-small-latest'] },
  { prefix: 'pixtral', meta: DB['pixtral-large-latest'] },
];

/**
 * 从本地知识库查找模型元数据
 * 匹配策略: 精确匹配 → 前缀匹配 → null
 */
export function getLocalModelMetadata(modelId: string): ModelMetadata | null {
  const lower = modelId.toLowerCase();

  // 1. 精确匹配
  if (DB[lower]) return { ...DB[lower] };

  // 2. 前缀匹配
  for (const rule of PREFIX_RULES) {
    if (lower.startsWith(rule.prefix)) return { ...rule.meta };
  }

  // 3. 模糊包含匹配 (如 "deepseek-ai/DeepSeek-V3" 包含 "deepseek")
  if (lower.includes('deepseek')) return { ...DB['deepseek-chat'] };
  if (lower.includes('qwen2.5') || lower.includes('qwen-2.5') || lower.includes('qwen2_5')) {
    return { contextWindow: 32768, maxOutput: 8192, inputModalities: ['text'], outputModalities: ['text'], supportsTools: true, supportsStreaming: true, owner: 'alibaba', description: 'Qwen 2.5 系列 (开源)' };
  }
  if (lower.includes('llama-3.3') || lower.includes('llama3.3')) return { ...DB['llama-3.3-70b-versatile'] };
  if (lower.includes('llama-3.1') || lower.includes('llama3.1')) return { ...DB['llama-3.1-8b-instant'] };
  if (lower.includes('mistral')) return { ...DB['mistral-large-latest'] };
  if (lower.includes('gemma')) return { contextWindow: 8192, maxOutput: 2048, inputModalities: ['text'], outputModalities: ['text'], supportsTools: false, supportsStreaming: true, owner: 'google', description: 'Gemma 开源模型' };

  return null;
}
