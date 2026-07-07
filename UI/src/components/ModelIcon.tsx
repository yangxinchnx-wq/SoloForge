import React from 'react';
import {
  // 内置服务商图标 — 直接导入组件, 不走 LobeModelIcon 的模糊匹配
  OpenAI,
  DeepSeek,
  Anthropic,
  Claude,
  SiliconCloud,
  Moonshot,
  Kimi,
  XiaomiMiMo,
  Gemini,
  Qwen,
  Zhipu,
  Wenxin,
  Doubao,
  Hunyuan,
  Spark,
  Minimax,
  Baichuan,
  Yi,
  ZeroOne,
  Stepfun,
  Mistral,
  Groq,
  OpenRouter,
  Together,
  Fireworks,
  Perplexity,
  Cohere,
  // 通用 ModelIcon (用于扫描到的模型列表, 按 model name 匹配)
  ModelIcon as LobeModelIcon,
} from '@lobehub/icons';
import { AnimalAvatar } from './AnimalAvatar';

interface ModelIconProps {
  modelName: string;
  className?: string;
  size?: number;
  /**
   * 图标类型配置 (仅对 custom_ 开头的自定义服务商生效):
   *   - undefined / 'auto': 自动匹配 @lobehub/icons
   *   - 'animal:<id>': 用内置动物头像 (20 种小动物)
   *   - 'custom:<dataUrl>': 用用户上传的自定义图标 (data:image/png;base64,...)
   * 内置服务商 (openai/deepseek/anthropic 等) 始终用固定 lobehub 图标, 不受此参数影响
   */
  iconType?: string;
}

/**
 * 内置服务商 ID → lobehub 图标组件 的直接映射
 * 优先使用 .Color 子组件 (彩色), 无 Color 的退回 Mono (单色)
 * 不走 LobeModelIcon 模糊匹配, 避免未知模型名触发 @lobehub/ui 无限循环
 */
const BUILTIN_PROVIDER_ICONS: Record<string, React.FC<{ size?: number; className?: string }>> = {
  // ── 原有服务商 ──
  openai: OpenAI,               // 无 Color, 用 Mono
  deepseek: DeepSeek.Color ?? DeepSeek,
  anthropic: Anthropic,         // 无 Color, 用 Mono
  claude: Claude.Color ?? Claude,
  gemini: Gemini.Color ?? Gemini,
  siliconflow: SiliconCloud.Color ?? SiliconCloud,
  siliconcloud: SiliconCloud.Color ?? SiliconCloud,
  moonshot: Moonshot,           // 无 Color, 用 Mono
  kimi: Kimi.Color ?? Kimi,
  xiaomi: XiaomiMiMo,           // 无 Color, 用 Mono
  // ── 国内大模型厂商 ──
  qwen: Qwen.Color ?? Qwen,
  zhipu: Zhipu.Color ?? Zhipu,
  wenxin: Wenxin.Color ?? Wenxin,
  baidu: Wenxin.Color ?? Wenxin,
  doubao: Doubao.Color ?? Doubao,
  hunyuan: Hunyuan.Color ?? Hunyuan,
  spark: Spark.Color ?? Spark,
  minimax: Minimax.Color ?? Minimax,
  baichuan: Baichuan.Color ?? Baichuan,
  yi: Yi.Color ?? Yi,
  zeroone: ZeroOne.Color ?? ZeroOne,
  stepfun: Stepfun.Color ?? Stepfun,
  // ── 国外大模型厂商 ──
  mistral: Mistral.Color ?? Mistral,
  groq: Groq,                   // 无 Color, 用 Mono
  openrouter: OpenRouter,       // 无 Color, 用 Mono
  together: Together.Color ?? Together,
  fireworks: Fireworks.Color ?? Fireworks,
  perplexity: Perplexity.Color ?? Perplexity,
  cohere: Cohere.Color ?? Cohere,
};

/**
 * 已知能在 LobeModelIcon 中安全渲染的模型 ID 前缀白名单。
 * 用于扫描到的模型列表 (如 gpt-4o, claude-3-5-sonnet 等)
 */
const KNOWN_MODEL_PREFIXES = [
  'gpt', 'o1', 'o3', 'o4',
  'claude', 'anthropic',
  'gemini', 'bison',
  'llama', 'mistral', 'mixtral', 'qwen', 'deepseek',
  'glm', 'moonshot', 'kimi', 'yi', 'baichuan',
  'spark', 'ernie', 'wenxin', 'doubao',
  'minimax', 'abab', 'hunyuan', 'zhipu',
  'command', 'cohere', 'phi', 'dbrx',
];

function isKnownModel(modelId: string): boolean {
  if (!modelId) return false;
  if (/^[\s\u4e00-\u9fff\uf900-\ufaff]+$/.test(modelId)) return false;
  return KNOWN_MODEL_PREFIXES.some(p => modelId.includes(p));
}

export const ModelIcon: React.FC<ModelIconProps> = ({ modelName, className = "w-4 h-4", size = 16, iconType }) => {
  const modelId = (modelName || '').trim().toLowerCase();

  // 0) 空模型名 → 静默占位 (不显示 "AI" 兜底)
  if (!modelId) {
    return (
      <div
        className={className}
        style={{
          width: size,
          height: size,
          borderRadius: '50%',
          border: '1px solid currentColor',
          opacity: 0.2,
          flexShrink: 0,
        }}
      />
    );
  }

  // 1) 内置服务商 → 直接用固定 lobehub 图标组件 (不走 iconType, 不走模糊匹配)
  const BuiltinIcon = BUILTIN_PROVIDER_ICONS[modelId];
  if (BuiltinIcon) {
    return <BuiltinIcon size={size} className={className} />;
  }

  // 2) 自定义服务商 (custom_ 开头) 或 custom 占位符 → 检查 iconType
  if (modelId.startsWith('custom')) {
    // animal: 开头 → 用内置动物头像
    if (iconType?.startsWith('animal:')) {
      const animalId = iconType.slice(7);
      return <AnimalAvatar id={animalId} size={size} className={className} />;
    }
    // custom: 开头 → 用户上传的图标 (data URL)
    if (iconType?.startsWith('custom:')) {
      const dataUrl = iconType.slice(7);
      return (
        <img
          src={dataUrl}
          alt="icon"
          className={className}
          style={{ width: size, height: size, borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }}
        />
      );
    }
    // 未设置 iconType → 用默认头像
    return <AnimalAvatar id="cat" size={size} className={className} />;
  }

  // 3) 特殊桥接: xiaomi / milm
  if (modelId.startsWith('milm') || modelId.startsWith('mimo') || modelId.includes('xiaomi')) {
    return <XiaomiMiMo size={size} className={className} />;
  }

  // 4) 特殊桥接: siliconflow
  if (
    modelId === 'siliconflow' ||
    modelId === 'siliconcloud' ||
    modelId.startsWith('siliconflow/') ||
    modelId.startsWith('siliconcloud/') ||
    modelId.includes('/siliconflow') ||
    modelId.includes('/siliconcloud')
  ) {
    return <SiliconCloud size={size} className={className} />;
  }

  // 5) 已知模型名 (扫描到的模型列表) → LobeModelIcon
  if (isKnownModel(modelId)) {
    return <LobeModelIcon model={modelId} size={size} className={className} type="color" />;
  }

  // 6) 兜底: 纯 CSS 回退图标
  return (
    <div
      className={className}
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        background: 'linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: '#fff',
        fontSize: size * 0.5,
        fontWeight: 700,
        lineHeight: 1,
        flexShrink: 0,
      }}
    >
      AI
    </div>
  );
};

