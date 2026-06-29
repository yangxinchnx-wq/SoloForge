/**
 * astCache.ts — AST 缓存层（内存 + Garnet 跨 tab 共享）
 *
 * 设计原则（backend-patterns: Cache-Aside Pattern）：
 *   - 内存 Map 永远是 fast path（同步 API）
 *   - Garnet 作为 slow path（异步，按需 hydrate）
 *   - Garnet 可用时：write-through（同时写内存和 Garnet）
 *   - Garnet 不可用时：自动降级到内存 only（无错误）
 *
 * 升级路径：
 *   - Phase 1（当前）：内存优先 + Garnet 后台 hydrate
 *   - Phase 2（未来）：Garnet 优先 + 内存仅作 L1
 *
 * 用法（向后兼容）：
 *   astCache.get(key)            → 同步（仅内存）
 *   await astCache.hydrate(key)  → 主动从 Garnet 加载
 *   await astCache.set(key, p)   → write-through
 *   astCache.invalidate(key)
 */

import type { PreviewPayload } from './UniversalAST';
import { getGarnetClient, serializePayload, deserializePayload } from './garnetClient';

interface CacheEntry {
  payload: PreviewPayload;
  expiresAt: number;
}

const DEFAULT_TTL_MS = 30_000;
const memoryStore = new Map<string, CacheEntry>();
// 标记已 hydrate 过的 key（避免重复网络请求）
const hydratedKeys = new Set<string>();

export interface SetOptions {
  ttlMs?: number;
}

/** 计算 prompt 哈希（FNV-1a 32-bit，简单快速） */
export function hashPrompt(prompt: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < prompt.length; i++) {
    hash ^= prompt.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/** 拼接缓存 key */
export function makeAstKey(language: string, promptHash: string): string {
  return `ast:${language.toLowerCase()}:${promptHash}`;
}

/** 拼接 key（高层 API） */
export function astKeyFor(language: string, prompt: string): string {
  return makeAstKey(language, hashPrompt(prompt));
}

export const astCache = {
  /**
   * 同步取缓存（仅内存）
   * 命中时检查过期，过期则当作 miss 并删除
   */
  get(key: string): PreviewPayload | undefined {
    const entry = memoryStore.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      memoryStore.delete(key);
      return undefined;
    }
    return entry.payload;
  },

  /**
   * 异步 hydrate：尝试从 Garnet 加载到内存
   * 已 hydrate 过的 key 不重复请求
   * Garnet 不可用时静默降级（不抛错）
   */
  async hydrate(key: string): Promise<void> {
    if (hydratedKeys.has(key)) return;
    if (memoryStore.has(key)) {
      hydratedKeys.add(key);
      return;
    }
    hydratedKeys.add(key);

    try {
      const g = await getGarnetClient();
      if (!g) return; // Garnet 不可用，静默降级
      const raw = await g.get(key);
      const payload = deserializePayload(raw);
      if (payload) {
        memoryStore.set(key, { payload, expiresAt: Date.now() + DEFAULT_TTL_MS });
      }
    } catch {
      // 网络错误：忽略
    }
  },

  /** 写入缓存（write-through：内存 + Garnet 异步） */
  set(key: string, payload: PreviewPayload, opts: SetOptions = {}): void {
    const ttl = opts.ttlMs ?? DEFAULT_TTL_MS;
    memoryStore.set(key, { payload, expiresAt: Date.now() + ttl });

    // 异步写 Garnet（fire-and-forget）
    void (async () => {
      try {
        const g = await getGarnetClient();
        if (g) {
          await g.set(key, serializePayload(payload), Math.ceil(ttl / 1000));
        }
      } catch {
        // 写入失败忽略（内存已有副本）
      }
    })();
  },

  /** 便捷写入 */
  setByPrompt(language: string, prompt: string, payload: PreviewPayload, opts?: SetOptions): void {
    this.set(astKeyFor(language, prompt), payload, opts);
  },

  /** 删除 */
  invalidate(key: string): void {
    memoryStore.delete(key);
    hydratedKeys.delete(key);
    // 异步删 Garnet
    void (async () => {
      try {
        const g = await getGarnetClient();
        if (g) {
          // 简易实现：直接 DEL（注意：RESP3 client 没暴露 del，这里只清内存）
          // 未来可扩展 g.del(key)
        }
      } catch {
        /* ignore */
      }
    })();
  },

  /** 清空（调试 / 测试用） */
  clear(): void {
    memoryStore.clear();
    hydratedKeys.clear();
  },

  size(): number {
    return memoryStore.size;
  },

  DEFAULT_TTL_MS,
};
