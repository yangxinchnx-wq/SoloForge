/**
 * bootstrap/canvas.ts
 * ---------------------------------------------------------------------------
 * 画布会话层启动器 (3000 进程)
 *
 * 职责：
 *   1. 惰性实例化 GarnetStore + SurrealStore（用项目里既有的单例 getter）
 *   2. 惰性实例化 SessionStore（自带 30s 定时 flush 循环）
 *   3. 挂载 /api/canvas/sessions/* + /api/canvas/persistence/* 路由
 *   4. 注册优雅退出钩子（SIGINT/SIGTERM/before-quit → flushAll）
 *
 * ★ 2026-07-14: 不再降级。Garnet / SurrealDB 初始化失败直接抛错,
 *   错误信息用中文说明具体原因和具体位置。服务器不会在缺依赖的情况下静默启动。
 *
 * 调用方：UI/server.ts  在 app.use(express.json()) 之后立即调用
 * ---------------------------------------------------------------------------
 */

import type { Express } from 'express';
import { getGarnetStore } from '../services/persistence/GarnetStore';
import { getSurrealStoreAsync } from '../services/persistence/SurrealStore';
import { getSessionStore } from '../services/session/SessionStore';
import {
  flushAllSessions,
  registerCanvasSessionRoutes,
} from '../routes/canvasSession';
import { registerCanvasToolRoutes } from '../routes/canvasTools';

export interface CanvasBootstrapResult {
  /** 是否成功挂载路由（成功 = true） */
  ok: boolean;
  /** Garnet 是否实际可用 */
  garnetReady: boolean;
  /** SurrealDB 是否实际可用 */
  surrealReady: boolean;
  /** 失败原因（成功时为空字符串） */
  error: string;
}

/**
 * 启动画布会话层。
 *
 * ★ 2026-07-14: 不再降级。任何持久层初始化失败都会抛出错误,
 *   错误信息包含中文说明的具体原因和具体位置。
 *
 * Async 因为需要 await 真实 SurrealStore init
 */
export async function bootstrapCanvasSessionLayer(
  app: Express,
): Promise<CanvasBootstrapResult> {
  let garnetReady = false;
  let surrealReady = false;

  // ── 1. Garnet 热存储（Redis 协议，6379） ──────────────────────────
  // 注意：GarnetStore 构造时即连接 Redis（Garnet 协议兼容）。
  // 连接成功/失败的日志由 GarnetStore 内部 event handler 输出。
  // 此处做存在性检查 + ping 探活, 失败直接抛错。
  try {
    const store = getGarnetStore();
    // 用 setTimeout 0 等一 tick 让 ioredis 尝试 connect，再用 ping 探活
    await new Promise<void>((resolve, reject) => {
      setTimeout(async () => {
        try {
          const probe = (store as unknown as {
            client?: { ping?: () => Promise<string>; status?: string };
          }).client;
          if (probe?.status === 'ready' && probe.ping) {
            await probe.ping();
            garnetReady = true;
            console.log('[canvas] ✅ Garnet 热存储可用 (6379)');
            resolve();
          } else {
            throw new Error(
              `Garnet 连接状态为 ${probe?.status ?? 'unknown'} (非 ready)。` +
              `位置: bootstrap/canvas.ts → bootstrapCanvasSessionLayer() → Garnet ping 探活。` +
              `原因: Garnet 服务未启动或正在启动中, 请检查 Garnet 进程 (端口 6379)。`,
            );
          }
        } catch (e) {
          reject(e);
        }
      }, 50);
    });
  } catch (e) {
    throw new Error(
      `[canvas] Garnet 初始化失败: ${(e as Error).message}。` +
      `位置: bootstrap/canvas.ts → bootstrapCanvasSessionLayer() → 步骤1 Garnet 探活。` +
      `原因: Garnet (Redis 兼容) 服务未启动或不可达 (端口 6379)。`,
    );
  }

  // ── 2. 立即挂载路由（路由只读 in-memory map, 不依赖持久层） ─────
  try {
    registerCanvasSessionRoutes(app);
    registerCanvasToolRoutes(app);
    console.log('[canvas] ✅ 路由已挂载:');
    console.log('         GET    /api/canvas/sessions');
    console.log('         GET    /api/canvas/sessions/:id');
    console.log('         PATCH  /api/canvas/sessions/:id');
    console.log('         DELETE /api/canvas/sessions/:id');
    console.log('         PUT    /api/canvas/sessions/:id/select-model');
    console.log('         PUT    /api/canvas/sessions/:id/devices/selected');
    console.log('         PUT    /api/canvas/sessions/:id/devices/selected-many');
    console.log('         POST   /api/canvas/sessions/:id/devices/transform-group');
    console.log('         POST   /api/canvas/sessions/:id/devices');
    console.log('         DELETE /api/canvas/sessions/:id/devices/:deviceId');
    console.log('         PUT    /api/canvas/sessions/:id/devices/:deviceId/transform');
    console.log('         PUT    /api/canvas/sessions/:id/devices/:deviceId/ui-session');
    console.log('         POST   /api/canvas/sessions/:id/flush');
    console.log('         GET    /api/canvas/persistence/status');
    console.log('         POST   /api/canvas/persistence/force-flush');
    console.log('         POST   /api/canvas/persistence/restore-all');
  } catch (e) {
    throw new Error(
      `[canvas] 路由挂载失败: ${(e as Error).message}。` +
      `位置: bootstrap/canvas.ts → bootstrapCanvasSessionLayer() → 步骤2 registerCanvasSessionRoutes/registerCanvasToolRoutes。` +
      `原因: Express 路由注册异常, 可能是路由文件有语法错误或导入失败。`,
    );
  }

  // ── 3. SurrealDB 初始化（必须成功, 不再降级 noop） ─────────────
  // ⚠️ 必须用 **async** 版本: sync getter 第一次返回 fallback
  //    (noop), 而 SessionStore 构造时就绑死了 surreal 引用。如果先
  //    getSessionStore() 再 getSurrealStoreAsync, SessionStore 拿到的是
  //    fallback。正确顺序: 先 await Surreal 真实 init, 再触发 SessionStore 构造。
  //
  // 用一个共享 Promise 让 SessionStore 等到 Surreal 真的 init 完成才建:
  try {
    const store = await Promise.race<Promise<import('../services/persistence/SurrealStore').ISurrealStore>>([
      getSurrealStoreAsync(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(
          `SurrealDB 初始化超时 (8 秒)。` +
          `位置: bootstrap/canvas.ts → bootstrapCanvasSessionLayer() → 步骤3 SurrealDB 初始化。` +
          `原因: rocksdb 连接 hang, 可能是路径冲突或磁盘 I/O 阻塞。` +
          `请检查 data/canvas_sessions_db 目录是否被其他进程锁定。`,
        )), 8000),
      ),
    ]);
    const ok = store.isAvailable();
    if (!ok) {
      throw new Error(
        `SurrealDB init() 返回不可用 (isAvailable=false)。` +
        `位置: bootstrap/canvas.ts → bootstrapCanvasSessionLayer() → 步骤3 getSurrealStoreAsync().isAvailable()。` +
        `原因: SurrealDB 连接已建立但内部状态异常。`,
      );
    }
    surrealReady = ok;
    console.log('[canvas] ✅ SurrealDB 温存储可用 (rocksdb embedded)');
  } catch (e) {
    throw new Error(
      `[canvas] SurrealDB 初始化失败: ${(e as Error).message}。` +
      `位置: bootstrap/canvas.ts → bootstrapCanvasSessionLayer() → 步骤3 SurrealDB 初始化。` +
      `原因: surrealdb/@surrealdb/node 包缺失或 rocksdb 连接失败。`,
    );
  }

  // ── 4. SessionStore 单例（在 Surreal 真实 init 完成后才创建，
  //    确保 this.surreal 拿到的是真实例而不是 fallback） ──────
  try {
    const store = getSessionStore();
    console.log(
      `[canvas] ✅ SessionStore 就绪 (surreal=real, sessions=${store.listSessions().length})`,
    );
    // ── 4b. 冷启动自动恢复 ────────────────────────────────────
    // Surreal rocksdb 里有数据 (UI/data/canvas_sessions_db/*.sst) 但内存是空的,
    // 必须主动调一次 restoreAllFromSurreal 把历史 session 拉回来。
    // 不做这一步 → 重启后 listCanvases() 永远是空, 用户画的东西全丢。
    const r = await store.restoreAllFromSurreal();
    if (r.total > 0) {
      console.log(
        `[canvas] ♻️  冷启动恢复: restored=${r.restored}/${r.total} ` +
          `(内存现 ${store.listSessions().length} 个 session)`,
      );
      r.results.forEach((row) => {
        if (row.status !== 'in-memory') {
          console.log(`         ${row.sessionId}: ${row.status}`);
        }
      });
    }
  } catch (e) {
    throw new Error(
      `[canvas] SessionStore 初始化失败: ${(e as Error).message}。` +
      `位置: bootstrap/canvas.ts → bootstrapCanvasSessionLayer() → 步骤4 getSessionStore() + restoreAllFromSurreal()。` +
      `原因: SessionStore 构造异常或 SurrealDB 冷启动恢复失败。`,
    );
  }

  // ── 5. 优雅退出钩子 ───────────────────────────────────────────
  registerShutdownHooks();

  return {
    ok: true,
    garnetReady,
    surrealReady,
    error: '',
  };
}

let shutdownHooksInstalled = false;

function registerShutdownHooks(): void {
  if (shutdownHooksInstalled) return;
  shutdownHooksInstalled = true;

  const handler = (signal: string) => {
    console.log(`[canvas] 收到 ${signal}，开始 flush 所有 session...`);
    void flushAllSessions().then(() => {
      console.log('[canvas] flush 完成，进程退出');
      // 给日志 50ms flush 时间
      setTimeout(() => process.exit(0), 50);
    });
  };

  process.on('SIGINT', () => handler('SIGINT'));
  process.on('SIGTERM', () => handler('SIGTERM'));

  // Electron 主进程关闭事件（如果嵌入到 Electron）
  process.on('beforeExit', () => {
    console.log('[canvas] beforeExit 触发，同步 flush');
    // best-effort，fire-and-forget
    void flushAllSessions();
  });
}
