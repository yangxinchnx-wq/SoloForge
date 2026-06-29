/**
 * modelProviderMap 构造工具 (2026-06-28 重构)
 *
 * 旧设计 (enc:v1: 本地加密 + __VAULT__ 哨兵):
 *   - localStorage 存 "已经设置过 key" 的痕迹, 但明文在别处
 *   - 双源, 易丢, 难排查 (enc:v1: 加密失败时静默吞明文 → 用户以为自己填过实际被清)
 *
 * 新设计 (OS 钥匙串是唯一可信源):
 *   - localStorage / settings.json 不再存任何 API Key 痕迹
 *   - 启动时调 vaultApi.listKeys() 拿到所有"已知 provider + 来源"
 *   - 用户在 Settings 里填的 key 走 vaultApi.putKey → 后端写 OS 钥匙串
 *   - ChatPanel 看到 vaultProviderId 就走 vaultApi.streamChat(后端拿 key)
 *
 * 因此本文件职责简化为:
 *   1. 把"已知 provider 列表"(来自 vault) 扁平化为 modelId -> ProviderEntry
 *   2. 用 DEFAULT_PROVIDER_CATALOG 兜底补全每个 provider 的 model 列表
 *   3. 给 ChatPanel 提供 vaultProviderId 字段, 决定走哪条调用路径
 */

// ============================================================
// Types
// ============================================================

export interface ModelProviderLike {
  id?: string;
  name?: string;
  enabled?: boolean;
  apiKey?: string;          // 仅供 "baseUrl 配置但还没存 key" 的本地条目
  baseUrl?: string;
  defaultUrl?: string;
  apiFormat?: 'openai' | 'anthropic' | string;
  models?: Array<{ id: string; name?: string; enabled?: boolean }>;
  customModels?: Array<string | { id: string; enabled?: boolean }>;
  /** 来源标记 (来自 vault) */
  source?: 'keychain' | 'memory' | 'env';
  /** bootstrap 时打的标记: 列表是 vault 自动合成的, 用户没手动配置 */
  __bootstrapped?: boolean;
}

export interface ProviderEntry {
  baseUrl: string;
  apiKey: string;
  model: string;
  providerName: string;
  enabledInSettings: boolean;
  apiFormat?: 'openai' | 'anthropic';
  /** 来源标记 */
  source: 'keychain' | 'memory' | 'env';
}

export type ModelProviderMap = Record<string, ProviderEntry>;

/**
 * apiKey 哨兵: 表明 key 在后端 vault, 紧跟的是 providerId
 * ChatPanel 通过 isVaultEntry() 判断后改走 vaultApi.streamChat
 */
export const VAULT_SENTINEL = '__VAULT__:';

export function isVaultEntry(entry: ProviderEntry | null | undefined): boolean {
  return !!entry && entry.apiKey.startsWith(VAULT_SENTINEL);
}

// ============================================================
// 主入口
// ============================================================

/**
 * 解析当前主模型
 *   - 主模型在 map 中且有 apiKey → 用它
 *   - 主模型不在 map / 无 apiKey → 从 map 中挑第一个有 apiKey 的当 fallback
 *   - map 本身为空 / 全部无 apiKey → 返回 null
 */
export function resolveMainEntry(
  mainModel: string,
  modelProviderMap: ModelProviderMap | null | undefined,
): { resolvedMainModel: string; entry: ProviderEntry | null } {
  const safeMap: ModelProviderMap = modelProviderMap || {};
  const direct = safeMap[mainModel];
  if (direct && direct.apiKey) {
    return { resolvedMainModel: mainModel, entry: direct };
  }
  const fallbackId = Object.keys(safeMap).find((k) => safeMap[k]?.apiKey);
  if (fallbackId) {
    return { resolvedMainModel: fallbackId, entry: safeMap[fallbackId] };
  }
  return { resolvedMainModel: mainModel, entry: null };
}

/**
 * 把 vault 列出的 provider 列表扁平化为 modelId -> ProviderEntry
 *
 * @param vaultKeys 后端 /api/vault/keys 返回的列表 (keychain + env 合并)
 *                  每个元素必有 { id, baseUrl, hasKey: true, source }
 * @param overrides 用户在 SettingsModal 里手动配置的本地条目
 *                  (model 列表、enabled、apiFormat 等会覆盖 vault 默认)
 */
export function buildModelProviderMap(
  vaultKeys: Array<{ id: string; baseUrl: string; source: 'keychain' | 'memory' | 'env' }>,
  overrides?: ModelProviderLike[] | null,
): ModelProviderMap {
  const map: ModelProviderMap = {};
  if (!Array.isArray(vaultKeys)) return map;

  const overrideById = new Map<string, ModelProviderLike>();
  if (Array.isArray(overrides)) {
    for (const o of overrides) {
      if (o && o.id) overrideById.set(o.id, o);
    }
  }

  for (const k of vaultKeys) {
    if (!k || !k.id) continue;
    const override = overrideById.get(k.id);
    const providerName = override?.name || k.id;
    const baseUrl = (k.baseUrl || override?.baseUrl || override?.defaultUrl || '').trim();
    const apiFormat: 'openai' | 'anthropic' | undefined =
      override?.apiFormat === 'anthropic' ? 'anthropic' : 'openai';
    const effectiveEnabled = override ? override.enabled !== false : true;
    if (!effectiveEnabled) continue;
    if (!baseUrl) continue;

    const source: 'keychain' | 'memory' | 'env' = k.source || 'keychain';
    // ChatPanel 用这个哨兵判定改走 vaultApi.streamChat
    const effectiveApiKey = VAULT_SENTINEL + k.id;

    const push = (modelId: string) => {
      if (!modelId) return;
      map[modelId] = {
        baseUrl,
        apiKey: effectiveApiKey,
        model: modelId,
        providerName,
        enabledInSettings: true,
        apiFormat,
        source,
        vaultProviderId: k.id,
      };
    };

    // 1) 优先用 override 里用户显式配置的 models
    const overrideModels = override?.models;
    if (Array.isArray(overrideModels) && overrideModels.length > 0) {
      for (const m of overrideModels) {
        if (m && m.id && m.enabled !== false) push(m.id);
      }
    }
    // 2) 再补 override.customModels
    const overrideCustom = override?.customModels;
    if (Array.isArray(overrideCustom)) {
      for (const cm of overrideCustom) {
        if (typeof cm === 'string' && cm) push(cm);
        else if (cm && cm.id && cm.enabled !== false) push(cm.id);
      }
    }
    // 3) 用户没配过 model 列表时, 用静态目录兜底
    if (Object.keys(map).length === 0 || !hasEntryForProvider(map, k.id, providerName, override)) {
      const catalog = DEFAULT_PROVIDER_CATALOG[k.id];
      if (catalog && Array.isArray(catalog.models)) {
        for (const m of catalog.models) {
          if (m && m.id) push(m.id);
        }
      }
    }
  }

  return map;
}

function hasEntryForProvider(
  map: ModelProviderMap,
  providerId: string,
  providerName: string,
  override?: ModelProviderLike,
): boolean {
  // 检查 map 中是否已有属于该 provider 的 entry (通过 providerName 匹配)
  if (!override) return false;
  return Object.values(map).some((e) => e.providerName === providerName);
}

/**
 * 把 vault 列表 + 用户本地覆盖合成 ModelProviderLike[]
 * (给 SettingsModal 显示用)
 */
export function materializeProviders(
  vaultKeys: Array<{ id: string; baseUrl: string; source: 'keychain' | 'memory' | 'env' }>,
  userOverrides?: ModelProviderLike[] | null,
): ModelProviderLike[] {
  const out: ModelProviderLike[] = [];
  const overrideById = new Map<string, ModelProviderLike>();
  if (Array.isArray(userOverrides)) {
    for (const o of userOverrides) {
      if (o && o.id) overrideById.set(o.id, o);
    }
  }
  for (const k of vaultKeys) {
    if (!k || !k.id) continue;
    const override = overrideById.get(k.id);
    const catalog = DEFAULT_PROVIDER_CATALOG[k.id];
    out.push({
      id: k.id,
      name: override?.name || catalog?.name || k.id,
      enabled: override ? override.enabled !== false : true,
      apiKey: VAULT_SENTINEL, // UI 不再需要展示明文, 用哨兵占位
      baseUrl: k.baseUrl,
      defaultUrl: catalog?.defaultUrl || k.baseUrl,
      apiFormat: override?.apiFormat || 'openai',
      models: override?.models || catalog?.models?.map((m) => ({ id: m.id, name: m.name, enabled: true })) || [],
      customModels: override?.customModels || [],
      source: k.source,
      // [2026-06-28 修复] 保留 status 字段, 否则 Header.tsx:487 的过滤
      //   `if (prov.enabled && prov.status === 'success')` 永远 false
      //   → 主模型下拉显示 "尚未配置可用模型"
      //   - vault 里有 key 证明 test 至少通过过一次, 默认 'success' 是合理推断
      //   - override 有显式 status (loading/failed/idle) 时, 保留 override 的瞬时态
      status: override?.status || 'success',
      // @ts-expect-error 自定义标记
      __bootstrapped: !override,
    });
  }
  return out;
}

// ============================================================
// 静态目录 (内置 provider 的默认 model 列表)
// ============================================================

export const DEFAULT_PROVIDER_CATALOG: Record<string, {
  name: string;
  baseUrl: string;
  defaultUrl: string;
  models: Array<{ id: string; name?: string }>;
}> = {
  xiaomi: {
    name: 'XIAOMIMIMO',
    baseUrl: 'https://api.xiaomimimo.com/v1',
    defaultUrl: 'https://api.xiaomimimo.com/v1',
    models: [
      { id: 'mimo-v2-flash', name: 'mimo-v2-flash' },
      { id: 'milm-pro', name: 'milm-pro' },
      { id: 'milm-6b', name: 'milm-6b' },
      { id: 'milm-1.3b', name: 'milm-1.3b' },
    ],
  },
  openai: {
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    defaultUrl: 'https://api.openai.com/v1',
    models: [
      { id: 'gpt-4o', name: 'gpt-4o' },
      { id: 'gpt-4o-mini', name: 'gpt-4o-mini' },
      { id: 'gpt-4-turbo', name: 'gpt-4-turbo' },
      { id: 'o1-preview', name: 'o1-preview' },
      { id: 'o1-mini', name: 'o1-mini' },
    ],
  },
  deepseek: {
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    defaultUrl: 'https://api.deepseek.com/v1',
    models: [
      { id: 'deepseek-chat', name: 'deepseek-chat' },
      { id: 'deepseek-reasoner', name: 'deepseek-reasoner' },
    ],
  },
  anthropic: {
    name: 'Anthropic',
    baseUrl: 'https://api.anthropic.com',
    defaultUrl: 'https://api.anthropic.com',
    models: [
      { id: 'claude-3-5-sonnet', name: 'claude-3-5-sonnet' },
      { id: 'claude-3-5-haiku', name: 'claude-3-5-haiku' },
      { id: 'claude-3-opus', name: 'claude-3-opus' },
    ],
  },
  gemini: {
    name: 'Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    defaultUrl: 'https://generativelanguage.googleapis.com/v1beta',
    models: [
      { id: 'gemini-1.5-pro', name: 'gemini-1.5-pro' },
      { id: 'gemini-1.5-flash', name: 'gemini-1.5-flash' },
      { id: 'gemini-2.0-flash-exp', name: 'gemini-2.0-flash-exp' },
    ],
  },
  siliconflow: {
    name: 'SiliconFlow',
    baseUrl: 'https://api.siliconflow.cn/v1',
    defaultUrl: 'https://api.siliconflow.cn/v1',
    models: [
      { id: 'Qwen/Qwen2.5-72B-Instruct', name: 'Qwen/Qwen2.5-72B-Instruct' },
      { id: 'deepseek-ai/DeepSeek-V3', name: 'deepseek-ai/DeepSeek-V3' },
      { id: 'deepseek-ai/DeepSeek-R1', name: 'deepseek-ai/DeepSeek-R1' },
    ],
  },
  moonshot: {
    name: 'Moonshot',
    baseUrl: 'https://api.moonshot.cn/v1',
    defaultUrl: 'https://api.moonshot.cn/v1',
    models: [
      { id: 'moonshot-v1-8k', name: 'moonshot-v1-8k' },
      { id: 'moonshot-v1-32k', name: 'moonshot-v1-32k' },
    ],
  },
};