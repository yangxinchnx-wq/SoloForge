// ─────────────────────────────────────────────────────────────────
// SoloForge 画布宿主 + IPC 模块 (从 main.cjs 提取, 2026-06-28)
//
// 目的:
//   - 把 canvas 相关的所有状态 (canvasSessions / canvasHostWindow / hostBounds)
//     和所有 canvas IPC handler (canvas:start / :stop / :embed-status 等)
//     封装成单一模块, 既供 main.cjs 生产环境使用, 也供 Electron 测试驱动调用
//   - 通过依赖注入 (deps) 让测试可以用 mock 实现替换关键系统调用
//     (moveWindow / embedWindowWithRetry / findWindowByPid / spawn 等)
//
// 设计原则:
//   - 状态全部封闭在工厂返回的实例里, 不污染模块全局
//   - 所有 IPC handler 在调用 registerIpc() 时一次性注册
//   - beforeQuit() 给 main.cjs 的 app.on('before-quit') 用, 做 graceful shutdown
// ─────────────────────────────────────────────────────────────────

'use strict';

const net = require('net');
const http = require('http');
const { spawn } = require('child_process');

// Node 22+ 原生 WebSocket (globalThis.WebSocket)
// ws transport: 高频 /transform /pushUI /render /setBackground /clearDevices
// http transport: 大块 /screenshot / rtt-texture (base64 上传/下载)
//
// 协议字段保持与 canvas (Dart) 端 _handleMessage 兼容:
//   { type?, action?, mode/ui?, platform?, ... }
// canvas 端: main.dart _handleMessage() → _handleDeviceAction() case 'transformDevice' / 'pushUI' / ...
const WebSocketImpl = typeof globalThis.WebSocket === 'function' ? globalThis.WebSocket : null;

/**
 * 创建画布管理器
 *
 * @param {Object} deps
 * @param {Electron.App} deps.app
 * @param {typeof import('electron').BrowserWindow} deps.BrowserWindow
 * @param {typeof import('electron').ipcMain} deps.ipcMain
 * @param {() => import('electron').BrowserWindow | null} deps.getMainWindow
 * @param {() => string} deps.resolveCanvasExePath
 * @param {() => string} deps.resolveCanvasDataDir
 * @param {() => string} deps.resolveModelsDir
 * @param {() => any} deps.readDeviceConfig
 * @param {() => any[]} deps.listAvailableModels
 * @param {(hwnd: number, x: number, y: number, w: number, h: number) => Promise<{ok: boolean, error?: string}>} deps.moveWindow
 * @param {(flutterHwnd: number, parentHwnd: number, x: number, y: number, w: number, h: number, opts?: any) => Promise<any>} deps.embedWindowWithRetry
 * @param {(pid: number) => Promise<number>} deps.findWindowByPid
 * @param {(port: number, path: string, body: any, timeoutMs?: number) => Promise<{status: number, body: string}>} deps.sendToCanvasRaw
 * @param {(port: number, timeoutMs?: number) => Promise<boolean>} [deps.waitForPort]
 * @param {() => Promise<number>} [deps.findFreePort]
 * @param {Function} [deps.spawn] - child_process.spawn, 测试时可用 mock
 * @param {string} [deps.logPrefix] - 日志前缀, 测试时设为 '[test]'
 */
function createCanvasManager(deps) {
  const {
    app,
    BrowserWindow,
    ipcMain,
    getMainWindow,
    resolveCanvasExePath,
    resolveCanvasDataDir,
    resolveModelsDir,
    readDeviceConfig,
    listAvailableModels,
    moveWindow,
    embedWindowWithRetry,
    findWindowByPid,
    sendToCanvasRaw,
    waitForPort,
    findFreePort,
    spawn: spawnFn = spawn,
    logPrefix = '[canvas]',
    idleDestroyMs = 30_000,
  } = deps;

  // ── 内部状态 ──
  /** @type {Map<string, {sessionId: string, pid: number, port: number, hwnd: number, width: number, height: number, embedStatus: any, process?: any, ws?: WsConn}>} */
  const canvasSessions = new Map();
  // s4 / 2026-06-28 修复: start 还没完成时 stop 会找不到 session, 留下孤儿进程
  //   场景: 用户点 ▶ 启动 (200-500ms 启动中) → 立刻点 ✕ 关闭
  //   之前: stop 返回 notFound, start 继续完成, 留下无人管的 canvas 子进程
  //   现在: spawn 后立刻登记到 pendingStarts, stop 检查 pendingStarts 先 kill 子进程 + 标记 aborted
  /** @type {Map<string, {child: any, aborted: boolean}>} */
  const pendingStarts = new Map();
  /**
   * @typedef {Object} WsConn
   * @property {any} ws           - WebSocket 实例
   * @property {boolean} ready    - OPEN 状态
   * @property {boolean} alive    - 已成功 upgrade 过一次 (避免 init race)
   * @property {Array<{resolve: Function, reject: Function, message: string}>} queue - 等待 ready 时排队的消息
   * @property {number} retryCount
   * @property {Function} _onClose
   */
  /** @type {Map<number, WsConn>} port → ws 连接 */
  const wsClients = new Map();
  /** @type {Map<string, number>} sessionId → port (用于 stopCanvas 时定位 ws) */
  const sessionPortMap = new Map();
  /** 测试 / 诊断 hook: ws 状态变化 */
  const wsHooks = new Set();
  let canvasHostWindow = null;
  let hostBounds = { x: 100, y: 100, width: 1200, height: 800 };
  let idleDestroyTimer = null;
  /** @type {Set<Function>} crash hooks for testing/diagnostics */
  const crashHooks = new Set();

  // ── 默认实现 (生产环境用) ──
  const _findFreePort = findFreePort || (() => new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  }));
  const _waitForPort = waitForPort || ((port, timeoutMs = 8000) => new Promise((resolve) => {
    const start = Date.now();
    const tryConnect = () => {
      const sock = net.createConnection({ host: '127.0.0.1', port }, () => {
        sock.end();
        resolve(true);
      });
      sock.on('error', () => {
        if (Date.now() - start > timeoutMs) resolve(false);
        else setTimeout(tryConnect, 200);
      });
    };
    tryConnect();
  }));

  // ────────────────────────────────────────────
  // 宿主窗口管理
  // ────────────────────────────────────────────
  function createCanvasHostWindow(parent) {
    if (canvasHostWindow && !canvasHostWindow.isDestroyed()) {
      try { canvasHostWindow.destroy(); } catch {}
    }
    canvasHostWindow = new BrowserWindow({
      width: hostBounds.width,
      height: hostBounds.height,
      x: hostBounds.x,
      y: hostBounds.y,
      parent: parent || undefined,
      show: true,
      frame: false,
      transparent: true,
      skipTaskbar: true,
      focusable: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      hasShadow: false,
      backgroundColor: '#00000000',
      webPreferences: {
        offscreen: false,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        backgroundThrottling: true,
      },
    });
    canvasHostWindow.loadURL('data:text/html,<html><body style="margin:0;background:transparent;backdrop-filter:none"></body></html>');
    canvasHostWindow.setAlwaysOnTop(false);
    canvasHostWindow.setIgnoreMouseEvents(false);
    return canvasHostWindow;
  }

  function ensureCanvasHost() {
    if (canvasHostWindow && !canvasHostWindow.isDestroyed()) {
      return canvasHostWindow;
    }
    const mainWin = getMainWindow();
    if (!mainWin || mainWin.isDestroyed()) {
      throw new Error('mainWindow not available; cannot create canvas host');
    }
    console.log(`${logPrefix}-host lazy create (first time user opens preview)`);
    return createCanvasHostWindow(mainWin);
  }

  function scheduleIdleDestroy() {
    if (idleDestroyTimer) clearTimeout(idleDestroyTimer);
    idleDestroyTimer = setTimeout(() => {
      if (canvasSessions.size > 0) return;
      if (!canvasHostWindow || canvasHostWindow.isDestroyed()) return;
      console.log(`${logPrefix}-host idle for ${idleDestroyMs / 1000}s, destroying to free memory`);
      try { canvasHostWindow.destroy(); } catch {}
      canvasHostWindow = null;
      idleDestroyTimer = null;
    }, idleDestroyMs);
  }

  function cancelIdleDestroy() {
    if (idleDestroyTimer) {
      clearTimeout(idleDestroyTimer);
      idleDestroyTimer = null;
    }
  }

  function positionCanvasHost(bounds) {
    if (!bounds) return;
    hostBounds = bounds;
    try {
      if (!canvasHostWindow || canvasHostWindow.isDestroyed()) return;
      canvasHostWindow.setBounds({
        x: Math.round(bounds.x),
        y: Math.round(bounds.y),
        width: Math.round(bounds.width),
        height: Math.round(bounds.height),
      });
    } catch (e) {
      console.warn(`${logPrefix}-host setBounds failed:`, e?.message);
    }
  }

  // ────────────────────────────────────────────
  // WebSocket 客户端管理 (每个 canvas 进程 port 一条长连接)
  //
  // 设计:
  //   - wsClients: port → { ws, ready, queue, retryCount }
  //   - ensureWs(port): lazy connect, 不阻塞调用方
  //   - sendOverWs(port, message): 优先用 ws, ws 未就绪 → 排入 queue
  //   - ws 断开: 自动重连, 指数退避 200ms / 500ms / 1s / 2s / 4s (max 4s)
  //   - ws 长期不可用: 调用方仍可走 sendToCanvasRaw (HTTP 降级)
  // ────────────────────────────────────────────
  function ensureWs(port) {
    if (!WebSocketImpl) return null;
    let conn = wsClients.get(port);
    if (conn && conn.disabled) return null;  // 测试用: ws 强制禁用
    if (conn && (conn.ws.readyState === 1 /* OPEN */ || conn.ws.readyState === 0 /* CONNECTING */)) {
      return conn;
    }
    if (conn && conn.ws.readyState === 2 /* CLOSING */) {
      // 正在关闭, 等 onclose 清理
      return null;
    }
    if (conn) {
      // 已 CLOSED, 复用 conn 但替换 ws
      conn.queue = [];
      conn.ready = false;
    } else {
      conn = { ws: null, ready: false, alive: false, queue: [], retryCount: 0, _onClose: null };
      wsClients.set(port, conn);
    }
    try {
      const ws = new WebSocketImpl(`ws://127.0.0.1:${port}/ws`);
      conn.ws = ws;
      ws.onopen = () => {
        conn.ready = true;
        conn.alive = true;
        conn.retryCount = 0;
        for (const h of wsHooks) {
          try { h({ port, type: 'open' }); } catch {}
        }
        const pending = conn.queue;
        conn.queue = [];
        for (const item of pending) {
          try { ws.send(item.message); item.resolve({ ok: true, transport: 'ws', queued: true }); }
          catch (e) { item.resolve({ ok: false, error: e.message }); }
        }
      };
      ws.onerror = (e) => {
        // 错误先于 close 触发, 只记日志, 不 reject (close 会处理 retry)
        const msg = e?.message || 'ws error';
        for (const h of wsHooks) {
          try { h({ port, type: 'error', error: msg }); } catch {}
        }
      };
      ws.onclose = () => {
        conn.ready = false;
        for (const h of wsHooks) {
          try { h({ port, type: 'close' }); } catch {}
        }
        // 拒排队的消息 (调用方会回退 HTTP)
        for (const item of conn.queue) {
          item.resolve({ ok: false, error: 'ws closed before send', transport: 'ws-queue-rejected' });
        }
        conn.queue = [];
        // 如果 port 还有 session 在用, 启动重连
        const portStillUsed = [...sessionPortMap.values()].includes(port);
        if (portStillUsed && conn.alive) {
          const delay = Math.min(4000, 200 * Math.pow(2, conn.retryCount));
          conn.retryCount++;
          setTimeout(() => {
            const stillUsed = [...sessionPortMap.values()].includes(port);
            if (stillUsed) ensureWs(port);
          }, delay);
        }
      };
      // canvas 主动推送 (Dart 端可能发回 RTT input / scene status 等)
      ws.onmessage = (ev) => {
        for (const h of wsHooks) {
          try { h({ port, type: 'message', data: ev?.data }); } catch {}
        }
      };
    } catch (e) {
      wsClients.delete(port);
      for (const h of wsHooks) {
        try { h({ port, type: 'failed', error: e.message }); } catch {}
      }
      return null;
    }
    return conn;
  }

  /**
   * 通过 WebSocket 发送消息到 canvas
   * @param {number} port
   * @param {object|string} message
   * @param {number} [timeoutMs=3000]
   * @returns {Promise<{ok: boolean, transport?: string, error?: string}>}
   */
  function sendOverWs(port, message, timeoutMs = 3000) {
    return new Promise((resolve) => {
      if (!WebSocketImpl) {
        return resolve({ ok: false, error: 'WebSocket not supported' });
      }
      const conn = ensureWs(port);
      if (!conn) {
        return resolve({ ok: false, error: 'ws init failed' });
      }
      const data = typeof message === 'string' ? message : JSON.stringify(message);
      if (conn.ready && conn.ws.readyState === 1) {
        try {
          conn.ws.send(data);
          return resolve({ ok: true, transport: 'ws' });
        } catch (e) {
          return resolve({ ok: false, error: e.message });
        }
      }
      // 未就绪 → 排队 (但有上限避免堆积)
      if (conn.queue.length >= 256) {
        return resolve({ ok: false, error: 'ws queue full' });
      }
      const timer = setTimeout(() => {
        const idx = conn.queue.findIndex((it) => it._timer === timer);
        if (idx >= 0) conn.queue.splice(idx, 1);
        resolve({ ok: false, error: 'ws queue timeout', transport: 'ws-queue-timeout' });
      }, timeoutMs);
      conn.queue.push({ message: data, resolve: (r) => { clearTimeout(timer); resolve(r); }, _timer: timer });
    });
  }

  function closeWs(port) {
    const conn = wsClients.get(port);
    if (!conn) return;
    try { conn.ws.close(); } catch {}
    wsClients.delete(port);
  }

  /**
   * 标记 port 为 ws 禁用 (测试用)
   * 后续 sendOverWs 将立即返回失败, 让调用方走 HTTP fallback
   * @param {number} port
   */
  function disableWs(port) {
    let conn = wsClients.get(port);
    if (!conn) {
      conn = { ws: null, ready: false, alive: false, queue: [], retryCount: 0, disabled: true };
      wsClients.set(port, conn);
    } else {
      try { conn.ws.close(); } catch {}
      conn.disabled = true;
      conn.ready = false;
    }
  }

  function isWsReady(port) {
    const conn = wsClients.get(port);
    return !!(conn && conn.ready && conn.ws.readyState === 1);
  }

  // ────────────────────────────────────────────
  // 通用 canvas HTTP POST (降级路径, 或大块数据专用)
  // 注意: 参数 sendToCanvasRaw 是 deps 注入的, 这里只用别名 httpPost 引用
  // ────────────────────────────────────────────
  const httpPost = sendToCanvasRaw;

  /**
   * 通用发送 — ws 优先, ws 不可用时降级 HTTP
   * @param {number} port
   * @param {string} path   - HTTP 路径 (降级用, ws 不需要)
   * @param {object|string} payload
   * @param {number} [timeoutMs=5000]
   */
  async function sendToCanvas(port, path, payload, timeoutMs = 5000) {
    // 高频 action 类: ws 优先 (1 次往返,无 HTTP 头开销)
    const r = await sendOverWs(port, payload, Math.min(timeoutMs, 3000));
    if (r.ok) return { ok: true, transport: r.transport };
    // ws 失败 → HTTP 降级
    const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
    const h = await httpPost(port, path, data, timeoutMs);
    if (h.status === 200) {
      try { return { ok: true, transport: 'http', body: JSON.parse(h.body) }; }
      catch { return { ok: true, transport: 'http', body: h.body }; }
    }
    return { ok: false, error: h.error || `http ${h.status}`, transport: 'http-failed' };
  }

  // ────────────────────────────────────────────
  // 启动画布
  // ────────────────────────────────────────────
  async function startCanvas(sessionId, width, height) {
    if (canvasSessions.has(sessionId)) {
      const existing = canvasSessions.get(sessionId);
      if (existing.process && !existing.process.killed) {
        cancelIdleDestroy();
        const { process, ...serializable } = existing;
        return { ok: true, session: serializable, reused: true };
      }
      canvasSessions.delete(sessionId);
    }
    // s4: 如果同一 sessionId 还在 pendingStarts (上一轮 start 没完成), 拒绝重入
    //   避免双 start 并发导致端口冲突 / 子进程泄漏
    if (pendingStarts.has(sessionId)) {
      return { ok: false, error: 'start already in progress for this session', code: 'START_BUSY' };
    }
    // s4 / 2026-06-28 修复: 必须在第一个 await 之前登记 pendingStarts
    //   否则 stop 可能在 _findFreePort() 期间到达, 找不到 session, 留下孤儿
    const pendingEntry = { child: null, aborted: false };
    pendingStarts.set(sessionId, pendingEntry);
    const isAborted = () => pendingEntry.aborted || !pendingStarts.has(sessionId);

    const fs = require('fs');
    const exe = resolveCanvasExePath();
    if (!fs.existsSync(exe)) {
      pendingStarts.delete(sessionId);
      return { ok: false, error: `canvas_preview.exe not found at ${exe}` };
    }

    let host;
    try {
      host = ensureCanvasHost();
    } catch (e) {
      pendingStarts.delete(sessionId);
      return { ok: false, error: `failed to create canvas host: ${e.message}` };
    }
    cancelIdleDestroy();
    const hostHwnd = host.getNativeWindowHandle().readInt32LE(0);
    const exeDir = require('path').dirname(exe);
    const modelsDir = resolveModelsDir();

    // 端口分配是第一个 await — 期间 stop 仍能通过 pendingStarts 找到并 abort
    const port = await _findFreePort();
    if (isAborted()) {
      // stop 已经 abort 了, 端口已经分配但无人认领, 让 OS 回收
      return { ok: false, error: 'start aborted by stop', aborted: true };
    }

    const child = spawnFn(exe, [
      `--port=${port}`,
      `--parent-hwnd=${hostHwnd}`,
      `--canvas-width=${width}`,
      `--canvas-height=${height}`,
      `--models-dir=${modelsDir}`,
    ], {
      cwd: exeDir,
      env: (() => { const e = { ...process.env }; delete e.ELECTRON_RUN_AS_NODE; delete e.ELECTRON_NO_ATTACH_CONSOLE; return e; })(),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    // spawn 完立刻把 child 引用挂到 pendingEntry, stop kill 时能找到
    pendingEntry.child = child;

    child.stdout?.on('data', (d) => console.log(`${logPrefix}:${sessionId}`, d.toString().trim()));
    child.stderr?.on('data', (d) => console.error(`${logPrefix}:${sessionId}:err`, d.toString().trim()));

    // s3.4 修复 #3 + #9: 一次性监听 + 异常退出通知 renderer
    child.once('exit', (code, signal) => {
      console.log(`${logPrefix}:${sessionId} exited code=${code} signal=${signal}`);
      const wasInMap = canvasSessions.has(sessionId);
      const wasPending = pendingStarts.has(sessionId);
      canvasSessions.delete(sessionId);
      sessionPortMap.delete(sessionId);
      // s4 / 2026-06-28 修复: 不要再 delete pendingStarts!
      //   之前这里 delete, 但 start 流程可能还在 await (e.g. _findFreePort / waitForPort / findWindowByPid)
      //   start 流程的 isAborted() 检查 !pendingStarts.has(sessionId), 会被误判为 'start aborted by stop'
      //   即使 child 是因为启动失败立即 exit (例如 mock canvas 启动失败 / Flutter 编译错误),
      //     也会被错误归因到 stop, 错误提示 'start aborted by stop'
      //   修复: pendingStarts 删只能由 start 流程自己负责 (成功 / 失败 / 异常)
      //   closeWs 仍要调: 否则 ws 客户端会无限重连, 表现就是 '画布关闭后 ws 卡死'
      closeWs(port);
      if (canvasSessions.size === 0) {
        scheduleIdleDestroy();
      }
      const unexpected = (wasInMap || wasPending) && signal !== 'SIGTERM' && code !== 0;
      if (unexpected) {
        const payload = { sessionId, code, signal, unexpected: true };
        const mainWin = getMainWindow();
        if (mainWin && !mainWin.isDestroyed()) {
          try {
            mainWin.webContents.send('canvas:crashed', payload);
          } catch (e) {
            console.warn(`${logPrefix}:${sessionId} failed to send crash notification:`, e?.message);
          }
        }
        // 测试 / 诊断 hook — 在 IPC send 不通的情况下也能捕获
        for (const hook of crashHooks) {
          try { hook(payload); } catch {}
        }
      }
    });

    // 等待端口 ready
    const ready = await _waitForPort(port, 10_000);
    if (isAborted()) {
      // s4: stop 触发了 abort, 不再继续往下走
      return { ok: false, error: 'start aborted by stop', aborted: true };
    }
    if (!ready) {
      killProcessTree(child);  // s5: 杀整棵进程树
      pendingStarts.delete(sessionId);
      return { ok: false, error: `canvas WebSocket did not start on port ${port}` };
    }

    // 找窗口 HWND (轮询最多 12s)
    let hwnd = 0;
    const pid = child.pid;
    for (let i = 0; i < 60 && hwnd === 0; i++) {
      if (isAborted()) return { ok: false, error: 'start aborted by stop', aborted: true };
      hwnd = await findWindowByPid(pid);
      if (hwnd === 0) await new Promise((r) => setTimeout(r, 200));
    }
    if (isAborted()) return { ok: false, error: 'start aborted by stop', aborted: true };
    if (hwnd === 0) {
      killProcessTree(child);  // s5: 杀整棵进程树
      pendingStarts.delete(sessionId);
      return { ok: false, error: `canvas window HWND not found for pid ${pid}` };
    }

    try {
      await moveWindow(hwnd, 0, 0, hostBounds.width, hostBounds.height);
    } catch (e) {
      console.warn(`${logPrefix} moveWindow failed:`, e?.message);
    }
    if (isAborted()) return { ok: false, error: 'start aborted by stop', aborted: true };

    let embedStatus = { ok: false, attempted: 0, succeeded: 0, retried: 0, error: 'not attempted' };
    try {
      embedStatus = await embedWindowWithRetry(
        hwnd, hostHwnd, 0, 0, hostBounds.width, hostBounds.height,
        { maxRetries: 1 }
      );
    } catch (e) {
      embedStatus = { ok: false, attempted: 0, succeeded: 0, retried: 0, error: e?.message || String(e) };
    }
    if (isAborted()) return { ok: false, error: 'start aborted by stop', aborted: true };

    const session = {
      sessionId, pid, port, hwnd, width, height,
      embedStatus,
    };
    // s4: 注册到 canvasSessions 之前再次确认没被 abort (cover await 期间 race)
    if (isAborted()) return { ok: false, error: 'start aborted by stop', aborted: true };
    canvasSessions.set(sessionId, { ...session, process: child });
    sessionPortMap.set(sessionId, port);
    pendingStarts.delete(sessionId);
    // 启动 ws 长连接 (lazy, 不阻塞返回)
    if (WebSocketImpl) {
      try { ensureWs(port); } catch (e) {
        console.warn(`${logPrefix}:${sessionId} ensureWs failed:`, e?.message);
      }
    }
    return { ok: true, session, reused: false };
  }

  async function resizeCanvas(sessionId, width, height) {
    const s = canvasSessions.get(sessionId);
    if (!s) return { ok: false, error: 'session not found' };
    s.width = width;
    s.height = height;
    return moveWindow(s.hwnd, 0, 0, width, height);
  }

  // ────────────────────────────────────────────
  // s5 / 2026-06-28: Windows 进程树强制 kill
  //   问题: Node child_process.kill() 在 Windows 上只调 TerminateProcess 杀主进程
  //         不杀子进程 (GPU worker / 派生进程), 表现为"关闭后进程不退出"
  //   修复: Windows 用 `taskkill /pid <pid> /T /F` 杀整棵进程树 (T=tree, F=force)
  //         POSIX 用 process group kill (negative pid) 杀整组
  // ────────────────────────────────────────────
  function killProcessTree(child) {
    if (!child || child.killed) return;
    const pid = child.pid;
    if (!pid) {
      try { child.kill(); } catch {}
      return;
    }
    if (process.platform === 'win32') {
      // taskkill /T /F 杀整棵进程树
      try {
        require('child_process').spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
        });
      } catch (e) {
        // taskkill 失败 fallback: 调 child.kill() (TerminateProcess)
        try { child.kill(); } catch {}
      }
    } else {
      // POSIX: 用 process group kill (negative pid) 杀整组
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        try { child.kill('SIGKILL'); } catch {}
      }
    }
  }

  async function stopCanvas(sessionId) {
    // s4 / 2026-06-28 修复: 先检查 pendingStarts, 避免 start/stop race 留下孤儿进程
    //   场景: start 正在跑 (200-500ms 启动中), 用户立刻点 stop
    //   之前: canvasSessions 没这个 session → 返回 notFound, 但 start 会继续完成 → 孤儿进程
    //   现在: pendingStarts 找到 → kill 子进程 + 标记 aborted, start 后续检测后提前返回
    const pending = pendingStarts.get(sessionId);
    if (pending) {
      pending.aborted = true;
      pendingStarts.delete(sessionId);
      if (pending.child && !pending.child.killed) {
        killProcessTree(pending.child);  // s5: 用 taskkill /T /F 杀整棵进程树
        setTimeout(() => {
          if (pending.child && !pending.child.killed) killProcessTree(pending.child);
        }, 3000);
      }
      return { ok: true, aborted: true };
    }
    const s = canvasSessions.get(sessionId);
    if (!s) return { ok: true, notFound: true };
    if (s.process && !s.process.killed) {
      killProcessTree(s.process);  // s5: 用 taskkill /T /F 杀整棵进程树
      setTimeout(() => {
        if (s.process && !s.process.killed) killProcessTree(s.process);
      }, 3000);
    }
    if (s.port != null) closeWs(s.port);
    sessionPortMap.delete(sessionId);
    canvasSessions.delete(sessionId);
    if (canvasSessions.size === 0) {
      scheduleIdleDestroy();
    }
    return { ok: true };
  }

  async function pushCanvasDSL(sessionId, dsl) {
    const s = canvasSessions.get(sessionId);
    if (!s) return { ok: false, error: 'session not found' };
    let payload;
    if (dsl && (dsl.ui || dsl.root)) {
      payload = JSON.stringify({ type: 'render', ...dsl });
    } else {
      payload = JSON.stringify({ type: 'render', ui: dsl });
    }
    return sendToCanvas(s.port, '/render', payload, 5000);
  }

  async function transformDevice(sessionId, deviceId, transform) {
    const s = canvasSessions.get(sessionId);
    if (!s) return { ok: false, error: 'session not found' };
    return sendToCanvas(s.port, '/transform', {
      action: 'transformDevice', sessionId, deviceId, transform,
    }, 2000);
  }

  async function pushUIToCanvas(sessionId, dsl, deviceId) {
    const s = canvasSessions.get(sessionId);
    if (!s) return { ok: false, error: 'session not found' };
    return sendToCanvas(s.port, '/push-ui', {
      action: 'pushUI', sessionId, dsl, deviceId: deviceId || null,
    });
  }

  async function clearCanvasDevices(sessionId) {
    const s = canvasSessions.get(sessionId);
    if (!s) return { ok: false, error: 'session not found' };
    return sendToCanvas(s.port, '/clear-devices', {
      action: 'clearDevices', sessionId,
    });
  }

  async function setCanvasBackground(sessionId, color) {
    const s = canvasSessions.get(sessionId);
    if (!s) return { ok: false, error: 'session not found' };
    return sendToCanvas(s.port, '/set-background', {
      action: 'setBackground', sessionId, color,
    });
  }

  async function screenshotCanvas(sessionId) {
    const s = canvasSessions.get(sessionId);
    if (!s) return { ok: false, error: 'session not found' };
    try {
      const r = await sendToCanvasRaw(s.port, '/screenshot', null, 5000);
      if (r.status !== 200) {
        return { ok: false, error: `screenshot failed: HTTP ${r.status} body=${r.body?.slice(0, 200)}` };
      }
      const parsed = JSON.parse(r.body);
      if (!parsed.ok || !parsed.png) {
        return { ok: false, error: parsed.error || 'no png in response' };
      }
      return {
        ok: true,
        dataUrl: `data:image/png;base64,${parsed.png}`,
        width: parsed.width,
        height: parsed.height,
        byteLength: parsed.byteLength,
        timestamp: parsed.timestamp,
      };
    } catch (e) {
      return { ok: false, error: e?.message || String(e) };
    }
  }

  // ────────────────────────────────────────────
  // IPC handlers 注册
  // ────────────────────────────────────────────
  function registerIpc() {
    ipcMain.handle('canvas:start', async (_e, { sessionId, width, height }) => {
      return startCanvas(sessionId, width || 800, height || 600);
    });
    ipcMain.handle('canvas:resize', async (_e, { sessionId, width, height }) => {
      return resizeCanvas(sessionId, width, height);
    });
    ipcMain.handle('canvas:stop', async (_e, { sessionId }) => {
      return stopCanvas(sessionId);
    });
    ipcMain.handle('canvas:push', async (_e, { sessionId, dsl }) => {
      return pushCanvasDSL(sessionId, dsl);
    });
    ipcMain.handle('canvas:transform-device', async (_e, { sessionId, deviceId, transform }) => {
      return transformDevice(sessionId, deviceId, transform);
    });
    ipcMain.handle('canvas:push-ui', async (_e, { sessionId, dsl, deviceId }) => {
      return pushUIToCanvas(sessionId, dsl, deviceId);
    });
    ipcMain.handle('canvas:clear-devices', async (_e, { sessionId }) => {
      return clearCanvasDevices(sessionId);
    });
    ipcMain.handle('canvas:set-background', async (_e, { sessionId, color }) => {
      return setCanvasBackground(sessionId, color);
    });
    ipcMain.handle('canvas:screenshot', async (_e, { sessionId }) => {
      return screenshotCanvas(sessionId);
    });
    ipcMain.handle('canvas:status', async (_e, { sessionId }) => {
      const s = canvasSessions.get(sessionId);
      const info = s
        ? {
            sessionId: s.sessionId, pid: s.pid, port: s.port, hwnd: s.hwnd,
            width: s.width, height: s.height, embedStatus: s.embedStatus,
            wsReady: s.port != null && isWsReady(s.port),
          }
        : null;
      return { ok: true, active: !!s, info };
    });
    ipcMain.handle('canvas:ws-status', async () => {
      /** @type {Array<{port: number, ready: boolean, alive: boolean, retryCount: number, queueLen: number, readyState: number}>} */
      const list = [];
      for (const [port, conn] of wsClients) {
        list.push({
          port,
          ready: conn.ready,
          alive: conn.alive,
          retryCount: conn.retryCount,
          queueLen: conn.queue.length,
          readyState: conn.ws?.readyState ?? -1,
        });
      }
      return { ok: true, wsClients: list, transport: 'ws-primary-with-http-fallback' };
    });
    ipcMain.handle('canvas:get-device-config', async () => {
      const config = readDeviceConfig();
      return { ok: true, config, modelsDir: resolveModelsDir() };
    });
    ipcMain.handle('canvas:list-models', async () => {
      return { ok: true, models: listAvailableModels() };
    });
    ipcMain.handle('canvas:report-bounds', async (_e, bounds) => {
      try {
        if (!bounds) return { ok: false, error: 'bounds missing' };
        hostBounds = bounds;
        positionCanvasHost(bounds);
        for (const [, s] of canvasSessions) {
          if (s.hwnd && s.process && !s.process.killed) {
            try { await moveWindow(s.hwnd, 0, 0, bounds.width, bounds.height); } catch {}
          }
        }
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e?.message || String(e) };
      }
    });
    ipcMain.handle('canvas:host-info', async () => ({
      ok: true,
      created: !!(canvasHostWindow && !canvasHostWindow.isDestroyed()),
      bounds: { ...hostBounds },
    }));
    ipcMain.handle('canvas:ensure-host', async () => {
      try {
        const host = ensureCanvasHost();
        cancelIdleDestroy();
        const hwnd = host.getNativeWindowHandle().readInt32LE(0);
        return { ok: true, created: true, hwnd, bounds: { ...hostBounds } };
      } catch (e) {
        return { ok: false, error: e?.message || String(e) };
      }
    });
    ipcMain.handle('canvas:embed-status', async (_e, payload) => {
      const sid = payload?.sessionId;
      if (!sid) return { ok: false, error: 'sessionId required' };
      const s = canvasSessions.get(sid);
      if (!s) return { ok: false, error: 'session not found', sessionId: sid };
      return {
        ok: true,
        sessionId: sid,
        embedded: s.embedStatus?.ok === true,
        embedStatus: s.embedStatus,
        hwnd: s.hwnd,
        pid: s.pid,
        width: s.width,
        height: s.height,
      };
    });
  }

  // ────────────────────────────────────────────
  // graceful shutdown (供 app.on('before-quit') 调用)
  // ────────────────────────────────────────────
  function beforeQuit() {
    for (const [port] of wsClients) {
      try { closeWs(port); } catch {}
    }
    for (const [sid, s] of canvasSessions) {
      if (s.process && !s.process.killed) {
        killProcessTree(s.process);  // s5: 杀整棵进程树
      }
    }
  }

  function getHostBounds() {
    return { ...hostBounds };
  }

  function setHostBounds(b) {
    hostBounds = b;
  }

  return {
    // 公开 API
    registerIpc,
    startCanvas,
    stopCanvas,
    resizeCanvas,
    pushCanvasDSL,
    pushUIToCanvas,
    transformDevice,
    clearCanvasDevices,
    setCanvasBackground,
    screenshotCanvas,
    ensureCanvasHost,
    positionCanvasHost,
    beforeQuit,
    getHostBounds,
    setHostBounds,
    cancelIdleDestroy,
    scheduleIdleDestroy,
    // 测试 / 诊断 hook: 子进程异常退出时调用 (与 IPC 'canvas:crashed' 同步)
    onCrash: (callback) => {
      crashHooks.add(callback);
      return () => crashHooks.delete(callback);
    },
    // 测试 / 诊断 hook: ws 状态变化 (open/close/error/message/failed)
    onWs: (callback) => {
      wsHooks.add(callback);
      return () => wsHooks.delete(callback);
    },
    // 给测试用的内部状态
    _internal: {
      canvasSessions,
      pendingStarts,
      getCanvasHostWindow: () => canvasHostWindow,
      idleDestroyMs,
      getWsClients: () => wsClients,
      getSessionPortMap: () => sessionPortMap,
    },
    // 直接调用 (测试用, 一般不要绕过 sendToCanvas)
    _testOnly: {
      ensureWs,
      sendOverWs,
      sendToCanvasRaw,
      isWsReady,
      closeWs,
      disableWs,
    },
  };
}

module.exports = { createCanvasManager };