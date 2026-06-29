// ─────────────────────────────────────────────────────────────────
// SoloForge 画布生命周期 — Electron 真实环境集成测试
//
// 目的: 验证画布 IPC 在真实 Electron 主进程里工作正常
//
//   之前 tests/canvas-lifecycle.mjs 只跑了纯 Node 静态检查,
//   没有经过 ipcMain.handle / BrowserWindow / spawn 这些 Electron API
//
// 跑法:
//   cd SoloForge   (项目根目录, 不是 UI/)
//   npx electron tests/electron-canvas-test.cjs
//
// 退出码: 0 = 全部通过, 1 = 有失败
// ─────────────────────────────────────────────────────────────────

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const net = require('net');
const { spawn } = require('child_process');

// ── 同步日志 ──
const LOG_DIR = path.join(__dirname, '..', 'logs', 'e2e');
fs.mkdirSync(LOG_DIR, { recursive: true });
const LOG_FILE = path.join(LOG_DIR, 'canvas-electron-test.log');
try { fs.unlinkSync(LOG_FILE); } catch {}
const PASS = [];
const FAIL = [];
const LOG_LINES = [];
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  LOG_LINES.push(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch {}
  try { process.stdout.write(line + '\n'); } catch {}
}
function assert(cond, msg) {
  if (cond) {
    PASS.push(msg);
    log(`  \x1b[32m✓\x1b[0m ${msg}`);
  } else {
    FAIL.push(msg);
    log(`  \x1b[31m✗\x1b[0m ${msg}`);
  }
}
function section(name) {
  log('');
  log(`══ ${name} ══`);
}

// ── 加载 Electron (必须在 app ready 之前) ──
let electron;
try {
  electron = require('electron');
} catch (e) {
  log('FATAL: require(electron) failed: ' + e.message);
  process.exit(2);
}
if (typeof electron === 'string') {
  log('FATAL: must run via `electron`, not `node`');
  log('  run: npx electron tests/electron-canvas-test.cjs');
  process.exit(2);
}
const { app, BrowserWindow, ipcMain } = electron;

const { createCanvasManager } = require(path.join(__dirname, '..', 'UI', 'electron', 'canvasHost.cjs'));

// ─────────────────────────────────────────────────────────────────
// Mock canvas HTTP server
//
// 设计要点:
//   1. mock canvas 是被 spawn 出去的子进程, 不是 test 进程内的 server
//   2. 子进程通过 --port=N 拿到要监听的端口
//   3. 子进程的所有接收请求都写到 stdout (前缀 'MOCK_RECV:'),
//      test 进程通过子进程的 stdout 收集这些事件
//   4. 还有一个 /stats 接口, 可以拉取所有历史请求 (更可靠)
// ─────────────────────────────────────────────────────────────────
function startMockCanvas() {
  // 不再启动 in-process server — mock canvas 就是 spawn 出去的子进程
  return { server: null, port: 0, state: { receivedActions: [] } };
}

// 写入一个 mock canvas 脚本 (Node.js), 让 spawn 它会监听 spawn 时指定的 --port
function makeMockCanvasScript() {
  const script = `
const http = require('http');
const crypto = require('crypto');
// 从 argv 解析 --port=N, 与真实 canvas_preview.exe 行为一致
const portArg = process.argv.find(a => a.startsWith('--port='));
const port = portArg ? parseInt(portArg.split('=')[1], 10) : 0;
if (!port) { console.error('[mock-canvas] missing --port=N'); process.exit(2); }

const actionLog = [];
const wsConnections = [];
const log = (msg) => { try { process.stdout.write('[mock-canvas] ' + msg + '\\n'); } catch {} };

function recordAction(entry) {
  actionLog.push({ ...entry, t: Date.now(), transport: entry.transport || 'http' });
  log('RECV ' + (entry.transport || 'http') + ' ' + (entry.method || 'WS') + ' ' + entry.url);
}

// 简易 WebSocket server (RFC6455 最小实现, 用于测试)
// 支持 text/binary frame, 不需要 perf
function handleWebSocketUpgrade(req, socket, head) {
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }
  const accept = crypto
    .createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');
  const headers = [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    'Sec-WebSocket-Accept: ' + accept,
    '', '',
  ].join('\\r\\n');
  socket.write(headers);

  const conn = {
    id: wsConnections.length + 1,
    buffer: Buffer.alloc(0),
    alive: true,
  };
  wsConnections.push(conn);
  log('WS upgrade ok, conn#' + conn.id);

  socket.on('data', (chunk) => {
    conn.buffer = Buffer.concat([conn.buffer, chunk]);
    while (conn.buffer.length >= 2) {
      const b1 = conn.buffer[0];
      const b2 = conn.buffer[1];
      const fin = (b1 & 0x80) !== 0;
      const opcode = b1 & 0x0f;
      const masked = (b2 & 0x80) !== 0;
      let len = b2 & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (conn.buffer.length < 4) return;
        len = conn.buffer.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (conn.buffer.length < 10) return;
        len = Number(conn.buffer.readBigUInt64BE(2));
        offset = 10;
      }
      // RFC 6455 §5.3: client→server frames MUST be masked
      let maskKey = null;
      if (masked) {
        if (conn.buffer.length < offset + 4) return;
        maskKey = conn.buffer.slice(offset, offset + 4);
        offset += 4;
      }
      if (conn.buffer.length < offset + len) return;
      let payload = conn.buffer.slice(offset, offset + len);
      if (masked && maskKey) {
        // XOR unmask
        const unmasked = Buffer.alloc(len);
        for (let i = 0; i < len; i++) {
          unmasked[i] = payload[i] ^ maskKey[i % 4];
        }
        payload = unmasked;
      }
      conn.buffer = conn.buffer.slice(offset + len);
      if (opcode === 0x1) {
        const text = payload.toString('utf8');
        let parsed = {};
        try { parsed = JSON.parse(text); } catch {}
        const action = parsed.action || parsed.type || 'unknown';
        const route = '/ws/' + action;
        // 调试: 偶发 raw 消息打印 (前 5 条)
        if (wsConnections.length === 1 && conn.msgCount === undefined) conn.msgCount = 0;
        if (conn.msgCount < 3) {
          log('WS raw: ' + text.slice(0, 200));
          conn.msgCount = (conn.msgCount || 0) + 1;
        }
        recordAction({ url: route, method: 'WS', body: parsed, transport: 'ws', connId: conn.id });
        // 回 ack frame (text)
        const ack = JSON.stringify({ ok: true, received: parsed, route, transport: 'ws' });
        sendWsFrame(socket, 0x1, Buffer.from(ack, 'utf8'));
      } else if (opcode === 0x8) {
        conn.alive = false;
        try { socket.end(); } catch {}
        return;
      } else if (opcode === 0x9) {
        sendWsFrame(socket, 0xa, payload); // pong
      }
    }
  });
  socket.on('close', () => { conn.alive = false; log('WS conn#' + conn.id + ' closed'); });
  socket.on('error', () => { conn.alive = false; });
}

function sendWsFrame(socket, opcode, payload) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  try { socket.write(Buffer.concat([header, payload])); } catch {}
}

const server = http.createServer((req, res) => {
  // WebSocket upgrade
  if (req.headers.upgrade && req.headers.upgrade.toLowerCase() === 'websocket') {
    handleWebSocketUpgrade(req, req.socket, Buffer.alloc(0));
    return;
  }
  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    let parsed = {};
    try { parsed = body ? JSON.parse(body) : {}; } catch {}
    recordAction({ url: req.url, method: req.method, body: parsed, transport: 'http' });

    if (req.url === '/stats' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ log: actionLog, wsConnections: wsConnections.length }));
      return;
    }
    if (req.url === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, mockCanvas: true, port, wsConnections: wsConnections.length }));
      return;
    }
    const businessPaths = [
      '/render', '/push-ui', '/transform', '/clear-devices',
      '/set-background', '/screenshot',
    ];
    if (businessPaths.some((p) => req.url === p)) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (req.url === '/screenshot') {
        res.end(JSON.stringify({
          ok: true,
          png: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
          width: 1, height: 1, byteLength: 70, timestamp: Date.now(),
        }));
      } else {
        res.end(JSON.stringify({ ok: true, received: parsed, route: req.url }));
      }
      return;
    }
    res.writeHead(404);
    res.end(JSON.stringify({ error: 'mock 404', route: req.url }));
  });
});
server.listen(port, '127.0.0.1', () => {
  log('listening on ' + port);
});
process.on('SIGTERM', () => {
  log('SIGTERM received, closing server');
  server.close(() => process.exit(0));
});
process.on('SIGKILL', () => process.exit(137));
`;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'soloforge-mock-canvas-'));
  const scriptPath = path.join(tmpDir, 'mock-canvas.js');
  fs.writeFileSync(scriptPath, script);
  return { scriptPath, tmpDir };
}

// 从子进程的 /stats 拉取 received actions
function getCanvasStats(port) {
  return new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1', port, path: '/stats', method: 'GET', timeout: 1500,
    }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => {
        try { resolve(JSON.parse(buf)); } catch { resolve({ log: [] }); }
      });
    });
    req.on('error', () => resolve({ log: [] }));
    req.on('timeout', () => { req.destroy(); resolve({ log: [] }); });
    req.end();
  });
}

// ─────────────────────────────────────────────────────────────────
// 主测试流程
// ─────────────────────────────────────────────────────────────────
async function runTests() {
  log('');
  log('╔══════════════════════════════════════════════╗');
  log('║  SoloForge 画布生命周期 — Electron 集成测试  ║');
  log('╚══════════════════════════════════════════════╝');
  log(`electron: ${process.versions.electron}`);
  log(`node: ${process.versions.node}`);
  log(`chrome: ${process.versions.chrome}`);

  // ── 准备 mock canvas (作为 spawn 子进程) ──
  section('0. 准备 mock canvas');
  const mockCanvas = await startMockCanvas();
  const { scriptPath, tmpDir } = makeMockCanvasScript();
  log(`  mock canvas script: ${scriptPath}`);

  // ── 浏览器宿主 ──
  log('  创建 main window...');
  const mainWindow = new BrowserWindow({
    show: false,
    width: 800,
    height: 600,
    webPreferences: {
      preload: path.join(__dirname, '..', 'UI', 'electron', 'preload.cjs'),
      contextIsolation: true,
      sandbox: false,
    },
  });
  // 不等 webContents 'did-finish-load', 直接 proceed
  mainWindow.loadURL('data:text/html,<html><body>test</body></html>');
  log(`  main window created (id=${mainWindow.id})`);

  // ── Canvas 管理器 (用 mock 依赖) ──
  let mockHwnd = 0xCAFE01;
  const moveWindowCalls = [];
  const embedCalls = [];
  const findHwndCalls = [];
  const spawnedProcs = [];  // 用于清理

  const mockDeps = {
    app, BrowserWindow, ipcMain,
    getMainWindow: () => mainWindow,
    resolveCanvasExePath: () => scriptPath,
    resolveCanvasDataDir: () => tmpDir,
    resolveModelsDir: () => tmpDir,
    readDeviceConfig: () => ({ models: [] }),
    listAvailableModels: () => [],
    moveWindow: async (hwnd, x, y, w, h) => {
      moveWindowCalls.push({ hwnd, x, y, w, h });
      return { ok: true };
    },
    embedWindowWithRetry: async (flutterHwnd, parentHwnd, x, y, w, h) => {
      embedCalls.push({ flutterHwnd, parentHwnd });
      return { ok: true, attempted: 1, succeeded: 1, retried: 0 };
    },
    findWindowByPid: async (pid) => {
      findHwndCalls.push(pid);
      return mockHwnd;
    },
    sendToCanvasRaw: (port, p, body, timeoutMs) => new Promise((resolve, reject) => {
      const data = body ? JSON.stringify(body) : '';
      const req = http.request({
        host: '127.0.0.1', port, path: p, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
        timeout: timeoutMs || 3000,
      }, (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => resolve({ status: res.statusCode, body: buf }));
      });
      req.on('error', reject);
      if (data) req.write(data);
      req.end();
    }),
    spawn: (exe, args, opts) => {
      // 用 ELECTRON_RUN_AS_NODE=1 让 Electron 退化为 Node, 才能跑我们的 mock JS 脚本
      // (否则 Electron 把它当成 Electron app 启动, 报 isolate_data->snapshot_data() crash)
      // 把 mock canvas 脚本作为第一个参数, 后面跟真实 canvas 会用的所有 args (--port= --parent-hwnd= 等)
      const child = spawn(process.execPath, [exe, ...args], {
        ...opts,
        env: {
          ...(opts?.env || process.env),
          ELECTRON_RUN_AS_NODE: '1',
        },
      });
      spawnedProcs.push(child);
      return child;
    },
    logPrefix: '[test-canvas]',
    idleDestroyMs: 1000,
  };

  const canvas = createCanvasManager(mockDeps);
  canvas.registerIpc();

  log(`  canvas manager registered IPC handlers`);
  log(`  _invokeHandlers size after register: ${ipcMain._invokeHandlers?.size || 'N/A'}`);

  // 通过 ipcMain._invokeHandlers 直接 invoke (绕过 renderer, 走真实 ipcMain 链路)
  function invoke(channel, ...args) {
    const handler = ipcMain._invokeHandlers?.get(channel);
    if (!handler) throw new Error(`no handler for ${channel}`);
    const fakeEvent = { sender: mainWindow.webContents };
    return Promise.resolve(handler(fakeEvent, ...args));
  }

  // ─────────────────────────────────────────────────────────────────
  // 1. IPC 注册验证
  // ─────────────────────────────────────────────────────────────────
  section('1. ipcMain.handle 真实注册');
  const handlerNames = [
    'canvas:start', 'canvas:stop', 'canvas:status',
    'canvas:resize', 'canvas:push', 'canvas:push-ui',
    'canvas:transform-device', 'canvas:clear-devices',
    'canvas:set-background', 'canvas:screenshot',
    'canvas:get-device-config', 'canvas:list-models',
    'canvas:report-bounds', 'canvas:host-info',
    'canvas:ensure-host', 'canvas:embed-status',
  ];
  for (const name of handlerNames) {
    const has = ipcMain._invokeHandlers?.has(name);
    assert(has, `ipcMain.handle 注册: ${name}`);
  }

  // ─────────────────────────────────────────────────────────────────
  // 2. 通过 IPC.invoke 真实调用
  // ─────────────────────────────────────────────────────────────────
  section('2. IPC.invoke 真实链路');

  // 2.1 host-info (初始)
  let r = await invoke('canvas:host-info');
  assert(r.ok === true && r.created === false, 'canvas:host-info 初始 created=false');
  assert(r.bounds && typeof r.bounds.width === 'number', 'canvas:host-info 返回 bounds');

  // 2.2 ensure-host
  r = await invoke('canvas:ensure-host');
  assert(r.ok === true && r.created === true, 'canvas:ensure-host 创建宿主窗口');
  assert(typeof r.hwnd === 'number' && r.hwnd > 0, 'canvas:ensure-host 返回 hwnd');

  // 2.3 host-info (已创建)
  r = await invoke('canvas:host-info');
  assert(r.ok === true && r.created === true, 'canvas:host-info 第二次 created=true');

  // 2.4 report-bounds
  r = await invoke('canvas:report-bounds', { x: 0, y: 0, width: 800, height: 600 });
  assert(r.ok === true, 'canvas:report-bounds 接受新 bounds');

  // 2.5 start canvas
  const sid1 = 'test-session-1';
  const t0 = Date.now();
  r = await invoke('canvas:start', { sessionId: sid1, width: 800, height: 600 });
  log(`  startCanvas 耗时: ${Date.now() - t0}ms`);
  log(`  start result: ${JSON.stringify(r)}`);
  assert(r.ok === true, 'canvas:start 成功');
  assert(r.session && r.session.port > 0, 'canvas:start 返回 port');
  assert(r.session.pid > 0, 'canvas:start 返回 pid');
  assert(r.session.hwnd > 0, 'canvas:start 返回 hwnd');
  assert(r.reused === false, '首次 start reused=false');
  const canvasPort1 = r.session.port;  // 保存供后续 stats 查询

  // 2.6 status
  r = await invoke('canvas:status', { sessionId: sid1 });
  assert(r.ok === true && r.active === true, 'canvas:status active=true');
  assert(r.info && r.info.pid > 0, 'canvas:status 返回 info');

  // 2.7 embed-status
  r = await invoke('canvas:embed-status', { sessionId: sid1 });
  assert(r.ok === true, 'canvas:embed-status 返回 ok');
  assert(r.embedded === true, 'canvas:embed-status embedded=true');

  // 2.8 status 错误 sid
  r = await invoke('canvas:status', { sessionId: 'non-existent' });
  assert(r.ok === true && r.active === false, 'canvas:status 错误 sid active=false');

  // 2.9 push
  r = await invoke('canvas:push', { sessionId: sid1, dsl: { ui: { type: 'Column', children: [] } } });
  assert(r.ok === true, 'canvas:push 调用 ok');
  let stats1 = await getCanvasStats(canvasPort1);
  assert(
    stats1.log.some((a) => a.url === '/render' || a.url === '/ws/render' || a.url === '/ws/unknown' /* raw */),
    `canvas:push 触发 mock (子进程收到 ${stats1.log.length} 个请求)`
  );

  // 2.10 push-ui
  r = await invoke('canvas:push-ui', { sessionId: sid1, dsl: { type: 'Text', text: 'Hello' } });
  assert(r.ok === true, 'canvas:push-ui 调用 ok');
  stats1 = await getCanvasStats(canvasPort1);
  assert(
    stats1.log.some((a) => a.url === '/push-ui' || a.url === '/ws/pushUI'),
    'canvas:push-ui 触发 mock (ws 或 http)'
  );

  // 2.11 transform-device
  r = await invoke('canvas:transform-device', { sessionId: sid1, deviceId: 'dev1', transform: { x: 100, y: 200, scale: 1.5 } });
  assert(r.ok === true, 'canvas:transform-device 调用 ok');
  stats1 = await getCanvasStats(canvasPort1);
  assert(
    stats1.log.some((a) => a.url === '/transform' || a.url === '/ws/transformDevice'),
    'canvas:transform-device 触发 mock (ws 或 http)'
  );

  // 2.12 set-background
  r = await invoke('canvas:set-background', { sessionId: sid1, color: '#1a1a1a' });
  assert(r.ok === true, 'canvas:set-background 调用 ok');
  stats1 = await getCanvasStats(canvasPort1);
  assert(
    stats1.log.some((a) => a.url === '/set-background' || a.url === '/ws/setBackground'),
    'canvas:set-background 触发 mock (ws 或 http)'
  );

  // 2.13 screenshot
  r = await invoke('canvas:screenshot', { sessionId: sid1 });
  assert(r.ok === true && typeof r.dataUrl === 'string' && r.dataUrl.startsWith('data:image/png'), 'canvas:screenshot 返回 PNG dataURL');

  // 2.14 get-device-config
  r = await invoke('canvas:get-device-config');
  assert(r.ok === true && Array.isArray(r.config.models), 'canvas:get-device-config 返回 config');

  // 2.15 list-models
  r = await invoke('canvas:list-models');
  assert(r.ok === true && Array.isArray(r.models), 'canvas:list-models 返回 models');

  // 2.16 resize
  r = await invoke('canvas:resize', { sessionId: sid1, width: 1024, height: 768 });
  assert(r.ok === true, 'canvas:resize 成功');
  assert(moveWindowCalls.length >= 2, `moveWindow 被调用 ${moveWindowCalls.length} 次`);

  // ─────────────────────────────────────────────────────────────────
  // 3. 重复 start (reused 路径)
  // ─────────────────────────────────────────────────────────────────
  section('3. 重复 start (reused 路径)');
  const findCallsBefore = findHwndCalls.length;
  r = await invoke('canvas:start', { sessionId: sid1, width: 800, height: 600 });
  assert(r.ok === true && r.reused === true, '第二次 start 同一 sid → reused=true');
  assert(findHwndCalls.length === findCallsBefore, 'reused 时不重新调用 findWindowByPid');

  // ─────────────────────────────────────────────────────────────────
  // 4. 并发 transform
  // ─────────────────────────────────────────────────────────────────
  section('4. 并发 transform (10 个)');
  const statsBefore = await getCanvasStats(canvasPort1);
  const before = statsBefore.log.filter((a) => a.url === '/transform' || a.url === '/ws/transformDevice').length;
  const promises = Array.from({ length: 10 }, (_, i) =>
    invoke('canvas:transform-device', { sessionId: sid1, deviceId: `dev${i}`, transform: { x: i * 10, y: i * 10 } })
  );
  const results = await Promise.all(promises);
  assert(results.every((r) => r.ok === true), '10 个并发 transform 全部成功');
  const statsAfter = await getCanvasStats(canvasPort1);
  const after = statsAfter.log.filter((a) => a.url === '/transform' || a.url === '/ws/transformDevice').length;
  assert(after - before >= 10, `mock canvas 收到 ≥10 个 transform (实际 +${after - before})`);

  // ─────────────────────────────────────────────────────────────────
  // 5. Stop 流程
  // ─────────────────────────────────────────────────────────────────
  section('5. Stop 流程');
  // 启动第二个 session
  const sid2 = 'test-session-2';
  mockHwnd = 0xCAFE02;  // 不同 hwnd
  r = await invoke('canvas:start', { sessionId: sid2, width: 800, height: 600 });
  assert(r.ok === true, '第二个 session start 成功');
  assert(canvas._internal.canvasSessions.size === 2, `现在 ${canvas._internal.canvasSessions.size} 个 session`);

  r = await invoke('canvas:stop', { sessionId: sid2 });
  assert(r.ok === true, 'canvas:stop sid2 成功');
  assert(canvas._internal.canvasSessions.size === 1, 'canvasSessions.size=1');

  // 等 mock canvas 进程真正退出
  await new Promise((r2) => setTimeout(r2, 500));
  r = await invoke('canvas:status', { sessionId: sid2 });
  assert(r.ok === true && r.active === false, 'stop 后 status active=false');

  // stop 不存在
  r = await invoke('canvas:stop', { sessionId: 'non-existent' });
  assert(r.ok === true && r.notFound === true, 'stop 不存在 → notFound=true');

  // stop sid1
  r = await invoke('canvas:stop', { sessionId: sid1 });
  assert(r.ok === true, 'canvas:stop sid1 成功');
  await new Promise((r2) => setTimeout(r2, 500));
  r = await invoke('canvas:status', { sessionId: sid1 });
  assert(r.ok === true && r.active === false, 'stop sid1 后 active=false');
  assert(canvas._internal.canvasSessions.size === 0, 'canvasSessions 已清空');

  // ─────────────────────────────────────────────────────────────────
  // 6. 异常崩溃 → canvas:crashed IPC 通知
  // ─────────────────────────────────────────────────────────────────
  section('6. 子进程异常退出 → canvas:crashed');
  const sid3 = 'crash-test-session';
  r = await invoke('canvas:start', { sessionId: sid3, width: 800, height: 600 });
  assert(r.ok === true, 'crash test: start 成功');

  // 用 canvas.onCrash() hook 直接捕获 (不依赖 renderer IPC 链路)
  const crashPayload = await new Promise((resolve) => {
    const off = canvas.onCrash((payload) => {
      off();
      resolve(payload);
    });
    setTimeout(() => { off(); resolve(null); }, 3000);

    // 触发异常退出 (非 SIGTERM, code !== 0)
    setTimeout(() => {
      const child = canvas._internal.canvasSessions.get(sid3)?.process;
      if (!child) {
        resolve(null);
        return;
      }
      log(`  手动触发 child exit (code=1 signal=null)`);
      child.emit('exit', 1, null);
    }, 100);
  });
  assert(crashPayload !== null, 'canvas:crashed 事件被触发');
  if (crashPayload) {
    log(`  crash payload: ${JSON.stringify(crashPayload)}`);
    assert(crashPayload.sessionId === sid3, `crash payload sessionId=${crashPayload.sessionId}`);
    assert(crashPayload.code === 1, `crash payload code=${crashPayload.code}`);
    assert(crashPayload.unexpected === true, 'crash payload unexpected=true');
  }
  await new Promise((r2) => setTimeout(r2, 200));
  assert(!canvas._internal.canvasSessions.has(sid3), '崩溃后 session 从 Map 删除');

  // ─────────────────────────────────────────────────────────────────
  // 7. 主动 stop (SIGTERM) 不触发 canvas:crashed
  // ─────────────────────────────────────────────────────────────────
  section('7. 主动 stop (SIGTERM) 不触发 canvas:crashed');
  const sid4 = 'sigterm-test-session';
  r = await invoke('canvas:start', { sessionId: sid4, width: 800, height: 600 });
  assert(r.ok === true, 'sigterm test: start 成功');

  let unexpectedCrashTriggered = false;
  const off4 = canvas.onCrash((payload) => {
    if (payload?.unexpected) unexpectedCrashTriggered = true;
  });

  r = await invoke('canvas:stop', { sessionId: sid4 });
  assert(r.ok === true, 'canvas:stop 成功');
  await new Promise((r2) => setTimeout(r2, 800));
  assert(unexpectedCrashTriggered === false, '主动 stop (SIGTERM) 不触发 canvas:crashed');
  off4();

  // ─────────────────────────────────────────────────────────────────
  // 8. before-quit cleanup
  // ─────────────────────────────────────────────────────────────────
  section('8. before-quit cleanup');
  const sid5 = 'before-quit-test';
  r = await invoke('canvas:start', { sessionId: sid5, width: 800, height: 600 });
  assert(r.ok === true, 'before-quit test: start 成功');
  const canvasPort5 = r.session.port;

  canvas.beforeQuit();
  await new Promise((r2) => setTimeout(r2, 500));
  const afterQuit = await new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1', port: canvasPort5, path: '/health', method: 'GET', timeout: 1000,
    }, (res) => resolve(res.statusCode));
    req.on('error', () => resolve('CONNECTION_REFUSED'));
    req.on('timeout', () => { req.destroy(); resolve('TIMEOUT'); });
    req.end();
  });
  assert(afterQuit === 'CONNECTION_REFUSED' || afterQuit === 'TIMEOUT', `beforeQuit 后无法连 mock canvas (got ${afterQuit})`);

  // ─────────────────────────────────────────────────────────────────
  // 9. WebSocket 传输路径 (高频 /transform + 低频 /push-ui)
  //    验证 canvasHost.cjs 已把 HTTP 替换为 ws 长连接
  // ─────────────────────────────────────────────────────────────────
  section('9. WebSocket 传输路径 (基础连接)');
  const sid9 = 'ws-session-1';
  const t9 = Date.now();
  r = await invoke('canvas:start', { sessionId: sid9, width: 800, height: 600 });
  log(`  startCanvas 耗时: ${Date.now() - t9}ms`);
  assert(r.ok === true, 'ws-test start 成功');
  const wsPort = r.session.port;

  // 等 ws 连接 ready (最多 2s)
  let wsReady = false;
  for (let i = 0; i < 40 && !wsReady; i++) {
    await new Promise((res) => setTimeout(res, 50));
    const wsStatus = await invoke('canvas:ws-status');
    const entry = wsStatus.wsClients.find((c) => c.port === wsPort);
    wsReady = entry && entry.ready === true && entry.alive === true;
  }
  assert(wsReady, 'ws 客户端 ready (canvas /ws upgrade 成功)');

  // 9.1 通过 ws 推 pushUI
  r = await invoke('canvas:push-ui', {
    sessionId: sid9, dsl: { type: 'text', value: 'ws-push-test' }, deviceId: 'd-ws-1',
  });
  assert(r.ok === true && r.transport === 'ws', 'canvas:push-ui 走 ws 传输');

  // 9.2 通过 ws 触发 transformDevice
  r = await invoke('canvas:transform-device', {
    sessionId: sid9, deviceId: 'd-ws-1',
    transform: { xRatio: 0.3, yRatio: 0.7, rotationX: 0, rotationY: 0, rotationZ: 0, displayScale: 1 },
  });
  assert(r.ok === true && r.transport === 'ws', 'canvas:transform-device 走 ws 传输');

  // 9.3 通过 ws 触发 setBackground
  r = await invoke('canvas:set-background', { sessionId: sid9, color: '#abcdef' });
  assert(r.ok === true && r.transport === 'ws', 'canvas:set-background 走 ws 传输');

  // 9.4 通过 ws 触发 clearDevices
  r = await invoke('canvas:clear-devices', { sessionId: sid9 });
  assert(r.ok === true && r.transport === 'ws', 'canvas:clear-devices 走 ws 传输');

  // 9.5 mock canvas 收到 ws 消息 (查 /stats)
  await new Promise((res) => setTimeout(res, 100));
  const stats9 = await getCanvasStats(wsPort);
  const wsEntries = stats9.log.filter((e) => e.transport === 'ws');
  const wsUrls = wsEntries.map((e) => e.url);
  assert(wsEntries.length >= 4, `mock canvas 收到 ≥4 条 ws 消息 (实际 ${wsEntries.length})`);
  assert(wsUrls.some((u) => u.includes('pushUI')), 'ws 收到 pushUI action');
  assert(wsUrls.some((u) => u.includes('transformDevice')), 'ws 收到 transformDevice action');
  assert(wsUrls.some((u) => u.includes('setBackground')), 'ws 收到 setBackground action');
  assert(wsUrls.some((u) => u.includes('clearDevices')), 'ws 收到 clearDevices action');

  // ─────────────────────────────────────────────────────────────────
  // 10. WebSocket 高频并发 (50 个 transform)
  // ─────────────────────────────────────────────────────────────────
  section('10. WebSocket 高频 transform (50 个并发)');
  const sid10 = 'ws-session-2';
  r = await invoke('canvas:start', { sessionId: sid10, width: 800, height: 600 });
  assert(r.ok === true, 'high-freq start 成功');
  const wsPort2 = r.session.port;
  // 等 ws ready
  for (let i = 0; i < 40; i++) {
    await new Promise((res) => setTimeout(res, 50));
    const wsStatus = await invoke('canvas:ws-status');
    const entry = wsStatus.wsClients.find((c) => c.port === wsPort2);
    if (entry && entry.ready && entry.alive) break;
  }
  const t10 = Date.now();
  const highFreqPromises = [];
  for (let i = 0; i < 50; i++) {
    highFreqPromises.push(invoke('canvas:transform-device', {
      sessionId: sid10, deviceId: 'hf-1',
      transform: { xRatio: i / 50, yRatio: 0.5, rotationX: 0, rotationY: 0, rotationZ: 0, displayScale: 1 },
    }));
  }
  const hfResults = await Promise.all(highFreqPromises);
  const t10Elapsed = Date.now() - t10;
  const hfAllOk = hfResults.every((x) => x.ok === true && x.transport === 'ws');
  assert(hfAllOk, `50 个并发 transform 全部走 ws 成功 (${t10Elapsed}ms)`);
  log(`  50 个 transform 总耗时: ${t10Elapsed}ms, 平均: ${(t10Elapsed / 50).toFixed(2)}ms/req`);

  // mock 收到全部 50 个
  await new Promise((res) => setTimeout(res, 200));
  const stats10 = await getCanvasStats(wsPort2);
  const hfWsEntries = stats10.log.filter((e) => e.transport === 'ws' && e.url.includes('transformDevice'));
  assert(hfWsEntries.length >= 50, `mock canvas 收到 ≥50 个 ws transform (实际 ${hfWsEntries.length})`);

  // ─────────────────────────────────────────────────────────────────
  // 11. WebSocket 不可用 → HTTP 降级
  //    模拟: 直接调用 _internal._testOnly.closeWs(port) 关掉 ws,
  //    后续 sendToCanvas 应该自动回退 HTTP
  // ─────────────────────────────────────────────────────────────────
  section('11. WebSocket 降级到 HTTP');
  const sid11 = 'ws-fallback-session';
  r = await invoke('canvas:start', { sessionId: sid11, width: 800, height: 600 });
  assert(r.ok === true, 'fallback-test start 成功');
  const fbPort = r.session.port;
  // 等 ws ready
  for (let i = 0; i < 40; i++) {
    await new Promise((res) => setTimeout(res, 50));
    const wsStatus = await invoke('canvas:ws-status');
    const entry = wsStatus.wsClients.find((c) => c.port === fbPort);
    if (entry && entry.ready && entry.alive) break;
  }
  // 通过测试 hook 强制禁用 ws (后续 sendOverWs 立即失败 → 走 HTTP)
  canvas._testOnly.disableWs(fbPort);
  await new Promise((res) => setTimeout(res, 100));
  // 后续调用应自动回退 HTTP
  r = await invoke('canvas:set-background', { sessionId: sid11, color: '#fallback' });
  assert(r.ok === true && r.transport === 'http', 'ws 禁用后 set-background 走 http fallback');
  r = await invoke('canvas:transform-device', {
    sessionId: sid11, deviceId: 'fb-1',
    transform: { xRatio: 0.1, yRatio: 0.1, rotationX: 0, rotationY: 0, rotationZ: 0, displayScale: 1 },
  });
  assert(r.ok === true && r.transport === 'http', 'ws 禁用后 transform 走 http fallback');
  // HTTP 路径被 mock canvas 记录为 http transport
  await new Promise((res) => setTimeout(res, 100));
  const stats11 = await getCanvasStats(fbPort);
  const httpEntries = stats11.log.filter((e) => e.transport === 'http');
  assert(httpEntries.length >= 2, `mock canvas 收到 ≥2 条 http 消息 (实际 ${httpEntries.length})`);
  assert(httpEntries.some((e) => e.url === '/set-background'), 'http 收到 /set-background');
  assert(httpEntries.some((e) => e.url === '/transform'), 'http 收到 /transform');

  // ─────────────────────────────────────────────────────────────────
  // 12. 多次 start/stop, ws 客户端正确清理
  // ─────────────────────────────────────────────────────────────────
  section('12. start/stop ws 客户端清理');
  const sid12 = 'ws-lifecycle-session';
  r = await invoke('canvas:start', { sessionId: sid12, width: 800, height: 600 });
  assert(r.ok === true, 'lifecycle start 成功');
  const lcPort = r.session.port;
  for (let i = 0; i < 40; i++) {
    await new Promise((res) => setTimeout(res, 50));
    const wsStatus = await invoke('canvas:ws-status');
    if (wsStatus.wsClients.find((c) => c.port === lcPort)) break;
  }
  let wsStatus12 = await invoke('canvas:ws-status');
  assert(wsStatus12.wsClients.some((c) => c.port === lcPort), 'ws 客户端注册到 wsClients');

  r = await invoke('canvas:stop', { sessionId: sid12 });
  assert(r.ok === true, 'lifecycle stop 成功');
  await new Promise((res) => setTimeout(res, 100));
  wsStatus12 = await invoke('canvas:ws-status');
  assert(!wsStatus12.wsClients.some((c) => c.port === lcPort), 'stop 后 ws 客户端从 wsClients 清除');

  // ─────────────────────────────────────────────────────────────────
  // 13. screenshot 仍走 HTTP (大块 base64 数据)
  // ─────────────────────────────────────────────────────────────────
  section('13. screenshot 保持 HTTP 传输 (大块数据)');
  const sid13 = 'screenshot-session';
  r = await invoke('canvas:start', { sessionId: sid13, width: 800, height: 600 });
  assert(r.ok === true, 'screenshot-test start 成功');
  for (let i = 0; i < 40; i++) {
    await new Promise((res) => setTimeout(res, 50));
    const wsStatus = await invoke('canvas:ws-status');
    const entry = wsStatus.wsClients.find((c) => c.port === r.session.port);
    if (entry && entry.ready && entry.alive) break;
  }
  r = await invoke('canvas:screenshot', { sessionId: sid13 });
  assert(r.ok === true && r.dataUrl && r.dataUrl.startsWith('data:image/png;base64,'), 'canvas:screenshot 返回 PNG dataURL');
  // 验证 screenshot 走的是 HTTP
  await new Promise((res) => setTimeout(res, 100));
  const allSessions = [...canvas._internal.canvasSessions.values()];
  const shotSession = allSessions.find((s) => s.sessionId === sid13);
  assert(!!shotSession, 'screenshot-session 在 canvasSessions 里');
  if (shotSession) {
    const shotStats = await getCanvasStats(shotSession.port);
    const shotHttp = shotStats.log.filter((e) => e.transport === 'http' && e.url === '/screenshot');
    assert(shotHttp.length >= 1, 'screenshot 走 http (mock 收到 http /screenshot)');
  }

  // 清理 sid9 / sid10 / sid11 / sid13
  for (const sid of [sid9, sid10, sid11, sid13]) {
    try { await invoke('canvas:stop', { sessionId: sid }); } catch {}
  }

  // ─────────────────────────────────────────────────────────────────
  // 总结
  // ─────────────────────────────────────────────────────────────────
  log('');
  log('════════════════════════════════════════');
  log(`通过: ${PASS.length}  失败: ${FAIL.length}`);

  if (FAIL.length > 0) {
    log('失败项:');
    FAIL.forEach((f) => log(`  - ${f}`));
  }

  // 清理
  if (mockCanvas.server) mockCanvas.server.close();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  spawnedProcs.forEach((p) => { try { p.kill('SIGTERM'); } catch {} });

  log('退出码: ' + (FAIL.length > 0 ? 1 : 0));
  setTimeout(() => app.exit(FAIL.length > 0 ? 1 : 0), 200);
}

// ─────────────────────────────────────────────────────────────────
// 启动入口
// ─────────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  runTests().catch((err) => {
    log('FATAL: ' + (err?.stack || err?.message || String(err)));
    app.exit(1);
  });
});

app.on('window-all-closed', () => {
  // 不自动 quit, 让测试自己控制
});

process.on('uncaughtException', (e) => {
  log('UNCAUGHT: ' + (e?.stack || e?.message || String(e)));
  try { app.exit(1); } catch {}
});
process.on('unhandledRejection', (e) => {
  log('UNHANDLED REJECTION: ' + (e?.stack || e?.message || String(e)));
  try { app.exit(1); } catch {}
});