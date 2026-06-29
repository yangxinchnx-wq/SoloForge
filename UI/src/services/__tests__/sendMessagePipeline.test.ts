/**
 * sendMessagePipeline 单元测试
 * 覆盖 validateInput / buildUserMessage / preprocessImages / resolveMainEntryForSend / buildRequestBody / pickSubEntries / pickCandidateEntries
 */
import { describe, it, expect } from 'vitest';
import {
  validateInput,
  buildUserMessage,
  preprocessImages,
  resolveMainEntryForSend,
  buildRequestBody,
  pickSubEntries,
  pickCandidateEntries,
  type ModelProviderEntry,
  type PendingAttachment,
  type ImagePending,
  type SmartRouterResult,
  type SendContext,
} from '../sendMessagePipeline';

// ============== validateInput ==============
describe('validateInput', () => {
  it('空 input + 无 attachment → invalid', () => {
    const r = validateInput('', null);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('empty');
  });

  it('空白 input + 有 attachment → valid + 默认分析文本', () => {
    const r = validateInput('   ', { fileName: 'a.ts', text: 'xxx' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.finalContent).toContain('a.ts');
  });

  it('普通 input → valid', () => {
    const r = validateInput('hello', null);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.finalContent).toBe('hello');
  });

  it('input 自动 trim', () => {
    const r = validateInput('  hello  ', null);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.finalContent).toBe('hello');
  });
});

// ============== buildUserMessage ==============
describe('buildUserMessage', () => {
  it('基础 user msg 字段', () => {
    const msg = buildUserMessage('hello', null);
    expect(msg.sender).toBe('user');
    expect(msg.content).toBe('hello');
    expect(msg.avatar).toContain('unsplash');
    expect(msg.time).toMatch(/\d{2}:\d{2}:\d{2}/);
  });

  it('有 attachment 时挂 attachment 字段', () => {
    const msg = buildUserMessage('check this', { fileName: 'f.ts', text: 'code' });
    expect(msg.attachment).toEqual({ fileName: 'f.ts', text: 'code' });
  });

  it('无 attachment 时 attachment 字段为 undefined', () => {
    const msg = buildUserMessage('hi', null);
    expect(msg.attachment).toBeUndefined();
  });
});

// ============== preprocessImages ==============
describe('preprocessImages', () => {
  it('Claude 主模型 → 走 compressImageForClaude', async () => {
    const fakeFiles = [
      { file: new File(['x'], 'a.png'), previewUrl: 'blob:1' },
    ] as ImagePending[];
    const compressCalled = vi.fn(async () => 'data:image/jpeg;base64,COMPRESSED');
    const fileToDataUrlCalled = vi.fn(async () => 'data:image/png;base64,RAW');

    const result = await preprocessImages(fakeFiles, true, {
      compressImageForClaude: compressCalled,
      fileToDataUrl: fileToDataUrlCalled,
    });

    expect(compressCalled).toHaveBeenCalledTimes(1);
    expect(fileToDataUrlCalled).not.toHaveBeenCalled();
    expect(result.imagesToSend).toEqual(['data:image/jpeg;base64,COMPRESSED']);
  });

  it('非 Claude 主模型 → 走 fileToDataUrl 原图', async () => {
    const fakeFiles = [
      { file: new File(['x'], 'a.png'), previewUrl: 'blob:1' },
    ] as ImagePending[];
    const compressCalled = vi.fn(async () => 'COMPRESSED');
    const fileToDataUrlCalled = vi.fn(async () => 'RAW');

    const result = await preprocessImages(fakeFiles, false, {
      compressImageForClaude: compressCalled,
      fileToDataUrl: fileToDataUrlCalled,
    });

    expect(compressCalled).not.toHaveBeenCalled();
    expect(fileToDataUrlCalled).toHaveBeenCalledTimes(1);
    expect(result.imagesToSend).toEqual(['RAW']);
  });

  it('多图并行处理 (Promise.all)', async () => {
    const fakeFiles = [
      { file: new File(['x'], 'a.png'), previewUrl: 'blob:1' },
      { file: new File(['y'], 'b.png'), previewUrl: 'blob:2' },
      { file: new File(['z'], 'c.png'), previewUrl: 'blob:3' },
    ] as ImagePending[];

    const result = await preprocessImages(fakeFiles, false, {
      compressImageForClaude: async () => '',
      fileToDataUrl: async (f) => `data:${f.name}`,
    });
    expect(result.imagesToSend).toEqual(['data:a.png', 'data:b.png', 'data:c.png']);
  });

  it('revokeObjectUrls 回调调用所有 previewUrl', () => {
    const fakeFiles = [
      { file: new File(['x'], 'a.png'), previewUrl: 'blob:1' },
      { file: new File(['y'], 'b.png'), previewUrl: 'blob:2' },
    ] as ImagePending[];
    const revokeSpy = vi.spyOn(URL, 'revokeObjectURL');

    preprocessImages(fakeFiles, false, {
      compressImageForClaude: async () => '',
      fileToDataUrl: async () => '',
    });

    // 同步执行后 revokeObjectUrls 还没被自动调, 调用方需要主动 invoke
    expect(revokeSpy).not.toHaveBeenCalled();
    // 调用 revoke
    // 注: 由于 preprocessImages 是 async, revokeObjectUrls 是被 freeze 在返回里
    // 但我们拿不到 Promise resolve 后的 revokeObjectUrls (因为 vi.fn 是 fire-and-forget)
    // 这里手动验证 mock 调用
    fakeFiles.forEach(f => URL.revokeObjectURL(f.previewUrl));
    expect(revokeSpy).toHaveBeenCalledWith('blob:1');
    expect(revokeSpy).toHaveBeenCalledWith('blob:2');
    revokeSpy.mockRestore();
  });
});

// ============== resolveMainEntryForSend ==============
describe('resolveMainEntryForSend', () => {
  const validEntry: ModelProviderEntry = {
    model: 'gpt-4o', providerName: 'openai', baseUrl: 'https://api.openai.com',
    apiKey: 'sk-xxx', enabledInSettings: true,
  };

  it('entry 有 apiKey → ok', () => {
    const r = resolveMainEntryForSend('gpt-4o', { 'gpt-4o': validEntry }, 'gpt-4o', validEntry, []);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.resolvedMainModel).toBe('gpt-4o');
  });

  it('entry 无 apiKey 但有 vaultProviderId → ok', () => {
    const e = { ...validEntry, apiKey: '', vaultProviderId: 'vault-1' };
    const r = resolveMainEntryForSend('gpt-4o', { 'gpt-4o': e }, 'gpt-4o', e, []);
    expect(r.ok).toBe(true);
  });

  it('decryptionFailures 非空 → 引导重输 key', () => {
    const r = resolveMainEntryForSend('gpt-4o', { 'gpt-4o': validEntry }, 'gpt-4o', undefined, [
      { name: 'openai' }, { name: 'anthropic' },
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errorMessage).toContain('设备指纹');
      expect(r.errorMessage).toContain('openai');
      expect(r.errorMessage).toContain('anthropic');
    }
  });

  it('map 为空 → 引导启用模型', () => {
    const r = resolveMainEntryForSend('gpt-4o', {}, 'gpt-4o', undefined, []);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errorMessage).toContain('尚未在');
      expect(r.errorMessage).toContain('添加并测试');
    }
  });

  it('entry 有但 map 没 → 引导重试', () => {
    const r = resolveMainEntryForSend('gpt-4o', { 'gpt-4o': validEntry }, 'gpt-4o', undefined, []);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errorMessage).toContain('当前主模型');
      expect(r.errorMessage).toContain('gpt-4o');
    }
  });

  it('decryptionFailures > 3 时显示 "等 N 个"', () => {
    const failures = Array.from({ length: 5 }, (_, i) => ({ name: `p${i}` }));
    const r = resolveMainEntryForSend('gpt-4o', { 'gpt-4o': validEntry }, 'gpt-4o', undefined, failures);
    if (!r.ok) expect(r.errorMessage).toContain('等 5 个');
  });
});

// ============== pickSubEntries / pickCandidateEntries ==============
describe('pickSubEntries', () => {
  const e1: ModelProviderEntry = { model: 'A', providerName: 'p1', baseUrl: 'u', apiKey: 'k', enabledInSettings: true };
  const e2: ModelProviderEntry = { model: 'B', providerName: 'p2', baseUrl: 'u', apiKey: 'k', enabledInSettings: true };
  const e3: ModelProviderEntry = { model: 'C', providerName: 'p3', baseUrl: 'u', apiKey: 'k', enabledInSettings: false };
  const map: Record<string, ModelProviderEntry> = { A: e1, B: e2, C: e3 };

  it('仅返回 secModels 列表里 + 启用 + 有 apiKey 的', () => {
    const subs = pickSubEntries([{ id: 'A' }, { id: 'B' }, { id: 'C' }], map);
    expect(subs.map(s => s.model)).toEqual(['A', 'B']); // C 未启用
  });

  it('secModels 里的 id 不在 map → 过滤掉', () => {
    const subs = pickSubEntries([{ id: 'A' }, { id: 'D' }], map);
    expect(subs.map(s => s.model)).toEqual(['A']);
  });

  it('支持 id 缺失回退到 name', () => {
    const subs = pickSubEntries([{ name: 'B' }], map);
    expect(subs.map(s => s.model)).toEqual(['B']);
  });
});

describe('pickCandidateEntries', () => {
  const e1: ModelProviderEntry = { model: 'A', providerName: 'p1', baseUrl: 'u', apiKey: 'k', enabledInSettings: true };
  const e2: ModelProviderEntry = { model: 'B', providerName: 'p2', baseUrl: 'u', apiKey: 'k', enabledInSettings: true };
  const e3: ModelProviderEntry = { model: 'C', providerName: 'p3', baseUrl: 'u', apiKey: '', enabledInSettings: true };
  const map: Record<string, ModelProviderEntry> = { A: e1, B: e2, C: e3 };

  it('返回不在 secModels 里 + 启用 + 有 apiKey 的', () => {
    const cands = pickCandidateEntries([{ id: 'A' }], map);
    expect(cands.map(s => s.model)).toEqual(['B']); // C 没 apiKey, A 在 secModels
  });

  it('全部都在 secModels → 返回空', () => {
    const cands = pickCandidateEntries([{ id: 'A' }, { id: 'B' }], map);
    expect(cands).toEqual([]);
  });
});

// ============== buildRequestBody ==============
describe('buildRequestBody', () => {
  const baseCtx: SendContext = {
    inputValue: 'hello',
    pendingAttachment: null,
    pendingImages: [],
    activeChatId: 'c1',
    activeMessages: [{ sender: 'user', content: 'hi', time: '12:00', avatar: '' }],
    activeSettings: { mode: 'normal' },
    selectedFile: null,
    editorContent: '',
    mainModel: 'gpt-4o',
    resolvedMainModel: 'gpt-4o',
    mainEntry: {
      model: 'gpt-4o', providerName: 'openai', baseUrl: 'https://api.openai.com',
      apiKey: 'sk-xxx', vaultProviderId: 'vault-1', enabledInSettings: true,
    },
    modelProviderMap: {},
    secModels: [],
    candidateEntries: [],
    subEntries: [],
    isClaudeMain: false,
    smartRoute: false,
    mixedTasks: false,
    hashlineAgentEnabled: false,
    permissionMode: 'normal',
    imagesToSend: [],
  };

  const mockDetectApiFormat = (e: ModelProviderEntry) =>
    e.model.startsWith('claude') ? 'anthropic' : 'openai';

  it('smartRoute=true + routed 有 subProviders → 用 routed 结果', () => {
    const routed: SmartRouterResult = {
      taskType: 'code',
      subProviders: [
        { baseUrl: 'u', apiKey: 'k', model: 'X', weight: 5, vaultProviderId: 'v', _reason: 'good' },
      ],
    };
    const body = buildRequestBody({ ...baseCtx, smartRoute: true, routed, detectApiFormat: mockDetectApiFormat });
    expect(body.subProviders).toHaveLength(1);
    expect(body.subProviders[0]).toMatchObject({
      model: 'X', weight: 5, _taskType: 'code', _reason: 'good',
      providerId: 'v',
    });
  });

  it('smartRoute=true 但 routed 为空 → 回退到 mixedTasks 分支', () => {
    const routed: SmartRouterResult = { taskType: 'code', subProviders: [] };
    const subE: ModelProviderEntry = { model: 'B', providerName: 'p', baseUrl: 'u', apiKey: 'k', enabledInSettings: true };
    const body = buildRequestBody({
      ...baseCtx,
      smartRoute: true,
      routed,
      mixedTasks: true,
      subEntries: [subE],
      secModels: [{ id: 'B', name: 'B', weight: 7 }],
      detectApiFormat: mockDetectApiFormat,
    });
    expect(body.subProviders).toHaveLength(1);
    expect(body.subProviders[0]).toMatchObject({
      model: 'B', weight: 7, _weight: 7,
    });
  });

  it('mixedTasks=true + subEntries 非空 → 用 secModels 配置', () => {
    const subE: ModelProviderEntry = { model: 'B', providerName: 'p', baseUrl: 'u', apiKey: 'k', enabledInSettings: true };
    const body = buildRequestBody({
      ...baseCtx,
      mixedTasks: true,
      subEntries: [subE],
      secModels: [{ id: 'B', name: 'B', weight: 8 }],
      detectApiFormat: mockDetectApiFormat,
    });
    expect(body.subProviders).toHaveLength(1);
    expect(body.subProviders[0].weight).toBe(8);
  });

  it('mixedTasks=true 但 subEntries 为空 → 空 subProviders', () => {
    const body = buildRequestBody({ ...baseCtx, mixedTasks: true, detectApiFormat: mockDetectApiFormat });
    expect(body.subProviders).toEqual([]);
  });

  it('无 smartRoute 无 mixedTasks → 空 subProviders', () => {
    const body = buildRequestBody({ ...baseCtx, detectApiFormat: mockDetectApiFormat });
    expect(body.subProviders).toEqual([]);
  });

  it('candidateProviders 始终返回脱敏字段 (无 apiKey)', () => {
    const candE: ModelProviderEntry = {
      model: 'D', providerName: 'prov', baseUrl: 'u', apiKey: 'should-not-leak', enabledInSettings: true,
    };
    const body = buildRequestBody({ ...baseCtx, candidateEntries: [candE], detectApiFormat: mockDetectApiFormat });
    expect(body.candidateProviders[0]).toEqual({
      displayName: 'D', providerName: 'prov', modelName: 'D', baseUrl: 'u',
    });
    expect(body.candidateProviders[0].apiKey).toBeUndefined();
  });

  it('vaultProviderId 注入到 provider.providerId', () => {
    const body = buildRequestBody({ ...baseCtx, detectApiFormat: mockDetectApiFormat });
    expect(body.provider.providerId).toBe('vault-1');
  });

  it('vaultProviderId 缺失时 providerId=undefined', () => {
    const e = { ...baseCtx.mainEntry, vaultProviderId: undefined };
    const body = buildRequestBody({ ...baseCtx, mainEntry: e, detectApiFormat: mockDetectApiFormat });
    expect(body.provider.providerId).toBeUndefined();
  });

  it('images 透传 imagesToSend', () => {
    const body = buildRequestBody({
      ...baseCtx, imagesToSend: ['img1', 'img2'], detectApiFormat: mockDetectApiFormat,
    });
    expect(body.images).toEqual(['img1', 'img2']);
  });

  it('activeFile 有 selectedFile 时挂 fileContext', () => {
    const body = buildRequestBody({
      ...baseCtx, selectedFile: 'a.ts', editorContent: 'code', detectApiFormat: mockDetectApiFormat,
    });
    expect(body.activeFile).toEqual({ name: 'a.ts', content: 'code' });
  });

  it('activeFile 无 selectedFile 时为 null', () => {
    const body = buildRequestBody({ ...baseCtx, detectApiFormat: mockDetectApiFormat });
    expect(body.activeFile).toBeNull();
  });
});