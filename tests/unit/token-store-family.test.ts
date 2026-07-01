/**
 * tokenStore + tokenFamily 单元测试
 *
 * 验证:
 *   1. init / create / rotate / revoke 状态机
 *   2. kid 唯一性 + family 关联
 *   3. 复用检测: active / rotating-grace / rotating-past-grace
 *   4. Grace Period 网络抖动兼容
 *   5. v1 → v2 自动迁移
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockStore } = vi.hoisted(() => {
  // 进程内 in-memory vault, 隔离每个测试
  return {
    mockStore: new Map<string, string>(),
  };
});

vi.mock('../../src/security/apiKeyVault', () => ({
  apiKeyVault: {
    init: vi.fn(async () => undefined),
    getKey: vi.fn(async (providerId: string) => {
      const apiKey = mockStore.get(providerId);
      if (apiKey) return { apiKey, baseUrl: 'vault://test', source: 'keychain' as const };
      return null;
    }),
    setKey: vi.fn(async (providerId: string, apiKey: string) => {
      mockStore.set(providerId, apiKey);
    }),
    deleteKey: vi.fn(async (providerId: string) => mockStore.delete(providerId)),
    flush: vi.fn(),
  },
}));

import {
  tokenStoreInit,
  createToken,
  getActiveTokens,
  findByToken,
  findByKid,
  revokeToken,
  revokeFamily,
  gcExpiredTokens,
  pickBootstrapToken,
  listActiveKids,
  __resetTokenStoreCacheForTest,
  VAULT_PROVIDER_ID_V2,
  VAULT_PROVIDER_ID_V1,
} from '../../src/security/tokenStore';
import { checkReuse, processBearerToken } from '../../src/security/tokenFamily';

beforeEach(() => {
  mockStore.clear();
  __resetTokenStoreCacheForTest();
});

// ============================================================
// tokenStore
// ============================================================

describe('tokenStore — init / create', () => {
  it('init 创建空 snapshot', async () => {
    await tokenStoreInit();
    const active = await getActiveTokens();
    expect(active).toEqual([]);
  });

  it('createToken 生成 64 字符 hex + 唯一 kid', async () => {
    await tokenStoreInit();
    const t = await createToken({ source: 'init' });
    expect(t.kid).toMatch(/^k_[0-9a-f]{1,8}$/);
    expect(t.token).toMatch(/^[0-9a-f]{64}$/);
    expect(t.status).toBe('active');
    expect(t.familyId).toMatch(/^f_[0-9a-f]{1,8}$/);
    expect(t.parentKid).toBeNull();
    expect(t.source).toBe('init');
  });

  it('多次 createToken kid 互不相同', async () => {
    await tokenStoreInit();
    const t1 = await createToken({ source: 'init' });
    const t2 = await createToken({ source: 'rotate' });
    expect(t1.kid).not.toBe(t2.kid);
    // 没有 parent 时各自独立 family
    expect(t1.familyId).not.toBe(t2.familyId);
  });

  it('createToken 带 parentKid → 父子同 family, parent 立即进入 rotating', async () => {
    await tokenStoreInit();
    const parent = await createToken({ source: 'init' });
    const child = await createToken({ parentKid: parent.kid, source: 'rotate' });
    expect(child.familyId).toBe(parent.familyId);
    expect(child.parentKid).toBe(parent.kid);
    // 创建子 token 即触发轮换, parent 立即变 rotating (这是设计)
    expect(parent.status).toBe('rotating');
    expect(parent.rotatedAt).not.toBeNull();
    expect(parent.graceUntil).toBeGreaterThan(parent.rotatedAt!);
  });

  it('getActiveTokens 返回 active + rotating', async () => {
    await tokenStoreInit();
    const a = await createToken({ source: 'init' });
    const b = await createToken({ parentKid: a.kid, source: 'rotate' });
    const active = await getActiveTokens();
    expect(active).toContain(a.token);
    expect(active).toContain(b.token);
  });
});

describe('tokenStore — v1 → v2 迁移', () => {
  it('检测到 v1 base64url JSON 数组时自动迁移', async () => {
    const v1Tokens = ['hex1abc', 'hex2def', 'hex3ghi'];
    const blob = Buffer.from(JSON.stringify(v1Tokens), 'utf8').toString('base64url');
    mockStore.set(VAULT_PROVIDER_ID_V1, blob);

    await tokenStoreInit();
    const active = await getActiveTokens();

    expect(active.length).toBe(3);
    for (const t of v1Tokens) expect(active).toContain(t);
    // v1 写到了 v2
    const v2Raw = mockStore.get(VAULT_PROVIDER_ID_V2);
    expect(v2Raw).toBeDefined();
    const v2 = JSON.parse(Buffer.from(v2Raw!, 'base64url').toString('utf8'));
    expect(v2.version).toBe(2);
  });

  it('v1 内容为空时, 不写入 v2', async () => {
    await tokenStoreInit();
    expect(mockStore.has(VAULT_PROVIDER_ID_V2)).toBe(false);
  });
});

describe('tokenStore — revoke / gc', () => {
  it('revokeToken 标记单个 kid 为 revoked', async () => {
    await tokenStoreInit();
    const t = await createToken({ source: 'init' });
    const ok = await revokeToken({ kid: t.kid });
    expect(ok).toBe(true);
    const after = await findByKid(t.kid);
    expect(after?.status).toBe('revoked');
  });

  it('revokeFamily 整族吊销', async () => {
    await tokenStoreInit();
    const a = await createToken({ source: 'init' });
    const b = await createToken({ parentKid: a.kid, source: 'rotate' });
    const result = await revokeFamily({ familyId: a.familyId, reason: 'manual' });
    expect(result.revokedTokens).toBeGreaterThanOrEqual(2);
    expect((await findByKid(a.kid))?.status).toBe('revoked');
    expect((await findByKid(b.kid))?.status).toBe('revoked');
  });

  it('gcExpiredTokens: 过了 grace period 的 rotating 自动转 revoked', async () => {
    await tokenStoreInit();
    const a = await createToken({ source: 'init' });
    const now = Date.now();
    // 创建一个 5s 前就已过 grace period 的 rotating
    await createToken({ parentKid: a.kid, source: 'rotate', now, graceMs: 1000 });
    // 把 a 的 rotatedAt 倒回到 1 小时前
    const aRec = await findByKid(a.kid);
    aRec!.rotatedAt = now - 3600_000;
    aRec!.graceUntil = now - 60_000; // 1 分钟前就过了
    // gc
    const removed = await gcExpiredTokens(now);
    expect(removed).toBe(1);
    expect((await findByKid(a.kid))?.status).toBe('revoked');
  });
});

describe('tokenStore — bootstrap / list', () => {
  it('pickBootstrapToken 选最新 active', async () => {
    await tokenStoreInit();
    const a = await createToken({ source: 'init', now: 1000 });
    const b = await createToken({ source: 'init', now: 2000 });
    const c = await createToken({ source: 'init', now: 3000 });
    const cand = await pickBootstrapToken();
    expect(cand?.kid).toBe(c.kid);
    expect(cand?.token).toBe(c.token);
  });

  it('listActiveKids 返回所有非 revoked', async () => {
    await tokenStoreInit();
    await createToken({ source: 'init' });
    await createToken({ source: 'init' });
    const list = await listActiveKids();
    expect(list.length).toBe(2);
    expect(list.every((e) => e.status === 'active')).toBe(true);
  });
});

// ============================================================
// tokenFamily — 复用检测
// ============================================================

describe('tokenFamily — checkReuse 决策树', () => {
  it('active token → allow', async () => {
    await tokenStoreInit();
    const t = await createToken({ source: 'init' });
    const r = await checkReuse(t.token);
    expect(r.decision).toBe('allow');
    expect(r.record?.kid).toBe(t.kid);
  });

  it('rotating token 在 grace period 内 → allow_in_grace', async () => {
    await tokenStoreInit();
    const a = await createToken({ source: 'init', now: 1000 });
    const b = await createToken({ parentKid: a.kid, source: 'rotate', now: 2000, graceMs: 60000 });
    // a 现在是 rotating, graceUntil = 2000 + 60000 = 62000
    const r = await checkReuse(a.token, 30_000);
    expect(r.decision).toBe('allow_in_grace');
    expect(r.graceUntil).toBe(62_000);
  });

  it('rotating token 过了 grace period → reuse_detected', async () => {
    await tokenStoreInit();
    const a = await createToken({ source: 'init', now: 1000 });
    await createToken({ parentKid: a.kid, source: 'rotate', now: 2000, graceMs: 1000 });
    // graceUntil = 3000
    const r = await checkReuse(a.token, 4000);
    expect(r.decision).toBe('reuse_detected');
  });

  it('revoked token → revoked 决定', async () => {
    await tokenStoreInit();
    const a = await createToken({ source: 'init' });
    await revokeToken({ kid: a.kid });
    const r = await checkReuse(a.token);
    expect(r.decision).toBe('revoked');
  });

  it('未知 token → unknown', async () => {
    await tokenStoreInit();
    const r = await checkReuse('not-in-vault');
    expect(r.decision).toBe('unknown');
  });

  it('空 bearer → unknown', async () => {
    await tokenStoreInit();
    const r = await checkReuse('');
    expect(r.decision).toBe('unknown');
  });
});

describe('tokenFamily — processBearerToken 自动吊销', () => {
  it('reuse_detected 自动吊销整族', async () => {
    await tokenStoreInit();
    const a = await createToken({ source: 'init', now: 1000 });
    await createToken({ parentKid: a.kid, source: 'rotate', now: 2000, graceMs: 1000 });
    const r = await processBearerToken({ bearer: a.token, now: 4000, autoRevokeFamily: true });
    expect(r.decision).toBe('reuse_detected');
    expect(r.autoRevokedTokens).toBeGreaterThanOrEqual(2);
    // 整族都被吊销
    expect((await findByKid(a.kid))?.status).toBe('revoked');
  });

  it('autoRevokeFamily=false 时仅报告, 不吊销', async () => {
    await tokenStoreInit();
    const a = await createToken({ source: 'init', now: 1000 });
    await createToken({ parentKid: a.kid, source: 'rotate', now: 2000, graceMs: 1000 });
    const r = await processBearerToken({ bearer: a.token, now: 4000, autoRevokeFamily: false });
    expect(r.decision).toBe('reuse_detected');
    expect(r.autoRevokedTokens).toBe(0);
    expect((await findByKid(a.kid))?.status).toBe('rotating');
  });
});
