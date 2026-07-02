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
 * 设计原则：
 *   - 任何持久层失败都不能阻塞 3000 启动（内存 + 路由必须可用）
 *   - Garnet 未启动时降级为内存模式（仍能工作，断电丢数据）
 *   - Surreal 包未装 / DB 不可写时降级 noop（已有 SurrealStore 内部实现）
 *   - 单例：getSessionStore() / getGarnetStore() / getSurrealStore() 多次调用
 *     拿到的都是同一个实例，跨路由共享
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
  /** Garnet 是否实际可用（false = 降级为内存模式） */
  garnetReady: boolean;
  /** SurrealDB 是否实际可用（false = 降级为 noop） */
  surrealReady: boolean;
  /** 失败原因（成功时为空字符串） */
  error: string;
}

/**
 * 启动画布会话层。**不抛异常**，任何错误都降级为部分可用。
 *
 * Async 因为需要 await 真实 SurrealStore init (避免 sync fallback 死锁)
 */
export async function bootstrapCanvasSessionLayer(
  app: Express,
): Promise<CanvasBootstrapResult> {
  let garnetReady = false;
  let surrealReady = false;
  const errors: string[] = [];

  // ── 1. Garnet 热存储（Redis 协议，6379） ──────────────────────────
  // 注意：GarnetStore 构造时即连接 Redis（Garnet 协议兼容）。
  // 连接成功/失败的日志由 GarnetStore 内部 event handler 输出。
  // 此处仅做存在性检查，不阻塞启动。
  try {
    getGarnetStore();
    // 用 setTimeout 0 等一 tick 让 ioredis 尝试 connect，再用 ping 探活
    setTimeout(() => {
      try {
        const probe = (getGarnetStore() as unknown as {
          client?: { ping?: () => Promise<string>; status?: string };
        }).client;
        if (probe?.status === 'ready' && probe.ping) {
          probe
            .ping()
            .then(() => {
              garnetReady = true;
              console.log('[canvas] ✅ Garnet 热存储可用 (6379)');
            })
            .catch((e: Error) => {
              console.warn('[canvas] ⚠️  Garnet ping 失败，运行于内存模式:', e.message);
            });
        } else {
          console.warn(
            `[canvas] ⚠️  Garnet 未就绪 (status=${probe?.status ?? 'unknown'})，运行于内存模式`,
          );
        }
      } catch (e) {
        console.warn('[canvas] ⚠️  Garnet 探活失败:', (e as Error).message);
      }
    }, 50);
  } catch (e) {
    errors.push(`garnet: ${(e as Error).message}`);
    console.warn('[canvas] ⚠️  GarnetStore 初始化失败:', (e as Error).message);
  }

  // ── 2. 立即挂载路由（不等 Surreal 完成 — 路由只读 in-memory map,
  //    Surreal 是后台持久化, 路由不需要等它） ─────────────────
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
    const msg = `route registration failed: ${(e as Error).message}`;
    errors.push(msg);
    console.error('[canvas] ❌ 路由挂载失败:', msg);
    return { ok: false, garnetReady, surrealReady, error: msg };
  }

  // ── 3. 后台 SurrealDB 初始化（不阻塞路由） ─────────────────────
  // ⚠️ 必须用 **async** 版本: sync getter 第一次返回 _synchronousFallback
  //    (noop), 而 SessionStore 构造时就绑死了 surreal 引用。如果先
  //    getSessionStore() 再 getSurrealStoreAsync, SessionStore 拿到的是
  //    fallback。正确顺序: 先 await Surreal 真实 init, 再触发 SessionStore 构造。
  //
  // 用一个共享 Promise 让 SessionStore 等到 Surreal 真的 init 完成才建:
  const surrealInitPromise: Promise<boolean> = Promise.race<boolean>([
    getSurrealStoreAsync().then((s) => {
      const ok = s.isAvailable();
      if (ok) console.log('[canvas] ✅ SurrealDB 温存储可用 (远程 8000)');
      else console.warn('[canvas] ⚠️  SurrealDB 不可用 (降级 noop，仅内存+日志)');
      return ok;
    }),
    new Promise<boolean>((_, reject) =>
      setTimeout(() => reject(new Error('surreal init timeout (8s)')), 8000),
    ),
  ]).catch((e: Error) => {
    console.warn('[canvas] ⚠️  SurrealDB 初始化失败 (降级 noop):', e.message);
    return false;
  });

  // ── 4. SessionStore 单例（在 Surreal 真实 init 完成后才创建，
  //    确保 this.surreal 拿到的是真实例而不是 fallback） ──────
  void surrealInitPromise.then((ok) => {
    surrealReady = ok;
    try {
      const store = getSessionStore();
      console.log(
        `[canvas] ✅ SessionStore 就绪 (surreal=${ok ? 'real' : 'noop'}, sessions=${store.listSessions().length})`,
      );
      // ── 4b. 冷启动自动恢复 ────────────────────────────────────
      // Surreal rocksdb 里有数据 (UI/data/canvas_sessions_db/*.sst) 但内存是空的,
      // 必须主动调一次 restoreAllFromSurreal 把历史 session 拉回来。
      // 不做这一步 → 重启后 listCanvases() 永远是空, 用户画的东西全丢。
      store
        .restoreAllFromSurreal()
        .then((r) => {
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
        })
        .catch((e: Error) => {
          console.warn('[canvas] ⚠️  冷启动恢复失败:', e.message);
        });
    } catch (e) {
      errors.push(`sessionStore: ${(e as Error).message}`);
      console.error('[canvas] ❌ SessionStore 初始化失败:', (e as Error).message);
    }
  });

  // ── 5. 优雅退出钩子 ───────────────────────────────────────────
  registerShutdownHooks();

  return {
    ok: true,
    garnetReady,
    surrealReady,
    error: errors.length ? errors.join('; ') : '',
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
