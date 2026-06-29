/**
 * SurrealDB 温存储客户端(可选依赖)
 *
 * - 30 秒 flush 一次, 把热数据写入 SurrealDB(跨重启恢复)
 * - 使用 @surrealdb/node
 * - 若包未安装或连接失败,自动降级为 noop(只警告一次,不抛错)
 */

import type { SessionState } from '../canvas/types';
import { isSessionState, repairSessionState } from '../canvas/validators';

const SURREAL_URL = process.env.SURREAL_URL || 'rocksdb://data/soloforge_db';
const NAMESPACE = process.env.SURREAL_NAMESPACE || 'soloforge_core';
const DATABASE = process.env.SURREAL_DATABASE || 'canvas_state';

/**
 * SurrealStore 接口契约(无论是否连接成功都满足)
 */
export interface ISurrealStore {
  init(): Promise<boolean>;
  saveSessionSnapshot(state: SessionState): Promise<boolean>;
  loadSessionSnapshot(sessionId: string): Promise<SessionState | null>;
  /**
   * s2.4: 列出所有已知 sessionId
   *   - 冷启动恢复时调用, SessionStore 据此批量恢复
   *   - Surreal 用 SELECT * FROM session_state
   *   - Noop / Garnet 退化为 []
   */
  listAllSessionIds?(): Promise<string[]>;
  close(): Promise<void>;
  isAvailable(): boolean;
}

/**
 * Noop 实现:@surrealdb/node 未安装或初始化失败时使用
 */
class NoopSurrealStore implements ISurrealStore {
  async init(): Promise<boolean> { return false; }
  async saveSessionSnapshot(): Promise<boolean> { return false; }
  async loadSessionSnapshot(): Promise<SessionState | null> { return null; }
  // s2.4: noop 不支持 listAllSessionIds, 返回空数组
  async listAllSessionIds(): Promise<string[]> { return []; }
  async close(): Promise<void> { /* noop */ }
  isAvailable(): boolean { return false; }
}

/**
 * 真实 SurrealDB 实现(包可用时)
 */
class SurrealStoreImpl implements ISurrealStore {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private db: any;
  private connected: boolean = false;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private SurrealCtor: any;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(SurrealCtor: any) {
    this.SurrealCtor = SurrealCtor;
    this.db = new SurrealCtor();
  }

  async init(): Promise<boolean> {
    try {
      await this.db.connect(SURREAL_URL);
      await this.db.use({ namespace: NAMESPACE, database: DATABASE });
      this.connected = true;
      console.log('[SurrealStore] connected:', SURREAL_URL);
      return true;
    } catch (e) {
      console.warn('[SurrealStore] init failed:', (e as Error).message);
      this.connected = false;
      return false;
    }
  }

  async saveSessionSnapshot(state: SessionState): Promise<boolean> {
    if (!this.connected) return false;
    try {
      const id = `session_state:${state.sessionId}`;
      await this.db.upsert(id, {
        ...state,
        snapshotAt: Date.now(),
      });
      return true;
    } catch (e) {
      console.warn('[SurrealStore] saveSessionSnapshot failed:', (e as Error).message);
      return false;
    }
  }

  async loadSessionSnapshot(sessionId: string): Promise<SessionState | null> {
    if (!this.connected) return null;
    try {
      const id = `session_state:${sessionId}`;
      const result = await this.db.select(id);
      if (!result) return null;
      const parsed = result as unknown;

      if (isSessionState(parsed)) {
        return parsed;
      }

      const repaired = repairSessionState(parsed);
      if (repaired) {
        console.warn(`[SurrealStore] repaired session ${sessionId}`);
        return repaired;
      }

      console.warn(`[SurrealStore] unrepairable session ${sessionId}, returning null`);
      return null;
    } catch (e) {
      return null;
    }
  }

  async close(): Promise<void> {
    if (this.connected) {
      try { await this.db.close(); } catch {}
      this.connected = false;
    }
  }

  isAvailable(): boolean { return this.connected; }

  /**
   * s2.4: 列出 SurrealDB 里所有 sessionId
   *
   * 用 `SELECT id FROM session_state` 拿全部 id
   * id 形如 `session_state:abc-def-123`, 需要 split ':' 拿后半段
   */
  async listAllSessionIds(): Promise<string[]> {
    if (!this.connected) return [];
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result: any = await this.db.select('session_state');
      if (!Array.isArray(result)) return [];
      return result
        .map((r: any) => {
          // 兼容几种返回形态
          const id = r?.id ?? r?.sessionId ?? '';
          if (typeof id !== 'string') return '';
          // session_state:xxx 格式, 取后半
          const parts = id.split(':');
          return parts[parts.length - 1] || id;
        })
        .filter((s: string) => s.length > 0);
    } catch (e) {
      console.warn('[SurrealStore] listAllSessionIds failed:', (e as Error).message);
      return [];
    }
  }
}

/**
 * 异步加载 SurrealStore(顶层 import 失败时不阻塞模块加载)
 */
async function createSurrealStore(): Promise<ISurrealStore> {
  try {
    const mod = await import('@surrealdb/node' as string);
    // 兼容 default export 和 named export
    const SurrealCtor = (mod as any).Surreal || (mod as any).default;
    if (!SurrealCtor) {
      throw new Error('@surrealdb/node has no Surreal export');
    }
    return new SurrealStoreImpl(SurrealCtor);
  } catch (e) {
    console.warn(
      '[SurrealStore] @surrealdb/node unavailable, using noop:',
      (e as Error).message
    );
    return new NoopSurrealStore();
  }
}

let _instance: ISurrealStore | null = null;
let _initPromise: Promise<ISurrealStore> | null = null;

export async function getSurrealStoreAsync(): Promise<ISurrealStore> {
  if (_instance) return _instance;
  if (_initPromise) return _initPromise;
  _initPromise = createSurrealStore().then(async (store) => {
    await store.init();
    _instance = store;
    return store;
  });
  return _initPromise;
}

/**
 * 同步获取(返回 noop 如果还在异步初始化中,确保调用方永不被阻塞)
 */
export function getSurrealStore(): ISurrealStore {
  if (_instance) return _instance;
  // 启动异步初始化(不阻塞)
  if (!_initPromise) {
    getSurrealStoreAsync().catch((e) => {
      console.warn('[SurrealStore] async init failed:', (e as Error).message);
    });
  }
  return _synchronousFallback;
}

/**
 * 同步 fallback:在异步初始化完成前提供 stub,避免业务阻塞
 */
const _synchronousFallback: ISurrealStore = {
  async init() { return false; },
  async saveSessionSnapshot() { return false; },
  async loadSessionSnapshot() { return null; },
  // s2.4: 同步 fallback 也提供 listAllSessionIds
  async listAllSessionIds() {
    if (_instance && typeof _instance.listAllSessionIds === 'function') {
      return _instance.listAllSessionIds();
    }
    return [];
  },
  async close() { /* noop */ },
  isAvailable() { return _instance?.isAvailable() ?? false; },
};

// 兼容旧名:SurrealStore 类名仍可导出(类型 + alias)
export type SurrealStore = ISurrealStore;