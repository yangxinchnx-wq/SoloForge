/**
 * Garnet Domain Cache (P8 cache-aside for hot read paths)
 * Path: src/data/garnet/domain-cache.ts
 * Date: 2026-06-30
 *
 * Plan §24 P8 — Garnet 读缓存 (cache-aside)
 * 4 个 plan 标定的热 key:
 *   - agent:meta:<uuid>        — Agent 元数据       TTL 5 min
 *   - agent:reputation:<uuid>  — Agent 信誉         TTL 30 s (写时 invalidate)
 *   - institution:active        — 活跃制度列表       TTL 10 min
 *   - law:active                — 活跃法律列表       TTL 10 min
 *
 * 用法:
 *   import { domainCache } from './data/garnet/domain-cache';
 *   const agent = await domainCache.getAgentMeta(agentId, async () => {
 *     // cache miss 回调: 从 SurrealDB / JSONL 读
 *     return await surrealdb.query(`SELECT * FROM agent WHERE id = $id`, { id: agentId });
 *   });
 *
 * 零破坏: 新文件, 不改现有 cache.ts / client.ts。
 */

import { getClient } from './client';

const KEY_AGENT_META = (id: string) => `agent:meta:${id}`;
const KEY_AGENT_REPUTATION = (id: string) => `agent:reputation:${id}`;
const KEY_INSTITUTION_ACTIVE = 'institution:active';
const KEY_LAW_ACTIVE = 'law:active';

const TTL = {
  AGENT_META: 300,           // 5 min
  AGENT_REPUTATION: 30,      // 30 s
  INSTITUTION_ACTIVE: 600,   // 10 min
  LAW_ACTIVE: 600,           // 10 min
} as const;

async function getJson<T>(key: string): Promise<T | null> {
  const client = getClient();
  if (!client) return null;
  const raw = await client.get(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function setJson<T>(key: string, value: T, ttlSec: number): Promise<void> {
  const client = getClient();
  if (!client) return;
  await client.setex(key, ttlSec, JSON.stringify(value));
}

async function del(...keys: string[]): Promise<void> {
  const client = getClient();
  if (!client) return;
  await client.del(...keys);
}

export const domainCache = {
  // ── Agent 元数据 (TTL 5min) ─────────────────────────────────────
  async getAgentMeta<T = unknown>(
    agentId: string,
    loader: () => Promise<T | null>,
  ): Promise<T | null> {
    const key = KEY_AGENT_META(agentId);
    const cached = await getJson<T>(key);
    if (cached !== null) return cached;
    const fresh = await loader();
    if (fresh !== null && fresh !== undefined) {
      await setJson(key, fresh, TTL.AGENT_META);
    }
    return fresh ?? null;
  },

  async invalidateAgentMeta(agentId: string): Promise<void> {
    await del(KEY_AGENT_META(agentId));
  },

  // ── Agent 信誉 (TTL 30s, 写时 invalidate) ──────────────────────
  async getAgentReputation<T = unknown>(
    agentId: string,
    loader: () => Promise<T | null>,
  ): Promise<T | null> {
    const key = KEY_AGENT_REPUTATION(agentId);
    const cached = await getJson<T>(key);
    if (cached !== null) return cached;
    const fresh = await loader();
    if (fresh !== null && fresh !== undefined) {
      await setJson(key, fresh, TTL.AGENT_REPUTATION);
    }
    return fresh ?? null;
  },

  async invalidateAgentReputation(agentId: string): Promise<void> {
    await del(KEY_AGENT_REPUTATION(agentId));
  },

  // 写后立即失效 (调 reputation.write 后调用)
  async onReputationWrite(agentId: string): Promise<void> {
    await this.invalidateAgentReputation(agentId);
  },

  // ── 活跃制度列表 (TTL 10min) ──────────────────────────────────
  async getInstitutionActive<T = unknown>(
    loader: () => Promise<T | null>,
  ): Promise<T | null> {
    const cached = await getJson<T>(KEY_INSTITUTION_ACTIVE);
    if (cached !== null) return cached;
    const fresh = await loader();
    if (fresh !== null && fresh !== undefined) {
      await setJson(KEY_INSTITUTION_ACTIVE, fresh, TTL.INSTITUTION_ACTIVE);
    }
    return fresh ?? null;
  },

  async invalidateInstitutionActive(): Promise<void> {
    await del(KEY_INSTITUTION_ACTIVE);
  },

  // ── 活跃法律列表 (TTL 10min) ──────────────────────────────────
  async getLawActive<T = unknown>(
    loader: () => Promise<T | null>,
  ): Promise<T | null> {
    const cached = await getJson<T>(KEY_LAW_ACTIVE);
    if (cached !== null) return cached;
    const fresh = await loader();
    if (fresh !== null && fresh !== undefined) {
      await setJson(KEY_LAW_ACTIVE, fresh, TTL.LAW_ACTIVE);
    }
    return fresh ?? null;
  },

  async invalidateLawActive(): Promise<void> {
    await del(KEY_LAW_ACTIVE);
  },

  // ── 统计 / 调试 ────────────────────────────────────────────────
  async stats(): Promise<{
    agentMeta: number;
    agentReputation: number;
    institutionActive: number;
    lawActive: number;
  }> {
    const client = getClient();
    if (!client) {
      return { agentMeta: 0, agentReputation: 0, institutionActive: 0, lawActive: 0 };
    }
    const [m, r, i, l] = await Promise.all([
      client.keys('agent:meta:*').then((k) => k.length).catch(() => 0),
      client.keys('agent:reputation:*').then((k) => k.length).catch(() => 0),
      client.exists(KEY_INSTITUTION_ACTIVE),
      client.exists(KEY_LAW_ACTIVE),
    ]);
    return {
      agentMeta: m,
      agentReputation: r,
      institutionActive: i,
      lawActive: l,
    };
  },

  TTL,
};

export default domainCache;
