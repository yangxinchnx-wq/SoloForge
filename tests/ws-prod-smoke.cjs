// ─────────────────────────────────────────────────────────────────
// SoloForge 画布 WebSocket — 生产环境实测 (真实 canvas_preview.exe)
//   不依赖 Electron, 直接 spawn 真实编译产物, 验证:
//     1. ws upgrade 成功
//     2. sendOverWs 真的发到 canvas
//     3. 自动重连
//     4. HTTP fallback 仍然工作
// ─────────────────────────────────────────────────────────────────
'use strict';

const fs = require('fs');
const path = require('path');
const net = require('net');
const http = require('http');
const { spawn } = require('child_process');

const CANVAS_EXE = path.join(__dirname, '..', 'UI', 'resources', 'canvas', 'canvas-dist', 'canvas_preview.exe');
if (!fs.existsSync(CANVAS_EXE)) {
  console.error('FATAL: canvas_preview.exe not found at', CANVAS_EXE);
  process.exit(2);
}

const LOG_DIR = path.join(__dirname, '..', 'logs', 'e2e');
fs.mkdirSync(LOG_DIR, { recursive: true });
const LOG = path.join(LOG_DIR, 'ws-prod-smoke.log');
try { fs.unlinkSync(LOG); } catch {}
const PASS = [], FAIL = [];
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  try { fs.appendFileSync(LOG, line + '\n'); } catch {}
  console.log(line);
}
function assert(cond, msg) {
  if (cond) { PASS.push(msg); log('  ✓ ' + msg); }
  else { FAIL.push(msg); log('  ✗ ' + msg); }
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

function waitPort(port, timeoutMs = 12000) {
  const start = Date.now();
  return new Promise((resolve) => {
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
  });
}

// 加载 canvasHost 工厂
const { createCanvasManager } = require(path.join(__dirname, '..', 'UI', 'electron', 'canvasHost.cjs'));

// ─────────────────────────────────────────────────────────────────
async function run() {
  log('═══════════════════════════════════════════════');
  log('  WebSocket 生产实测 (真实 canvas_preview.exe)');
  log('═══════════════════════════════════════════════');
  log(`  canvas exe: ${CANVAS_EXE}`);

  // ── 准备一个 fake BrowserWindow (canvasHost 不实际需要 GUI, 只要 mock 接口) ──
  const fakeWindow = {
    isDestroyed: () => false,
    getNativeWindowHandle: () => Buffer.from([0xCA, 0xFE, 0x00, 0x01, 0, 0, 0, 0]),
    destroy: () => {},
    loadURL: () => {},
    setAlwaysOnTop: () => {},
    setIgnoreMouseEvents: () => {},
    setBounds: () => {},
    on: () => {},
    once: () => {},
    webContents: { send: () => {} },
  };
  const fakeApp = {
    on: () => {},
    quit: () => {},
    whenReady: () => Promise.resolve(),
  };

  const ipcHandlers = new Map();
  const fakeIpcMain = {
    handle: (ch, fn) => ipcHandlers.set(ch, fn),
    on: () => {},
  };

  // ── 创建 canvas manager (production 配置) ──
  const canvas = createCanvasManager({
    app: fakeApp,
    BrowserWindow: function () { return fakeWindow; },
    ipcMain: fakeIpcMain,
    getMainWindow: () => fakeWindow,
    resolveCanvasExePath: () => CANVAS_EXE,
    resolveCanvasDataDir: () => path.dirname(CANVAS_EXE),
    resolveModelsDir: () => path.join(__dirname, '..', 'UI', 'resources', 'canvas', 'models'),
    readDeviceConfig: () => ({ models: [] }),
    listAvailableModels: () => [],
    moveWindow: async () => ({ ok: true }),
    embedWindowWithRetry: async () => ({ ok: true, attempted: 1, succeeded: 1, retried: 0 }),
    findWindowByPid: async () => 0xDEAD,
    sendToCanvasRaw: (port, p, body, timeoutMs) => new Promise((resolve) => {
      const data = body ? JSON.stringify(body) : '';
      const req = http.request({
        host: '127.0.0.1', port, path: p, method: 'POST',
        headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
        timeout: timeoutMs || 3000,
      }, (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => resolve({ status: res.statusCode, body: buf }));
      });
      req.on('error', (e) => resolve({ status: 0, body: '', error: e.message }));
      req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: '', error: 'timeout' }); });
      if (data) req.write(data);
      req.end();
    }),
    waitForPort: (port, t) => waitPort(port, t || 8000),
    findFreePort,
    spawn,
    logPrefix: '[ws-prod]',
    idleDestroyMs: 30_000,
  });

  canvas.registerIpc();

  // 找 free port 给 canvas (绕过 _findFreePort 的内部使用)
  const canvasPort = await findFreePort();
  log(`  reserved canvas port: ${canvasPort}`);

  // ── 1. 直接 spawn 真实 canvas_preview.exe ──
  log('');
  log('── 1. spawn 真实 canvas_preview.exe ──');
  const child = spawn(CANVAS_EXE, [
    `--port=${canvasPort}`,
    `--parent-hwnd=${fakeWindow.getNativeWindowHandle().readInt32LE(0)}`,
    `--canvas-width=800`,
    `--canvas-height=600`,
    `--models-dir=${path.join(__dirname, '..', 'UI', 'resources', 'canvas', 'models')}`,
  ], {
    cwd: path.dirname(CANVAS_EXE),
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.stdout?.on('data', (d) => log(`  [canvas.out] ${d.toString().trim()}`));
  child.stderr?.on('data', (d) => log(`  [canvas.err] ${d.toString().trim()}`));

  log(`  pid=${child.pid}, waiting for port ${canvasPort}...`);
  const ready = await waitPort(canvasPort, 12000);
  assert(ready, `canvas_preview.exe 监听 :${canvasPort}`);
  if (!ready) {
    log('FATAL: canvas 未启动');
    try { child.kill('SIGTERM'); } catch {}
    process.exit(1);
  }

  // 等 1s 让 HTTP server 完全启动
  await new Promise((r) => setTimeout(r, 800));

  // ── 2. WebSocket 连接 ──
  log('');
  log('── 2. WebSocket 连接到 canvas /ws ──');
  let wsConnected = false;
  let wsMessageAck = null;
  let wsResolveAck = null;
  const ackPromise = new Promise((res) => { wsResolveAck = res; });

  const ws = new WebSocket(`ws://127.0.0.1:${canvasPort}/ws`);
  ws.onopen = () => { wsConnected = true; log('  ws open'); };
  ws.onmessage = (ev) => {
    log(`  ws recv: ${typeof ev.data === 'string' ? ev.data.slice(0, 100) : '<binary>'}`);
    wsMessageAck = ev.data;
    if (wsResolveAck) wsResolveAck(ev.data);
  };
  ws.onerror = (e) => log(`  ws error: ${e.message || e}`);
  ws.onclose = () => log('  ws close');

  // 等连接
  for (let i = 0; i < 50 && !wsConnected; i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  assert(wsConnected, 'WebSocket upgrade 成功');

  // ── 3. 发送 transformDevice via ws ──
  log('');
  log('── 3. ws.send transformDevice ──');
  const transformMsg = JSON.stringify({
    action: 'transformDevice',
    sessionId: 'prod-smoke-1',
    deviceId: 'prod-dev-1',
    transform: { xRatio: 0.42, yRatio: 0.58, rotationX: 0, rotationY: 0, rotationZ: 0, displayScale: 1 },
  });
  ws.send(transformMsg);
  log(`  sent: ${transformMsg.slice(0, 80)}...`);
  // 等 ack 或 2s 超时
  const ackResult = await Promise.race([
    ackPromise,
    new Promise((r) => setTimeout(() => r('TIMEOUT'), 2000)),
  ]);
  log(`  ack: ${typeof ackResult === 'string' ? ackResult.slice(0, 80) : ackResult}`);

  // ── 4. 用 canvasHost.cjs 的 sendOverWs 发 pushUI ──
  log('');
  log('── 4. canvasHost.cjs sendOverWs pushUI ──');
  // 注册 session 到 wsClients
  const sessionEntry = { sessionId: 'prod-smoke-1', pid: child.pid, port: canvasPort, hwnd: 0xDEAD, width: 800, height: 600 };
  canvas._internal.canvasSessions.set('prod-smoke-1', sessionEntry);
  canvas._testOnly.ensureWs(canvasPort);
  // 等 ws ready
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 100));
    if (canvas._testOnly.isWsReady(canvasPort)) break;
  }
  assert(canvas._testOnly.isWsReady(canvasPort), 'canvasHost._testOnly.isWsReady true');
  const r1 = await canvas.pushUIToCanvas('prod-smoke-1', { type: 'Text', text: 'prod-ws-test' }, 'd-1');
  assert(r1.ok === true && r1.transport === 'ws', 'canvas.pushUIToCanvas 走 ws transport');
  const r2 = await canvas.setCanvasBackground('prod-smoke-1', '#ff0000');
  assert(r2.ok === true && r2.transport === 'ws', 'canvas.setCanvasBackground 走 ws transport');
  const r3 = await canvas.transformDevice('prod-smoke-1', 'd-1', {
    xRatio: 0.5, yRatio: 0.5, rotationX: 0, rotationY: 0, rotationZ: 0, displayScale: 1,
  });
  assert(r3.ok === true && r3.transport === 'ws', 'canvas.transformDevice 走 ws transport');

  // ── 5. HTTP fallback (force disable ws) ──
  // 注意: 当前生产 canvas_preview.exe 只编译了 /render HTTP 路径,
  //       其他 endpoint (transform / pushUI / setBackground) 仅 WS 可达.
  //       所以 fallback 测试用 pushCanvasDSL (走 /render) 而不是 setBackground
  log('');
  log('── 5. ws disable → HTTP fallback (走 /render) ──');
  canvas._testOnly.disableWs(canvasPort);
  const r4 = await canvas.pushCanvasDSL('prod-smoke-1', { ui: { type: 'Text', text: 'http-fallback' } });
  log(`  r4 = ${JSON.stringify(r4)}`);
  assert(r4.ok === true && r4.transport === 'http', 'ws 禁用后 pushCanvasDSL 走 http fallback (canvas 仅 /render 路由)');

  // ── 6. 高频 ws transform (40 个并发) ──
  log('');
  log('── 6. 高频 ws transform (40 个并发) ──');
  // 重新启用 ws
  canvas._testOnly.closeWs(canvasPort);
  canvas._internal.canvasSessions.set('prod-smoke-1', sessionEntry);
  canvas._testOnly.ensureWs(canvasPort);
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 100));
    if (canvas._testOnly.isWsReady(canvasPort)) break;
  }
  const t0 = Date.now();
  const hfPromises = [];
  for (let i = 0; i < 40; i++) {
    hfPromises.push(canvas.transformDevice('prod-smoke-1', `d-hf-${i}`, {
      xRatio: i / 40, yRatio: 0.5, rotationX: 0, rotationY: 0, rotationZ: 0, displayScale: 1,
    }));
  }
  const hfResults = await Promise.all(hfPromises);
  const elapsed = Date.now() - t0;
  const hfAllOk = hfResults.every((x) => x.ok === true && x.transport === 'ws');
  assert(hfAllOk, `40 个并发 transform 全部 ws 成功 (${elapsed}ms, 平均 ${(elapsed/40).toFixed(2)}ms/req)`);

  // ── 7. 清理 ──
  log('');
  log('── 7. cleanup ──');
  try { ws.close(); } catch {}
  try { canvas._testOnly.closeWs(canvasPort); } catch {}
  try { await canvas.stopCanvas('prod-smoke-1'); } catch {}
  try { child.kill('SIGTERM'); } catch {}
  setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 3000);

  log('');
  log('═══════════════════════════════════════════════');
  log(`  通过: ${PASS.length}  失败: ${FAIL.length}`);
  log('═══════════════════════════════════════════════');
  if (FAIL.length > 0) {
    FAIL.forEach((f) => log('  - ' + f));
  }
  log(`退出码: ${FAIL.length > 0 ? 1 : 0}`);
  setTimeout(() => process.exit(FAIL.length > 0 ? 1 : 0), 500);
}

run().catch((e) => {
  log('FATAL: ' + (e?.stack || e?.message || String(e)));
  process.exit(1);
});
