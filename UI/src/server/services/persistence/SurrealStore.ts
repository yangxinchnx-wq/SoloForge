/**
 * SurrealDB 温存储客户端
 *
 * - 30 秒 flush 一次, 把热数据写入 SurrealDB(跨重启恢复)
 * - 架构: Surreal 类 (surrealdb@2.x) + createNodeEngines (@surrealdb/node@3.x)
 *   Surreal v2 接受 { engines } 参数, 与 v3 引擎兼容
 * - 走本地 embedded rocksdb://, 无需远程 server
 *
 * ★ 2026-07-14: 不再降级。任何初始化失败、连接失败、操作失败都直接抛错,
 *   错误信息用中文说明具体原因和具体位置。
 */

import path from 'path';
import type { SessionState } from '../canvas/types';
import { isSessionState, repairSessionState } from '../canvas/validators';

// 走本地 embedded rocksdb (与 root backend 3001 共享 data 目录, 互不冲突)
const SURREAL_URL = process.env.SURREAL_URL || 'rocksdb://data/canvas_sessions_db';
const NAMESPACE = process.env.SURREAL_NAMESPACE || 'soloforge_core';
const DATABASE = process.env.SURREAL_DATABASE || 'canvas_state';

/**
 * SurrealStore 接口契约
 */
export interface ISurrealStore {
  init(): Promise<boolean>;
  saveSessionSnapshot(state: SessionState): Promise<boolean>;
  loadSessionSnapshot(sessionId: string): Promise<SessionState | null>;
  /**
   * s2.4: 列出所有已知 sessionId
   *   - 冷启动恢复时调用, SessionStore 据此批量恢复
   *   - Surreal 用 SELECT * FROM session_state
   */
  listAllSessionIds?(): Promise<string[]>;
  /** ★ 2026-07-11: 删除画布会话状态 (级联清理) */
  deleteSessionState?(sessionId: string): Promise<boolean>;
  close(): Promise<void>;
  isAvailable(): boolean;
}

/**
 * 真实 SurrealDB 实现
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
    // ⚠️ 关键: 用 **相对路径** `rocksdb://data/xxx`
    //   绝对路径 `rocksdb://C:/...` 在 Surreal v2 + v3 engine 组合下会 hang
    //   (Surreal 把 `C:` 当成引擎协议名, 等不存在的 C engine, 永远不 resolve)
    //   Root 3001 用相对路径 `data/soloforge_db` 所以工作。
    const relPath = 'data/canvas_sessions_db';
    console.log(`[SurrealStore] connecting to rocksdb://${relPath} (cwd=${process.cwd()}) ...`);
    try {
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
        throw new Error(
          `[SurrealStore] init() 定义表结构失败: ${(e as Error).message}。` +
          `位置: SurrealStore.ts → SurrealStoreImpl.init() → DEFINE TABLE/INDEX。` +
          `原因: SurrealDB rocksdb 可能损坏或路径不可写 (${relPath})。`,
        );
      }
      this.connected = true;
      console.log(
        `[SurrealStore] ✅ connected: rocksdb://${relPath} (ns=${NAMESPACE}, db=${DATABASE})`,
      );
      return true;
    } catch (e) {
      this.connected = false;
      throw new Error(
        `[SurrealStore] init() 连接 SurrealDB 失败: ${(e as Error).message}。` +
        `位置: SurrealStore.ts → SurrealStoreImpl.init() → db.connect(rocksdb://${relPath})。` +
        `原因: rocksdb 路径不可访问、磁盘满、或 surrealdb/@surrealdb/node 引擎版本不兼容。`,
      );
    }
  }

  async saveSessionSnapshot(state: SessionState): Promise<boolean> {
    if (!this.connected) {
      throw new Error(
        `[SurrealStore] saveSessionSnapshot() 失败: SurrealDB 未连接。` +
        `位置: SurrealStore.ts → SurrealStoreImpl.saveSessionSnapshot(${state.sessionId})。` +
        `原因: init() 未成功完成或连接已断开。`,
      );
    }
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
      throw new Error(
        `[SurrealStore] saveSessionSnapshot() 失败: ${(e as Error).message}。` +
        `位置: SurrealStore.ts → SurrealStoreImpl.saveSessionSnapshot(${state.sessionId})。` +
        `原因: SurrealDB 写入异常, 可能是 rocksdb 磁盘满或数据格式不合法。`,
      );
    }
  }

  async loadSessionSnapshot(sessionId: string): Promise<SessionState | null> {
    if (!this.connected) {
      throw new Error(
        `[SurrealStore] loadSessionSnapshot() 失败: SurrealDB 未连接。` +
        `位置: SurrealStore.ts → SurrealStoreImpl.loadSessionSnapshot(${sessionId})。` +
        `原因: init() 未成功完成或连接已断开。`,
      );
    }
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
      throw new Error(
        `[SurrealStore] loadSessionSnapshot() 失败: ${(e as Error).message}。` +
        `位置: SurrealStore.ts → SurrealStoreImpl.loadSessionSnapshot(${sessionId})。` +
        `原因: SurrealDB 查询异常。`,
      );
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
   * ★ 2026-07-11: 删除画布会话状态 (级联清理)
   * DELETE FROM session_state WHERE sessionId = $sid
   */
  async deleteSessionState(sessionId: string): Promise<boolean> {
    if (!this.connected) {
      throw new Error(
        `[SurrealStore] deleteSessionState() 失败: SurrealDB 未连接。` +
        `位置: SurrealStore.ts → SurrealStoreImpl.deleteSessionState(${sessionId})。` +
        `原因: init() 未成功完成或连接已断开。`,
      );
    }
    try {
      await this.db.query('DELETE FROM session_state WHERE sessionId = $sid', { sid: sessionId });
      return true;
    } catch (e) {
      throw new Error(
        `[SurrealStore] deleteSessionState() 失败: ${(e as Error).message}。` +
        `位置: SurrealStore.ts → SurrealStoreImpl.deleteSessionState(${sessionId})。` +
        `原因: SurrealDB 删除异常。`,
      );
    }
  }

  /**
   * s2.4: 列出 SurrealDB 里所有 sessionId
   *
   * 用 `SELECT id FROM session_state` 拿全部 id
   * id 形如 `session_state:abc-def-123`, 需要 split ':' 拿后半段
   */
  async listAllSessionIds(): Promise<string[]> {
    if (!this.connected) {
      throw new Error(
        `[SurrealStore] listAllSessionIds() 失败: SurrealDB 未连接。` +
        `位置: SurrealStore.ts → SurrealStoreImpl.listAllSessionIds()。` +
        `原因: init() 未成功完成或连接已断开。`,
      );
    }
    try {
      // v3: rows 在 session_state table 内, 用 SELECT VALUE 拿 sessionId 字段
      const result: any = await this.db.query('SELECT VALUE sessionId FROM session_state WHERE sessionId != NONE');
      const rows = Array.isArray(result) ? (result[0] as any[]) : (result as any);
      if (!Array.isArray(rows)) return [];
      return rows.filter((s: any) => typeof s === 'string' && s.length > 0);
    } catch (e) {
      throw new Error(
        `[SurrealStore] listAllSessionIds() 失败: ${(e as Error).message}。` +
        `位置: SurrealStore.ts → SurrealStoreImpl.listAllSessionIds()。` +
        `原因: SurrealDB 查询异常。`,
      );
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
 *
 * ★ 2026-07-14: 不再降级为 noop。依赖缺失直接抛错。
 */
async function createSurrealStore(): Promise<ISurrealStore> {
  let SurrealCtor: any = null;
  let engines: any = null;
  try {
    const mainMod = await import('surrealdb' as string);
    SurrealCtor = (mainMod as any).Surreal || (mainMod as any).default;
    if (!SurrealCtor) throw new Error('surrealdb 包没有导出 Surreal 类');
  } catch (e) {
    throw new Error(
      `[SurrealStore] 加载 surrealdb 依赖失败: ${(e as Error).message}。` +
      `位置: SurrealStore.ts → createSurrealStore() → import('surrealdb')。` +
      `原因: surrealdb 包未安装或损坏。请执行 npm install surrealdb。`,
    );
  }
  try {
    const nodeMod = await import('@surrealdb/node' as string);
    const createNodeEngines =
      (nodeMod as any).createNodeEngines ||
      (nodeMod as any).default?.createNodeEngines;
    if (!createNodeEngines) throw new Error('@surrealdb/node 包没有导出 createNodeEngines');
    // 关键: 必须**调用** createNodeEngines() 拿包含 rocksdb 的 engines 对象
    //       直接传函数本身 Surreal 会报 "engine not configured"
    engines = createNodeEngines();
  } catch (e) {
    throw new Error(
      `[SurrealStore] 加载 @surrealdb/node 依赖失败: ${(e as Error).message}。` +
      `位置: SurrealStore.ts → createSurrealStore() → import('@surrealdb/node')。` +
      `原因: @surrealdb/node 包未安装或损坏。请执行 npm install @surrealdb/node。`,
    );
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
 * ★ 2026-07-14: 同步获取不再返回 fallback noop。
 * 如果异步初始化尚未完成, 直接抛错, 要求调用方使用 async 版本。
 */
export function getSurrealStore(): ISurrealStore {
  if (_instance) return _instance;
  throw new Error(
    `[SurrealStore] getSurrealStore() 同步获取失败: SurrealDB 异步初始化尚未完成。` +
    `位置: SurrealStore.ts → getSurrealStore()。` +
    `原因: 调用方在 SurrealDB init() 完成前同步访问了 SurrealStore。` +
    `请改用 await getSurrealStoreAsync(), 或确保 bootstrap 已完成后再调用。`,
  );
}

// 兼容旧名:SurrealStore 类名仍可导出(类型 + alias)
export type SurrealStore = ISurrealStore;
