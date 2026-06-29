/**
 * buildModelProviderMap 单元测试 (2026-06-28 重构版)
 *
 * 新签名: buildModelProviderMap(vaultKeys, overrides?)
 *   - vaultKeys 来自 vaultApi.listKeys() 后端金库列表
 *   - overrides 是用户在 SettingsModal 里的 ModelProviderLike[] 本地条目
 *
 * 覆盖:
 * - 基本扁平化: vault 多 provider × 多 model → modelId -> ProviderEntry
 * - 跳过 overrides.enabled=false
 * - 跳过 baseUrl 为空
 * - 处理 null / undefined / 非数组 输入
 * - customModels 支持 string 和 {id, enabled}
 * - apiFormat: 'anthropic' 仅在显式声明时传递
 * - 多个 provider 拥有同名 model 时, 后者覆盖前者
 * - vault + overrides 合并: vault 提供 baseUrl/key, overrides 提供 model/format
 */

import { describe, it, expect } from 'vitest';
import {
  buildModelProviderMap,
  resolveMainEntry,
  materializeProviders,
  isVaultEntry,
  VAULT_SENTINEL,
} from '../modelProviderMap';

const vaultKey = (id: string, baseUrl: string, source: 'keychain' | 'memory' | 'env' = 'keychain') =>
  ({ id, baseUrl, source, hasKey: true as const });

describe('buildModelProviderMap — 基本扁平化 (vault-first)', () => {
  it('单个 vault key + override.models → 1 个 entry', () => {
    const map = buildModelProviderMap(
      [vaultKey('openai', 'https://api.openai.com/v1')],
      [{
        id: 'openai', name: 'OpenAI', enabled: true,
        models: [{ id: 'gpt-4o', name: 'GPT-4o', enabled: true }],
      }],
    );
    expect(Object.keys(map)).toEqual(['gpt-4o']);
    expect(map['gpt-4o']).toMatchObject({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: VAULT_SENTINEL + 'openai',
      model: 'gpt-4o',
      providerName: 'OpenAI',
      enabledInSettings: true,
      apiFormat: 'openai',
      source: 'keychain',
    });
  });

  it('多个 vault key × 多个 model → 全部展平', () => {
    const map = buildModelProviderMap(
      [
        vaultKey('openai', 'https://api.openai.com/v1'),
        vaultKey('anthropic', 'https://api.anthropic.com/v1'),
      ],
      [
        { id: 'openai', name: 'OpenAI', enabled: true,
          models: [{ id: 'gpt-4o', enabled: true }, { id: 'gpt-4o-mini', enabled: true }] },
        { id: 'anthropic', name: 'Anthropic', enabled: true,
          models: [{ id: 'claude-3-5-sonnet', enabled: true }, { id: 'claude-3-5-haiku', enabled: true }] },
      ],
    );
    expect(Object.keys(map).sort()).toEqual(['claude-3-5-haiku', 'claude-3-5-sonnet', 'gpt-4o', 'gpt-4o-mini']);
    expect(map['gpt-4o'].providerName).toBe('OpenAI');
    expect(map['claude-3-5-sonnet'].providerName).toBe('Anthropic');
  });

  it('vault 没有, override 有 → 跳过 (vault 才是可信源)', () => {
    const map = buildModelProviderMap(
      [],
      [{ id: 'openai', enabled: true, apiKey: 'sk-abc', baseUrl: 'https://api.openai.com/v1',
        models: [{ id: 'gpt-4o', enabled: true }] }],
    );
    expect(map).toEqual({});
  });

  it('vault 有但 baseUrl 空 → 跳过', () => {
    const map = buildModelProviderMap(
      [vaultKey('openai', '')],
      [{ id: 'openai', enabled: true, models: [{ id: 'gpt-4o', enabled: true }] }],
    );
    expect(map).toEqual({});
  });
});

describe('buildModelProviderMap — overrides 过滤', () => {
  it('override.enabled=false → 跳过', () => {
    const map = buildModelProviderMap(
      [vaultKey('openai', 'https://api.openai.com/v1')],
      [{ id: 'openai', enabled: false, models: [{ id: 'gpt-4o', enabled: true }] }],
    );
    expect(map).toEqual({});
  });

  it('model.enabled=false → 跳过该 model, 其他 model 保留', () => {
    const map = buildModelProviderMap(
      [vaultKey('openai', 'https://api.openai.com/v1')],
      [{ id: 'openai', enabled: true, models: [{ id: 'gpt-4o', enabled: true }, { id: 'gpt-3.5-turbo', enabled: false }] }],
    );
    expect(Object.keys(map)).toEqual(['gpt-4o']);
  });

  it('vault 有但没 override → 用静态目录兜底 (default model 列表)', () => {
    const map = buildModelProviderMap([vaultKey('openai', 'https://api.openai.com/v1')], []);
    // openai 静态目录里有 gpt-4o 等
    expect(Object.keys(map).length).toBeGreaterThan(0);
    expect(map['gpt-4o']?.baseUrl).toBe('https://api.openai.com/v1');
    expect(map['gpt-4o']?.apiKey).toBe(VAULT_SENTINEL + 'openai');
  });

  it('vault 是 env 来源 → entry.source 标记为 env', () => {
    const map = buildModelProviderMap(
      [vaultKey('openai', 'https://api.openai.com/v1', 'env')],
      [{ id: 'openai', enabled: true, models: [{ id: 'gpt-4o', enabled: true }] }],
    );
    expect(map['gpt-4o'].source).toBe('env');
  });
});

describe('buildModelProviderMap — customModels', () => {
  it('customModels 是 string[]', () => {
    const map = buildModelProviderMap(
      [vaultKey('custom', 'http://x')],
      [{ id: 'custom', enabled: true, customModels: ['my-a', 'my-b'] }],
    );
    expect(Object.keys(map).sort()).toEqual(['my-a', 'my-b']);
  });

  it('customModels 是 {id, enabled}[]', () => {
    const map = buildModelProviderMap(
      [vaultKey('custom', 'http://x')],
      [{ id: 'custom', enabled: true, customModels: [{ id: 'my-a', enabled: true }, { id: 'my-b', enabled: false }] }],
    );
    expect(Object.keys(map)).toEqual(['my-a']);
  });

  it('models 和 customModels 同时存在时合并', () => {
    const map = buildModelProviderMap(
      [vaultKey('custom', 'http://x')],
      [{ id: 'custom', enabled: true, models: [{ id: 'm1', enabled: true }], customModels: ['m2', 'm3'] }],
    );
    expect(Object.keys(map).sort()).toEqual(['m1', 'm2', 'm3']);
  });
});

describe('buildModelProviderMap — apiFormat', () => {
  it('apiFormat: "anthropic" 显式传递', () => {
    const map = buildModelProviderMap(
      [vaultKey('anthropic', 'http://x')],
      [{ id: 'anthropic', enabled: true, apiFormat: 'anthropic', models: [{ id: 'claude-3-5-sonnet', enabled: true }] }],
    );
    expect(map['claude-3-5-sonnet'].apiFormat).toBe('anthropic');
  });

  it('未声明 apiFormat 时默认 openai', () => {
    const map = buildModelProviderMap(
      [vaultKey('openai', 'http://x')],
      [{ id: 'openai', enabled: true, models: [{ id: 'gpt-4o', enabled: true }] }],
    );
    expect(map['gpt-4o'].apiFormat).toBe('openai');
  });
});

describe('buildModelProviderMap — 健壮性', () => {
  it('vaultKeys=null → {}', () => {
    expect(buildModelProviderMap(null as any)).toEqual({});
  });
  it('vaultKeys=undefined → {}', () => {
    expect(buildModelProviderMap(undefined)).toEqual({});
  });
  it('vaultKeys 非数组 → {}', () => {
    expect(buildModelProviderMap({} as any)).toEqual({});
  });
  it('空数组 → {}', () => {
    expect(buildModelProviderMap([])).toEqual({});
  });
  it('model 没有 id → 跳过', () => {
    const map = buildModelProviderMap(
      [vaultKey('x', 'http://x')],
      [{ id: 'x', enabled: true, models: [{ enabled: true } as any] }],
    );
    expect(map).toEqual({});
  });
});

describe('buildModelProviderMap — 重名 model', () => {
  it('多个 provider 有同名 model → 后者覆盖前者', () => {
    const map = buildModelProviderMap(
      [vaultKey('p1', 'http://a'), vaultKey('p2', 'http://b')],
      [
        { id: 'p1', name: 'P1', enabled: true, models: [{ id: 'shared-model', enabled: true }] },
        { id: 'p2', name: 'P2', enabled: true, models: [{ id: 'shared-model', enabled: true }] },
      ],
    );
    expect(map['shared-model'].providerName).toBe('P2');
    expect(map['shared-model'].baseUrl).toBe('http://b');
    expect(map['shared-model'].apiKey).toBe(VAULT_SENTINEL + 'p2');
  });
});

describe('materializeProviders — vault + overrides 合成', () => {
  it('vault + overrides → 列表含 override 的 name/model', () => {
    const out = materializeProviders(
      [vaultKey('openai', 'https://api.openai.com/v1')],
      [{ id: 'openai', name: 'OpenAI Custom', enabled: true,
        models: [{ id: 'gpt-4o', enabled: true }, { id: 'custom-1', enabled: true }] }],
    );
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe('OpenAI Custom');
    expect(out[0].apiKey).toBe(VAULT_SENTINEL);
    expect(out[0].source).toBe('keychain');
  });

  it('vault 有但 override 没有 → 用静态目录兜底, 标 __bootstrapped', () => {
    const out = materializeProviders([vaultKey('openai', 'https://api.openai.com/v1')], []);
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe('OpenAI'); // 来自 catalog
    expect(out[0].__bootstrapped).toBe(true);
  });
});

describe('isVaultEntry — 哨兵识别', () => {
  it('apiKey 以 __VAULT__: 开头 → true', () => {
    expect(isVaultEntry({
      baseUrl: 'x', apiKey: VAULT_SENTINEL + 'openai', model: 'gpt-4o',
      providerName: 'OpenAI', enabledInSettings: true, source: 'keychain',
    })).toBe(true);
  });
  it('apiKey 是普通字符串 → false', () => {
    expect(isVaultEntry({
      baseUrl: 'x', apiKey: 'sk-abc', model: 'gpt-4o',
      providerName: 'OpenAI', enabledInSettings: true, source: 'keychain',
    })).toBe(false);
  });
  it('null / undefined → false', () => {
    expect(isVaultEntry(null)).toBe(false);
    expect(isVaultEntry(undefined)).toBe(false);
  });
});

describe('resolveMainEntry — 主模型解析', () => {
  const entry = (model: string, apiKey = VAULT_SENTINEL + 'openai'): any => ({
    baseUrl: 'http://x',
    apiKey,
    model,
    providerName: 'P',
    enabledInSettings: true,
    apiFormat: 'openai' as const,
    source: 'keychain' as const,
  });

  it('主模型在 map 中且有 apiKey → 直接返回', () => {
    const m = { 'gpt-4o': entry('gpt-4o') };
    const r = resolveMainEntry('gpt-4o', m);
    expect(r.resolvedMainModel).toBe('gpt-4o');
    expect(r.entry?.apiKey).toBe(VAULT_SENTINEL + 'openai');
  });

  it('主模型不在 map 中 → 走 fallback', () => {
    const m = { 'a': entry('a'), 'b': entry('b'), 'c': entry('c') };
    const r = resolveMainEntry('gpt-4o', m);
    expect(r.resolvedMainModel).toBe('a');
    expect(r.entry?.model).toBe('a');
  });

  it('主模型在 map 中但 apiKey 为空 → 走 fallback', () => {
    const m = { 'gpt-4o': entry('gpt-4o', ''), 'fallback': entry('fallback', VAULT_SENTINEL + 'anthropic') };
    const r = resolveMainEntry('gpt-4o', m);
    expect(r.resolvedMainModel).toBe('fallback');
    expect(r.entry?.apiKey).toBe(VAULT_SENTINEL + 'anthropic');
  });

  it('map 为空 / null / undefined → 返回 null', () => {
    expect(resolveMainEntry('gpt-4o', {}).entry).toBeNull();
    expect(resolveMainEntry('gpt-4o', null).entry).toBeNull();
    expect(resolveMainEntry('gpt-4o', undefined).entry).toBeNull();
  });

  it('map 所有 entry 都无 apiKey → 返回 null', () => {
    const m = { 'a': entry('a', ''), 'b': entry('b', '') };
    const r = resolveMainEntry('gpt-4o', m);
    expect(r.entry).toBeNull();
  });
});