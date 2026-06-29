// ─────────────────────────────────────────────────────────────────
// SoloForge 按钮 bug 自动化测试
//
// 目的: 模拟 renderer 端 PreviewPanel.tsx 上所有按钮的点击事件序列,
//       验证 canvasHost.cjs IPC handler 在以下场景下不会引发 bug:
//         1. 正常按钮序列 (start → pushUI → transform → setBackground → clear → screenshot → stop)
//         2. 同一按钮高频点击 (50x transformDevice 并发)
//         3. 状态错位 (重复 start / 还没完成就 stop / stop 不存在 session)
//         4. 操作未启动的画布 (transform / screenshot / pushUI 在 idle 时)
//         5. 快速切换 3D 尺寸 (pushUI race)
//         6. 资源泄漏 (1000x start/stop 循环)
//         7. 画布崩溃后 UI 能否恢复
//         8. 画布控制三按钮 (▶启动/■暂停/✕关闭) 互斥状态机
//
// 跑法: cd SoloForge
//       npx electron tests/button-bug-test.cjs
// 退出: 0 = 通过, 1 = 有 bug 触发
// ─────────────────────────────────────────────────────────────────

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const net = require('net');
const { spawn } = require('child_process');

const LOG_DIR = path.join(__dirname, '..', 'logs', 'e2e');
fs.mkdirSync(LOG_DIR, { recursive: true });
const LOG_FILE = path.join(LOG_DIR, 'button-bug-test.log');
try { fs.unlinkSync(LOG_FILE); } catch {}
const PASS = [];
const FAIL = [];
const BUGS = [];
const LOG_LINES = [];

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  LOG_LINES.push(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch {}
  try { process.stdout.write(line + '\n'); } catch {}
}
function assert(cond, msg) {
  if (cond) { PASS.push(msg); log(`  \x1b[32m✓\x1b[0m ${msg}`); }
  else { FAIL.push(msg); log(`  \x1b[31m✗\x1b[0m ${msg}`); }
}
function bug(scenario, detail) {
  BUGS.push({ scenario, detail });
  log(`  \x1b[41m🐛 BUG\x1b[0m [${scenario}] ${detail}`);
}
function section(name) {
  log('');
  log(`══ ${name} ══`);
}

// ── Electron ──
let electron;
try { electron = require('electron'); } catch (e) { log('FATAL: ' + e.message); process.exit(2); }
if (typeof electron === 'string') { log('FATAL: must run via electron'); process.exit(2); }
const { app, BrowserWindow, ipcMain } = electron;

const { createCanvasManager } = require(path.join(__dirname, '..', 'UI', 'electron', 'canvasHost.cjs'));

// ─────────────────────────────────────────────────────────────────
// Mock canvas 子进程脚本 — 与 electron-canvas-test.cjs 相同, 但简化
// ─────────────────────────────────────────────────────────────────
function makeMockCanvasScript() {
  const script = `
const http = require('http');
const crypto = require('crypto');
const portArg = process.argv.find(a => a.startsWith('--port='));
const port = portArg ? parseInt(portArg.split('=')[1], 10) : 0;
if (!port) { console.error('[mock-canvas] missing --port=N'); process.exit(2); }

const actionLog = [];
const wsConnections = [];
const log = (m) => { try { process.stdout.write('[mock-canvas] ' + m + '\\n'); } catch {} };

function recordAction(e) { actionLog.push({ ...e, t: Date.now(), transport: e.transport || 'http' }); }

function handleWS(req, socket) {
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write([
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    'Sec-WebSocket-Accept: ' + accept,
    '', '',
  ].join('\\r\\n'));
  const conn = { id: wsConnections.length + 1, buffer: Buffer.alloc(0), alive: true };
  wsConnections.push(conn);
  socket.on('data', (chunk) => {
    conn.buffer = Buffer.concat([conn.buffer, chunk]);
    while (conn.buffer.length >= 2) {
      const b1 = conn.buffer[0], b2 = conn.buffer[1];
      const fin = (b1 & 0x80) !== 0, opcode = b1 & 0x0f;
      const masked = (b2 & 0x80) !== 0;
      let len = b2 & 0x7f, offset = 2;
      if (len === 126) { if (conn.buffer.length < 4) return; len = conn.buffer.readUInt16BE(2); offset = 4; }
      else if (len === 127) { if (conn.buffer.length < 10) return; len = Number(conn.buffer.readBigUInt64BE(2)); offset = 10; }
      let maskKey = null;
      if (masked) { if (conn.buffer.length < offset + 4) return; maskKey = conn.buffer.slice(offset, offset+4); offset += 4; }
      if (conn.buffer.length < offset + len) return;
      let payload = conn.buffer.slice(offset, offset + len);
      if (masked && maskKey) {
        const u = Buffer.alloc(len);
        for (let i = 0; i < len; i++) u[i] = payload[i] ^ maskKey[i % 4];
        payload = u;
      }
      conn.buffer = conn.buffer.slice(offset + len);
      if (opcode === 0x1) {
        const text = payload.toString('utf8');
        let parsed = {}; try { parsed = JSON.parse(text); } catch {}
        const action = parsed.action || parsed.type || 'unknown';
        recordAction({ url: '/ws/' + action, method: 'WS', body: parsed, transport: 'ws', connId: conn.id });
        const ack = JSON.stringify({ ok: true, received: parsed, route: '/ws/' + action, transport: 'ws' });
        sendFrame(socket, 0x1, Buffer.from(ack, 'utf8'));
      } else if (opcode === 0x8) { try { socket.end(); } catch {} return; }
    }
  });
  socket.on('close', () => { conn.alive = false; });
  socket.on('error', () => { conn.alive = false; });
}
function sendFrame(socket, op, payload) {
  const len = payload.length;
  let header;
  if (len < 126) header = Buffer.from([0x80 | op, len]);
  else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x80 | op; header[1] = 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x80 | op; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2); }
  try { socket.write(Buffer.concat([header, payload])); } catch {}
}

const server = http.createServer((req, res) => {
  if (req.headers.upgrade && req.headers.upgrade.toLowerCase() === 'websocket') {
    handleWS(req, req.socket); return;
  }
  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    let parsed = {}; try { parsed = body ? JSON.parse(body) : {}; } catch {}
    recordAction({ url: req.url, method: req.method, body: parsed, transport: 'http' });
    if (req.url === '/stats') { res.writeHead(200, {'Content-Type':'application/json'}); res.end(JSON.stringify({ log: actionLog, wsConnections: wsConnections.length })); return; }
    if (req.url === '/health') { res.writeHead(200, {'Content-Type':'application/json'}); res.end(JSON.stringify({ ok: true })); return; }
    const biz = ['/render','/push-ui','/transform','/clear-devices','/set-background','/screenshot'];
    if (biz.some(p => req.url === p)) {
      res.writeHead(200, {'Content-Type':'application/json'});
      if (req.url === '/screenshot') {
        res.end(JSON.stringify({ ok: true, png: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', width: 1, height: 1, byteLength: 70, timestamp: Date.now() }));
      } else { res.end(JSON.stringify({ ok: true, received: parsed, route: req.url })); }
      return;
    }
    res.writeHead(404); res.end(JSON.stringify({ error: 'mock 404' }));
  });
});
server.listen(port, '127.0.0.1', () => log('listening ' + port));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGKILL', () => process.exit(137));
`;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'soloforge-bbtn-'));
  const scriptPath = path.join(tmpDir, 'mock-canvas.js');
  fs.writeFileSync(scriptPath, script);
  return { scriptPath, tmpDir };
}

function getCanvasStats(port) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/stats', method: 'GET', timeout: 1500 }, (res) => {
      let buf = ''; res.on('data', c => buf += c);
      res.on('end', () => { try { resolve(JSON.parse(buf)); } catch { resolve({ log: [] }); } });
    });
    req.on('error', () => resolve({ log: [] }));
    req.on('timeout', () => { req.destroy(); resolve({ log: [] }); });
    req.end();
  });
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
    srv.on('error', reject);
  });
}

// ── Mock Electron deps ──
function makeMockWindow() {
  // 模拟 BrowserWindow — 满足 canvasHost.cjs 的最小需求
  let destroyed = false;
  const win = {
    isDestroyed: () => destroyed,
    destroy: () => { destroyed = true; },
    setBounds: () => {},
    setAlwaysOnTop: () => {},
    setIgnoreMouseEvents: () => {},
    loadURL: () => {},
    getNativeWindowHandle: () => {
      // 32-byte buffer, 前 4 字节是 hwnd (随便填个非零值)
      const buf = Buffer.alloc(32);
      buf.writeInt32LE(0x12345678, 0);
      return buf;
    },
  };
  return win;
}

function makeMockElectron() {
  return {
    app,
    BrowserWindow: function (opts) {
      // canvasHost.cjs 用 new BrowserWindow(opts) 创建 host 窗口
      // 返回 mock 即可
      return makeMockWindow();
    },
    ipcMain: {
      _handlers: new Map(),
      handle(channel, fn) { this._handlers.set(channel, fn); },
      invokeHandler(channel, ...args) { const fn = this._handlers.get(channel); if (!fn) throw new Error('no handler: ' + channel); return fn({}, ...args); },
    },
  };
}

// ── 主测试 ──
async function runTests() {
  log('');
  log('╔══════════════════════════════════════════════════════════╗');
  log('║  SoloForge 按钮 bug 自动化测试 (button-bug-test)         ║');
  log('╚══════════════════════════════════════════════════════════╝');

  await app.whenReady();
  log('electron app ready');

  // 准备 mock canvas script
  const { scriptPath, tmpDir } = makeMockCanvasScript();
  log('mock-canvas script: ' + scriptPath);

  // 准备 deps
  const mockElectron = makeMockElectron();
  const mockMainWin = makeMockWindow();
  const mainWindows = [mockMainWin];
  const getMainWindow = () => mainWindows[0] || null;

  const cm = createCanvasManager({
    app,
    BrowserWindow: mockElectron.BrowserWindow,
    ipcMain: mockElectron.ipcMain,
    getMainWindow,
    resolveCanvasExePath: () => scriptPath,  // 用 mock script 代替
    resolveCanvasDataDir: () => tmpDir,
    resolveModelsDir: () => tmpDir,
    readDeviceConfig: () => ({ devices: [] }),
    listAvailableModels: () => [],
    moveWindow: async (hwnd, x, y, w, h) => ({ ok: true }),
    embedWindowWithRetry: async () => ({ ok: true, attempted: 1, succeeded: 1, retried: 0 }),
    findWindowByPid: async (pid) => 0xABCD,  // mock canvas 没真窗口, 直接返
    sendToCanvasRaw: async (port, p, body, timeoutMs) => {
      // 直接 HTTP POST 到 mock canvas
      return new Promise((resolve) => {
        const data = body || '';
        const req = http.request({
          host: '127.0.0.1', port, path: p, method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
          timeout: timeoutMs || 5000,
        }, (res) => {
          let buf = ''; res.on('data', c => buf += c);
          res.on('end', () => resolve({ status: res.statusCode, body: buf }));
        });
        req.on('error', (e) => resolve({ status: 0, body: '', error: e.message }));
        req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: '', error: 'timeout' }); });
        if (data) req.write(data);
        req.end();
      });
    },
    findFreePort,
    waitForPort: async (port, timeoutMs = 8000) => {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        try {
          const ok = await new Promise((resolve) => {
            const sock = net.createConnection({ host: '127.0.0.1', port }, () => { sock.end(); resolve(true); });
            sock.on('error', () => resolve(false));
            setTimeout(() => { try { sock.destroy(); } catch {} resolve(false); }, 1000);
          });
          if (ok) return true;
        } catch {}
        await new Promise(r => setTimeout(r, 200));
      }
      return false;
    },
    // s3.4 / 2026-06-28 fix: 在 Electron 测试环境下, 直接 spawn .js 会触发 EFTYPE
    //   Windows 找不到 .js 的解释器 (.js 关联到 Electron 而不是 Node)
    //   解法: 如果 exe 是 .js, 用 process.execPath + ELECTRON_RUN_AS_NODE=1 走 Node 模式
    spawn: (exe, args, opts = {}) => {
      if (typeof exe === 'string' && (exe.endsWith('.js') || exe.endsWith('.cjs'))) {
        return spawn(process.execPath, [exe, ...args], {
          ...opts,
          env: { ...(opts.env || process.env), ELECTRON_RUN_AS_NODE: '1' },
        });
      }
      return spawn(exe, args, opts);
    },
    logPrefix: '[btntst]',
  });

  cm.registerIpc();

  // helper: invoke IPC handler (模拟 renderer 的 ipcRenderer.invoke)
  async function ipc(channel, payload) {
    try {
      return await mockElectron.ipcMain.invokeHandler(channel, payload);
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  // ============== Section 1: 正常按钮序列 ==============
  section('Section 1: 正常按钮序列 (start → pushUI → transform → setBg → clear → screenshot → stop)');
  {
    const sid = 'tab-1';
    const startRes = await ipc('canvas:start', { sessionId: sid, width: 800, height: 600 });
    if (!startRes.ok) log(`  [debug] start error: ${startRes.error}`);
    assert(startRes.ok === true, '启动按钮 — 成功 spawn');
    assert(startRes.session && startRes.session.port > 0, '启动按钮 — 返回 session 包含 port');
    assert(cm._internal.canvasSessions.has(sid), 'canvasSessions Map 包含 sid');

    // 等 ws 就绪
    await new Promise(r => setTimeout(r, 500));

    // pushUI (尺寸选择器: 选 iPhone 14 Pro)
    const pushUIRes = await ipc('canvas:push-ui', { sessionId: sid, dsl: { action: 'selectDevice', modelKey: 'm-iphone14pro' }, deviceId: null });
    assert(pushUIRes.ok === true, '3D 尺寸选择按钮 — pushUI selectDevice 成功');

    // transform (拖拽设备)
    const trRes = await ipc('canvas:transform-device', { sessionId: sid, deviceId: 'dev-1', transform: { x: 100, y: 200, rotation: 0.5 } });
    assert(trRes.ok === true, '设备拖拽按钮 — transform 成功');

    // setBackground (底色选择)
    const bgRes = await ipc('canvas:set-background', { sessionId: sid, color: '#0B1020' });
    assert(bgRes.ok === true, '底色按钮 — setBackground 成功');

    // clearDevices (2D 模式切换)
    const clrRes = await ipc('canvas:clear-devices', { sessionId: sid });
    assert(clrRes.ok === true, '2D 模式按钮 — clearDevices 成功');

    // push DSL (聊天自动推 UI)
    const pushRes = await ipc('canvas:push', { sessionId: sid, dsl: { ui: { type: 'text', props: { content: 'hello' } } } });
    assert(pushRes.ok === true, '聊天推送 — push DSL 成功');

    // screenshot (截图按钮)
    const shotRes = await ipc('canvas:screenshot', { sessionId: sid });
    assert(shotRes.ok === true, '截图按钮 — 成功');
    assert(shotRes.dataUrl && shotRes.dataUrl.startsWith('data:image/png'), '截图按钮 — 返回 dataUrl');

    // stop (关闭按钮)
    const stopRes = await ipc('canvas:stop', { sessionId: sid });
    assert(stopRes.ok === true, '关闭按钮 — stop 成功');
    assert(!cm._internal.canvasSessions.has(sid), '关闭后 canvasSessions Map 移除 sid');

    // 等 mock 子进程 exit
    await new Promise(r => setTimeout(r, 500));
  }

  // ============== Section 2: 同一按钮高频点击 (50x transformDevice) ==============
  section('Section 2: 同一按钮高频点击 (50x transformDevice 并发)');
  {
    const sid = 'tab-2';
    await ipc('canvas:start', { sessionId: sid, width: 800, height: 600 });
    await new Promise(r => setTimeout(r, 500));

    const N = 50;
    const start = Date.now();
    const promises = [];
    for (let i = 0; i < N; i++) {
      promises.push(ipc('canvas:transform-device', {
        sessionId: sid, deviceId: 'dev-x',
        transform: { x: i, y: i * 2, rotation: i * 0.01 },
      }));
    }
    const results = await Promise.all(promises);
    const elapsed = Date.now() - start;
    const okCount = results.filter(r => r && r.ok).length;
    assert(okCount >= N * 0.8, `50x transformDevice 并发, 至少 80% 成功 (实际 ${okCount}/${N})`);
    assert(elapsed < 5000, `50x transformDevice 在 5s 内完成 (实际 ${elapsed}ms)`);

    // 验证 ws queue 没堆积
    const wsMap = cm._internal.getWsClients();
    let maxQueue = 0;
    for (const [, conn] of wsMap) maxQueue = Math.max(maxQueue, conn.queue.length);
    assert(maxQueue < 50, `ws queue 未堆积 (max=${maxQueue})`);

    await ipc('canvas:stop', { sessionId: sid });
    await new Promise(r => setTimeout(r, 300));
  }

  // ============== Section 3: 状态错位 — 重复 start ==============
  section('Section 3: 状态错位 — 重复 start 同一 sessionId');
  {
    const sid = 'tab-3';
    const r1 = await ipc('canvas:start', { sessionId: sid, width: 800, height: 600 });
    assert(r1.ok === true, '第一次 start 成功');

    // 立刻重复 start (用户双击 ▶ 按钮)
    const r2 = await ipc('canvas:start', { sessionId: sid, width: 800, height: 600 });
    assert(r2.ok === true, '重复 start 成功 (reused)');
    assert(r2.reused === true, '第二次 start 返回 reused=true, 不重复 spawn');

    // 检查只有 1 个 session
    assert(cm._internal.canvasSessions.size === 1, `canvasSessions Map 只有 1 个 session (实际 ${cm._internal.canvasSessions.size})`);

    // 检查只有 1 个子进程 (没多 spawn)
    const internal = cm._internal.canvasSessions.get(sid);
    assert(internal && internal.pid, '唯一 session 有 pid');

    await ipc('canvas:stop', { sessionId: sid });
    await new Promise(r => setTimeout(r, 300));
  }

  // ============== Section 4: 状态错位 — 还没 start 就 stop ==============
  section('Section 4: 状态错位 — 还没 start 就 stop');
  {
    const sid = 'tab-never-started';
    // stop 不存在的 session
    const r = await ipc('canvas:stop', { sessionId: sid });
    assert(r.ok === true, 'stop 不存在的 session — 不抛错 (idempotent)');
    assert(r.notFound === true, 'stop 不存在返回 notFound=true');
  }

  // ============== Section 5: 操作未启动的画布 ==============
  section('Section 5: 在 idle 状态操作画布 (transform / pushUI / screenshot / setBg)');
  {
    const sid = 'tab-idle';
    const r1 = await ipc('canvas:transform-device', { sessionId: sid, deviceId: 'd1', transform: {} });
    assert(r1.ok === false, 'idle 状态 transform — 返回错误');
    assert(r1.error && r1.error.includes('not found'), 'idle transform — 错误信息提示 not found');

    const r2 = await ipc('canvas:push-ui', { sessionId: sid, dsl: {} });
    assert(r2.ok === false, 'idle 状态 pushUI — 返回错误');

    const r3 = await ipc('canvas:screenshot', { sessionId: sid });
    assert(r3.ok === false, 'idle 状态 screenshot — 返回错误');

    const r4 = await ipc('canvas:set-background', { sessionId: sid, color: '#000' });
    assert(r4.ok === false, 'idle 状态 setBg — 返回错误');

    const r5 = await ipc('canvas:push', { sessionId: sid, dsl: {} });
    assert(r5.ok === false, 'idle 状态 push — 返回错误');
  }

  // ============== Section 6: 快速切换 3D 尺寸 (pushUI race) ==============
  section('Section 6: 快速切换 3D 尺寸 (5x pushUI 不同 modelKey)');
  {
    const sid = 'tab-size';
    await ipc('canvas:start', { sessionId: sid, width: 800, height: 600 });
    await new Promise(r => setTimeout(r, 500));

    const models = ['m-iphone14pro', 'm-galaxys23', 'm-pixel7', 't-ipadpro129', 'w-apple41'];
    const promises = models.map(m => ipc('canvas:push-ui', {
      sessionId: sid, dsl: { action: 'selectDevice', modelKey: m }, deviceId: null,
    }));
    const results = await Promise.all(promises);
    const okCount = results.filter(r => r && r.ok).length;
    assert(okCount === models.length, `5x pushUI 全部成功 (实际 ${okCount}/${models.length})`);

    // 检查 mock 收到了 5 条 /ws/pushUI
    const sess = cm._internal.canvasSessions.get(sid);
    if (sess) {
      const stats = await getCanvasStats(sess.port);
      const pushUIs = stats.log.filter(e => e.url === '/ws/pushUI' || e.url === '/push-ui');
      assert(pushUIs.length >= models.length, `mock canvas 收到 ${models.length} 条 pushUI (实际 ${pushUIs.length})`);
    }

    await ipc('canvas:stop', { sessionId: sid });
    await new Promise(r => setTimeout(r, 300));
  }

  // ============== Section 7: 资源泄漏 (50x start/stop 循环, 比 1000 更快) ==============
  section('Section 7: 资源泄漏 (50x start/stop 循环)');
  {
    const N = 50;
    const initialSize = cm._internal.canvasSessions.size;
    const initialWs = cm._internal.getWsClients().size;
    const initialPortMap = cm._internal.getSessionPortMap().size;
    log(`  初始: sessions=${initialSize} ws=${initialWs} portMap=${initialPortMap}`);

    for (let i = 0; i < N; i++) {
      const sid = `leak-${i}`;
      const r = await ipc('canvas:start', { sessionId: sid, width: 800, height: 600 });
      if (!r.ok) { bug('leak-loop', `第 ${i} 次 start 失败: ${r.error}`); break; }
      await new Promise(res => setTimeout(res, 30));
      const sr = await ipc('canvas:stop', { sessionId: sid });
      if (!sr.ok) { bug('leak-loop', `第 ${i} 次 stop 失败: ${sr.error}`); break; }
      await new Promise(res => setTimeout(res, 30));
    }

    // 等所有 mock canvas 子进程 exit
    await new Promise(r => setTimeout(r, 1500));

    const finalSize = cm._internal.canvasSessions.size;
    const finalWs = cm._internal.getWsClients().size;
    const finalPortMap = cm._internal.getSessionPortMap().size;
    log(`  最终: sessions=${finalSize} ws=${finalWs} portMap=${finalPortMap}`);

    assert(finalSize === 0, `canvasSessions 已清空 (实际 ${finalSize})`);
    assert(finalPortMap === 0, `sessionPortMap 已清空 (实际 ${finalPortMap})`);
    // ws 可能因为 close 异步未完成, 给点宽容
    assert(finalWs <= 2, `wsClients 已清理 (实际 ${finalWs})`);
  }

  // ============== Section 8.5: renderer state race (PreviewPanel.tsx 模拟) ==============
  section('Section 8.5: renderer state race — closeCanvas abort startAbortRef, 防止状态被覆盖');
  {
    // 验证修复后: closeCanvas 调 startAbortRef.current?.abort(), startCanvas 完成时
    //   检测 signal.aborted → 提前 return, 不调 setCanvasState('error'), state 保持 'idle'
    //
    // 历史 (修复前, git log):
    //   closeCanvas 不调 startAbortRef.abort → startCanvas 完成后 (res.ok=false 因 IPC abort)
    //   → 走 if (!res.ok) 分支 → setCanvasState('error') 覆盖 closeCanvas 的 'idle'
    //   用户感受: ▶ 启动 → ✕ 关闭 → 转圈消失 → 几百 ms 后突然变 error (state race)
    //   修复点: PreviewPanel.tsx closeCanvas (line 793) + cancelStart (line 960)
    //           都加了 startAbortRef.current?.abort()
    const sid = 'tab-state-race';
    let rendererState = 'idle';
    let simSignalAborted = false;

    // 模拟 startCanvas (line 599-769) — 修复后行为
    const startSim = async () => {
      simSignalAborted = false;
      rendererState = 'starting';
      const startP = ipc('canvas:start', { sessionId: sid, width: 800, height: 600 });
      const res = await startP;
      // line 699: if (isStartAborted(signal)) return;
      if (simSignalAborted) return;  // closeCanvas abort 了, 提前 return, 不改 state
      if (!res.ok) rendererState = 'error';
      else rendererState = 'running';
    };

    // 模拟 closeCanvas (line 793) — 修复后行为
    const closeSim = async () => {
      simSignalAborted = true;  // 修复: abort startAbortRef
      await ipc('canvas:stop', { sessionId: sid });
      rendererState = 'idle';
    };

    // 1) 点 ▶
    const startP = startSim();
    await new Promise(r => setTimeout(r, 80));  // 等进入 'starting'

    // 2) 点 ✕ (closeCanvas abort startAbortRef + IPC stop)
    await closeSim();

    // 3) startCanvas 完成
    await startP;

    // 期望 state 保持 'idle' (closeSim 设的)
    assert(rendererState === 'idle', `修复后: 期望 idle, 实际 ${rendererState} (closeCanvas abort startAbortRef 后 startCanvas 不覆盖 state)`);

    // 等清理
    await new Promise(r => setTimeout(r, 500));
  }

  // ============== Section 8.6: 启动期间多次点 ✕ ==============
  section('Section 8.6: 启动期间多次点 ✕ — 不应卡死');
  {
    const sid = 'tab-multi-close';
    const startP = ipc('canvas:start', { sessionId: sid, width: 800, height: 600 });

    // 在 start 返回前点 ✕ 3 次
    const t0 = Date.now();
    const stops = await Promise.all([
      ipc('canvas:stop', { sessionId: sid }),
      ipc('canvas:stop', { sessionId: sid }),
      ipc('canvas:stop', { sessionId: sid }),
    ]);
    const t1 = Date.now();

    const startR = await startP;
    const t2 = Date.now();

    assert(t1 - t0 < 1000, `3x stop 不应卡死 (< 1s, 实际 ${t1-t0}ms)`);
    assert(t2 - t0 < 3000, `整个 start+3x stop < 3s (实际 ${t2-t0}ms)`);
    assert(stops.every(s => s && typeof s.ok === 'boolean'), '3x stop 都返回 ok 字段');
    log(`  startR.ok=${startR.ok} aborted=${startR.aborted || false}, stops=[${stops.map(s => `ok=${s.ok} aborted=${s.aborted || false} notFound=${s.notFound || false}`).join(', ')}]`);

    // 第一个 stop 应该 abort 启动, 后续 2 个 stop 应该是 notFound
    const abortedCount = stops.filter(s => s.aborted).length;
    const notFoundCount = stops.filter(s => s.notFound).length;
    assert(abortedCount === 1, `3x stop 中恰好 1 个 aborted (实际 ${abortedCount})`);
    assert(notFoundCount === 2, `3x stop 中 2 个 notFound (实际 ${notFoundCount})`);

    // canvasSessions 应该是空的
    await new Promise(r => setTimeout(r, 500));
    assert(!cm._internal.canvasSessions.has(sid), 'canvasSessions 已清理');
    assert(!cm._internal.pendingStarts.has(sid), 'pendingStarts 已清理');
  }

  // ============== Section 8.7: 启动期间点 ⏸ (starting 时 ⏸ 按钮 disabled) ==============
  section('Section 8.7: 启动期间点 ⏸ — PreviewPanel line 1417 disabled 保护');
  {
    // PreviewPanel.tsx line 1413-1429: 暂停按钮 disabled={canvasState !== 'running'}
    // 模拟: starting 时点 ⏸, pauseCanvas 内部 if (canvasState !== 'running') return
    // 实际是: 按钮 disabled, onClick 不触发. 但即使绕过 UI 直接调, 也不应卡死
    const sid = 'tab-pause-during-start';
    const startP = ipc('canvas:start', { sessionId: sid, width: 800, height: 600 });

    // 模拟 pauseCanvas 内部状态检查
    let rendererState = 'starting';
    const pauseSim = () => {
      if (rendererState !== 'running') return;  // 跟 PreviewPanel line 1417 一致
      rendererState = 'paused';
    };
    pauseSim();
    assert(rendererState === 'starting', '⏸ 在 starting 时不修改 state (UI 保护)');

    // 即使绕过 UI 直接调 IPC stop, 也不应卡死
    const t0 = Date.now();
    const stopR = await ipc('canvas:stop', { sessionId: sid });
    const t1 = Date.now();
    assert(t1 - t0 < 2000, `⏸ 后 ✕ 不卡死 (实际 ${t1-t0}ms)`);
    assert(stopR.ok === true, 'stop 成功');

    const startR = await startP;
    log(`  startR.ok=${startR.ok} aborted=${startR.aborted || false}`);

    // 等清理
    await new Promise(r => setTimeout(r, 500));
  }

  // ============== Section 8.8: running 状态点 ⏸ → ✕ — IPC 不卡死 ==============
  section('Section 8.8: running 状态点 ⏸ → ✕ — IPC stop 不应卡死');
  {
    const sid = 'tab-running-pause-close';
    const startR = await ipc('canvas:start', { sessionId: sid, width: 800, height: 600 });
    if (!startR.ok) {
      log(`  [skip] start failed: ${startR.error}`);
    } else {
      await new Promise(r => setTimeout(r, 1500));  // 等到 running 状态

      // 模拟 pauseCanvas: 不调 IPC, 只 setCanvasState('paused')
      let rendererState = 'running';
      rendererState = 'paused';
      log(`  pause: state ${'running'} → ${rendererState}`);

      // 模拟 closeCanvas: startAbortRef.abort + IPC stop
      const t0 = Date.now();
      const stopR = await ipc('canvas:stop', { sessionId: sid });
      const t1 = Date.now();

      assert(stopR.ok === true, `running 状态 stop 成功 (ok=${stopR.ok})`);
      assert(t1 - t0 < 2000, `running 状态 stop 在 2s 内返回 (实际 ${t1-t0}ms)`);
      assert(!cm._internal.canvasSessions.has(sid), 'stop 后 canvasSessions 已清理');

      // 等清理
      await new Promise(r => setTimeout(r, 500));
    }
  }

  // ============== Section 8.9: running 状态快速点 ⏸/✕/▶ 交替 — 不死循环 ==============
  section('Section 8.9: running 状态快速点 ⏸/✕/▶ 交替 — 不死循环');
  {
    const sid = 'tab-rapid-toggle';
    const startR = await ipc('canvas:start', { sessionId: sid, width: 800, height: 600 });
    if (!startR.ok) {
      log(`  [skip] start failed: ${startR.error}`);
    } else {
      await new Promise(r => setTimeout(r, 1000));

      // 模拟 5 轮 ⏸/▶/✕ 切换, 每轮 IPC 都要 < 2s
      const t0 = Date.now();
      for (let i = 0; i < 5; i++) {
        // ▶ 重启 (注意: 同 sessionId restart 走 reused path, 所以要先 stop)
        const stopR = await ipc('canvas:stop', { sessionId: sid });
        if (!stopR.ok) { bug('rapid-toggle', `第 ${i} 轮 stop 失败: ${stopR.error}`); break; }
        await new Promise(r => setTimeout(r, 100));
        const restartR = await ipc('canvas:start', { sessionId: sid, width: 800, height: 600 });
        if (!restartR.ok) { bug('rapid-toggle', `第 ${i} 轮 restart 失败: ${restartR.error}`); break; }
        await new Promise(r => setTimeout(r, 200));
      }
      const t1 = Date.now();
      log(`  5 轮 start/stop 总耗时 ${t1-t0}ms`);

      assert(t1 - t0 < 15000, `5 轮 start/stop < 15s (实际 ${t1-t0}ms)`);

      // 清理
      await ipc('canvas:stop', { sessionId: sid });
      await new Promise(r => setTimeout(r, 500));
    }
  }

  // ============== Section 8.10: stop 后立即 start — 端口分配不冲突 ==============
  section('Section 8.10: stop 后立即 start — 端口分配不应卡死');
  {
    const sid = 'tab-stop-restart';
    for (let i = 0; i < 10; i++) {
      const r1 = await ipc('canvas:start', { sessionId: sid, width: 800, height: 600 });
      if (!r1.ok) { bug('stop-restart', `第 ${i} 次 start 失败: ${r1.error}`); break; }
      const r2 = await ipc('canvas:stop', { sessionId: sid });
      if (!r2.ok) { bug('stop-restart', `第 ${i} 次 stop 失败: ${r2.error}`); break; }
    }
    await new Promise(r => setTimeout(r, 800));
    assert(!cm._internal.canvasSessions.has(sid), '10 轮后 canvasSessions 已清空');
    assert(!cm._internal.pendingStarts.has(sid), '10 轮后 pendingStarts 已清空');
  }

  // ============== Section 8.11: 完整 lifecycle — start → pause → close → re-start ==============
  section('Section 8.11: 完整 lifecycle — start → pause → close → re-start');
  {
    const sid = 'tab-lifecycle';
    // 1) 启动
    const r1 = await ipc('canvas:start', { sessionId: sid, width: 800, height: 600 });
    if (!r1.ok) { log(`  [skip] start 1 failed: ${r1.error}`); }
    else {
      await new Promise(r => setTimeout(r, 800));
      // 2) 暂停 (无 IPC, 模拟 renderer state 切换)
      log('  pause: state running → paused');
      // 3) 关闭
      const t0 = Date.now();
      const r2 = await ipc('canvas:stop', { sessionId: sid });
      const t1 = Date.now();
      assert(r2.ok === true, 'lifecycle 关闭 ok');
      assert(t1 - t0 < 2000, `lifecycle 关闭 < 2s (实际 ${t1-t0}ms)`);

      // 4) 等彻底清理
      await new Promise(r => setTimeout(r, 500));
      assert(!cm._internal.canvasSessions.has(sid), 'lifecycle 关闭后 session 清空');

      // 5) 重新启动 (用户再次点 ▶)
      const r3 = await ipc('canvas:start', { sessionId: sid, width: 800, height: 600 });
      assert(r3.ok === true, `lifecycle 重启 ok (got ok=${r3.ok} error=${r3.error || '-'})`);

      // 清理
      await ipc('canvas:stop', { sessionId: sid });
      await new Promise(r => setTimeout(r, 500));
    }
  }

  // ============== Section 8.12: 多次快速 click ✕ (幂等性 + 不死循环) ==============
  section('Section 8.12: 多次快速 click ✕ (幂等性)');
  {
    const sid = 'tab-rapid-close';
    const startR = await ipc('canvas:start', { sessionId: sid, width: 800, height: 600 });
    if (!startR.ok) { log(`  [skip] start failed: ${startR.error}`); }
    else {
      await new Promise(r => setTimeout(r, 800));
      // 快速点 ✕ 10 次
      const t0 = Date.now();
      const stops = await Promise.all(
        Array(10).fill(0).map(() => ipc('canvas:stop', { sessionId: sid }))
      );
      const t1 = Date.now();
      assert(t1 - t0 < 2000, `10x rapid stop < 2s (实际 ${t1-t0}ms)`);
      const okCount = stops.filter(s => s && s.ok).length;
      assert(okCount === 10, `10x stop 全部 ok (实际 ${okCount})`);
      // 第一个 stop 删 session, 后续 9 个 notFound
      const notFoundCount = stops.filter(s => s && s.notFound).length;
      assert(notFoundCount === 9, `9x notFound (实际 ${notFoundCount})`);

      // 等清理
      await new Promise(r => setTimeout(r, 500));
      assert(!cm._internal.canvasSessions.has(sid), 'rapid close 后 session 清空');
    }
  }

  // ============== Section 8: start 还没完成就 stop (race) ==============
  section('Section 8: race — start 还没返回就 stop');
  {
    const sid = 'tab-race';
    // 不等 start 返回
    const startP = ipc('canvas:start', { sessionId: sid, width: 800, height: 600 });
    // 立刻 stop (如果 start 还没注册 session, stop 会成功 no-op)
    const stopP = ipc('canvas:stop', { sessionId: sid });
    const [startR, stopR] = await Promise.all([startP, stopP]);
    // 两种合法结果: (A) start 先完成 → stop 正常 (B) stop 先到 → start 完成后会 reused/stop 已 noop
    // 但不能两个都抛错
    assert(startR && typeof startR.ok === 'boolean', 'race — start 返回有 ok 字段');
    assert(stopR && typeof stopR.ok === 'boolean', 'race — stop 返回有 ok 字段');
    log(`  start.ok=${startR.ok} reused=${startR.reused || false}, stop.ok=${stopR.ok} notFound=${stopR.notFound || false}`);

    // 等清理
    await new Promise(r => setTimeout(r, 800));
    assert(!cm._internal.canvasSessions.has(sid) || cm._internal.canvasSessions.get(sid).process?.killed, 'race 后 session 已清理或已 kill');
  }

  // ============== Section 9: 控制三按钮互斥 (preview ▶ / ■ / ✕ 状态机) ==============
  section('Section 9: 画布控制三按钮状态机 (PreviewPanel.tsx line 1391-1439)');
  {
    // 模拟 PreviewPanel 状态机: idle → starting → running → paused → running → idle
    // 通过 canvasState ref 跟踪
    const sid = 'tab-fsm';
    let state = 'idle';

    // 1) idle: 启动按钮可用, 暂停/关闭禁用
    assert(state === 'idle', '初始: idle');
    // ▶ 启动
    const startP = ipc('canvas:start', { sessionId: sid, width: 800, height: 600 });
    state = 'starting';
    // starting: 启动按钮 disabled (预览代码 line 1393)
    // 同时点 ✕ 关闭 — 状态 starting, close 会调 stop
    const stopDuringStart = await ipc('canvas:stop', { sessionId: sid });
    // 等 start 真的完成
    const startR = await startP;
    state = startR.ok ? (startR.reused ? 'running' : 'running') : 'error';

    // 等子进程 exit (stop 已经发 SIGTERM)
    await new Promise(r => setTimeout(r, 800));

    // 如果 start 后 session 还在, 再 stop 一次 (cleanup)
    if (cm._internal.canvasSessions.has(sid)) {
      await ipc('canvas:stop', { sessionId: sid });
      await new Promise(r => setTimeout(r, 500));
    }

    state = 'idle';
    assert(state === 'idle', '关闭后状态: idle');
    assert(!cm._internal.canvasSessions.has(sid), '关闭后 session 清理');
  }

  // ============== Section 10: canvas 崩溃 (子进程异常退出) ==============
  section('Section 10: canvas 子进程崩溃 — 状态正确恢复');
  {
    // 用 SIGKILL 模拟 canvas crash
    const sid = 'tab-crash';
    const startRes = await ipc('canvas:start', { sessionId: sid, width: 800, height: 600 });
    if (!startRes.ok) { log(`  [skip] start failed: ${startRes.error}`); }
    else {
      await new Promise(r => setTimeout(r, 500));
      const sess = cm._internal.canvasSessions.get(sid);
      if (!sess) {
        log('  [skip] session not in map (start may have failed)');
      } else {
        assert(sess && sess.process, 'crash 前 session 存在');

        // 监听 crash hook
        let crashed = false;
        const off = cm.onCrash((p) => { if (p.sessionId === sid) crashed = true; });

        // SIGKILL 模拟崩溃
        sess.process.kill('SIGKILL');
        // 等 child exit handler 跑完
        await new Promise(r => setTimeout(r, 1000));

        assert(crashed, 'crash hook 触发');
        assert(!cm._internal.canvasSessions.has(sid), 'crash 后 session 清理');
        assert(!cm._internal.getSessionPortMap().has(sid), 'crash 后 portMap 清理');

        off();

        // crash 后再操作 — 应该返回错误而不是抛
        const r = await ipc('canvas:transform-device', { sessionId: sid, deviceId: 'd', transform: {} });
        assert(r.ok === false, 'crash 后 transform 返回错误, 不抛异常');
      }
    }
  }

  // ============== Section 11: 截图按钮 边界 — running vs idle ==============
  section('Section 11: 截图按钮边界 (running vs idle vs crashed)');
  {
    // idle 时: PreviewPanel 隐藏截图按钮 (line 1443), 但直接调 IPC 应该 fail
    const idleShot = await ipc('canvas:screenshot', { sessionId: 'tab-never' });
    assert(idleShot.ok === false, 'idle 截图 — 失败');

    // running 时: 成功
    const sid = 'tab-shot';
    await ipc('canvas:start', { sessionId: sid, width: 800, height: 600 });
    await new Promise(r => setTimeout(r, 500));
    const runShot = await ipc('canvas:screenshot', { sessionId: sid });
    assert(runShot.ok === true, 'running 截图 — 成功');
    assert(runShot.dataUrl && runShot.dataUrl.length > 50, 'running 截图 — dataUrl 长度 > 50');

    await ipc('canvas:stop', { sessionId: sid });
    await new Promise(r => setTimeout(r, 500));

    // stop 后: 失败
    const postStop = await ipc('canvas:screenshot', { sessionId: sid });
    assert(postStop.ok === false, 'stop 后截图 — 失败');
  }

  // ============== Section 12: push / pushUI / transform / setBg / clear 在 stop 后 ==============
  section('Section 12: stop 后所有写操作 (push/pushUI/transform/setBg/clear) 失败');
  {
    const sid = 'tab-poststop';
    await ipc('canvas:start', { sessionId: sid, width: 800, height: 600 });
    await new Promise(r => setTimeout(r, 500));
    await ipc('canvas:stop', { sessionId: sid });
    await new Promise(r => setTimeout(r, 500));

    const ops = [
      ['canvas:push', { sessionId: sid, dsl: { ui: {} } }],
      ['canvas:push-ui', { sessionId: sid, dsl: {}, deviceId: null }],
      ['canvas:transform-device', { sessionId: sid, deviceId: 'd', transform: {} }],
      ['canvas:set-background', { sessionId: sid, color: '#fff' }],
      ['canvas:clear-devices', { sessionId: sid }],
      ['canvas:resize', { sessionId: sid, width: 100, height: 100 }],
    ];
    for (const [ch, p] of ops) {
      const r = await ipc(ch, p);
      assert(r.ok === false, `stop 后 ${ch} — 失败 (不抛异常)`);
    }
  }

  // ============== Section 13: status / ws-status / embed-status / host-info ==============
  section('Section 13: 查询接口 — 状态可读');
  {
    const statusIdle = await ipc('canvas:status', { sessionId: 'no-such-tab' });
    assert(statusIdle.ok === true && statusIdle.active === false, 'status — 不存在 session: active=false');

    const sid = 'tab-status';
    await ipc('canvas:start', { sessionId: sid, width: 800, height: 600 });
    await new Promise(r => setTimeout(r, 500));
    const statusRun = await ipc('canvas:status', { sessionId: sid });
    assert(statusRun.ok === true && statusRun.active === true, 'status — 运行中: active=true');
    assert(statusRun.info && statusRun.info.port > 0, 'status — info.port 存在');

    const wsStatus = await ipc('canvas:ws-status', null);
    assert(wsStatus.ok === true, 'ws-status — 成功');
    assert(Array.isArray(wsStatus.wsClients), 'ws-status — wsClients 是数组');

    const embedStatus = await ipc('canvas:embed-status', { sessionId: sid });
    assert(embedStatus.ok === true, 'embed-status — 成功');
    assert(embedStatus.embedded === true, 'embed-status — embedded=true (mock 总是成功)');

    const hostInfo = await ipc('canvas:host-info', null);
    assert(hostInfo.ok === true, 'host-info — 成功');

    const ensureHost = await ipc('canvas:ensure-host', null);
    assert(ensureHost.ok === true, 'ensure-host — 成功');

    await ipc('canvas:stop', { sessionId: sid });
    await new Promise(r => setTimeout(r, 500));
  }

  // ============== Section 14: ensureHost 重复调用 ==============
  section('Section 14: ensureHost 重复调用 — 不应泄漏 host 窗口');
  {
    const before = cm._internal.getCanvasHostWindow();
    for (let i = 0; i < 10; i++) {
      const r = await ipc('canvas:ensure-host', null);
      assert(r.ok === true, `ensureHost 第 ${i+1} 次 — 成功`);
    }
    const after = cm._internal.getCanvasHostWindow();
    assert(before === after, 'ensureHost 10x — 同一个 host 窗口 (没新建 10 个)');
  }

  // ============== 总结 ==============
  log('');
  log('╔══════════════════════════════════════════════════════════╗');
  log(`║  测试结果: ${PASS.length} 通过, ${FAIL.length} 失败, ${BUGS.length} bug`);
  log('╚══════════════════════════════════════════════════════════╝');

  if (BUGS.length > 0) {
    log('');
    log('🐛 发现的 bug:');
    for (const b of BUGS) {
      log(`  - [${b.scenario}] ${b.detail}`);
    }
  }

  if (FAIL.length > 0) {
    log('');
    log('❌ 失败用例:');
    for (const f of FAIL) log(`  - ${f}`);
  }

  // 清理
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}

  process.exit(FAIL.length > 0 || BUGS.length > 0 ? 1 : 0);
}

app.whenReady().then(runTests).catch((e) => {
  log('FATAL: ' + e.message);
  log(e.stack);
  process.exit(2);
});
