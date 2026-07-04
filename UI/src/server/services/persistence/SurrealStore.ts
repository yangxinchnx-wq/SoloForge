/**
 * SurrealDB 温存储客户端(可选依赖)
 *
 * - 30 秒 flush 一次, 把热数据写入 SurrealDB(跨重启恢复)
 * - 架构: Surreal 类 (surrealdb@2.x) + createNodeEngines (@surrealdb/node@3.x)
 *   Surreal v2 接受 { engines } 参数, 与 v3 引擎兼容
 * - 走本地 embedded rocksdb://, 无需远程 server
 * - 若包未安装或连接失败,自动降级为 noop(只警告一次,不抛错)
 */

import path from 'path';
import type { SessionState } from '../canvas/types';
import { isSessionState, repairSessionState } from '../canvas/validators';

// 走本地 embedded rocksdb (与 root backend 3001 共享 data 目录, 互不冲突)
const SURREAL_URL = process.env.SURREAL_URL || 'rocksdb://data/canvas_sessions_db';
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
  constructor(SurrealCtor: any, engines: any) {
    // v2 Surreal 接受 { engines } 参数 (文档注释: * const db = new Surreal({...}))
    // createNodeEngines 来自 @surrealdb/node v3, 提供 rocksdb/file/memory 引擎
    // 关键: engines 必须是 createNodeEngines() 的**返回值**(含 rocksdb 函数的对象),
    //      不是 createNodeEngines 函数本身(否则 Surreal 内部当作"未配置")
    this.db = new SurrealCtor({ engines });
  }

  async init(): Promise<boolean> {
    try {
      // ⚠️ 关键: 用 **相对路径** `rocksdb://data/xxx`
      //   绝对路径 `rocksdb://C:/...` 在 Surreal v2 + v3 engine 组合下会 hang
      //   (Surreal 把 `C:` 当成引擎协议名, 等不存在的 C engine, 永远不 resolve)
      //   Root 3001 用相对路径 `data/soloforge_db` 所以工作。
      const relPath = 'data/canvas_sessions_db';
      console.log(`[SurrealStore] connecting to rocksdb://${relPath} (cwd=${process.cwd()}) ...`);
      await this.db.connect(`rocksdb://${relPath}`);
      await this.db.use({ namespace: NAMESPACE, database: DATABASE });
      // v3 schema: schemaless table + unique index on sessionId
      //   - schemaless: 允许任意字段 (SessionState 是动态 shape)
      //   - unique index: 保证每个 sessionId 只有一行
      try {
        await this.db.query('DEFINE TABLE IF NOT EXISTS session_state SCHEMALESS;');
        await this.db.query(
          'DEFINE INDEX IF NOT EXISTS idx_session_id ON TABLE session_state COLUMNS sessionId UNIQUE;',
        );
        console.log('[SurrealStore] schema: session_state SCHEMALESS + idx_session_id UNIQUE');
      } catch (e) {
        console.warn('[SurrealStore] DEFINE failed (continuing):', (e as Error).message);
      }
      this.connected = true;
      console.log(
        `[SurrealStore] ✅ connected: rocksdb://${relPath} (ns=${NAMESPACE}, db=${DATABASE})`,
      );
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
      const data = {
        ...state,
        snapshotAt: Date.now(),
      };
      // v3 不接受 db.upsert('table:string-id', data) (会建子表),
      // 也不支持 ON DUPLICATE KEY UPDATE
      // 走两步: UPDATE WHERE 命中则返, 没命中则 INSERT
      const updResult: any = await this.db.query(
        `UPDATE session_state CONTENT $data WHERE sessionId = $sid`,
        { data, sid: state.sessionId },
      );
      const updatedRows = Array.isArray(updResult) ? (updResult[0] as any[]) : [];
      if (Array.isArray(updatedRows) && updatedRows.length > 0) return true;
      try {
        // P0: 包含 ACL 字段 (ownerChatSessionId / visibility / name / description / createdAt / lastAccessedBy)
        await this.db.query(
          `INSERT INTO session_state (
            sessionId, name, description, createdAt,
            selectedDeviceKey, devices, bgColor,
            selectedDeviceId, selectedDeviceIds, lastUpdated,
            ownerChatSessionId, visibility, lastAccessedBy,
            snapshotAt
          ) VALUES (
            $sid, $name, $desc, $cat,
            $sdk, $devices, $bg,
            $sdid, $sdis, $lu,
            $owner, $vis, $lab,
            $sa
          )`,
          {
            sid: state.sessionId,
            name: state.name,
            desc: state.description ?? null,
            cat: state.createdAt ?? null,
            sdk: state.selectedDeviceKey,
            devices: state.devices,
            bg: state.bgColor,
            sdid: state.selectedDeviceId,
            sdis: state.selectedDeviceIds,
            lu: state.lastUpdated,
            owner: state.ownerChatSessionId,
            vis: state.visibility,
            lab: state.lastAccessedBy ?? {},
            sa: data.snapshotAt,
          },
        );
        return true;
      } catch (insertErr) {
        // UNIQUE 索引拒重复 — 视为幂等成功
        const msg = (insertErr as Error).message || '';
        if (msg.includes('already contains')) return true;
        throw insertErr;
      }
    } catch (e) {
      console.warn('[SurrealStore] saveSessionSnapshot failed:', (e as Error).message);
      return false;
    }
  }

  async loadSessionSnapshot(sessionId: string): Promise<SessionState | null> {
    if (!this.connected) return null;
    try {
      // v3: row 在 session_state table 内, 用 sessionId 字段查
      const result = await this.db.query(
        'SELECT * FROM session_state WHERE sessionId = $sid LIMIT 1',
        { sid: sessionId },
      );
      const rows = Array.isArray(result) ? (result[0] as any[]) : (result as any);
      if (!Array.isArray(rows) || rows.length === 0) return null;
      const parsed = rows[0] as unknown;
      if (isSessionState(parsed)) return parsed;
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
      // v3: rows 在 session_state table 内, 用 SELECT VALUE 拿 sessionId 字段
      const result: any = await this.db.query('SELECT VALUE sessionId FROM session_state WHERE sessionId != NONE');
      const rows = Array.isArray(result) ? (result[0] as any[]) : (result as any);
      if (!Array.isArray(rows)) return [];
      return rows.filter((s: any) => typeof s === 'string' && s.length > 0);
    } catch (e) {
      console.warn('[SurrealStore] listAllSessionIds failed:', (e as Error).message);
      return [];
    }
  }
}

/**
 * 异步加载 SurrealStore(顶层 import 失败时不阻塞模块加载)
 *
 * 架构:
 *   - Surreal 类         → 来自 `surrealdb@2.x` (v2 Surreal 类接受 engines 参数)
 *   - createNodeEngines  → 来自 `@surrealdb/node@3.x` (提供 rocksdb/file/memory 引擎)
 *   - 走本地 embedded rocksdb://, 无需远程 SurrealDB server
 *   - 与 root backend 3001 用同一份 data 目录 (互不冲突: 不同 db)
 */
async function createSurrealStore(): Promise<ISurrealStore> {
  let SurrealCtor: any = null;
  let engines: any = null;
  try {
    const mainMod = await import('surrealdb' as string);
    SurrealCtor = (mainMod as any).Surreal || (mainMod as any).default;
    if (!SurrealCtor) throw new Error('surrealdb has no Surreal export');
  } catch (e) {
    console.warn(
      '[SurrealStore] surrealdb unavailable, using noop:',
      (e as Error).message,
    );
    return new NoopSurrealStore();
  }
  try {
    const nodeMod = await import('@surrealdb/node' as string);
    const createNodeEngines =
      (nodeMod as any).createNodeEngines ||
      (nodeMod as any).default?.createNodeEngines;
    if (!createNodeEngines) throw new Error('@surrealdb/node has no createNodeEngines');
    // 关键: 必须**调用** createNodeEngines() 拿包含 rocksdb 的 engines 对象
    //       直接传函数本身 Surreal 会报 "engine not configured"
    engines = createNodeEngines();
  } catch (e) {
    console.warn(
      '[SurrealStore] @surrealdb/node engines unavailable, using noop:',
      (e as Error).message,
    );
    return new NoopSurrealStore();
  }
  return new SurrealStoreImpl(SurrealCtor, engines);
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